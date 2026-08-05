import { createHash, randomUUID } from 'node:crypto';

import { and, asc, eq, inArray, isNull } from 'drizzle-orm';

import type { BitrixApiClient } from '../bitrix/bitrix-client.js';
import type { Database } from '../db/database.js';
import {
  registryAttachments,
  registryAttachmentCopies,
  registryAuditLog,
  registryDocumentFieldValues,
  registryDocumentLinks,
  registryDocuments,
  registryDocumentTypes,
  registryFieldDefinitions,
  registrySections,
  registrySettings,
  registryTypeFields,
} from '../db/schema/index.js';
import { ApiError } from '../http/api-error.js';
import type { RegistryContext } from '../http/registry-context.js';
import { logger } from '../logger.js';
import { CrmEntityAccessService } from '../permissions/crm-entity-access.service.js';
import { SalesDealAccessService } from '../permissions/sales-deal-access.service.js';
import {
  assertSectionVisible,
  assertTypePermission,
  assertTypeVisible,
  isDocumentFieldHidden,
  loadRegistryPolicy,
  type RegistryPolicy,
} from '../permissions/policy.service.js';
import type {
  AddExternalLinkInput,
  InitializeFileUploadInput,
} from './attachments.schemas.js';

interface UploadSession {
  id: string;
  portalUrl: string;
  userId: number;
  documentId: string;
  folderId: number;
  name: string;
  mimeType: string | null;
  sizeBytes: number;
  uploadUrl: string;
  fieldName: string;
  fieldDefinitionId: string | null;
  fieldKey: string | null;
  replacesAttachment: typeof registryAttachments.$inferSelect | null;
  expiresAt: number;
}

interface DiskObject {
  ID: string | number;
  NAME: string;
  TYPE: string;
  PARENT_ID: string | number;
  DELETED_TYPE?: string | number;
  SIZE?: string | number;
  DETAIL_URL?: string;
  DOWNLOAD_URL?: string;
}

interface UploadInitialization {
  uploadUrl?: string;
  UploadUrl?: string;
  field?: string;
}

interface PreparedAttachmentCopy {
  dealId: number;
  dealTitle: string;
  diskFileId: number;
  diskFolderId: number;
  storagePath: string;
  url: string | null;
}

const ROOT_FOLDER_SETTING = 'bitrix_disk_root_folder_id';
const FOLDER_CACHE_PREFIX = 'bitrix_disk_folder_id:';
const UPLOAD_SESSION_TTL_MS = 10 * 60 * 1000;

export class AttachmentsService {
  private readonly uploadSessions = new Map<string, UploadSession>();
  private readonly folderCache = new Map<string, number>();
  private readonly crmEntityAccess: CrmEntityAccessService;
  private readonly salesDealAccess: SalesDealAccessService;

  constructor(
    private readonly database: Database,
    private readonly bitrix: BitrixApiClient,
  ) {
    this.crmEntityAccess = new CrmEntityAccessService(database, bitrix);
    this.salesDealAccess = new SalesDealAccessService(database, bitrix);
  }

  async addExternalLink(
    context: RegistryContext,
    documentId: string,
    input: AddExternalLinkInput,
  ) {
    const document = await this.loadEditableDocument(context, documentId);
    const url = new URL(input.url);
    url.hash = '';
    const name = this.normalizeDisplayName(input.name || url.hostname);

    const [attachment] = await this.database.transaction(async (transaction) => {
      const [created] = await transaction
        .insert(registryAttachments)
        .values({
          portalUrl: context.portalUrl,
          documentId,
          kind: 'link',
          name,
          url: url.toString(),
          createdBy: context.userId,
        })
        .returning();
      await transaction.insert(registryAuditLog).values({
        portalUrl: context.portalUrl,
        documentId,
        event: 'attachment_added',
        actorId: context.userId,
        after: this.toAttachmentResponse(created),
        metadata: { kind: 'link', documentType: document.typeCode },
      });
      return [created];
    });

    return this.toAttachmentResponse(attachment);
  }

