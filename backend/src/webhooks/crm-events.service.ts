import { createHash } from 'node:crypto';

import { and, asc, eq, inArray, isNull, like } from 'drizzle-orm';

import { AttachmentsService } from '../attachments/attachments.service.js';
import type { BitrixApiClient } from '../bitrix/bitrix-client.js';
import type { Database } from '../db/database.js';
import {
  registryAuditLog,
  registryAttachmentCopies,
  registryAttachments,
  registryDocumentLinks,
  registryDocuments,
  registrySettings,
} from '../db/schema/index.js';
import { ApiError } from '../http/api-error.js';
import type { RegistryContext } from '../http/registry-context.js';
import type { CrmEvent } from './crm-events.schemas.js';
import { closedDealState } from '../permissions/sales-deal-access.service.js';

type EntityType = 'deal' | 'company';

interface ReconciliationMarker {
  event: CrmEvent['event'];
  entityId: number;
  attempts: number;
  queuedAt: string;
  lastAttemptAt?: string;
  lastError?: string;
}

const RECONCILIATION_PREFIX = 'crm_reconciliation:';

interface BitrixEntity {
  ID?: string | number;
  TITLE?: string;
  CLOSED?: string | boolean | number;
  STAGE_SEMANTIC_ID?: string;
}

interface DocumentChange {
  documentId: string;
  previousLinkTitles: string[];
  previousCounterpartyName?: string | null;
  previousDealClosed?: boolean | null;
  previousUpdatedAt?: Date;
}

export class CrmEventsService {
  private readonly attachments: AttachmentsService;

  constructor(
    private readonly database: Database,
    private readonly bitrix: BitrixApiClient,
  ) {
    this.attachments = new AttachmentsService(database, bitrix);
  }

  async processTracked(event: CrmEvent, domain: string) {
    const portalUrl = `https://${domain}`;
    const key = this.reconciliationKey(event);
    const marker: ReconciliationMarker = {
      event: event.event,
      entityId: event.data.FIELDS.ID,
      attempts: 0,
      queuedAt: new Date().toISOString(),
    };
    await this.database
      .insert(registrySettings)
      .values({ portalUrl, key, value: marker })
      .onConflictDoUpdate({
        target: [registrySettings.portalUrl, registrySettings.key],
        set: { value: marker, updatedAt: new Date() },
      });
    try {
      const result = await this.process(event, domain);
      await this.database
        .delete(registrySettings)
        .where(and(
          eq(registrySettings.portalUrl, portalUrl),
          eq(registrySettings.key, key),
        ));
      return result;
    } catch (error) {
      await this.recordReconciliationFailure(portalUrl, key, marker, error);
      throw error;
    }
  }

  async reconcilePending(context: RegistryContext, limit = 100) {
    if (!context.bitrix || context.roleCode !== 'admin') {
      throw new ApiError(
        403,
        'registry_admin_required',
        'A verified Bitrix24 administrator is required for CRM reconciliation.',
      );
    }
    const rows = await this.database
      .select({ key: registrySettings.key, value: registrySettings.value })
      .from(registrySettings)
      .where(and(
        eq(registrySettings.portalUrl, context.portalUrl),
        like(registrySettings.key, `${RECONCILIATION_PREFIX}%`),
      ))
      .orderBy(asc(registrySettings.createdAt))
      .limit(limit);
    let completed = 0;
    let failed = 0;
    for (const row of rows) {
      const marker = this.parseReconciliationMarker(row.value);
      if (!marker) {
        failed += 1;
        continue;
      }
      const event: CrmEvent = {
        event: marker.event,
        data: { FIELDS: { ID: marker.entityId } },
        auth: {
          domain: context.bitrix.domain,
          application_token: 'server-side-reconciliation',
          access_token: context.bitrix.accessToken,
          member_id: context.bitrix.memberId,
        },
      };
      try {
        await this.process(event, context.bitrix.domain);
        await this.database
          .delete(registrySettings)
          .where(and(
            eq(registrySettings.portalUrl, context.portalUrl),
            eq(registrySettings.key, row.key),
          ));
        completed += 1;
      } catch (error) {
        await this.recordReconciliationFailure(
          context.portalUrl,
          row.key,
          marker,
          error,
        );
        failed += 1;
      }
    }
    return { pending: rows.length, completed, failed };
  }

