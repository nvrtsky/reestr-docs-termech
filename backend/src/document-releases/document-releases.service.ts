import { createHash } from 'node:crypto';

import { and, desc, eq, inArray, max, or, sql } from 'drizzle-orm';

import { AttachmentsService, type StoredReleasedPdf } from '../attachments/attachments.service.js';
import type { BitrixApiClient } from '../bitrix/bitrix-client.js';
import type { PortalInstallationsService } from '../bitrix/portal-installations.service.js';
import type { AppConfig } from '../config.js';
import type { Database } from '../db/database.js';
import type { LifecycleConfig } from '../db/schema/index.js';
import {
  registryAttachments,
  registryAuditLog,
  registryDocumentLinks,
  registryDocumentReleases,
  registryDocuments,
  registryDocumentTypes,
  registryLifecycles,
  registrySections,
} from '../db/schema/index.js';
import { documentNumberUniquenessKey } from '../documents/document-numbering.service.js';
import { ApiError } from '../http/api-error.js';
import type { RegistryContext } from '../http/registry-context.js';
import type { DocumentReleaseInput } from './document-releases.schemas.js';

const PENDING_RETRY_AFTER_MS = 15 * 60 * 1_000;

interface PreparedRelease {
  documentId: string;
  releaseId: string;
  replay?: {
    attachmentId: string;
    current: boolean;
  };
}

export class DocumentReleasesService {
  private readonly attachments: AttachmentsService;

  constructor(
    private readonly database: Database,
    bitrix: BitrixApiClient,
    private readonly installations: PortalInstallationsService,
    private readonly config: AppConfig,
  ) {
    this.attachments = new AttachmentsService(database, bitrix);
  }

  async receive(input: DocumentReleaseInput) {
    const portalUrl = canonicalPortalUrl(input.portalUrl);
    const domain = new URL(portalUrl).hostname;
    const pdf = Buffer.from(input.pdf.contentBase64, 'base64');
    this.assertPdf(input, pdf);
    const requestHash = createHash('sha256')
      .update(stableJson({ ...input, portalUrl, pdf: { ...input.pdf, contentBase64: undefined } }))
      .update('\0')
      .update(pdf)
      .digest('hex');

    await this.installations.assertActive(domain);
    const accessToken = await this.installations.accessToken(domain);
    const prepared = await this.prepare(portalUrl, input, requestHash);
    if (prepared.replay) {
      return {
        status: 'replayed' as const,
        documentId: prepared.documentId,
        releaseId: prepared.releaseId,
        attachmentId: prepared.replay.attachmentId,
        current: prepared.replay.current,
      };
    }

    const context: RegistryContext = {
      portalUrl,
      userId: input.document.responsibleId,
      userName: input.document.responsibleName ?? undefined,
      roleCode: 'document_release_service',
      roleSource: 'user',
      departmentIds: [],
      source: 'bitrix',
      bitrix: { domain, accessToken },
    };
    let stored: StoredReleasedPdf | null = null;
    try {
      stored = await this.attachments.uploadReleasedPdf(context, prepared.documentId, {
        name: input.pdf.name,
        bytes: pdf,
      });
      return await this.complete(portalUrl, input, requestHash, prepared, stored);
    } catch (error) {
      if (stored) {
        await this.attachments.deleteReleasedPdf(context, stored.diskFileId).catch(() => undefined);
      }
      await this.fail(portalUrl, prepared.releaseId, apiErrorCode(error));
      throw error;
    }
  }