  async syncDealCopies(
    context: RegistryContext,
    documentId: string,
    dealId: number,
  ) {
    const document = await this.loadEditableDocument(context, documentId);
    const deal = document.deals.find((item) => item.entityId === dealId);
    if (!deal) return { created: 0 };

    const attachments = await this.database
      .select({
        id: registryAttachments.id,
        diskFileId: registryAttachments.diskFileId,
      })
      .from(registryAttachments)
      .where(and(
        eq(registryAttachments.portalUrl, context.portalUrl),
        eq(registryAttachments.documentId, documentId),
        eq(registryAttachments.kind, 'file'),
        eq(registryAttachments.isCurrent, true),
        isNull(registryAttachments.deletedAt),
      ));
    if (!attachments.length) return { created: 0 };
    if (attachments.some((attachment) => !attachment.diskFileId)) {
      throw new ApiError(
        409,
        'attachment_disk_file_missing',
        'Bitrix24 Disk file ID is missing.',
      );
    }

    const attachmentIds = attachments.map((attachment) => attachment.id);
    const existing = await this.database
      .select({ attachmentId: registryAttachmentCopies.attachmentId })
      .from(registryAttachmentCopies)
      .where(and(
        eq(registryAttachmentCopies.portalUrl, context.portalUrl),
        eq(registryAttachmentCopies.dealId, dealId),
        inArray(registryAttachmentCopies.attachmentId, attachmentIds),
        isNull(registryAttachmentCopies.deletedAt),
      ));
    const existingAttachmentIds = new Set(existing.map((copy) => copy.attachmentId));
    const missing = attachments.filter((attachment) => !existingAttachmentIds.has(attachment.id));
    if (!missing.length) return { created: 0 };

    const prepared: Array<PreparedAttachmentCopy & { attachmentId: string }> = [];
    try {
      for (const attachment of missing) {
        prepared.push({
          attachmentId: attachment.id,
          ...await this.copyFileToDeal(context, document, attachment.diskFileId!, deal),
        });
      }
      await this.database.transaction(async (transaction) => {
        await transaction.insert(registryAttachmentCopies).values(prepared.map((copy) => ({
          portalUrl: context.portalUrl,
          attachmentId: copy.attachmentId,
          dealId: copy.dealId,
          dealTitle: copy.dealTitle,
          diskFileId: copy.diskFileId,
          diskFolderId: copy.diskFolderId,
          storagePath: copy.storagePath,
          url: copy.url,
          createdBy: context.userId,
        })));
        await transaction.insert(registryAuditLog).values({
          portalUrl: context.portalUrl,
          documentId,
          event: 'attachment_deal_copies_synced',
          actorId: context.userId,
          metadata: {
            dealId,
            dealTitle: deal.entityTitle,
            attachmentIds: prepared.map((copy) => copy.attachmentId),
            physicalCopyCount: prepared.length,
          },
        });
      });
      return { created: prepared.length };
    } catch (error) {
      const bitrixContext = this.requireBitrixContext(context);
      await Promise.all(prepared.map((copy) => this.bitrix.call(
        bitrixContext.domain,
        bitrixContext.accessToken,
        'disk.file.markdeleted',
        { id: copy.diskFileId },
      ).catch(() => undefined)));
      throw error;
    }
  }

  async initializeFileUpload(
    context: RegistryContext,
    documentId: string,
    input: InitializeFileUploadInput,
  ) {
    const document = await this.loadEditableDocument(context, documentId);
    const bitrixContext = this.requireBitrixContext(context);
    const replacesAttachment = input.replacesAttachmentId
      ? await this.loadReplaceableAttachment(context, documentId, input.replacesAttachmentId)
      : null;
    const dynamicField = await this.resolveDynamicFileField(
      context,
      document,
      input.fieldKey,
      replacesAttachment,
    );
    const folderId = await this.resolveDocumentFolder(context, document);
    const name = this.normalizeFileName(input.name);
    const initialized = await this.bitrix.call<UploadInitialization>(
      bitrixContext.domain,
      bitrixContext.accessToken,
      'disk.folder.uploadfile',
      { id: folderId, data: { NAME: name }, generateUniqueName: true },
    );
    const uploadUrl = initialized.uploadUrl || initialized.UploadUrl;
    const fieldName = initialized.field;
    if (!uploadUrl || !fieldName) {
      throw new ApiError(
        502,
        'bitrix_upload_initialization_invalid',
        'Bitrix24 did not return file upload parameters.',
      );
    }

    this.removeExpiredUploadSessions();
    const id = randomUUID();
    const expiresAt = Date.now() + UPLOAD_SESSION_TTL_MS;
    this.uploadSessions.set(id, {
      id,
      portalUrl: context.portalUrl,
      userId: context.userId,
      documentId,
      folderId,
      name,
      mimeType: input.mimeType || null,
      sizeBytes: input.sizeBytes,
      uploadUrl,
      fieldName,
      fieldDefinitionId: dynamicField?.id ?? null,
      fieldKey: dynamicField?.key ?? null,
      replacesAttachment,
      expiresAt,
    });
    return { uploadId: id, fieldName, name, expiresAt: new Date(expiresAt).toISOString() };
  }