  async process(event: CrmEvent, domain: string) {
    const entityType: EntityType = event.event.includes('DEAL') ? 'deal' : 'company';
    const entityId = event.data.FIELDS.ID;
    if (event.event.endsWith('DELETE')) {
      return this.removeEntityLinks(
        `https://${domain}`,
        entityType,
        entityId,
        domain,
        event.auth.access_token,
      );
    }

    if (!event.auth.access_token) {
      throw new ApiError(
        503,
        'bitrix_event_access_token_missing',
        'Bitrix24 event does not contain an access token; retry is required.',
      );
    }
    const method = entityType === 'deal' ? 'crm.deal.get' : 'crm.company.get';
    const entity = await this.bitrix.call<BitrixEntity>(
      domain,
      event.auth.access_token,
      method,
      { id: entityId },
    );
    const title = typeof entity.TITLE === 'string' ? entity.TITLE.trim().slice(0, 500) : '';
    if (!title) {
      throw new ApiError(
        502,
        'bitrix_entity_title_missing',
        'Bitrix24 returned an entity without a title.',
      );
    }
    return this.synchronizeEntity(
      `https://${domain}`,
      entityType,
      entityId,
      title,
      entityType === 'deal' ? closedDealState(entity) : null,
      domain,
      event.auth.access_token,
    );
  }

  private async synchronizeEntity(
    portalUrl: string,
    entityType: EntityType,
    entityId: number,
    title: string,
    dealClosed: boolean | null,
    domain: string,
    accessToken: string,
  ) {
    const links = await this.database
      .select({
        id: registryDocumentLinks.id,
        documentId: registryDocumentLinks.documentId,
        entityTitle: registryDocumentLinks.entityTitle,
        dealClosed: registryDocumentLinks.dealClosed,
      })
      .from(registryDocumentLinks)
      .where(
        and(
          eq(registryDocumentLinks.portalUrl, portalUrl),
          eq(registryDocumentLinks.entityType, entityType),
          eq(registryDocumentLinks.entityId, entityId),
        ),
      );
    const counterpartyDocuments = entityType === 'company'
      ? await this.database
          .select({
            documentId: registryDocuments.id,
            counterpartyName: registryDocuments.counterpartyName,
            updatedAt: registryDocuments.updatedAt,
          })
          .from(registryDocuments)
          .where(
            and(
              eq(registryDocuments.portalUrl, portalUrl),
              eq(registryDocuments.counterpartyId, entityId),
            ),
          )
      : [];

    const changes = new Map<string, DocumentChange>();
    for (const link of links) {
      const titleChanged = link.entityTitle !== title;
      const stateChanged = entityType === 'deal' && link.dealClosed !== dealClosed;
      if (!titleChanged && !stateChanged) continue;
      const change = changes.get(link.documentId) ?? {
        documentId: link.documentId,
        previousLinkTitles: [],
      };
      if (titleChanged) change.previousLinkTitles.push(link.entityTitle);
      if (stateChanged) change.previousDealClosed = link.dealClosed;
      changes.set(link.documentId, change);
    }
    for (const document of counterpartyDocuments) {
      if (document.counterpartyName === title) continue;
      const change = changes.get(document.documentId) ?? {
        documentId: document.documentId,
        previousLinkTitles: [],
      };
      change.previousCounterpartyName = document.counterpartyName;
      change.previousUpdatedAt = document.updatedAt;
      changes.set(document.documentId, change);
    }
    if (!changes.size) {
      if (entityType === 'deal') {
        await this.database
          .update(registryDocumentLinks)
          .set({ dealClosed, dealStateCheckedAt: new Date() })
          .where(
            and(
              eq(registryDocumentLinks.portalUrl, portalUrl),
              eq(registryDocumentLinks.entityType, 'deal'),
              eq(registryDocumentLinks.entityId, entityId),
            ),
          );
      }
      return { status: 'unchanged' as const, entityType, entityId, affectedDocuments: 0 };
    }

    const relocationContext: RegistryContext = {
      portalUrl,
      userId: 0,
      userName: 'Система',
      roleCode: 'admin',
      roleSource: 'bitrix_admin',
      departmentIds: [],
      source: 'bitrix',
      bitrix: { domain, accessToken },
    };
    const relocations: Array<{
      documentId: string;
      value: Awaited<ReturnType<AttachmentsService['prepareCounterpartyRelocation']>>;
    }> = [];
    try {
      if (entityType === 'company') {
        for (const change of changes.values()) {
          if (!Object.hasOwn(change, 'previousCounterpartyName')) continue;
          relocations.push({
            documentId: change.documentId,
            value: await this.attachments.prepareCounterpartyRelocation(
              relocationContext,
              change.documentId,
              entityId,
              title,
            ),
          });
        }
      }
    } catch (error) {
      await Promise.all(relocations.map((relocation) =>
        this.attachments.rollbackCounterpartyRelocation(relocationContext, relocation.value)));
      throw error;
    }
    const relocationByDocument = new Map(
      relocations.map((relocation) => [relocation.documentId, relocation.value]),
    );
    try {
      await this.database.transaction(async (transaction) => {
      await transaction
        .update(registryDocumentLinks)
        .set({
          entityTitle: title,
          ...(entityType === 'deal' ? { dealClosed, dealStateCheckedAt: new Date() } : {}),
        })
        .where(
          and(
            eq(registryDocumentLinks.portalUrl, portalUrl),
            eq(registryDocumentLinks.entityType, entityType),
            eq(registryDocumentLinks.entityId, entityId),
          ),
        );
      if (entityType === 'company') {
        for (const change of changes.values()) {
          if (!Object.hasOwn(change, 'previousCounterpartyName')) continue;
          const [updated] = await transaction
            .update(registryDocuments)
            .set({ counterpartyName: title, updatedAt: new Date() })
            .where(and(
              eq(registryDocuments.id, change.documentId),
              eq(registryDocuments.portalUrl, portalUrl),
              eq(registryDocuments.counterpartyId, entityId),
              eq(registryDocuments.updatedAt, change.previousUpdatedAt!),
            ))
            .returning({ id: registryDocuments.id });
          if (!updated) {
            throw new ApiError(
              409,
              'crm_entity_update_conflict',
              'The document company changed while the Bitrix24 event was being processed.',
            );
          }
          const relocation = relocationByDocument.get(change.documentId);
          if (relocation) {
            for (const attachment of relocation.attachmentUpdates) {
              await transaction
                .update(registryAttachments)
                .set({
                  diskFolderId: attachment.diskFolderId,
                  url: attachment.url,
                })
                .where(and(
                  eq(registryAttachments.id, attachment.id),
                  eq(registryAttachments.portalUrl, portalUrl),
                  eq(registryAttachments.documentId, change.documentId),
                ));
            }
            for (const copy of relocation.copyUpdates) {
              await transaction
                .update(registryAttachmentCopies)
                .set({
                  diskFolderId: copy.diskFolderId,
                  storagePath: copy.storagePath,
                  url: copy.url,
                })
                .where(and(
                  eq(registryAttachmentCopies.id, copy.id),
                  eq(registryAttachmentCopies.portalUrl, portalUrl),
                ));
            }
          }
        }
      }
      await transaction.insert(registryAuditLog).values(
        [...changes.values()].map((change) => ({
          portalUrl,
          documentId: change.documentId,
          event: 'crm_entity_title_updated',
          actorName: 'Система',
          before: {
            entityType,
            entityId,
            linkTitles: change.previousLinkTitles,
            ...(Object.hasOwn(change, 'previousDealClosed')
              ? { dealClosed: change.previousDealClosed }
              : {}),
            ...(Object.hasOwn(change, 'previousCounterpartyName')
              ? { counterpartyName: change.previousCounterpartyName }
              : {}),
          },
          after: {
            entityType,
            entityId,
            title,
            ...(entityType === 'deal' ? { dealClosed } : {}),
          },
          metadata: { source: 'bitrix_webhook' },
        })),
      );
      });
    } catch (error) {
      await Promise.all(relocations.map((relocation) =>
        this.attachments.rollbackCounterpartyRelocation(relocationContext, relocation.value)));
      throw error;
    }
    return {
      status: 'updated' as const,
      entityType,
      entityId,
      affectedDocuments: changes.size,
    };
  }