  private async prepare(
    portalUrl: string,
    input: DocumentReleaseInput,
    requestHash: string,
  ): Promise<PreparedRelease> {
    return this.database.transaction(async (transaction) => {
      await transaction.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${releaseLockKey(portalUrl, input)}, 0))`,
      );
      const [knownRelease] = await transaction
        .select({
          id: registryDocumentReleases.id,
          documentId: registryDocumentReleases.documentId,
          requestHash: registryDocumentReleases.requestHash,
          status: registryDocumentReleases.status,
          attachmentId: registryDocumentReleases.attachmentId,
          updatedAt: registryDocumentReleases.updatedAt,
        })
        .from(registryDocumentReleases)
        .where(and(
          eq(registryDocumentReleases.portalUrl, portalUrl),
          eq(registryDocumentReleases.source, input.source),
          eq(registryDocumentReleases.externalDocumentId, input.externalDocumentId),
          eq(registryDocumentReleases.versionId, input.versionId),
        ))
        .limit(1);
      if (knownRelease) {
        if (knownRelease.requestHash !== requestHash) {
          throw new ApiError(
            409,
            'document_release_idempotency_conflict',
            'This document version was already delivered with different content.',
          );
        }
        if (knownRelease.status === 'completed' && knownRelease.attachmentId) {
          const [attachment] = await transaction
            .select({ isCurrent: registryAttachments.isCurrent })
            .from(registryAttachments)
            .where(and(
              eq(registryAttachments.portalUrl, portalUrl),
              eq(registryAttachments.id, knownRelease.attachmentId),
            ))
            .limit(1);
          if (!attachment) {
            throw new ApiError(
              409,
              'document_release_attachment_missing',
              'The delivered release no longer has its stored PDF.',
            );
          }
          return {
            documentId: knownRelease.documentId,
            releaseId: knownRelease.id,
            replay: {
              attachmentId: knownRelease.attachmentId,
              current: attachment.isCurrent,
            },
          };
        }
        if (
          knownRelease.status === 'pending'
          && knownRelease.updatedAt.getTime() > Date.now() - PENDING_RETRY_AFTER_MS
        ) {
          throw new ApiError(
            409,
            'document_release_in_progress',
            'This document version is already being delivered.',
          );
        }
        await transaction
          .update(registryDocumentReleases)
          .set({ status: 'pending', errorCode: null, updatedAt: new Date() })
          .where(eq(registryDocumentReleases.id, knownRelease.id));
        return { documentId: knownRelease.documentId, releaseId: knownRelease.id };
      }

      const configuration = await this.loadTypeConfiguration(transaction, portalUrl, input.source);
      const identity = documentIdentityCondition(portalUrl, input);
      const documents = await transaction
        .select({ id: registryDocuments.id })
        .from(registryDocuments)
        .where(identity)
        .limit(2);
      if (documents.length > 1) {
        throw new ApiError(
          409,
          'document_release_identity_conflict',
          'More than one registry card matches this source document.',
        );
      }

      let documentId = documents[0]?.id;
      if (!documentId) {
        const [created] = await transaction
          .insert(registryDocuments)
          .values({
            portalUrl,
            sectionId: configuration.sectionId,
            typeId: configuration.typeId,
            number: input.document.number,
            numberUniquenessKey: configuration.numberUniquenessEnabled && input.document.number
              ? documentNumberUniquenessKey(input.document.number, input.document.counterpartyId ?? null)
              : null,
            title: input.document.title,
            documentDate: input.document.documentDate,
            amount: input.document.amount,
            currency: input.document.currency,
            legalEntityId: input.document.legalEntityId ?? null,
            legalEntityName: input.document.legalEntityName ?? null,
            counterpartyId: input.document.counterpartyId ?? null,
            counterpartyName: input.document.counterpartyName ?? null,
            status: configuration.initialStatus,
            responsibleId: input.document.responsibleId,
            responsibleName: input.document.responsibleName ?? null,
            createdBy: input.document.responsibleId,
            externalSource: input.source,
            externalDocumentId: input.externalDocumentId,
            externalEntityTypeId: input.externalEntityTypeId ?? null,
            externalEntityId: input.externalEntityId ?? null,
            externalStatus: 'release_pending',
            externalUpdatedAt: new Date(input.releasedAt),
            externalSyncedAt: new Date(),
            isFinalized: false,
          })
          .returning({ id: registryDocuments.id });
        documentId = created.id;
      }

      const [release] = await transaction
        .insert(registryDocumentReleases)
        .values({
          portalUrl,
          documentId,
          source: input.source,
          externalDocumentId: input.externalDocumentId,
          versionId: input.versionId,
          releasedAt: new Date(input.releasedAt),
          requestHash,
          pdfSha256: input.pdf.sha256,
        })
        .returning({ id: registryDocumentReleases.id });
      return { documentId, releaseId: release.id };
    });
  }

  private async complete(
    portalUrl: string,
    input: DocumentReleaseInput,
    requestHash: string,
    prepared: PreparedRelease,
    stored: StoredReleasedPdf,
  ) {
    return this.database.transaction(async (transaction) => {
      await transaction.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${releaseLockKey(portalUrl, input)}, 0))`,
      );
      const [release] = await transaction
        .select()
        .from(registryDocumentReleases)
        .where(and(
          eq(registryDocumentReleases.id, prepared.releaseId),
          eq(registryDocumentReleases.portalUrl, portalUrl),
          eq(registryDocumentReleases.requestHash, requestHash),
          eq(registryDocumentReleases.status, 'pending'),
        ))
        .limit(1);
      if (!release) {
        throw new ApiError(
          409,
          'document_release_state_conflict',
          'The release state changed during PDF storage.',
        );
      }
      const [latest] = await transaction
        .select({ releasedAt: registryDocumentReleases.releasedAt })
        .from(registryDocumentReleases)
        .where(and(
          eq(registryDocumentReleases.portalUrl, portalUrl),
          eq(registryDocumentReleases.documentId, prepared.documentId),
          eq(registryDocumentReleases.status, 'completed'),
        ))
        .orderBy(desc(registryDocumentReleases.releasedAt))
        .limit(1);
      const stale = isReleaseStale(latest?.releasedAt, new Date(input.releasedAt));
      const [document] = await transaction
        .select({
          isFinalized: registryDocuments.isFinalized,
          responsibleId: registryDocuments.responsibleId,
          responsibleName: registryDocuments.responsibleName,
          status: registryDocuments.status,
          comment: registryDocuments.comment,
          deletedAt: registryDocuments.deletedAt,
          deletedBy: registryDocuments.deletedBy,
        })
        .from(registryDocuments)
        .where(and(
          eq(registryDocuments.portalUrl, portalUrl),
          eq(registryDocuments.id, prepared.documentId),
        ))
        .limit(1);
      if (!document) {
        throw new ApiError(409, 'document_release_card_missing', 'The target registry card is missing.');
      }
      const configuration = await this.loadTypeConfiguration(transaction, portalUrl, input.source);