  async uploadFile(
    context: RegistryContext,
    documentId: string,
    uploadId: string,
    body: AsyncIterable<Uint8Array>,
    contentType: string,
    contentLength?: string,
  ) {
    const session = this.uploadSessions.get(uploadId);
    if (!session || session.expiresAt <= Date.now()) {
      this.uploadSessions.delete(uploadId);
      throw new ApiError(410, 'upload_session_expired', 'The file upload session has expired.');
    }
    if (
      session.portalUrl !== context.portalUrl ||
      session.userId !== context.userId ||
      session.documentId !== documentId
    ) {
      throw new ApiError(403, 'upload_session_denied', 'The file upload session is not available.');
    }
    const document = await this.loadEditableDocument(context, documentId);
    const bitrixContext = this.requireBitrixContext(context);
    this.uploadSessions.delete(uploadId);

    const uploaded = await this.bitrix.upload<DiskObject>(
      bitrixContext.domain,
      session.uploadUrl,
      body,
      contentType,
      contentLength,
    );
    const uploadedId = this.positiveInteger(uploaded.ID);
    if (!uploadedId) {
      throw new ApiError(502, 'bitrix_uploaded_file_invalid', 'Bitrix24 returned invalid file metadata.');
    }

    const file = await this.bitrix.call<DiskObject>(
      bitrixContext.domain,
      bitrixContext.accessToken,
      'disk.file.get',
      { id: uploadedId },
    );
    this.assertUploadedFile(file, session);

    let preparedCopies: PreparedAttachmentCopy[] = [];
    try {
      preparedCopies = await this.createDealCopies(
        context,
        document,
        uploadedId,
      );
      const { attachment, copies } = await this.database.transaction(async (transaction) => {
        if (session.replacesAttachment) {
          const replaced = await transaction
            .update(registryAttachments)
            .set({ isCurrent: false })
            .where(
              and(
                eq(registryAttachments.id, session.replacesAttachment.id),
                eq(registryAttachments.portalUrl, context.portalUrl),
                eq(registryAttachments.documentId, documentId),
                eq(registryAttachments.isCurrent, true),
                isNull(registryAttachments.deletedAt),
              ),
            )
            .returning({ id: registryAttachments.id });
          if (!replaced.length) {
            throw new ApiError(
              409,
              'attachment_version_conflict',
              'The attachment was already replaced. Refresh the document and retry.',
            );
          }
        }
        const [created] = await transaction
          .insert(registryAttachments)
          .values({
            portalUrl: context.portalUrl,
            documentId,
            fieldDefinitionId: session.fieldDefinitionId,
            kind: 'file',
            name: this.normalizeFileName(file.NAME),
            mimeType: session.mimeType,
            sizeBytes: this.positiveInteger(file.SIZE) ?? session.sizeBytes,
            diskFileId: uploadedId,
            diskFolderId: session.folderId,
            url: file.DETAIL_URL || null,
            version: session.replacesAttachment
              ? session.replacesAttachment.version + 1
              : 1,
            isPrimary: session.replacesAttachment?.isPrimary ?? false,
            replacesAttachmentId: session.replacesAttachment?.id ?? null,
            createdBy: context.userId,
          })
          .returning();
        const copies = preparedCopies.length
          ? await transaction
              .insert(registryAttachmentCopies)
              .values(preparedCopies.map((copy) => ({
                portalUrl: context.portalUrl,
                attachmentId: created.id,
                dealId: copy.dealId,
                dealTitle: copy.dealTitle,
                diskFileId: copy.diskFileId,
                diskFolderId: copy.diskFolderId,
                storagePath: copy.storagePath,
                url: copy.url,
                createdBy: context.userId,
              })))
              .returning()
          : [];
        if (session.fieldDefinitionId) {
          await transaction
            .insert(registryDocumentFieldValues)
            .values({
              portalUrl: context.portalUrl,
              documentId,
              fieldDefinitionId: session.fieldDefinitionId,
              value: { attachmentId: created.id },
            })
            .onConflictDoUpdate({
              target: [
                registryDocumentFieldValues.portalUrl,
                registryDocumentFieldValues.documentId,
                registryDocumentFieldValues.fieldDefinitionId,
              ],
              set: {
                value: { attachmentId: created.id },
                updatedAt: new Date(),
              },
            });
        }
        await transaction.insert(registryAuditLog).values({
          portalUrl: context.portalUrl,
          documentId,
          event: session.replacesAttachment ? 'attachment_replaced' : 'attachment_added',
          actorId: context.userId,
          before: session.replacesAttachment
            ? this.toAttachmentResponse(session.replacesAttachment)
            : null,
          after: this.toAttachmentResponse(created, session.fieldKey, copies),
          metadata: {
            kind: 'file',
            fieldKey: session.fieldKey,
            dealCopyCount: copies.length,
            dealIds: copies.map((copy) => copy.dealId),
          },
        });
        return { attachment: created, copies };
      });
      return this.toAttachmentResponse(attachment, session.fieldKey, copies);
    } catch (error) {
      await Promise.all([
        uploadedId,
        ...preparedCopies.map((copy) => copy.diskFileId),
      ].map((id) => this.bitrix
        .call(bitrixContext.domain, bitrixContext.accessToken, 'disk.file.markdeleted', { id })
        .catch(() => undefined)));
      throw error;
    }
  }