  private async removeEntityLinks(
    portalUrl: string,
    entityType: EntityType,
    entityId: number,
    domain: string,
    accessToken?: string,
  ) {
    const [links, copies] = await Promise.all([
      this.database
        .select()
        .from(registryDocumentLinks)
        .where(
          and(
            eq(registryDocumentLinks.portalUrl, portalUrl),
            eq(registryDocumentLinks.entityType, entityType),
            eq(registryDocumentLinks.entityId, entityId),
          ),
        ),
      entityType === 'deal'
        ? this.database
            .select({
              id: registryAttachmentCopies.id,
              diskFileId: registryAttachmentCopies.diskFileId,
              documentId: registryAttachments.documentId,
            })
            .from(registryAttachmentCopies)
            .innerJoin(
              registryAttachments,
              eq(registryAttachmentCopies.attachmentId, registryAttachments.id),
            )
            .where(and(
              eq(registryAttachmentCopies.portalUrl, portalUrl),
              eq(registryAttachments.portalUrl, portalUrl),
              eq(registryAttachmentCopies.dealId, entityId),
              isNull(registryAttachmentCopies.deletedAt),
            ))
        : Promise.resolve([]),
    ]);
    if (!links.length && !copies.length) {
      return { status: 'unchanged' as const, entityType, entityId, affectedDocuments: 0 };
    }
    if (copies.length && !accessToken) {
      throw new ApiError(
        503,
        'bitrix_event_access_token_missing',
        'Bitrix24 event does not contain an access token; physical copy cleanup must be retried.',
      );
    }

    const markedFileIds: number[] = [];
    try {
      for (const copy of copies) {
        await this.bitrix.call(
          domain,
          accessToken!,
          'disk.file.markdeleted',
          { id: copy.diskFileId },
        );
        markedFileIds.push(copy.diskFileId);
      }
    } catch (error) {
      await Promise.all(markedFileIds.map((diskFileId) => this.bitrix.call(
        domain,
        accessToken!,
        'disk.file.restore',
        { id: diskFileId },
      ).catch(() => undefined)));
      throw error;
    }

    try {
      await this.database.transaction(async (transaction) => {
      await transaction
        .delete(registryDocumentLinks)
        .where(inArray(registryDocumentLinks.id, links.map((link) => link.id)));
      if (copies.length) {
        await transaction
          .update(registryAttachmentCopies)
          .set({ deletedAt: new Date() })
          .where(inArray(registryAttachmentCopies.id, copies.map((copy) => copy.id)));
      }
      const audits: Array<typeof registryAuditLog.$inferInsert> = links.map((link) => ({
          portalUrl,
          documentId: link.documentId,
          event: 'crm_entity_deleted',
          actorName: 'Система',
          before: link,
          after: null,
          metadata: {
            source: 'bitrix_webhook',
            entityType,
            entityId,
            physicalCopyCount: copies.filter((copy) => copy.documentId === link.documentId).length,
          },
        }));
      const linkedDocumentIds = new Set(links.map((link) => link.documentId));
      for (const documentId of new Set(copies.map((copy) => copy.documentId))) {
        if (linkedDocumentIds.has(documentId)) continue;
        audits.push({
          portalUrl,
          documentId,
          event: 'crm_entity_deleted',
          actorName: 'Система',
          before: { entityType, entityId },
          after: null,
          metadata: {
            source: 'bitrix_webhook',
            entityType,
            entityId,
            physicalCopyCount: copies.filter((copy) => copy.documentId === documentId).length,
          },
        });
      }
      if (audits.length) await transaction.insert(registryAuditLog).values(audits);
      });
    } catch (error) {
      await Promise.all(markedFileIds.map((diskFileId) => this.bitrix.call(
        domain,
        accessToken!,
        'disk.file.restore',
        { id: diskFileId },
      ).catch(() => undefined)));
      throw error;
    }
    const affectedDocuments = new Set([
      ...links.map((link) => link.documentId),
      ...copies.map((copy) => copy.documentId),
    ]);
    return {
      status: 'removed' as const,
      entityType,
      entityId,
      affectedDocuments: affectedDocuments.size,
    };
  }