      let replacedAttachmentId: string | null = null;
      if (!stale) {
        const [current] = await transaction
          .select({ id: registryAttachments.id })
          .from(registryAttachments)
          .where(and(
            eq(registryAttachments.portalUrl, portalUrl),
            eq(registryAttachments.documentId, prepared.documentId),
            eq(registryAttachments.kind, 'file'),
            eq(registryAttachments.isPrimary, true),
            eq(registryAttachments.isCurrent, true),
          ))
          .limit(1);
        replacedAttachmentId = current?.id ?? null;
        if (current) {
          await transaction
            .update(registryAttachments)
            .set({ isCurrent: false })
            .where(eq(registryAttachments.id, current.id));
        }
      }
      const [versionRow] = await transaction
        .select({ value: max(registryAttachments.version) })
        .from(registryAttachments)
        .where(and(
          eq(registryAttachments.portalUrl, portalUrl),
          eq(registryAttachments.documentId, prepared.documentId),
          eq(registryAttachments.kind, 'file'),
          eq(registryAttachments.isPrimary, true),
        ));
      const [attachment] = await transaction
        .insert(registryAttachments)
        .values({
          portalUrl,
          documentId: prepared.documentId,
          kind: 'file',
          name: stored.name,
          mimeType: 'application/pdf',
          sizeBytes: stored.sizeBytes,
          diskFileId: stored.diskFileId,
          diskFolderId: stored.diskFolderId,
          url: stored.url,
          version: (versionRow?.value ?? 0) + 1,
          isPrimary: true,
          isCurrent: !stale,
          replacesAttachmentId: replacedAttachmentId,
          createdBy: input.document.responsibleId,
        })
        .returning({ id: registryAttachments.id });