  async softDelete(context: RegistryContext, documentId: string, attachmentId: string) {
    const document = await this.loadEditableDocument(context, documentId);
    const [attachment] = await this.database
      .select()
      .from(registryAttachments)
      .where(
        and(
          eq(registryAttachments.id, attachmentId),
          eq(registryAttachments.documentId, documentId),
          eq(registryAttachments.portalUrl, context.portalUrl),
          isNull(registryAttachments.deletedAt),
        ),
      )
      .limit(1);
    if (!attachment) {
      throw new ApiError(404, 'attachment_not_found', 'Attachment was not found.');
    }

    let dynamicField: { key: string; isRequired: boolean } | null = null;
    if (attachment.fieldDefinitionId) {
      const [field] = await this.database
        .select({
          key: registryFieldDefinitions.key,
          isRequired: registryTypeFields.isRequired,
        })
        .from(registryTypeFields)
        .innerJoin(
          registryFieldDefinitions,
          eq(registryTypeFields.fieldDefinitionId, registryFieldDefinitions.id),
        )
        .where(
          and(
            eq(registryTypeFields.portalUrl, context.portalUrl),
            eq(registryTypeFields.typeId, document.typeId),
            eq(registryTypeFields.fieldDefinitionId, attachment.fieldDefinitionId),
          ),
        )
        .limit(1);
      dynamicField = field ?? null;
      if (attachment.isCurrent && field?.isRequired) {
        throw new ApiError(
          409,
          'required_file_field_delete_denied',
          'A required file field can only be replaced with another file.',
          { key: field.key },
        );
      }
    }
    if (
      !attachment.fieldDefinitionId
      && attachment.isCurrent
      && document.contentRequired
    ) {
      const otherContent = await this.database
        .select({ id: registryAttachments.id })
        .from(registryAttachments)
        .where(and(
          eq(registryAttachments.portalUrl, context.portalUrl),
          eq(registryAttachments.documentId, documentId),
          eq(registryAttachments.isCurrent, true),
          isNull(registryAttachments.fieldDefinitionId),
          isNull(registryAttachments.deletedAt),
        ))
        .limit(2);
      if (otherContent.length <= 1) {
        throw new ApiError(
          409,
          'document_content_delete_denied',
          'A required file or HTTPS link can only be replaced with other content.',
        );
      }
    }

    const bitrixContext = attachment.kind === 'file'
      ? this.requireBitrixContext(context)
      : null;
    if (attachment.kind === 'file' && !attachment.diskFileId) {
      throw new ApiError(
        409,
        'attachment_disk_file_missing',
        'Bitrix24 Disk file ID is missing.',
      );
    }

    const storageCopies = attachment.kind === 'file'
      ? await this.database
          .select()
          .from(registryAttachmentCopies)
          .where(and(
            eq(registryAttachmentCopies.portalUrl, context.portalUrl),
            eq(registryAttachmentCopies.attachmentId, attachmentId),
            isNull(registryAttachmentCopies.deletedAt),
          ))
      : [];
    const markedFileIds: number[] = [];
    if (bitrixContext && attachment.diskFileId) {
      try {
        for (const diskFileId of [
          attachment.diskFileId,
          ...storageCopies.map((copy) => copy.diskFileId),
        ]) {
          await this.bitrix.call(
            bitrixContext.domain,
            bitrixContext.accessToken,
            'disk.file.markdeleted',
            { id: diskFileId },
          );
          markedFileIds.push(diskFileId);
        }
      } catch (error) {
        await Promise.all(markedFileIds.map((diskFileId) => this.bitrix
          .call(
            bitrixContext.domain,
            bitrixContext.accessToken,
            'disk.file.restore',
            { id: diskFileId },
          )
          .catch(() => undefined)));
        throw error;
      }
    }

    try {
      await this.database.transaction(async (transaction) => {
        const deletedAt = new Date();
        const [deleted] = await transaction
          .update(registryAttachments)
          .set({ deletedAt, isCurrent: false })
          .where(
            and(
              eq(registryAttachments.id, attachmentId),
              eq(registryAttachments.documentId, documentId),
              eq(registryAttachments.portalUrl, context.portalUrl),
              isNull(registryAttachments.deletedAt),
            ),
          )
          .returning({ id: registryAttachments.id });
        if (!deleted) {
          throw new ApiError(409, 'attachment_not_found', 'Attachment was not found.');
        }
        if (storageCopies.length) {
          await transaction
            .update(registryAttachmentCopies)
            .set({ deletedAt })
            .where(and(
              eq(registryAttachmentCopies.portalUrl, context.portalUrl),
              eq(registryAttachmentCopies.attachmentId, attachmentId),
              isNull(registryAttachmentCopies.deletedAt),
            ));
        }
        if (attachment.fieldDefinitionId && attachment.isCurrent) {
          await transaction
            .delete(registryDocumentFieldValues)
            .where(
              and(
                eq(registryDocumentFieldValues.portalUrl, context.portalUrl),
                eq(registryDocumentFieldValues.documentId, documentId),
                eq(
                  registryDocumentFieldValues.fieldDefinitionId,
                  attachment.fieldDefinitionId,
                ),
              ),
            );
        }
        await transaction.insert(registryAuditLog).values({
          portalUrl: context.portalUrl,
          documentId,
          event: 'attachment_deleted',
          actorId: context.userId,
          before: this.toAttachmentResponse(attachment, dynamicField?.key, storageCopies),
        });
      });
    } catch (error) {
      if (bitrixContext && markedFileIds.length) {
        await Promise.all(markedFileIds.map((diskFileId) => this.bitrix.call(
            bitrixContext.domain,
            bitrixContext.accessToken,
            'disk.file.restore',
            { id: diskFileId },
          )
          .catch((restoreError) => {
            logger.error(
              {
                error: restoreError,
                portalUrl: context.portalUrl,
                documentId,
                attachmentId,
                diskFileId,
              },
              'Could not restore a Bitrix24 Disk file after attachment delete rollback',
            );
          })));
      }
      throw error;
    }
  }