  private reconciliationKey(event: CrmEvent) {
    const identity = JSON.stringify({
      event: event.event,
      entityId: event.data.FIELDS.ID,
      ts: event.ts ?? null,
      handlerId: event.event_handler_id ?? null,
    });
    return `${RECONCILIATION_PREFIX}${createHash('sha256').update(identity).digest('hex')}`;
  }

  private parseReconciliationMarker(value: unknown): ReconciliationMarker | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const marker = value as Partial<ReconciliationMarker>;
    if (
      !['ONCRMDEALUPDATE', 'ONCRMDEALDELETE', 'ONCRMCOMPANYUPDATE', 'ONCRMCOMPANYDELETE']
        .includes(String(marker.event))
      || !Number.isSafeInteger(marker.entityId)
      || Number(marker.entityId) <= 0
    ) return null;
    return {
      event: marker.event!,
      entityId: Number(marker.entityId),
      attempts: Number.isSafeInteger(marker.attempts) ? Number(marker.attempts) : 0,
      queuedAt: typeof marker.queuedAt === 'string'
        ? marker.queuedAt
        : new Date().toISOString(),
      ...(typeof marker.lastAttemptAt === 'string'
        ? { lastAttemptAt: marker.lastAttemptAt }
        : {}),
      ...(typeof marker.lastError === 'string' ? { lastError: marker.lastError } : {}),
    };
  }

  private async recordReconciliationFailure(
    portalUrl: string,
    key: string,
    marker: ReconciliationMarker,
    error: unknown,
  ) {
    const message = error instanceof Error ? error.message : String(error);
    await this.database
      .update(registrySettings)
      .set({
        value: {
          ...marker,
          attempts: marker.attempts + 1,
          lastAttemptAt: new Date().toISOString(),
          lastError: message.slice(0, 1000),
        } satisfies ReconciliationMarker,
        updatedAt: new Date(),
      })
      .where(and(
        eq(registrySettings.portalUrl, portalUrl),
        eq(registrySettings.key, key),
      ));
  }
}