      if (!stale) {
        await transaction
          .update(registryDocuments)
          .set({
            sectionId: configuration.sectionId,
            typeId: configuration.typeId,
            number: input.document.number,
            numberUniquenessKey: configuration.numberUniquenessEnabled && input.document.number
              ? documentNumberUniquenessKey(input.document.number, input.document.counterpartyId ?? null)
              : null,
            title: input.document.title,
            documentDate: input.document.documentDate,
            amount: input.document.amount,
            currency: input.document.currency,
            legalEntityId: input.document.legalEntityId ?? null,
            legalEntityName: input.document.legalEntityName ?? null,
            counterpartyId: input.document.counterpartyId ?? null,
            counterpartyName: input.document.counterpartyName ?? null,
            responsibleId: document.isFinalized
              ? document.responsibleId
              : input.document.responsibleId,
            responsibleName: document.isFinalized
              ? document.responsibleName
              : input.document.responsibleName ?? null,
            externalSource: input.source,
            externalDocumentId: input.externalDocumentId,
            externalEntityTypeId: input.externalEntityTypeId ?? null,
            externalEntityId: input.externalEntityId ?? null,
            externalStatus: 'released',
            externalUpdatedAt: new Date(input.releasedAt),
            externalSyncedAt: new Date(),
            isFinalized: true,
            updatedBy: input.document.responsibleId,
            updatedAt: new Date(),
          })
          .where(and(
            eq(registryDocuments.portalUrl, portalUrl),
            eq(registryDocuments.id, prepared.documentId),
          ));
        await this.replaceSourceLinks(transaction, portalUrl, prepared.documentId, input);
      }

      await transaction
        .update(registryDocumentReleases)
        .set({
          status: 'completed',
          attachmentId: attachment.id,
          errorCode: null,
          completedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(registryDocumentReleases.id, prepared.releaseId));
      await transaction.insert(registryAuditLog).values({
        portalUrl,
        documentId: prepared.documentId,
        event: 'document_release_received',
        actorId: input.document.responsibleId,
        actorName: input.document.responsibleName ?? null,
        after: {
          source: input.source,
          externalDocumentId: input.externalDocumentId,
          versionId: input.versionId,
          attachmentId: attachment.id,
          stale,
        },
        metadata: { automated: true, pdfSha256: input.pdf.sha256 },
      });
      return {
        status: stale ? 'stored_stale' as const : 'stored' as const,
        documentId: prepared.documentId,
        releaseId: prepared.releaseId,
        attachmentId: attachment.id,
        current: !stale,
      };
    });
  }

  private async replaceSourceLinks(
    transaction: Parameters<Parameters<Database['transaction']>[0]>[0],
    portalUrl: string,
    documentId: string,
    input: DocumentReleaseInput,
  ) {
    const managedRoles = input.source === 'bitrix_smart_invoice'
      ? ['release_import', 'bitrix_import']
      : ['release_import'];
    await transaction
      .delete(registryDocumentLinks)
      .where(and(
        eq(registryDocumentLinks.portalUrl, portalUrl),
        eq(registryDocumentLinks.documentId, documentId),
        inArray(registryDocumentLinks.linkRole, managedRoles),
      ));
    const links: Array<typeof registryDocumentLinks.$inferInsert> = [];
    if (input.crm.company) {
      links.push({
        portalUrl,
        documentId,
        entityType: 'company',
        entityId: input.crm.company.id,
        entityTitle: input.crm.company.title,
        linkRole: 'release_import',
      });
    }
    for (const deal of input.crm.deals) {
      links.push({
        portalUrl,
        documentId,
        entityType: 'deal',
        entityId: deal.id,
        entityTitle: deal.title,
        linkRole: 'release_import',
        dealClosed: deal.closed ?? null,
        dealStateCheckedAt: deal.closed === undefined ? null : new Date(),
      });
    }
    if (links.length) await transaction.insert(registryDocumentLinks).values(links);

    const [existingLink] = await transaction
      .select({ id: registryAttachments.id })
      .from(registryAttachments)
      .where(and(
        eq(registryAttachments.portalUrl, portalUrl),
        eq(registryAttachments.documentId, documentId),
        eq(registryAttachments.kind, 'link'),
        eq(registryAttachments.isPrimary, true),
        eq(registryAttachments.isCurrent, true),
      ))
      .limit(1);
    if (existingLink) {
      await transaction
        .update(registryAttachments)
        .set({
          name: 'Открыть исходный документ',
          url: input.internalUrl,
        })
        .where(eq(registryAttachments.id, existingLink.id));
    } else {
      await transaction.insert(registryAttachments).values({
        portalUrl,
        documentId,
        kind: 'link',
        name: 'Открыть исходный документ',
        url: input.internalUrl,
        isPrimary: true,
        isCurrent: true,
        createdBy: input.document.responsibleId,
      });
    }
  }

  private async loadTypeConfiguration(
    transaction: Parameters<Parameters<Database['transaction']>[0]>[0],
    portalUrl: string,
    source: DocumentReleaseInput['source'],
  ) {
    const typeCode = source === 'bitrix_smart_invoice' ? 'client_invoice' : 'client_quote';
    const [row] = await transaction
      .select({
        typeId: registryDocumentTypes.id,
        sectionId: registryDocumentTypes.sectionId,
        numberUniquenessEnabled: registryDocumentTypes.numberUniquenessEnabled,
        lifecycle: registryLifecycles.config,
      })
      .from(registryDocumentTypes)
      .innerJoin(registrySections, eq(registryDocumentTypes.sectionId, registrySections.id))
      .innerJoin(registryLifecycles, eq(registryDocumentTypes.lifecycleId, registryLifecycles.id))
      .where(and(
        eq(registryDocumentTypes.portalUrl, portalUrl),
        eq(registrySections.portalUrl, portalUrl),
        eq(registryLifecycles.portalUrl, portalUrl),
        eq(registryDocumentTypes.code, typeCode),
        eq(registryDocumentTypes.isActive, true),
        eq(registrySections.isActive, true),
        eq(registryLifecycles.isActive, true),
      ))
      .limit(1);
    if (!row) {
      throw new ApiError(
        409,
        'document_release_catalog_missing',
        'The target registry document type is not configured.',
      );
    }
    return {
      ...row,
      initialStatus: (row.lifecycle as LifecycleConfig).initialStatus,
    };
  }

  private async fail(portalUrl: string, releaseId: string, errorCode: string) {
    await this.database
      .update(registryDocumentReleases)
      .set({ status: 'failed', errorCode, updatedAt: new Date() })
      .where(and(
        eq(registryDocumentReleases.portalUrl, portalUrl),
        eq(registryDocumentReleases.id, releaseId),
        eq(registryDocumentReleases.status, 'pending'),
      ))
      .catch(() => undefined);
  }

  private assertPdf(input: DocumentReleaseInput, pdf: Buffer) {
    if (pdf.length !== input.pdf.sizeBytes || pdf.length > this.config.DOCUMENT_RELEASE_MAX_PDF_BYTES) {
      throw new ApiError(413, 'document_release_pdf_size_invalid', 'Released PDF size is invalid.');
    }
    if (pdf.subarray(0, 5).toString('ascii') !== '%PDF-') {
      throw new ApiError(400, 'document_release_pdf_invalid', 'Released content is not a PDF file.');
    }
    const checksum = createHash('sha256').update(pdf).digest('hex');
    if (checksum !== input.pdf.sha256) {
      throw new ApiError(400, 'document_release_checksum_mismatch', 'Released PDF checksum does not match.');
    }
  }
}