  async getAccess(context: RegistryContext, documentId: string, attachmentId: string) {
    await this.loadVisibleDocument(context, documentId);
    const [attachment] = await this.database
      .select({
        kind: registryAttachments.kind,
        url: registryAttachments.url,
        diskFileId: registryAttachments.diskFileId,
      })
      .from(registryAttachments)
      .where(
        and(
          eq(registryAttachments.id, attachmentId),
          eq(registryAttachments.documentId, documentId),
          eq(registryAttachments.portalUrl, context.portalUrl),
          isNull(registryAttachments.deletedAt),
        ),
      )
      .limit(1);
    if (!attachment) {
      throw new ApiError(404, 'attachment_not_found', 'Attachment was not found.');
    }
    if (attachment.kind === 'link') {
      if (!attachment.url) {
        throw new ApiError(409, 'attachment_url_missing', 'Attachment URL is missing.');
      }
      return { kind: 'link' as const, url: attachment.url };
    }

    const bitrixContext = this.requireBitrixContext(context);
    if (!attachment.diskFileId) {
      throw new ApiError(409, 'attachment_disk_file_missing', 'Bitrix24 Disk file ID is missing.');
    }
    const file = await this.bitrix.call<DiskObject>(
      bitrixContext.domain,
      bitrixContext.accessToken,
      'disk.file.get',
      { id: attachment.diskFileId },
    );
    if (file.TYPE !== 'file' || String(file.DELETED_TYPE ?? '0') !== '0') {
      throw new ApiError(404, 'bitrix_file_not_available', 'Bitrix24 Disk file is not available.');
    }
    const detailUrl = this.bitrixFileUrl(file.DETAIL_URL, bitrixContext.domain);
    const downloadUrl = this.bitrixFileUrl(file.DOWNLOAD_URL, bitrixContext.domain);
    const url = detailUrl || downloadUrl;
    if (!url) {
      throw new ApiError(502, 'bitrix_file_url_missing', 'Bitrix24 did not return a file URL.');
    }
    return { kind: 'file' as const, url, downloadUrl };
  }

  private loadEditableDocument(context: RegistryContext, documentId: string) {
    return this.loadDocument(context, documentId, true);
  }

  private async loadReplaceableAttachment(
    context: RegistryContext,
    documentId: string,
    attachmentId: string,
  ) {
    const [attachment] = await this.database
      .select()
      .from(registryAttachments)
      .where(
        and(
          eq(registryAttachments.id, attachmentId),
          eq(registryAttachments.portalUrl, context.portalUrl),
          eq(registryAttachments.documentId, documentId),
          eq(registryAttachments.kind, 'file'),
          eq(registryAttachments.isCurrent, true),
          isNull(registryAttachments.deletedAt),
        ),
      )
      .limit(1);
    if (!attachment) {
      throw new ApiError(
        404,
        'replaceable_attachment_not_found',
        'A current file attachment to replace was not found.',
      );
    }
    return attachment;
  }

  private async resolveDynamicFileField(
    context: RegistryContext,
    document: Awaited<ReturnType<AttachmentsService['loadEditableDocument']>>,
    requestedKey: string | undefined,
    replacesAttachment: typeof registryAttachments.$inferSelect | null,
  ) {
    const requested = requestedKey?.trim() || null;
    const fieldDefinitionId = replacesAttachment?.fieldDefinitionId ?? null;
    if (!requested && !fieldDefinitionId) return null;

    const conditions = [
      eq(registryTypeFields.portalUrl, context.portalUrl),
      eq(registryTypeFields.typeId, document.typeId),
      eq(registryFieldDefinitions.portalUrl, context.portalUrl),
      eq(registryFieldDefinitions.isActive, true),
      eq(registryFieldDefinitions.dataType, 'file'),
    ];
    if (requested) {
      conditions.push(eq(registryFieldDefinitions.key, requested));
    } else if (fieldDefinitionId) {
      conditions.push(eq(registryFieldDefinitions.id, fieldDefinitionId));
    }
    const [field] = await this.database
      .select({
        id: registryFieldDefinitions.id,
        key: registryFieldDefinitions.key,
        dataType: registryFieldDefinitions.dataType,
      })
      .from(registryTypeFields)
      .innerJoin(
        registryFieldDefinitions,
        eq(registryTypeFields.fieldDefinitionId, registryFieldDefinitions.id),
      )
      .where(and(...conditions))
      .limit(1);
    if (!field) {
      throw new ApiError(
        400,
        'document_file_field_invalid',
        'The requested file field is not available for this document type.',
        { key: requested },
      );
    }
    if (fieldDefinitionId && field.id !== fieldDefinitionId) {
      throw new ApiError(
        409,
        'attachment_field_mismatch',
        'A file version must remain linked to the same document field.',
        { key: field.key },
      );
    }
    const policy = await loadRegistryPolicy(this.database, context);
    if (isDocumentFieldHidden(policy, field, document.typeCode)) {
      throw new ApiError(
        403,
        'document_fields_access_denied',
        'The requested document field is hidden for this role.',
        { keys: [field.key] },
      );
    }

    if (!replacesAttachment) {
      const [current] = await this.database
        .select({ id: registryAttachments.id })
        .from(registryAttachments)
        .where(
          and(
            eq(registryAttachments.portalUrl, context.portalUrl),
            eq(registryAttachments.documentId, document.id),
            eq(registryAttachments.fieldDefinitionId, field.id),
            eq(registryAttachments.isCurrent, true),
            isNull(registryAttachments.deletedAt),
          ),
        )
        .limit(1);
      if (current) {
        throw new ApiError(
          409,
          'document_file_field_occupied',
          'The file field already contains a file. Replace its current version instead.',
          { key: field.key, attachmentId: current.id },
        );
      }
    }
    return field;
  }