export function canonicalPortalUrl(value: string) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new ApiError(400, 'document_release_portal_invalid', 'Portal URL must be an exact HTTPS origin.');
  }
  return url.origin.toLowerCase();
}

export function isReleaseStale(latest: Date | undefined, candidate: Date) {
  return !!latest && latest.getTime() >= candidate.getTime();
}

function documentIdentityCondition(portalUrl: string, input: DocumentReleaseInput) {
  const stringIdentity = and(
    eq(registryDocuments.externalSource, input.source),
    eq(registryDocuments.externalDocumentId, input.externalDocumentId),
  );
  const numericIdentity = input.source === 'bitrix_smart_invoice'
    ? and(
        eq(registryDocuments.externalSource, input.source),
        eq(registryDocuments.externalEntityTypeId, input.externalEntityTypeId!),
        eq(registryDocuments.externalEntityId, input.externalEntityId!),
      )
    : undefined;
  return and(
    eq(registryDocuments.portalUrl, portalUrl),
    numericIdentity ? or(stringIdentity, numericIdentity)! : stringIdentity,
  );
}

function releaseLockKey(portalUrl: string, input: DocumentReleaseInput) {
  return `registry-release:${portalUrl}:${input.source}:${input.externalDocumentId}`;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function apiErrorCode(error: unknown) {
  return error instanceof ApiError ? error.code : 'document_release_failed';
}