  private loadVisibleDocument(context: RegistryContext, documentId: string) {
    return this.loadDocument(context, documentId, false, true);
  }

  private async loadDocument(
    context: RegistryContext,
    documentId: string,
    requireEdit: boolean,
    includeArchived = false,
  ) {
    const policy = await loadRegistryPolicy(this.database, context);
    const crmEntityScope = await this.crmEntityAccess.prepare(context);
    const salesDealScope = await this.salesDealAccess.prepare(context);
    const [document] = await this.database
      .select({
        id: registryDocuments.id,
        createdBy: registryDocuments.createdBy,
        responsibleId: registryDocuments.responsibleId,
        status: registryDocuments.status,
        deletedAt: registryDocuments.deletedAt,
        counterpartyId: registryDocuments.counterpartyId,
        counterpartyName: registryDocuments.counterpartyName,
        typeId: registryDocuments.typeId,
        sectionCode: registrySections.code,
        sectionName: registrySections.name,
        typeCode: registryDocumentTypes.code,
        contentRequired: registryDocumentTypes.contentRequired,
      })
      .from(registryDocuments)
      .innerJoin(registrySections, eq(registryDocuments.sectionId, registrySections.id))
      .innerJoin(registryDocumentTypes, eq(registryDocuments.typeId, registryDocumentTypes.id))
      .where(and(
        eq(registryDocuments.id, documentId),
        eq(registryDocuments.portalUrl, context.portalUrl),
        ...(crmEntityScope ? [crmEntityScope] : []),
        ...(salesDealScope ? [salesDealScope] : []),
        ...(includeArchived ? [] : [isNull(registryDocuments.deletedAt)]),
      ))
      .limit(1);
    if (!document) {
      throw new ApiError(404, 'document_not_found', 'Document was not found.');
    }
    assertSectionVisible(policy, document.sectionCode);
    assertTypeVisible(policy, document.typeCode);
    if (requireEdit) {
      if (document.deletedAt || document.status === 'archived') {
        throw new ApiError(
          409,
          'document_archived_read_only',
          'Archived documents are read-only.',
        );
      }
      assertTypePermission(policy, document.typeCode, 'content');
      this.assertCanEdit(policy, context, document);
    }

    const deals = await this.database
      .select({
        entityId: registryDocumentLinks.entityId,
        entityTitle: registryDocumentLinks.entityTitle,
      })
      .from(registryDocumentLinks)
      .where(
        and(
          eq(registryDocumentLinks.portalUrl, context.portalUrl),
          eq(registryDocumentLinks.documentId, documentId),
          eq(registryDocumentLinks.entityType, 'deal'),
        ),
      )
      .orderBy(asc(registryDocumentLinks.createdAt));
    return { ...document, deals };
  }

  private assertCanEdit(
    policy: RegistryPolicy,
    context: RegistryContext,
    document: { createdBy: number; responsibleId: number },
  ) {
    const own =
      document.createdBy === context.userId || document.responsibleId === context.userId;
    if (!policy.permissions.editAny && !(policy.permissions.editOwn && own)) {
      throw new ApiError(403, 'edit_access_denied', 'Document editing is not allowed.');
    }
  }

  private requireBitrixContext(context: RegistryContext) {
    if (!context.bitrix) {
      throw new ApiError(
        409,
        'bitrix_disk_session_required',
        'File uploads require an authenticated Bitrix24 session.',
      );
    }
    return context.bitrix;
  }

  private async resolveDocumentFolder(
    context: RegistryContext,
    document: Awaited<ReturnType<AttachmentsService['loadEditableDocument']>>,
  ) {
    const bitrixContext = this.requireBitrixContext(context);
    const rootFolderId = await this.loadRootFolderId(context.portalUrl);
    const companyName = this.folderName(
      document.counterpartyName || 'Без компании',
      document.counterpartyId,
    );
    const sectionName = this.normalizeFolderName(document.sectionName);

    const companyFolderId = await this.ensureFolder(
      context.portalUrl,
      bitrixContext.domain,
      bitrixContext.accessToken,
      rootFolderId,
      companyName,
    );
    const dealFolderId = await this.ensureFolder(
      context.portalUrl,
      bitrixContext.domain,
      bitrixContext.accessToken,
      companyFolderId,
      'Без сделки',
    );
    return this.ensureFolder(
      context.portalUrl,
      bitrixContext.domain,
      bitrixContext.accessToken,
      dealFolderId,
      sectionName,
    );
  }

  private async resolveDealFolder(
    context: RegistryContext,
    document: Awaited<ReturnType<AttachmentsService['loadEditableDocument']>>,
    deal: { entityId: number; entityTitle: string },
  ) {
    const bitrixContext = this.requireBitrixContext(context);
    const rootFolderId = await this.loadRootFolderId(context.portalUrl);
    const companyName = this.folderName(
      document.counterpartyName || 'Без компании',
      document.counterpartyId,
    );
    const dealName = this.folderName(deal.entityTitle, deal.entityId);
    const sectionName = this.normalizeFolderName(document.sectionName);
    const companyFolderId = await this.ensureFolder(
      context.portalUrl,
      bitrixContext.domain,
      bitrixContext.accessToken,
      rootFolderId,
      companyName,
    );
    const dealFolderId = await this.ensureFolder(
      context.portalUrl,
      bitrixContext.domain,
      bitrixContext.accessToken,
      companyFolderId,
      dealName,
    );
    const folderId = await this.ensureFolder(
      context.portalUrl,
      bitrixContext.domain,
      bitrixContext.accessToken,
      dealFolderId,
      sectionName,
    );
    return {
      folderId,
      path: [companyName, dealName, sectionName].join(' / '),
    };
  }

  private async createDealCopies(
    context: RegistryContext,
    document: Awaited<ReturnType<AttachmentsService['loadEditableDocument']>>,
    sourceFileId: number,
  ) {
    const bitrixContext = this.requireBitrixContext(context);
    const copies: PreparedAttachmentCopy[] = [];
    try {
      for (const deal of document.deals) {
        copies.push(await this.copyFileToDeal(context, document, sourceFileId, deal));
      }
      return copies;
    } catch (error) {
      await Promise.all(copies.map((copy) => this.bitrix
        .call(
          bitrixContext.domain,
          bitrixContext.accessToken,
          'disk.file.markdeleted',
          { id: copy.diskFileId },
        )
        .catch(() => undefined)));
      throw error;
    }
  }

  private async copyFileToDeal(
    context: RegistryContext,
    document: Awaited<ReturnType<AttachmentsService['loadEditableDocument']>>,
    sourceFileId: number,
    deal: { entityId: number; entityTitle: string },
  ): Promise<PreparedAttachmentCopy> {
    const bitrixContext = this.requireBitrixContext(context);
    const target = await this.resolveDealFolder(context, document, deal);
    const copied = await this.bitrix.call<DiskObject>(
      bitrixContext.domain,
      bitrixContext.accessToken,
      'disk.file.copyto',
      { id: sourceFileId, targetFolderId: target.folderId },
    );
    const diskFileId = this.positiveInteger(copied.ID);
    const parentId = this.positiveInteger(copied.PARENT_ID);
    if (
      !diskFileId
      || copied.TYPE !== 'file'
      || parentId !== target.folderId
      || String(copied.DELETED_TYPE ?? '0') !== '0'
    ) {
      throw new ApiError(
        502,
        'bitrix_file_copy_invalid',
        'Bitrix24 returned invalid metadata for a copied file.',
      );
    }
    return {
      dealId: deal.entityId,
      dealTitle: deal.entityTitle,
      diskFileId,
      diskFolderId: target.folderId,
      storagePath: target.path,
      url: this.bitrixFileUrl(
        copied.DETAIL_URL || copied.DOWNLOAD_URL,
        bitrixContext.domain,
      ),
    };
  }

  private async loadRootFolderId(portalUrl: string) {
    const [setting] = await this.database
      .select({ value: registrySettings.value })
      .from(registrySettings)
      .where(
        and(
          eq(registrySettings.portalUrl, portalUrl),
          eq(registrySettings.key, ROOT_FOLDER_SETTING),
        ),
      )
      .limit(1);
    const value = setting?.value;
    const id = this.positiveInteger(
      value && typeof value === 'object' && 'id' in value
        ? (value as { id: unknown }).id
        : value,
    );
    if (!id) {
      throw new ApiError(
        409,
        'bitrix_disk_root_not_configured',
        'Bitrix24 Disk root folder is not configured for this portal.',
      );
    }
    return id;
  }

  private async ensureFolder(
    portalUrl: string,
    domain: string,
    accessToken: string,
    parentId: number,
    name: string,
  ) {
    const cacheKey = this.folderCacheKey(parentId, name);
    const memoryKey = `${portalUrl}\0${cacheKey}`;
    const memoryId = this.folderCache.get(memoryKey);
    if (memoryId) return memoryId;

    const [cached] = await this.database
      .select({ value: registrySettings.value })
      .from(registrySettings)
      .where(
        and(
          eq(registrySettings.portalUrl, portalUrl),
          eq(registrySettings.key, cacheKey),
        ),
      )
      .limit(1);
    const cachedId = this.positiveInteger(
      cached?.value && typeof cached.value === 'object' && 'id' in cached.value
        ? (cached.value as { id: unknown }).id
        : null,
    );
    if (cachedId) {
      this.folderCache.set(memoryKey, cachedId);
      return cachedId;
    }

    let folder = await this.findFolder(domain, accessToken, parentId, name);
    if (!folder) {
      try {
        folder = await this.bitrix.call<DiskObject>(
          domain,
          accessToken,
          'disk.folder.addsubfolder',
          { id: parentId, data: { NAME: name } },
        );
      } catch (error) {
        folder = await this.findFolder(domain, accessToken, parentId, name);
        if (!folder) throw error;
      }
    }
    const folderId = this.positiveInteger(folder.ID);
    if (!folderId || folder.TYPE !== 'folder') {
      throw new ApiError(502, 'bitrix_folder_invalid', 'Bitrix24 returned invalid folder metadata.');
    }

    await this.database
      .insert(registrySettings)
      .values({
        portalUrl,
        key: cacheKey,
        value: { id: folderId, parentId, name },
      })
      .onConflictDoUpdate({
        target: [registrySettings.portalUrl, registrySettings.key],
        set: { value: { id: folderId, parentId, name }, updatedAt: new Date() },
      });
    this.folderCache.set(memoryKey, folderId);
    return folderId;
  }

  private async findFolder(
    domain: string,
    accessToken: string,
    parentId: number,
    name: string,
  ) {
    const children = await this.bitrix.call<DiskObject[]>(
      domain,
      accessToken,
      'disk.folder.getchildren',
      { id: parentId, filter: { NAME: name, TYPE: 'folder' } },
    );
    return children.find((item) => item.TYPE === 'folder' && item.NAME === name) || null;
  }

  private assertUploadedFile(file: DiskObject, session: UploadSession) {
    const parentId = this.positiveInteger(file.PARENT_ID);
    const size = this.positiveInteger(file.SIZE) ?? 0;
    if (
      file.TYPE !== 'file' ||
      parentId !== session.folderId ||
      String(file.DELETED_TYPE ?? '0') !== '0' ||
      size !== session.sizeBytes
    ) {
      throw new ApiError(
        502,
        'bitrix_uploaded_file_mismatch',
        'Uploaded file metadata does not match the requested upload.',
      );
    }
  }

  private toAttachmentResponse(
    attachment: typeof registryAttachments.$inferSelect,
    fieldKey?: string | null,
    copies: Array<typeof registryAttachmentCopies.$inferSelect> = [],
  ) {
    return {
      id: attachment.id,
      kind: attachment.kind,
      name: attachment.name,
      mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes,
      diskFileId: attachment.diskFileId,
      url: attachment.url,
      version: attachment.version,
      isPrimary: attachment.isPrimary,
      isCurrent: attachment.isCurrent,
      replacesAttachmentId: attachment.replacesAttachmentId,
      fieldKey: fieldKey ?? null,
      storageCopies: copies.map((copy) => ({
        id: copy.id,
        dealId: copy.dealId,
        dealTitle: copy.dealTitle,
        diskFileId: copy.diskFileId,
        diskFolderId: copy.diskFolderId,
        storagePath: copy.storagePath,
        url: copy.url,
        createdAt: copy.createdAt,
      })),
      createdBy: attachment.createdBy,
      createdAt: attachment.createdAt,
    };
  }

  private folderCacheKey(parentId: number, name: string) {
    const digest = createHash('sha256').update(name).digest('hex').slice(0, 24);
    return `${FOLDER_CACHE_PREFIX}${parentId}:${digest}`;
  }

  private folderName(name: string, id: number | null) {
    return this.normalizeFolderName(id ? `${name} [${id}]` : name);
  }

  private normalizeFolderName(value: string) {
    const normalized = value
      .replace(/[\u0000-\u001f\u007f\\/:*?"<>|]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120);
    return normalized || 'Без названия';
  }

  private normalizeFileName(value: string) {
    const name = value.replace(/\\/g, '/').split('/').pop() || '';
    const normalized = name.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 255);
    if (!normalized || normalized === '.' || normalized === '..') {
      throw new ApiError(400, 'file_name_invalid', 'File name is invalid.');
    }
    return normalized;
  }

  private normalizeDisplayName(value: string) {
    const normalized = value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 255);
    if (!normalized) {
      throw new ApiError(400, 'attachment_name_invalid', 'Attachment name is invalid.');
    }
    return normalized;
  }

  private positiveInteger(value: unknown) {
    const number = typeof value === 'number' ? value : Number(value);
    return Number.isSafeInteger(number) && number > 0 ? number : null;
  }

  private bitrixFileUrl(value: string | undefined, domain: string) {
    if (!value) return null;
    try {
      const url = new URL(value);
      if (
        url.protocol !== 'https:' ||
        url.hostname.toLowerCase() !== domain ||
        url.username ||
        url.password
      ) {
        return null;
      }
      return url.toString();
    } catch {
      return null;
    }
  }

  private removeExpiredUploadSessions() {
    const now = Date.now();
    for (const [id, session] of this.uploadSessions) {
      if (session.expiresAt <= now) this.uploadSessions.delete(id);
    }
  }
}
