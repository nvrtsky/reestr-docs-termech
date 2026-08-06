import { createHash } from 'node:crypto';

import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  ilike,
  inArray,
  isNotNull,
  isNull,
  lte,
  ne,
  notInArray,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';

import type { BitrixApiClient } from '../bitrix/bitrix-client.js';
import { AttachmentsService } from '../attachments/attachments.service.js';
import type { Database } from '../db/database.js';
import {
  registryAttachments,
  registryAttachmentCopies,
  registryAuditLog,
  registryBulkUploadItems,
  registryDocumentFieldValues,
  registryDocumentLinks,
  registryDocumentRelations,
  registryDocuments,
  registryDocumentTypeSections,
  registryDocumentTypes,
  registryFieldDefinitions,
  registryLifecycles,
  registrySections,
  registryTaskLinks,
  registryTypeFields,
} from '../db/schema/index.js';
import { ApiError } from '../http/api-error.js';
import type { RegistryContext } from '../http/registry-context.js';
import { logger } from '../logger.js';
import { BitrixNotificationsService } from '../notifications/bitrix-notifications.service.js';
import { CrmEntityAccessService } from '../permissions/crm-entity-access.service.js';
import { SalesDealAccessService } from '../permissions/sales-deal-access.service.js';
import {
  assertSectionVisible,
  assertTypePermission,
  assertTypeVisible,
  isDocumentFieldHidden,
  isMoneyHidden,
  isTypePermissionGranted,
  loadRegistryPolicy,
  type RegistryPolicy,
} from '../permissions/policy.service.js';
import type {
  AddDocumentLinkInput,
  AddTaskLinkInput,
  BulkAssignDocumentsInput,
  BulkDeleteDocumentsInput,
  BulkRestoreDocumentsInput,
  CreateDocumentInput,
  DocumentListQuery,
  SetParentRelationInput,
  UpdateDocumentInput,
} from './documents.schemas.js';
import {
  DocumentNumberingService,
  isDocumentNumberConflict,
} from './document-numbering.service.js';

interface DocumentsServiceDependencies {
  database: Database;
  bitrix: BitrixApiClient;
}

export interface DocumentEntityReference {
  entityType: 'deal' | 'company';
  entityId: number;
}

interface BulkUploadCreateOptions {
  idempotencyKey: string;
  clientRowId: string;
}

interface ArchiveParticipants {
  cardCreatorId: number;
  fileUploaderIds: number[];
  recipientIds: number[];
}

interface ArchiveNotificationDocument {
  id: string;
  number: string | null;
  title: string;
  responsibleId: number;
}

export function resolveLegacyArchiveRestoreStatus(
  events: Array<{ before: unknown; after: unknown }>,
  lifecycleConfig: {
    initialStatus: string;
    states: Array<{ code: string; terminal?: boolean }>;
  },
) {
  for (const event of events) {
    const before = event.before as { status?: unknown } | null;
    const after = event.after as { status?: unknown } | null;
    if (
      after?.status === 'archived'
      && typeof before?.status === 'string'
      && before.status !== 'archived'
      && lifecycleConfig.states.some((state) => state.code === before.status)
    ) {
      return before.status;
    }
  }
  if (
    lifecycleConfig.initialStatus
    && lifecycleConfig.initialStatus !== 'archived'
    && lifecycleConfig.states.some((state) => state.code === lifecycleConfig.initialStatus)
  ) {
    return lifecycleConfig.initialStatus;
  }
  return lifecycleConfig.states.find((state) => state.code !== 'archived')?.code || 'draft';
}

export class DocumentsService {
  private readonly numbering = new DocumentNumberingService();
  private readonly attachments: AttachmentsService;

  constructor(
    private readonly database: Database,
    private readonly bitrix: BitrixApiClient,
    private readonly notifications: BitrixNotificationsService,
    private readonly crmEntityAccess: CrmEntityAccessService,
    private readonly salesDealAccess: SalesDealAccessService,
  ) {
    this.attachments = new AttachmentsService(database, bitrix);
  }

  async list(
    context: RegistryContext,
    query: DocumentListQuery,
    documentIds?: string[],
  ) {
    const policy = await loadRegistryPolicy(this.database, context);
    const accessScopes = await this.prepareAccessScopes(context);
    const allowedSections = query.sections.length
      ? query.sections.filter((code) => policy.visibleSectionCodes.includes(code))
      : policy.visibleSectionCodes;

    if (allowedSections.length === 0 || documentIds?.length === 0) {
      return { items: [], meta: { total: 0, limit: query.limit, offset: query.offset } };
    }

    const conditions: SQL[] = [
      eq(registryDocuments.portalUrl, context.portalUrl),
      query.deleted === 'only'
        ? or(
            isNotNull(registryDocuments.deletedAt),
            eq(registryDocuments.status, 'archived'),
          )!
        : and(
            isNull(registryDocuments.deletedAt),
            ne(registryDocuments.status, 'archived'),
          )!,
      inArray(registrySections.code, allowedSections),
    ];
    conditions.push(...accessScopes);
    if (documentIds) {
      conditions.push(inArray(registryDocuments.id, documentIds));
    }

    if (query.statuses.length) {
      conditions.push(inArray(registryDocuments.status, query.statuses));
    }
    if (query.view === 'mine') {
      conditions.push(eq(registryDocuments.responsibleId, context.userId));
    } else if (query.view === 'work') {
      conditions.push(inArray(registryDocuments.status, ['awaiting', 'on_review']));
    } else if (query.view === 'draft') {
      conditions.push(eq(registryDocuments.status, 'draft'));
    }
    if (query.type) {
      conditions.push(eq(registryDocumentTypes.code, query.type));
    }
    if (policy.visibleTypeCodes) {
      conditions.push(inArray(registryDocumentTypes.code, policy.visibleTypeCodes));
    }
    const hiddenTypeCodes = Object.entries(policy.permissions.byType ?? {})
      .filter(([, permissions]) => permissions.view === false)
      .map(([typeCode]) => typeCode);
    if (hiddenTypeCodes.length) {
      conditions.push(notInArray(registryDocumentTypes.code, hiddenTypeCodes));
    }
    if (query.responsibleId) {
      conditions.push(eq(registryDocuments.responsibleId, query.responsibleId));
    }
    if (query.counterparty) {
      conditions.push(
        ilike(registryDocuments.counterpartyName, `%${query.counterparty}%`),
      );
    }
    if (query.from) {
      conditions.push(gte(registryDocuments.documentDate, query.from));
    }
    if (query.to) {
      conditions.push(lte(registryDocuments.documentDate, query.to));
    }
    const dynamicFilters = Object.entries(query.fieldFilters ?? {});
    if (dynamicFilters.length) {
      const definitions = await this.database
        .select({
          key: registryFieldDefinitions.key,
          dataType: registryFieldDefinitions.dataType,
        })
        .from(registryFieldDefinitions)
        .where(
          and(
            eq(registryFieldDefinitions.portalUrl, context.portalUrl),
            eq(registryFieldDefinitions.isActive, true),
            inArray(registryFieldDefinitions.key, dynamicFilters.map(([key]) => key)),
          ),
        );
      const definitionByKey = new Map(definitions.map((item) => [item.key, item]));
      const unknown = dynamicFilters
        .map(([key]) => key)
        .filter((key) => !definitionByKey.has(key));
      if (unknown.length) {
        throw new ApiError(400, 'unknown_document_fields', 'Unknown dynamic field filters.', { keys: unknown });
      }
      const forbidden = definitions
        .filter((field) => isDocumentFieldHidden(policy, field, query.type))
        .map((field) => field.key);
      if (forbidden.length) {
        throw new ApiError(403, 'document_fields_access_denied', 'Dynamic field filters are hidden for this role.', { keys: forbidden });
      }
      for (const [key, value] of dynamicFilters) {
        conditions.push(sql`exists (
          select 1
          from registry_document_field_values as dynamic_value
          inner join registry_field_definitions as dynamic_field
            on dynamic_field.id = dynamic_value.field_definition_id
          where dynamic_value.portal_url = ${context.portalUrl}
            and dynamic_value.document_id = ${registryDocuments.id}
            and dynamic_field.portal_url = ${context.portalUrl}
            and dynamic_field.key = ${key}
            and dynamic_value.value #>> '{}' ilike ${`%${String(value)}%`}
        )`);
      }
    }
    if (query.search) {
      conditions.push(
        or(
          ilike(registryDocuments.number, `%${query.search}%`),
          ilike(registryDocuments.title, `%${query.search}%`),
          ilike(registryDocuments.counterpartyName, `%${query.search}%`),
          ilike(registryDocumentTypes.name, `%${query.search}%`),
        )!,
      );
    }

    const where = and(...conditions)!;
    const baseSelection = {
      id: registryDocuments.id,
      number: registryDocuments.number,
      title: registryDocuments.title,
      documentDate: registryDocuments.documentDate,
      uploadedAt: registryDocuments.uploadedAt,
      amount: registryDocuments.amount,
      currency: registryDocuments.currency,
      legalEntityId: registryDocuments.legalEntityId,
      legalEntityName: registryDocuments.legalEntityName,
      counterpartyId: registryDocuments.counterpartyId,
      counterpartyName: registryDocuments.counterpartyName,
      dealStageId: registryDocuments.dealStageId,
      status: registryDocuments.status,
      comment: registryDocuments.comment,
      responsibleId: registryDocuments.responsibleId,
      responsibleName: registryDocuments.responsibleName,
      createdBy: registryDocuments.createdBy,
      createdAt: registryDocuments.createdAt,
      updatedAt: registryDocuments.updatedAt,
      externalSource: registryDocuments.externalSource,
      externalEntityTypeId: registryDocuments.externalEntityTypeId,
      externalEntityId: registryDocuments.externalEntityId,
      externalStatus: registryDocuments.externalStatus,
      externalUpdatedAt: registryDocuments.externalUpdatedAt,
      externalSyncedAt: registryDocuments.externalSyncedAt,
      deletedAt: registryDocuments.deletedAt,
      deletedBy: registryDocuments.deletedBy,
      supersedesId: registryDocuments.supersedesId,
      sectionCode: registrySections.code,
      sectionName: registrySections.name,
      sectionColor: registrySections.color,
      typeCode: registryDocumentTypes.code,
      typeName: registryDocumentTypes.name,
      isFinancial: registryDocumentTypes.isFinancial,
    };

    const [rows, [totalRow]] = await Promise.all([
      this.database
        .select(baseSelection)
        .from(registryDocuments)
        .innerJoin(
          registrySections,
          eq(registryDocuments.sectionId, registrySections.id),
        )
        .innerJoin(
          registryDocumentTypes,
          eq(registryDocuments.typeId, registryDocumentTypes.id),
        )
        .where(where)
        .orderBy(desc(registryDocuments.documentDate), desc(registryDocuments.createdAt))
        .limit(query.limit)
        .offset(query.offset),
      this.database
        .select({ value: count(registryDocuments.id) })
        .from(registryDocuments)
        .innerJoin(
          registrySections,
          eq(registryDocuments.sectionId, registrySections.id),
        )
        .innerJoin(
          registryDocumentTypes,
          eq(registryDocuments.typeId, registryDocumentTypes.id),
        )
        .where(where),
    ]);

    const fieldRows = rows.length
      ? await this.database
          .select({
            documentId: registryDocumentFieldValues.documentId,
            key: registryFieldDefinitions.key,
            label: registryFieldDefinitions.label,
            dataType: registryFieldDefinitions.dataType,
            value: registryDocumentFieldValues.value,
          })
          .from(registryDocumentFieldValues)
          .innerJoin(
            registryFieldDefinitions,
            eq(registryDocumentFieldValues.fieldDefinitionId, registryFieldDefinitions.id),
          )
          .where(
            and(
              eq(registryDocumentFieldValues.portalUrl, context.portalUrl),
              eq(registryFieldDefinitions.portalUrl, context.portalUrl),
              eq(registryFieldDefinitions.isActive, true),
              inArray(registryDocumentFieldValues.documentId, rows.map((row) => row.id)),
            ),
          )
      : [];
    const typeCodeByDocument = new Map(rows.map((row) => [row.id, row.typeCode]));
    const fieldsByDocument = new Map<string, typeof fieldRows>();
    for (const field of fieldRows) {
      if (isDocumentFieldHidden(policy, field, typeCodeByDocument.get(field.documentId))) continue;
      const current = fieldsByDocument.get(field.documentId) ?? [];
      current.push(field);
      fieldsByDocument.set(field.documentId, current);
    }
    const relationsByDocument = await this.loadRelationsForDocuments(
      context,
      rows.map((row) => row.id),
      policy,
      accessScopes,
    );
    return {
      items: rows.map((row) => ({
        ...this.toResponse(row, policy),
        fields: (fieldsByDocument.get(row.id) ?? []).map(({ documentId: _documentId, ...field }) => field),
        relations: relationsByDocument.get(row.id) ?? { parent: null, children: [] },
      })),
      meta: { total: totalRow?.value ?? 0, limit: query.limit, offset: query.offset },
    };
  }

  async listOptions(context: RegistryContext) {
    const policy = await loadRegistryPolicy(this.database, context);
    const accessScopes = await this.prepareAccessScopes(context);
    if (policy.visibleSectionCodes.length === 0) {
      return {
        scopeTotal: 0,
        archiveTotal: 0,
        sections: {},
        views: { all: 0, mine: 0, work: 0, draft: 0 },
        responsibles: [],
      };
    }

    const visibleConditions: SQL[] = [
      eq(registryDocuments.portalUrl, context.portalUrl),
      inArray(registrySections.code, policy.visibleSectionCodes),
    ];
    visibleConditions.push(...accessScopes);
    if (policy.visibleTypeCodes) {
      visibleConditions.push(inArray(registryDocumentTypes.code, policy.visibleTypeCodes));
    }
    const hiddenTypeCodes = Object.entries(policy.permissions.byType ?? {})
      .filter(([, permissions]) => permissions.view === false)
      .map(([typeCode]) => typeCode);
    if (hiddenTypeCodes.length) {
      visibleConditions.push(notInArray(registryDocumentTypes.code, hiddenTypeCodes));
    }
    const activeScope = and(
      ...visibleConditions,
      isNull(registryDocuments.deletedAt),
      ne(registryDocuments.status, 'archived'),
    )!;
    const archiveScope = and(
      ...visibleConditions,
      or(
        isNotNull(registryDocuments.deletedAt),
        eq(registryDocuments.status, 'archived'),
      )!,
    )!;
    const countDocuments = async (scope: SQL, extra?: SQL) => {
      const [row] = await this.database
        .select({ value: count(registryDocuments.id) })
        .from(registryDocuments)
        .innerJoin(registrySections, eq(registryDocuments.sectionId, registrySections.id))
        .innerJoin(
          registryDocumentTypes,
          eq(registryDocuments.typeId, registryDocumentTypes.id),
        )
        .where(extra ? and(scope, extra) : scope);
      return row?.value ?? 0;
    };

    const [sectionRows, responsibleRows, all, mine, work, draft, archiveTotal] = await Promise.all([
      this.database
        .select({
          code: registrySections.code,
          value: count(registryDocuments.id),
        })
        .from(registryDocuments)
        .innerJoin(registrySections, eq(registryDocuments.sectionId, registrySections.id))
        .innerJoin(
          registryDocumentTypes,
          eq(registryDocuments.typeId, registryDocumentTypes.id),
        )
        .where(activeScope)
        .groupBy(registrySections.code),
      this.database
        .select({
          id: registryDocuments.responsibleId,
          name: registryDocuments.responsibleName,
          value: count(registryDocuments.id),
        })
        .from(registryDocuments)
        .innerJoin(registrySections, eq(registryDocuments.sectionId, registrySections.id))
        .innerJoin(
          registryDocumentTypes,
          eq(registryDocuments.typeId, registryDocumentTypes.id),
        )
        .where(activeScope)
        .groupBy(registryDocuments.responsibleId, registryDocuments.responsibleName)
        .orderBy(asc(registryDocuments.responsibleName), asc(registryDocuments.responsibleId)),
      countDocuments(activeScope),
      countDocuments(activeScope, eq(registryDocuments.responsibleId, context.userId)),
      countDocuments(activeScope, inArray(registryDocuments.status, ['awaiting', 'on_review'])),
      countDocuments(activeScope, eq(registryDocuments.status, 'draft')),
      countDocuments(archiveScope),
    ]);

    const sections = Object.fromEntries(
      policy.visibleSectionCodes.map((code) => [code, 0]),
    ) as Record<string, number>;
    for (const row of sectionRows) sections[row.code] = row.value;

    return {
      scopeTotal: all,
      archiveTotal,
      sections,
      views: { all, mine, work, draft },
      responsibles: responsibleRows.map((row) => ({
        id: row.id,
        name: row.name || `Пользователь #${row.id}`,
        count: row.value,
      })),
    };
  }

  async listLinked(
    context: RegistryContext,
    query: DocumentListQuery,
    references: DocumentEntityReference[],
  ) {
    if (!references.length) return this.list(context, query, []);
    const referenceConditions = references.map((reference) =>
      and(
        eq(registryDocumentLinks.entityType, reference.entityType),
        eq(registryDocumentLinks.entityId, reference.entityId),
      )!,
    );
    const rows = await this.database
      .selectDistinct({ documentId: registryDocumentLinks.documentId })
      .from(registryDocumentLinks)
      .where(
        and(
          eq(registryDocumentLinks.portalUrl, context.portalUrl),
          or(...referenceConditions),
        ),
      );
    const result = await this.list(context, query, rows.map((row) => row.documentId));
    if (!result.items.length) return result;
    const documentIds = result.items.map((item) => item.id);
    const linkRows = await this.database
      .select()
      .from(registryDocumentLinks)
      .where(
        and(
          eq(registryDocumentLinks.portalUrl, context.portalUrl),
          inArray(registryDocumentLinks.documentId, documentIds),
        ),
      )
      .orderBy(asc(registryDocumentLinks.createdAt));
    const linksByDocument = new Map<string, typeof linkRows>();
    for (const link of linkRows) {
      const links = linksByDocument.get(link.documentId) || [];
      links.push(link);
      linksByDocument.set(link.documentId, links);
    }
    return {
      ...result,
      items: result.items.map((item) => ({
        ...item,
        links: linksByDocument.get(item.id) || [],
      })),
    };
  }

  async addLink(
    context: RegistryContext,
    documentId: string,
    input: AddDocumentLinkInput & { entityTitle: string },
  ) {
    const policy = await loadRegistryPolicy(this.database, context);
    const current = await this.loadDocumentForWrite(context, documentId);
    assertSectionVisible(policy, current.sectionCode);
    assertTypeVisible(policy, current.typeCode);
    this.assertCanEdit(policy, context, current);

    let insertedLinkId: string | null = null;
    await this.database.transaction(async (transaction) => {
      const inserted = await transaction
        .insert(registryDocumentLinks)
        .values({
          portalUrl: context.portalUrl,
          documentId,
          entityType: input.entityType,
          entityId: input.entityId,
          entityTitle: input.entityTitle,
          linkRole: input.linkRole ?? null,
        })
        .onConflictDoNothing()
        .returning({ id: registryDocumentLinks.id });
      if (!inserted.length) return;
      insertedLinkId = inserted[0].id;
      await transaction.insert(registryAuditLog).values({
        portalUrl: context.portalUrl,
        documentId,
        event: 'link_added',
        actorId: context.userId,
        after: {
          linkId: inserted[0].id,
          entityType: input.entityType,
          entityId: input.entityId,
          entityTitle: input.entityTitle,
          linkRole: input.linkRole ?? null,
        },
      });
    });

    if (input.entityType === 'deal') {
      try {
        await this.attachments.syncDealCopies(context, documentId, input.entityId);
      } catch (error) {
        if (insertedLinkId) {
          await this.database.transaction(async (transaction) => {
            await transaction.delete(registryDocumentLinks).where(and(
              eq(registryDocumentLinks.id, insertedLinkId!),
              eq(registryDocumentLinks.portalUrl, context.portalUrl),
              eq(registryDocumentLinks.documentId, documentId),
            ));
            await transaction.insert(registryAuditLog).values({
              portalUrl: context.portalUrl,
              documentId,
              event: 'link_add_rolled_back',
              actorId: context.userId,
              metadata: {
                linkId: insertedLinkId,
                entityType: input.entityType,
                entityId: input.entityId,
                reason: 'physical_copy_sync_failed',
              },
            });
          }).catch(() => undefined);
        }
        throw error;
      }
    }

    return this.getById(context, documentId);
  }

  async removeLink(
    context: RegistryContext,
    documentId: string,
    linkId: string,
  ) {
    const policy = await loadRegistryPolicy(this.database, context);
    const current = await this.loadDocumentForWrite(context, documentId);
    assertSectionVisible(policy, current.sectionCode);
    assertTypeVisible(policy, current.typeCode);
    this.assertCanEdit(policy, context, current);

    const [link] = await this.database
      .select()
      .from(registryDocumentLinks)
      .where(and(
        eq(registryDocumentLinks.id, linkId),
        eq(registryDocumentLinks.portalUrl, context.portalUrl),
        eq(registryDocumentLinks.documentId, documentId),
      ))
      .limit(1);
    if (!link) {
      throw new ApiError(404, 'document_link_not_found', 'Document link was not found.');
    }
    const dealCopies = link.entityType === 'deal'
      ? await this.database
          .select({
            id: registryAttachmentCopies.id,
            diskFileId: registryAttachmentCopies.diskFileId,
          })
          .from(registryAttachmentCopies)
          .innerJoin(
            registryAttachments,
            eq(registryAttachmentCopies.attachmentId, registryAttachments.id),
          )
          .where(and(
            eq(registryAttachmentCopies.portalUrl, context.portalUrl),
            eq(registryAttachments.documentId, documentId),
            eq(registryAttachmentCopies.dealId, link.entityId),
            isNull(registryAttachmentCopies.deletedAt),
          ))
      : [];
    const bitrixContext = dealCopies.length ? context.bitrix : null;
    if (dealCopies.length && !bitrixContext) {
      throw new ApiError(
        409,
        'bitrix_disk_session_required',
        'Deal copy cleanup requires an authenticated Bitrix24 session.',
      );
    }
    const markedFileIds: number[] = [];
    try {
      for (const copy of dealCopies) {
        await this.bitrix.call(
          bitrixContext!.domain,
          bitrixContext!.accessToken,
          'disk.file.markdeleted',
          { id: copy.diskFileId },
        );
        markedFileIds.push(copy.diskFileId);
      }
    } catch (error) {
      if (bitrixContext) {
        await Promise.all(markedFileIds.map((diskFileId) => this.bitrix.call(
          bitrixContext.domain,
          bitrixContext.accessToken,
          'disk.file.restore',
          { id: diskFileId },
        ).catch(() => undefined)));
      }
      throw error;
    }

    try {
      await this.database.transaction(async (transaction) => {
      const [removed] = await transaction
        .delete(registryDocumentLinks)
        .where(
          and(
            eq(registryDocumentLinks.id, linkId),
            eq(registryDocumentLinks.portalUrl, context.portalUrl),
            eq(registryDocumentLinks.documentId, documentId),
          ),
        )
        .returning();
      if (!removed) {
        throw new ApiError(404, 'document_link_not_found', 'Document link was not found.');
      }
      if (dealCopies.length) {
        await transaction
          .update(registryAttachmentCopies)
          .set({ deletedAt: new Date() })
          .where(inArray(registryAttachmentCopies.id, dealCopies.map((copy) => copy.id)));
      }
      await transaction.insert(registryAuditLog).values({
        portalUrl: context.portalUrl,
        documentId,
        event: 'link_removed',
        actorId: context.userId,
        before: removed,
        metadata: { physicalCopyCount: dealCopies.length },
      });
      });
    } catch (error) {
      if (bitrixContext) {
        await Promise.all(markedFileIds.map((diskFileId) => this.bitrix.call(
          bitrixContext.domain,
          bitrixContext.accessToken,
          'disk.file.restore',
          { id: diskFileId },
        ).catch(() => undefined)));
      }
      throw error;
    }

    return this.getById(context, documentId);
  }

  async removeLinkById(context: RegistryContext, linkId: string) {
    const [link] = await this.database
      .select({ documentId: registryDocumentLinks.documentId })
      .from(registryDocumentLinks)
      .where(
        and(
          eq(registryDocumentLinks.id, linkId),
          eq(registryDocumentLinks.portalUrl, context.portalUrl),
        ),
      )
      .limit(1);
    if (!link) {
      throw new ApiError(404, 'document_link_not_found', 'Document link was not found.');
    }
    return this.removeLink(context, link.documentId, linkId);
  }

  async setParentRelation(
    context: RegistryContext,
    childDocumentId: string,
    input: SetParentRelationInput,
  ) {
    if (childDocumentId === input.parentDocumentId) {
      throw new ApiError(
        400,
        'document_relation_self_reference',
        'A document cannot be related to itself.',
      );
    }

    const policy = await loadRegistryPolicy(this.database, context);
    const [knownRelation] = await this.database
      .select()
      .from(registryDocumentRelations)
      .where(and(
        eq(registryDocumentRelations.portalUrl, context.portalUrl),
        eq(registryDocumentRelations.childDocumentId, childDocumentId),
      ))
      .limit(1);
    const documentIds = new Set([
      childDocumentId,
      input.parentDocumentId,
      ...(knownRelation ? [knownRelation.parentDocumentId] : []),
    ]);
    const documents = await Promise.all(
      [...documentIds].map((id) => this.loadDocumentForWrite(context, id)),
    );
    for (const document of documents) {
      assertSectionVisible(policy, document.sectionCode);
      assertTypeVisible(policy, document.typeCode);
      this.assertCanEdit(policy, context, document);
    }

    await this.database.transaction(async (transaction) => {
      await transaction.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`registry-relations:${context.portalUrl}`}))`,
      );
      const [currentRelation] = await transaction
        .select()
        .from(registryDocumentRelations)
        .where(and(
          eq(registryDocumentRelations.portalUrl, context.portalUrl),
          eq(registryDocumentRelations.childDocumentId, childDocumentId),
        ))
        .limit(1);
      if (
        (currentRelation?.id ?? null) !== (knownRelation?.id ?? null)
        || (currentRelation?.parentDocumentId ?? null) !== (knownRelation?.parentDocumentId ?? null)
      ) {
        throw new ApiError(
          409,
          'document_relation_changed',
          'The document relation changed while it was being edited.',
        );
      }
      if (
        currentRelation?.parentDocumentId === input.parentDocumentId
        && currentRelation.relationType === input.relationType
      ) return;

      let cursor: string | null = input.parentDocumentId;
      const visited = new Set<string>();
      while (cursor) {
        if (cursor === childDocumentId) {
          throw new ApiError(
            409,
            'document_relation_cycle',
            'Document relations cannot contain a cycle.',
          );
        }
        if (visited.has(cursor)) {
          throw new ApiError(
            409,
            'document_relation_cycle',
            'Document relations cannot contain a cycle.',
          );
        }
        visited.add(cursor);
        const [ancestor] = await transaction
          .select({ parentDocumentId: registryDocumentRelations.parentDocumentId })
          .from(registryDocumentRelations)
          .where(and(
            eq(registryDocumentRelations.portalUrl, context.portalUrl),
            eq(registryDocumentRelations.childDocumentId, cursor),
          ))
          .limit(1);
        cursor = ancestor?.parentDocumentId ?? null;
      }

      if (currentRelation) {
        await transaction
          .delete(registryDocumentRelations)
          .where(eq(registryDocumentRelations.id, currentRelation.id));
      }
      const [created] = await transaction
        .insert(registryDocumentRelations)
        .values({
          portalUrl: context.portalUrl,
          parentDocumentId: input.parentDocumentId,
          childDocumentId,
          relationType: input.relationType,
          createdBy: context.userId,
        })
        .returning();

      await transaction.insert(registryAuditLog).values({
        portalUrl: context.portalUrl,
        documentId: childDocumentId,
        event: currentRelation ? 'relation_parent_changed' : 'relation_parent_added',
        actorId: context.userId,
        before: currentRelation ?? null,
        after: created,
      });
      if (currentRelation) {
        await transaction.insert(registryAuditLog).values({
          portalUrl: context.portalUrl,
          documentId: currentRelation.parentDocumentId,
          event: 'relation_child_removed',
          actorId: context.userId,
          before: currentRelation,
        });
      }
      await transaction.insert(registryAuditLog).values({
        portalUrl: context.portalUrl,
        documentId: input.parentDocumentId,
        event: 'relation_child_added',
        actorId: context.userId,
        after: created,
      });
    });

    return this.getById(context, childDocumentId);
  }

  async removeParentRelation(context: RegistryContext, childDocumentId: string) {
    const policy = await loadRegistryPolicy(this.database, context);
    const [relation] = await this.database
      .select()
      .from(registryDocumentRelations)
      .where(and(
        eq(registryDocumentRelations.portalUrl, context.portalUrl),
        eq(registryDocumentRelations.childDocumentId, childDocumentId),
      ))
      .limit(1);
    if (!relation) {
      throw new ApiError(
        404,
        'document_relation_not_found',
        'The document does not have a parent relation.',
      );
    }
    const documents = await Promise.all([
      this.loadDocumentForWrite(context, childDocumentId),
      this.loadDocumentForWrite(context, relation.parentDocumentId),
    ]);
    for (const document of documents) {
      assertSectionVisible(policy, document.sectionCode);
      assertTypeVisible(policy, document.typeCode);
      this.assertCanEdit(policy, context, document);
    }

    await this.database.transaction(async (transaction) => {
      const [removed] = await transaction
        .delete(registryDocumentRelations)
        .where(and(
          eq(registryDocumentRelations.id, relation.id),
          eq(registryDocumentRelations.portalUrl, context.portalUrl),
          eq(registryDocumentRelations.childDocumentId, childDocumentId),
        ))
        .returning();
      if (!removed) {
        throw new ApiError(
          409,
          'document_relation_changed',
          'The document relation changed while it was being edited.',
        );
      }
      await transaction.insert(registryAuditLog).values([
        {
          portalUrl: context.portalUrl,
          documentId: childDocumentId,
          event: 'relation_parent_removed',
          actorId: context.userId,
          before: removed,
        },
        {
          portalUrl: context.portalUrl,
          documentId: removed.parentDocumentId,
          event: 'relation_child_removed',
          actorId: context.userId,
          before: removed,
        },
      ]);
    });
    return this.getById(context, childDocumentId);
  }

  async addTaskLink(
    context: RegistryContext,
    documentId: string,
    input: AddTaskLinkInput & { taskTitle: string },
  ) {
    const policy = await loadRegistryPolicy(this.database, context);
    const current = await this.loadDocumentForWrite(context, documentId);
    assertSectionVisible(policy, current.sectionCode);
    assertTypeVisible(policy, current.typeCode);
    this.assertCanEdit(policy, context, current);

    await this.database.transaction(async (transaction) => {
      const inserted = await transaction
        .insert(registryTaskLinks)
        .values({
          portalUrl: context.portalUrl,
          documentId,
          taskId: input.taskId,
          taskTitle: input.taskTitle,
        })
        .onConflictDoNothing()
        .returning({ id: registryTaskLinks.id });
      if (!inserted.length) return;
      await transaction.insert(registryAuditLog).values({
        portalUrl: context.portalUrl,
        documentId,
        event: 'task_link_added',
        actorId: context.userId,
        after: {
          taskLinkId: inserted[0].id,
          taskId: input.taskId,
          taskTitle: input.taskTitle,
        },
      });
    });
    return this.getById(context, documentId);
  }

  async removeTaskLink(
    context: RegistryContext,
    documentId: string,
    taskLinkId: string,
  ) {
    const policy = await loadRegistryPolicy(this.database, context);
    const current = await this.loadDocumentForWrite(context, documentId);
    assertSectionVisible(policy, current.sectionCode);
    assertTypeVisible(policy, current.typeCode);
    this.assertCanEdit(policy, context, current);

    await this.database.transaction(async (transaction) => {
      const [removed] = await transaction
        .delete(registryTaskLinks)
        .where(and(
          eq(registryTaskLinks.id, taskLinkId),
          eq(registryTaskLinks.portalUrl, context.portalUrl),
          eq(registryTaskLinks.documentId, documentId),
        ))
        .returning();
      if (!removed) {
        throw new ApiError(404, 'task_link_not_found', 'Task link was not found.');
      }
      await transaction.insert(registryAuditLog).values({
        portalUrl: context.portalUrl,
        documentId,
        event: 'task_link_removed',
        actorId: context.userId,
        before: removed,
      });
    });
    return this.getById(context, documentId);
  }

  async getById(context: RegistryContext, id: string, deletedOnly = false) {
    const policy = await loadRegistryPolicy(this.database, context);
    const accessScopes = await this.prepareAccessScopes(context);
    const [row] = await this.database
      .select({
        id: registryDocuments.id,
        number: registryDocuments.number,
        title: registryDocuments.title,
        documentDate: registryDocuments.documentDate,
        uploadedAt: registryDocuments.uploadedAt,
        amount: registryDocuments.amount,
        currency: registryDocuments.currency,
        legalEntityId: registryDocuments.legalEntityId,
        legalEntityName: registryDocuments.legalEntityName,
        counterpartyId: registryDocuments.counterpartyId,
        counterpartyName: registryDocuments.counterpartyName,
        dealStageId: registryDocuments.dealStageId,
        status: registryDocuments.status,
        comment: registryDocuments.comment,
        responsibleId: registryDocuments.responsibleId,
        responsibleName: registryDocuments.responsibleName,
        createdBy: registryDocuments.createdBy,
        createdAt: registryDocuments.createdAt,
        updatedAt: registryDocuments.updatedAt,
        externalSource: registryDocuments.externalSource,
        externalEntityTypeId: registryDocuments.externalEntityTypeId,
        externalEntityId: registryDocuments.externalEntityId,
        externalStatus: registryDocuments.externalStatus,
        externalUpdatedAt: registryDocuments.externalUpdatedAt,
        externalSyncedAt: registryDocuments.externalSyncedAt,
        deletedAt: registryDocuments.deletedAt,
        deletedBy: registryDocuments.deletedBy,
        supersedesId: registryDocuments.supersedesId,
        sectionCode: registrySections.code,
        sectionName: registrySections.name,
        sectionColor: registrySections.color,
        internalTypeId: registryDocuments.typeId,
        typeCode: registryDocumentTypes.code,
        typeName: registryDocumentTypes.name,
        isFinancial: registryDocumentTypes.isFinancial,
      })
      .from(registryDocuments)
      .innerJoin(registrySections, eq(registryDocuments.sectionId, registrySections.id))
      .innerJoin(
        registryDocumentTypes,
        eq(registryDocuments.typeId, registryDocumentTypes.id),
      )
      .where(
        and(
          eq(registryDocuments.id, id),
          eq(registryDocuments.portalUrl, context.portalUrl),
          ...accessScopes,
          deletedOnly
            ? or(
                isNotNull(registryDocuments.deletedAt),
                eq(registryDocuments.status, 'archived'),
              )!
            : and(
                isNull(registryDocuments.deletedAt),
                ne(registryDocuments.status, 'archived'),
              )!,
        ),
      )
      .limit(1);

    if (!row) {
      throw new ApiError(404, 'document_not_found', 'Document was not found.');
    }
    assertSectionVisible(policy, row.sectionCode);
    assertTypeVisible(policy, row.typeCode);

    const [attachments, storageCopies, links, taskLinks, rawFieldValues, history] = await Promise.all([
      this.database
        .select({
          id: registryAttachments.id,
          kind: registryAttachments.kind,
          name: registryAttachments.name,
          mimeType: registryAttachments.mimeType,
          sizeBytes: registryAttachments.sizeBytes,
          diskFileId: registryAttachments.diskFileId,
          url: registryAttachments.url,
          version: registryAttachments.version,
          isPrimary: registryAttachments.isPrimary,
          isCurrent: registryAttachments.isCurrent,
          replacesAttachmentId: registryAttachments.replacesAttachmentId,
          fieldKey: registryFieldDefinitions.key,
          createdBy: registryAttachments.createdBy,
          createdAt: registryAttachments.createdAt,
        })
        .from(registryAttachments)
        .leftJoin(
          registryFieldDefinitions,
          eq(registryAttachments.fieldDefinitionId, registryFieldDefinitions.id),
        )
        .where(
          and(
            eq(registryAttachments.portalUrl, context.portalUrl),
            eq(registryAttachments.documentId, id),
            isNull(registryAttachments.deletedAt),
          ),
        )
        .orderBy(desc(registryAttachments.createdAt)),
      this.database
        .select({
          id: registryAttachmentCopies.id,
          attachmentId: registryAttachmentCopies.attachmentId,
          dealId: registryAttachmentCopies.dealId,
          dealTitle: registryAttachmentCopies.dealTitle,
          diskFileId: registryAttachmentCopies.diskFileId,
          diskFolderId: registryAttachmentCopies.diskFolderId,
          storagePath: registryAttachmentCopies.storagePath,
          url: registryAttachmentCopies.url,
          createdAt: registryAttachmentCopies.createdAt,
        })
        .from(registryAttachmentCopies)
        .innerJoin(
          registryAttachments,
          eq(registryAttachmentCopies.attachmentId, registryAttachments.id),
        )
        .where(and(
          eq(registryAttachmentCopies.portalUrl, context.portalUrl),
          eq(registryAttachments.portalUrl, context.portalUrl),
          eq(registryAttachments.documentId, id),
          isNull(registryAttachmentCopies.deletedAt),
          isNull(registryAttachments.deletedAt),
        ))
        .orderBy(asc(registryAttachmentCopies.dealTitle)),
      this.database
        .select()
        .from(registryDocumentLinks)
        .where(
          and(
            eq(registryDocumentLinks.portalUrl, context.portalUrl),
            eq(registryDocumentLinks.documentId, id),
          ),
        )
        .orderBy(asc(registryDocumentLinks.createdAt)),
      this.database
        .select()
        .from(registryTaskLinks)
        .where(and(
          eq(registryTaskLinks.portalUrl, context.portalUrl),
          eq(registryTaskLinks.documentId, id),
        ))
        .orderBy(asc(registryTaskLinks.createdAt)),
      this.database
        .select({
          key: registryFieldDefinitions.key,
          defaultLabel: registryFieldDefinitions.label,
          labelOverride: registryTypeFields.labelOverride,
          dataType: registryFieldDefinitions.dataType,
          value: registryDocumentFieldValues.value,
          sortOrder: registryTypeFields.sortOrder,
        })
        .from(registryDocumentFieldValues)
        .innerJoin(
          registryFieldDefinitions,
          eq(
            registryDocumentFieldValues.fieldDefinitionId,
            registryFieldDefinitions.id,
          ),
        )
        .innerJoin(
          registryTypeFields,
          and(
            eq(registryTypeFields.portalUrl, context.portalUrl),
            eq(registryTypeFields.typeId, row.internalTypeId),
            eq(
              registryTypeFields.fieldDefinitionId,
              registryFieldDefinitions.id,
            ),
          ),
        )
        .where(
          and(
            eq(registryDocumentFieldValues.portalUrl, context.portalUrl),
            eq(registryDocumentFieldValues.documentId, id),
          ),
        )
        .orderBy(asc(registryTypeFields.sortOrder)),
      this.database
        .select()
        .from(registryAuditLog)
        .where(
          and(
            eq(registryAuditLog.portalUrl, context.portalUrl),
            eq(registryAuditLog.documentId, id),
          ),
        )
        .orderBy(desc(registryAuditLog.createdAt))
        .limit(100),
    ]);

    const fieldValues = rawFieldValues
      .filter((field) => !isDocumentFieldHidden(policy, field, row.typeCode))
      .map((field) => ({
        key: field.key,
        label: field.labelOverride || field.defaultLabel,
        dataType: field.dataType,
        value: field.value,
      }));
    const relationsByDocument = await this.loadRelationsForDocuments(
      context,
      [id],
      policy,
      accessScopes,
    );
    const dealStates = await this.salesDealAccess.documentStates(context, id);
    const resolvedLinks = links.map((link) => {
      if (link.entityType !== 'deal') return link;
      const state = dealStates.get(link.entityId);
      return state ? { ...link, ...state } : link;
    });
    const storageCopiesByAttachment = new Map<string, typeof storageCopies>();
    for (const copy of storageCopies) {
      const current = storageCopiesByAttachment.get(copy.attachmentId) ?? [];
      current.push(copy);
      storageCopiesByAttachment.set(copy.attachmentId, current);
    }
    return {
      ...this.toResponse(row, policy),
      attachments: attachments.map((attachment) => ({
        ...attachment,
        storageCopies: (storageCopiesByAttachment.get(attachment.id) ?? [])
          .map(({ attachmentId: _attachmentId, ...copy }) => copy),
      })),
      links: resolvedLinks,
      taskLinks,
      fields: fieldValues,
      history: history.map((entry) => this.sanitizeAuditEntry(entry, policy, row.typeCode)),
      relations: relationsByDocument.get(id) ?? { parent: null, children: [] },
    };
  }

  async create(
    context: RegistryContext,
    input: CreateDocumentInput,
    bulkUpload?: BulkUploadCreateOptions,
  ) {
    const bulkRequestHash = bulkUpload
      ? createHash('sha256').update(JSON.stringify(input)).digest('hex')
      : null;
    if (bulkUpload && bulkRequestHash) {
      const [existing] = await this.database
        .select({
          requestHash: registryBulkUploadItems.requestHash,
          status: registryBulkUploadItems.status,
          documentId: registryBulkUploadItems.documentId,
        })
        .from(registryBulkUploadItems)
        .where(and(
          eq(registryBulkUploadItems.portalUrl, context.portalUrl),
          eq(registryBulkUploadItems.createdBy, context.userId),
          eq(registryBulkUploadItems.idempotencyKey, bulkUpload.idempotencyKey),
        ))
        .limit(1);
      if (existing) {
        if (existing.requestHash !== bulkRequestHash) {
          throw new ApiError(
            409,
            'bulk_upload_idempotency_conflict',
            'The bulk upload idempotency key was already used for another payload.',
          );
        }
        if (existing.status === 'ready' && existing.documentId) {
          return this.getById(context, existing.documentId);
        }
        throw new ApiError(
          409,
          'bulk_upload_in_progress',
          'This bulk upload row is already being processed.',
        );
      }
    }
    const policy = await loadRegistryPolicy(this.database, context);
    const typeConfig = await this.loadTypeConfiguration(
      context,
      input.sectionCode,
      input.typeCode,
    );
    assertSectionVisible(policy, typeConfig.sectionCode);
    assertTypeVisible(policy, typeConfig.typeCode);
    if (!isTypePermissionGranted(
      policy,
      typeConfig.typeCode,
      'create',
      policy.permissions.create,
    )) {
      throw new ApiError(403, 'create_access_denied', 'Document creation is not allowed.');
    }
    if (typeConfig.isFinancial && isMoneyHidden(policy, typeConfig.typeCode)) {
      throw new ApiError(
        403,
        'financial_document_create_denied',
        'A role with hidden financial fields cannot create financial documents.',
      );
    }
    if (isMoneyHidden(policy, typeConfig.typeCode) && (input.amount !== undefined || input.currency !== undefined)) {
      throw new ApiError(
        403,
        'financial_fields_access_denied',
        'Financial fields are hidden for this role.',
      );
    }
    this.assertFinancialFields(typeConfig.isFinancial, input.amount, input.currency);
    await this.validateFieldValues(
      context,
      typeConfig.typeId,
      typeConfig.typeCode,
      input.fields,
      true,
      policy,
    );

    const initialStatus = typeConfig.lifecycleConfig.initialStatus;
    const requestedStatus = input.status || initialStatus;
    if (!typeConfig.lifecycleConfig.states.some((state) => state.code === requestedStatus)) {
      throw new ApiError(400, 'document_status_not_found', 'Document status was not found in the selected lifecycle.');
    }
    if (requestedStatus !== initialStatus) {
      this.assertCanTransition(policy, context, {
        createdBy: context.userId,
        responsibleId: input.responsibleId ?? context.userId,
        typeCode: typeConfig.typeCode,
      });
      if (requestedStatus === 'archived' && !isTypePermissionGranted(
        policy,
        typeConfig.typeCode,
        'archive',
        policy.permissions.softDelete,
      )) {
        throw new ApiError(403, 'delete_access_denied', 'Document archiving is not allowed.');
      }
      const initialTransition = typeConfig.lifecycleConfig.transitions.find(
        (transition) => transition.from === initialStatus && transition.to === requestedStatus,
      );
      if (!initialTransition) {
        throw new ApiError(
          409,
          'initial_status_transition_not_allowed',
          `Transition ${initialStatus} -> ${requestedStatus} is not allowed during creation.`,
        );
      }
      if (initialTransition.roles && !initialTransition.roles.includes(policy.roleCode)) {
        throw new ApiError(403, 'transition_role_denied', 'Role cannot select this initial document status.');
      }
      if (initialTransition.requiresAttachment) {
        throw new ApiError(
          409,
          'initial_status_attachment_required',
          'This status can only be selected after the document attachment has been uploaded.',
        );
      }
    }

    const superseded = input.supersedesId
      ? await this.loadDocumentForWrite(context, input.supersedesId)
      : null;
    if (superseded) {
      assertSectionVisible(policy, superseded.sectionCode);
      assertTypeVisible(policy, superseded.typeCode);
      this.assertCanEdit(policy, context, superseded);
      if (!isTypePermissionGranted(
        policy,
        superseded.typeCode,
        'archive',
        policy.permissions.softDelete,
      )) {
        throw new ApiError(403, 'delete_access_denied', 'Document archiving is not allowed.');
      }
      if (
        superseded.sectionCode !== typeConfig.sectionCode
        || superseded.typeCode !== typeConfig.typeCode
      ) {
        throw new ApiError(
          409,
          'superseded_document_type_mismatch',
          'A new document revision must have the same section and type.',
        );
      }
      if (!superseded.lifecycleConfig.states.some((state) => state.code === 'archived')) {
        throw new ApiError(
          409,
          'superseded_document_archive_unavailable',
          'The document lifecycle does not contain the archived status.',
        );
      }
      const [existingRevision] = await this.database
        .select({ id: registryDocuments.id })
        .from(registryDocuments)
        .where(
          and(
            eq(registryDocuments.portalUrl, context.portalUrl),
            eq(registryDocuments.supersedesId, superseded.id),
            isNull(registryDocuments.deletedAt),
          ),
        )
        .limit(1);
      if (existingRevision) {
        throw new ApiError(
          409,
          'document_already_superseded',
          'A newer revision of this document already exists.',
        );
      }
    }

    let documentId: string;
    try {
      documentId = await this.database.transaction(async (transaction) => {
      if (bulkUpload && bulkRequestHash) {
        const [reservation] = await transaction
          .insert(registryBulkUploadItems)
          .values({
            portalUrl: context.portalUrl,
            createdBy: context.userId,
            idempotencyKey: bulkUpload.idempotencyKey,
            clientRowId: bulkUpload.clientRowId,
            requestHash: bulkRequestHash,
          })
          .onConflictDoNothing()
          .returning({ id: registryBulkUploadItems.id });
        if (!reservation) {
          throw new ApiError(
            409,
            'bulk_upload_in_progress',
            'This bulk upload row is already being processed.',
          );
        }
      }
      const resolvedNumber = await this.numbering.resolve(
        transaction as unknown as Database,
        typeConfig,
        {
          portalUrl: context.portalUrl,
          number: input.number,
          documentDate: input.documentDate,
          counterpartyId: input.counterpartyId,
        },
      );
      const [document] = await transaction
        .insert(registryDocuments)
        .values({
          portalUrl: context.portalUrl,
          sectionId: typeConfig.sectionId,
          typeId: typeConfig.typeId,
          number: resolvedNumber.number,
          numberUniquenessKey: resolvedNumber.numberUniquenessKey,
          title: input.title,
          documentDate: input.documentDate,
          amount: input.amount ?? null,
          currency: input.currency ?? null,
          legalEntityId: input.legalEntityId ?? null,
          legalEntityName: input.legalEntityName ?? null,
          counterpartyId: input.counterpartyId ?? null,
          counterpartyName: input.counterpartyName ?? null,
          dealStageId: input.dealStageId ?? null,
          status: requestedStatus,
          comment: input.comment ?? null,
          responsibleId: input.responsibleId ?? context.userId,
          responsibleName: input.responsibleName ?? null,
          createdBy: context.userId,
          supersedesId: superseded?.id ?? null,
        })
        .returning({ id: registryDocuments.id });

      if (input.links.length) {
        await transaction.insert(registryDocumentLinks).values(
          input.links.map((link) => ({
            portalUrl: context.portalUrl,
            documentId: document.id,
            entityType: link.entityType,
            entityId: link.entityId,
            entityTitle: link.entityTitle,
            linkRole: link.linkRole ?? null,
          })),
        );
      }

      if (input.taskLinks.length) {
        await transaction.insert(registryTaskLinks).values(
          input.taskLinks.map((link) => ({
            portalUrl: context.portalUrl,
            documentId: document.id,
            taskId: link.taskId,
            taskTitle: link.taskTitle!,
          })),
        );
      }

      await this.upsertFieldValues(
        transaction as unknown as Database,
        context,
        document.id,
        typeConfig.typeId,
        input.fields,
      );

      await transaction.insert(registryAuditLog).values({
        portalUrl: context.portalUrl,
        documentId: document.id,
        event: 'document_created',
        actorId: context.userId,
        after: {
          ...input,
          number: resolvedNumber.number,
          sectionCode: typeConfig.sectionCode,
          typeCode: typeConfig.typeCode,
          status: requestedStatus,
        },
        metadata: superseded || bulkUpload
          ? {
              ...(superseded ? { supersedesId: superseded.id } : {}),
              ...(bulkUpload ? {
                bulkUpload: true,
                bulkClientRowId: bulkUpload.clientRowId,
                bulkIdempotencyKey: bulkUpload.idempotencyKey,
              } : {}),
            }
          : null,
      });

      if (bulkUpload) {
        await transaction
          .update(registryBulkUploadItems)
          .set({
            documentId: document.id,
            status: 'ready',
            updatedAt: new Date(),
          })
          .where(and(
            eq(registryBulkUploadItems.portalUrl, context.portalUrl),
            eq(registryBulkUploadItems.createdBy, context.userId),
            eq(registryBulkUploadItems.idempotencyKey, bulkUpload.idempotencyKey),
          ));
      }

      if (superseded) {
        await transaction
          .update(registryDocuments)
          .set({
            status: 'archived',
            updatedBy: context.userId,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(registryDocuments.id, superseded.id),
              eq(registryDocuments.portalUrl, context.portalUrl),
              isNull(registryDocuments.deletedAt),
            ),
          );
        await transaction.insert(registryAuditLog).values({
          portalUrl: context.portalUrl,
          documentId: superseded.id,
          event: 'document_superseded',
          actorId: context.userId,
          before: { status: superseded.status },
          after: { status: 'archived', supersededById: document.id },
        });
      }

      return document.id;
      });
    } catch (error) {
      if (isDocumentNumberConflict(error)) {
        throw new ApiError(
          409,
          'document_number_conflict',
          'Документ с таким номером уже существует для выбранных типа и компании.',
        );
      }
      throw error;
    }

    const created = await this.getById(context, documentId);
    await this.notifications.responsibleAssigned(context, created);
    return created;
  }

  async update(
    context: RegistryContext,
    id: string,
    input: UpdateDocumentInput,
  ) {
    const policy = await loadRegistryPolicy(this.database, context);
    const current = await this.loadDocumentForWrite(context, id);
    assertSectionVisible(policy, current.sectionCode);
    assertTypeVisible(policy, current.typeCode);
    this.assertCanEdit(policy, context, current);

    if (isMoneyHidden(policy, current.typeCode) && (input.amount !== undefined || input.currency !== undefined)) {
      throw new ApiError(
        403,
        'financial_fields_access_denied',
        'Financial fields are hidden for this role.',
      );
    }

    const { fields, ...coreInput } = input;
    const updates = Object.fromEntries(
      Object.entries(coreInput).filter(([, value]) => value !== undefined),
    ) as Partial<typeof registryDocuments.$inferInsert>;
    updates.updatedBy = context.userId;
    updates.updatedAt = new Date();

    this.assertFinancialFields(
      current.isFinancial,
      input.amount === undefined ? current.amount : input.amount,
      input.currency === undefined ? current.currency : input.currency,
    );
    if (fields) {
      await this.validateFieldValues(
        context,
        current.typeId,
        current.typeCode,
        fields,
        false,
        policy,
      );
    }

    try {
      await this.database.transaction(async (transaction) => {
      if (
        input.number !== undefined
        || input.documentDate !== undefined
        || input.counterpartyId !== undefined
      ) {
        const resolvedNumber = await this.numbering.resolve(
          transaction as unknown as Database,
          current,
          {
            portalUrl: context.portalUrl,
            number: input.number === undefined ? current.number : input.number,
            documentDate: input.documentDate === undefined
              ? current.documentDate
              : input.documentDate,
            counterpartyId: input.counterpartyId === undefined
              ? current.counterpartyId
              : input.counterpartyId,
          },
        );
        updates.number = resolvedNumber.number;
        updates.numberUniquenessKey = resolvedNumber.numberUniquenessKey;
      }
      await transaction
        .update(registryDocuments)
        .set(updates)
        .where(
          and(
            eq(registryDocuments.id, id),
            eq(registryDocuments.portalUrl, context.portalUrl),
            isNull(registryDocuments.deletedAt),
          ),
        );

      if (fields) {
        await this.upsertFieldValues(
          transaction as unknown as Database,
          context,
          id,
          current.typeId,
          fields,
        );
      }

      await transaction.insert(registryAuditLog).values({
        portalUrl: context.portalUrl,
        documentId: id,
        event: 'document_updated',
        actorId: context.userId,
        before: this.auditSnapshot(current),
        after: { ...updates, fields },
      });
      });
    } catch (error) {
      if (isDocumentNumberConflict(error)) {
        throw new ApiError(
          409,
          'document_number_conflict',
          'Документ с таким номером уже существует для выбранных типа и компании.',
        );
      }
      throw error;
    }

    const updated = await this.getById(context, id);
    if (
      input.responsibleId !== undefined
      && input.responsibleId !== current.responsibleId
    ) {
      await this.notifications.responsibleAssigned(context, updated);
    }
    return updated;
  }

  async transition(
    context: RegistryContext,
    id: string,
    targetStatus: string,
    comment?: string,
  ) {
    const policy = await loadRegistryPolicy(this.database, context);
    const current = await this.loadDocumentForWrite(context, id);
    assertSectionVisible(policy, current.sectionCode);
    assertTypeVisible(policy, current.typeCode);
    this.assertCanTransition(policy, context, current);
    if (targetStatus === 'archived' && !isTypePermissionGranted(
      policy,
      current.typeCode,
      'archive',
      policy.permissions.softDelete,
    )) {
      throw new ApiError(403, 'delete_access_denied', 'Document archiving is not allowed.');
    }

    if (current.status === targetStatus) {
      throw new ApiError(409, 'status_unchanged', 'Document already has this status.');
    }

    const transition = current.lifecycleConfig.transitions.find(
      (item) => item.from === current.status && item.to === targetStatus,
    );
    if (!transition) {
      throw new ApiError(
        409,
        'transition_not_allowed',
        `Transition ${current.status} -> ${targetStatus} is not allowed.`,
      );
    }
    if (transition.roles && !transition.roles.includes(policy.roleCode)) {
      throw new ApiError(403, 'transition_role_denied', 'Role cannot perform transition.');
    }
    await this.assertRequiredFileFieldsComplete(context, id, current.typeId);
    await this.assertRequiredContentComplete(context, id, current.contentRequired);
    if (transition.requiresAttachment) {
      const [attachmentCount] = await this.database
        .select({ value: count(registryAttachments.id) })
        .from(registryAttachments)
        .where(
          and(
            eq(registryAttachments.portalUrl, context.portalUrl),
            eq(registryAttachments.documentId, id),
            eq(registryAttachments.isCurrent, true),
            isNull(registryAttachments.deletedAt),
          ),
        );
      if (!attachmentCount?.value) {
        throw new ApiError(
          409,
          'attachment_required',
          'An attachment is required for this transition.',
        );
      }
    }

    // Archiving has one storage model: recoverable soft-delete. Lifecycle
    // configurations may still expose `archived` as a target, but the action
    // is routed through the same archive/restore path as the registry menu.
    if (targetStatus === 'archived') {
      await this.softDelete(context, id);
      return this.getById(context, id, true);
    }

    await this.database.transaction(async (transaction) => {
      await transaction
        .update(registryDocuments)
        .set({ status: targetStatus, updatedBy: context.userId, updatedAt: new Date() })
        .where(
          and(
            eq(registryDocuments.id, id),
            eq(registryDocuments.portalUrl, context.portalUrl),
            isNull(registryDocuments.deletedAt),
          ),
        );
      await transaction.insert(registryAuditLog).values({
        portalUrl: context.portalUrl,
        documentId: id,
        event: 'status_changed',
        actorId: context.userId,
        before: { status: current.status },
        after: { status: targetStatus },
        metadata: comment ? { comment } : null,
      });
    });

    const updated = await this.getById(context, id, targetStatus === 'archived');
    const previousStatusLabel = current.lifecycleConfig.states
      .find((state) => state.code === current.status)?.label || current.status;
    const nextStatusLabel = current.lifecycleConfig.states
      .find((state) => state.code === targetStatus)?.label || targetStatus;
    await this.notifications.statusChanged(
      context,
      updated,
      targetStatus,
      previousStatusLabel,
      nextStatusLabel,
    );
    return updated;
  }

  async softDelete(context: RegistryContext, id: string) {
    const policy = await loadRegistryPolicy(this.database, context);
    const current = await this.loadDocumentForWrite(context, id);
    assertSectionVisible(policy, current.sectionCode);
    assertTypeVisible(policy, current.typeCode);
    if (!isTypePermissionGranted(
      policy,
      current.typeCode,
      'archive',
      policy.permissions.softDelete,
    )) {
      throw new ApiError(403, 'delete_access_denied', 'Soft-delete is not allowed.');
    }
    const participants = await this.loadArchiveParticipants(
      context,
      id,
      current.createdBy,
    );

    await this.database.transaction(async (transaction) => {
      await transaction
        .update(registryDocuments)
        .set({
          deletedAt: new Date(),
          deletedBy: context.userId,
          updatedBy: context.userId,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(registryDocuments.id, id),
            eq(registryDocuments.portalUrl, context.portalUrl),
            isNull(registryDocuments.deletedAt),
          ),
        );
      await transaction.insert(registryAuditLog).values({
        portalUrl: context.portalUrl,
        documentId: id,
        event: 'document_deleted',
        actorId: context.userId,
        before: this.auditSnapshot(current),
        metadata: {
          cardCreatorId: current.createdBy,
          fileUploaderIds: participants.fileUploaderIds,
          notificationRecipientIds: participants.recipientIds,
        },
      });
    });
    await this.recordArchiveNotifications(
      context,
      current,
      'archived',
      participants,
    );
  }

  async bulkAssign(context: RegistryContext, input: BulkAssignDocumentsInput) {
    const policy = await loadRegistryPolicy(this.database, context);
    const documents = await Promise.all(
      input.documentIds.map((id) => this.loadDocumentForWrite(context, id)),
    );
    for (const document of documents) {
      assertSectionVisible(policy, document.sectionCode);
      assertTypeVisible(policy, document.typeCode);
      this.assertCanEdit(policy, context, document);
    }
    const changed = documents.filter(
      (document) => document.responsibleId !== input.responsibleId,
    );

    await this.database.transaction(async (transaction) => {
      for (const document of changed) {
        await transaction
          .update(registryDocuments)
          .set({
            responsibleId: input.responsibleId,
            responsibleName: input.responsibleName ?? null,
            updatedBy: context.userId,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(registryDocuments.id, document.id),
              eq(registryDocuments.portalUrl, context.portalUrl),
              isNull(registryDocuments.deletedAt),
            ),
          );
        await transaction.insert(registryAuditLog).values({
          portalUrl: context.portalUrl,
          documentId: document.id,
          event: 'responsible_changed',
          actorId: context.userId,
          before: {
            responsibleId: document.responsibleId,
            responsibleName: document.responsibleName,
          },
          after: {
            responsibleId: input.responsibleId,
            responsibleName: input.responsibleName ?? null,
          },
          metadata: { bulk: true },
        });
      }
    });

    for (const document of changed) {
      await this.notifications.responsibleAssigned(context, {
        id: document.id,
        title: document.title,
        number: document.number,
        responsibleId: input.responsibleId,
      });
    }
    return { requested: documents.length, updated: changed.length };
  }

  async bulkDelete(context: RegistryContext, input: BulkDeleteDocumentsInput) {
    const policy = await loadRegistryPolicy(this.database, context);
    const documents = await Promise.all(
      input.documentIds.map((id) => this.loadDocumentForWrite(context, id)),
    );
    for (const document of documents) {
      assertSectionVisible(policy, document.sectionCode);
      assertTypeVisible(policy, document.typeCode);
      if (!isTypePermissionGranted(
        policy,
        document.typeCode,
        'archive',
        policy.permissions.softDelete,
      )) {
        throw new ApiError(403, 'delete_access_denied', 'Soft-delete is not allowed.');
      }
    }
    const participants = new Map(await Promise.all(documents.map(async (document) => [
      document.id,
      await this.loadArchiveParticipants(context, document.id, document.createdBy),
    ] as const)));

    const deletedAt = new Date();
    await this.database.transaction(async (transaction) => {
      for (const document of documents) {
        await transaction
          .update(registryDocuments)
          .set({
            deletedAt,
            deletedBy: context.userId,
            updatedBy: context.userId,
            updatedAt: deletedAt,
          })
          .where(
            and(
              eq(registryDocuments.id, document.id),
              eq(registryDocuments.portalUrl, context.portalUrl),
              isNull(registryDocuments.deletedAt),
            ),
          );
        await transaction.insert(registryAuditLog).values({
          portalUrl: context.portalUrl,
          documentId: document.id,
          event: 'document_deleted',
          actorId: context.userId,
          before: this.auditSnapshot(document),
          metadata: {
            bulk: true,
            cardCreatorId: document.createdBy,
            fileUploaderIds: participants.get(document.id)!.fileUploaderIds,
            notificationRecipientIds: participants.get(document.id)!.recipientIds,
          },
        });
      }
    });
    await this.recordArchiveNotificationsForMany(
      context,
      documents,
      'archived',
      participants,
    );
    return { deleted: documents.length };
  }

  async bulkRestore(context: RegistryContext, input: BulkRestoreDocumentsInput) {
    const policy = await loadRegistryPolicy(this.database, context);
    const documents = await Promise.all(
      input.documentIds.map((id) => this.loadDocumentForWrite(context, id, true)),
    );
    for (const document of documents) {
      assertSectionVisible(policy, document.sectionCode);
      assertTypeVisible(policy, document.typeCode);
      if (!isTypePermissionGranted(
        policy,
        document.typeCode,
        'restore',
        policy.permissions.restore,
      )) {
        throw new ApiError(403, 'restore_access_denied', 'Восстановление документов недоступно для вашей роли.');
      }
      if (!document.deletedAt && document.status !== 'archived') {
        throw new ApiError(409, 'document_not_deleted', 'Документ не находится в архиве.');
      }
    }
    const participants = new Map(await Promise.all(documents.map(async (document) => [
      document.id,
      await this.loadArchiveParticipants(context, document.id, document.createdBy),
    ] as const)));

    const restoredStatuses = new Map(await Promise.all(documents.map(async (document) => [
      document.id,
      document.status === 'archived'
        ? await this.legacyArchiveRestoreStatus(
            context,
            document.id,
            document.lifecycleConfig,
          )
        : document.status,
    ] as const)));
    const restoredAt = new Date();
    await this.database.transaction(async (transaction) => {
      for (const document of documents) {
        await transaction
          .update(registryDocuments)
          .set({
            status: restoredStatuses.get(document.id)!,
            deletedAt: null,
            deletedBy: null,
            updatedBy: context.userId,
            updatedAt: restoredAt,
          })
          .where(
            and(
              eq(registryDocuments.id, document.id),
              eq(registryDocuments.portalUrl, context.portalUrl),
              or(
                isNotNull(registryDocuments.deletedAt),
                eq(registryDocuments.status, 'archived'),
              ),
            ),
          );
        await transaction.insert(registryAuditLog).values({
          portalUrl: context.portalUrl,
          documentId: document.id,
          event: 'document_restored',
          actorId: context.userId,
          metadata: {
            bulk: true,
            cardCreatorId: document.createdBy,
            fileUploaderIds: participants.get(document.id)!.fileUploaderIds,
            notificationRecipientIds: participants.get(document.id)!.recipientIds,
            restoredStatus: restoredStatuses.get(document.id),
          },
        });
      }
    });
    await this.recordArchiveNotificationsForMany(
      context,
      documents,
      'restored',
      participants,
    );
    return { restored: documents.length };
  }

  async abandonCreation(context: RegistryContext, id: string) {
    const policy = await loadRegistryPolicy(this.database, context);
    const current = await this.loadDocumentForWrite(context, id);
    assertSectionVisible(policy, current.sectionCode);
    assertTypeVisible(policy, current.typeCode);
    const ageMs = Date.now() - current.createdAt.getTime();
    if (
      current.createdBy !== context.userId ||
      current.status !== current.lifecycleConfig.initialStatus ||
      ageMs < 0 ||
      ageMs > 15 * 60 * 1000
    ) {
      throw new ApiError(
        409,
        'document_abandon_not_allowed',
        'This document can no longer be abandoned as an incomplete creation.',
      );
    }
    const [finalizedCreation] = await this.database
      .select({ id: registryAuditLog.id })
      .from(registryAuditLog)
      .where(and(
        eq(registryAuditLog.portalUrl, context.portalUrl),
        eq(registryAuditLog.documentId, id),
        eq(registryAuditLog.event, 'document_creation_finalized'),
      ))
      .limit(1);
    if (finalizedCreation) {
      throw new ApiError(
        409,
        'document_abandon_not_allowed',
        'A finalized document cannot be abandoned as an incomplete creation.',
      );
    }
    const uploadedFiles = await this.database
      .select({
        id: registryAttachments.id,
        diskFileId: registryAttachments.diskFileId,
      })
      .from(registryAttachments)
      .where(
        and(
          eq(registryAttachments.portalUrl, context.portalUrl),
          eq(registryAttachments.documentId, id),
          eq(registryAttachments.kind, 'file'),
          isNull(registryAttachments.deletedAt),
        ),
      );
    const uploadedFileIds = uploadedFiles.map((attachment) => attachment.id);
    const uploadedFileCopies = uploadedFileIds.length
      ? await this.database
          .select({ diskFileId: registryAttachmentCopies.diskFileId })
          .from(registryAttachmentCopies)
          .where(and(
            eq(registryAttachmentCopies.portalUrl, context.portalUrl),
            inArray(registryAttachmentCopies.attachmentId, uploadedFileIds),
            isNull(registryAttachmentCopies.deletedAt),
          ))
      : [];
    if (uploadedFiles.some((attachment) => !attachment.diskFileId)) {
      throw new ApiError(
        409,
        'attachment_disk_file_missing',
        'Bitrix24 Disk file ID is missing.',
      );
    }

    const diskFilesToDelete = [
      ...uploadedFiles.map((attachment) => attachment.diskFileId!),
      ...uploadedFileCopies.map((copy) => copy.diskFileId),
    ];
    const bitrixContext = diskFilesToDelete.length ? context.bitrix : null;
    if (diskFilesToDelete.length && !bitrixContext) {
      throw new ApiError(
        409,
        'bitrix_disk_session_required',
        'File cleanup requires an authenticated Bitrix24 session.',
      );
    }
    const deletedDiskFileIds: number[] = [];
    try {
      for (const diskFileId of diskFilesToDelete) {
        await this.bitrix.call(
          bitrixContext!.domain,
          bitrixContext!.accessToken,
          'disk.file.markdeleted',
          { id: diskFileId },
        );
        deletedDiskFileIds.push(diskFileId);
      }
    } catch (error) {
      for (const diskFileId of deletedDiskFileIds) {
        await this.bitrix.call(
          bitrixContext!.domain,
          bitrixContext!.accessToken,
          'disk.file.restore',
          { id: diskFileId },
        ).catch(() => undefined);
      }
      throw error;
    }

    let supersededStatusToRestore: string | null = null;
    if (current.supersedesId) {
      const [supersedeEvent] = await this.database
        .select({ before: registryAuditLog.before, after: registryAuditLog.after })
        .from(registryAuditLog)
        .where(
          and(
            eq(registryAuditLog.portalUrl, context.portalUrl),
            eq(registryAuditLog.documentId, current.supersedesId),
            eq(registryAuditLog.event, 'document_superseded'),
          ),
        )
        .orderBy(desc(registryAuditLog.createdAt))
        .limit(1);
      const before = supersedeEvent?.before as { status?: unknown } | null;
      const after = supersedeEvent?.after as { supersededById?: unknown } | null;
      if (
        after?.supersededById === id
        && typeof before?.status === 'string'
        && before.status
      ) {
        supersededStatusToRestore = before.status;
      }
    }

    try {
      await this.database.transaction(async (transaction) => {
      await transaction
        .update(registryDocuments)
        .set({
          numberUniquenessKey: null,
          deletedAt: new Date(),
          deletedBy: context.userId,
          updatedBy: context.userId,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(registryDocuments.id, id),
            eq(registryDocuments.portalUrl, context.portalUrl),
            isNull(registryDocuments.deletedAt),
          ),
        );
      await transaction
        .update(registryAttachments)
        .set({
          isCurrent: false,
          deletedAt: new Date(),
        })
        .where(and(
          eq(registryAttachments.portalUrl, context.portalUrl),
          eq(registryAttachments.documentId, id),
          isNull(registryAttachments.deletedAt),
        ));
      if (uploadedFileIds.length) {
        await transaction
          .update(registryAttachmentCopies)
          .set({ deletedAt: new Date() })
          .where(and(
            eq(registryAttachmentCopies.portalUrl, context.portalUrl),
            inArray(registryAttachmentCopies.attachmentId, uploadedFileIds),
            isNull(registryAttachmentCopies.deletedAt),
          ));
      }
      await transaction
        .delete(registryBulkUploadItems)
        .where(and(
          eq(registryBulkUploadItems.portalUrl, context.portalUrl),
          eq(registryBulkUploadItems.createdBy, context.userId),
          eq(registryBulkUploadItems.documentId, id),
        ));
      await transaction.insert(registryAuditLog).values({
        portalUrl: context.portalUrl,
        documentId: id,
        event: 'document_creation_abandoned',
        actorId: context.userId,
        before: this.auditSnapshot(current),
        metadata: {
          reason: 'attachment_upload_failed',
          physicalCopyCount: uploadedFileCopies.length,
        },
      });
      if (current.supersedesId && supersededStatusToRestore) {
        const [restored] = await transaction
          .update(registryDocuments)
          .set({
            status: supersededStatusToRestore,
            updatedBy: context.userId,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(registryDocuments.id, current.supersedesId),
              eq(registryDocuments.portalUrl, context.portalUrl),
              eq(registryDocuments.status, 'archived'),
              isNull(registryDocuments.deletedAt),
            ),
          )
          .returning({ id: registryDocuments.id });
        if (restored) {
          await transaction.insert(registryAuditLog).values({
            portalUrl: context.portalUrl,
            documentId: current.supersedesId,
            event: 'document_supersede_reverted',
            actorId: context.userId,
            before: { status: 'archived', supersededById: id },
            after: { status: supersededStatusToRestore },
            metadata: { reason: 'replacement_creation_abandoned' },
          });
        }
      }
      });
    } catch (error) {
      if (bitrixContext) {
        for (const diskFileId of deletedDiskFileIds) {
          await this.bitrix.call(
            bitrixContext.domain,
            bitrixContext.accessToken,
            'disk.file.restore',
            { id: diskFileId },
          ).catch(() => undefined);
        }
      }
      throw error;
    }
  }

  async finalizeCreation(context: RegistryContext, id: string) {
    const policy = await loadRegistryPolicy(this.database, context);
    const current = await this.loadDocumentForWrite(context, id);
    assertSectionVisible(policy, current.sectionCode);
    assertTypeVisible(policy, current.typeCode);
    if (current.createdBy !== context.userId) {
      throw new ApiError(
        403,
        'document_creation_finalize_denied',
        'Only the document creator can finalize its initial upload.',
      );
    }
    await this.assertRequiredFileFieldsComplete(context, id, current.typeId);
    await this.assertRequiredContentComplete(context, id, current.contentRequired);
    await this.database.insert(registryAuditLog).values({
      portalUrl: context.portalUrl,
      documentId: id,
      event: 'document_creation_finalized',
      actorId: context.userId,
    });
    return this.getById(context, id);
  }

  async restore(context: RegistryContext, id: string) {
    const policy = await loadRegistryPolicy(this.database, context);
    const current = await this.loadDocumentForWrite(context, id, true);
    assertSectionVisible(policy, current.sectionCode);
    assertTypeVisible(policy, current.typeCode);
    if (!isTypePermissionGranted(
      policy,
      current.typeCode,
      'restore',
      policy.permissions.restore,
    )) {
      throw new ApiError(403, 'restore_access_denied', 'Restore is not allowed.');
    }
    if (!current.deletedAt && current.status !== 'archived') {
      throw new ApiError(409, 'document_not_deleted', 'Документ не находится в архиве.');
    }
    const restoredStatus = current.status === 'archived'
      ? await this.legacyArchiveRestoreStatus(context, id, current.lifecycleConfig)
      : current.status;
    const participants = await this.loadArchiveParticipants(
      context,
      id,
      current.createdBy,
    );

    await this.database.transaction(async (transaction) => {
      await transaction
        .update(registryDocuments)
        .set({
          status: restoredStatus,
          deletedAt: null,
          deletedBy: null,
          updatedBy: context.userId,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(registryDocuments.id, id),
            eq(registryDocuments.portalUrl, context.portalUrl),
          ),
        );
      await transaction.insert(registryAuditLog).values({
        portalUrl: context.portalUrl,
        documentId: id,
        event: 'document_restored',
        actorId: context.userId,
        metadata: {
          cardCreatorId: current.createdBy,
          fileUploaderIds: participants.fileUploaderIds,
          notificationRecipientIds: participants.recipientIds,
          restoredStatus,
        },
      });
    });

    await this.recordArchiveNotifications(
      context,
      current,
      'restored',
      participants,
    );

    return this.getById(context, id);
  }

  private async legacyArchiveRestoreStatus(
    context: RegistryContext,
    documentId: string,
    lifecycleConfig: {
      initialStatus: string;
      states: Array<{ code: string; terminal?: boolean }>;
    },
  ) {
    const events = await this.database
      .select({ before: registryAuditLog.before, after: registryAuditLog.after })
      .from(registryAuditLog)
      .where(and(
        eq(registryAuditLog.portalUrl, context.portalUrl),
        eq(registryAuditLog.documentId, documentId),
        eq(registryAuditLog.event, 'status_changed'),
      ))
      .orderBy(desc(registryAuditLog.createdAt))
      .limit(50);
    return resolveLegacyArchiveRestoreStatus(events, lifecycleConfig);
  }

  private async loadTypeConfiguration(
    context: RegistryContext,
    sectionCode: string,
    typeCode: string,
  ) {
    const [item] = await this.database
      .select({
        sectionId: registrySections.id,
        sectionCode: registrySections.code,
        typeId: registryDocumentTypes.id,
        typeCode: registryDocumentTypes.code,
        isFinancial: registryDocumentTypes.isFinancial,
        numberFormat: registryDocumentTypes.numberFormat,
        numberAutoGenerate: registryDocumentTypes.numberAutoGenerate,
        numberUniquenessEnabled: registryDocumentTypes.numberUniquenessEnabled,
        contentRequired: registryDocumentTypes.contentRequired,
        lifecycleConfig: registryLifecycles.config,
      })
      .from(registryDocumentTypes)
      .innerJoin(
        registryDocumentTypeSections,
        eq(registryDocumentTypes.id, registryDocumentTypeSections.typeId),
      )
      .innerJoin(registrySections, eq(registryDocumentTypeSections.sectionId, registrySections.id))
      .innerJoin(
        registryLifecycles,
        eq(registryDocumentTypes.lifecycleId, registryLifecycles.id),
      )
      .where(
        and(
          eq(registryDocumentTypes.portalUrl, context.portalUrl),
          eq(registryDocumentTypeSections.portalUrl, context.portalUrl),
          eq(registrySections.portalUrl, context.portalUrl),
          eq(registryLifecycles.portalUrl, context.portalUrl),
          eq(registrySections.code, sectionCode),
          eq(registryDocumentTypes.code, typeCode),
          eq(registrySections.isActive, true),
          eq(registryDocumentTypes.isActive, true),
          eq(registryLifecycles.isActive, true),
        ),
      )
      .limit(1);

    if (!item) {
      throw new ApiError(400, 'document_type_not_found', 'Document type was not found.');
    }
    return item;
  }

  private async prepareAccessScopes(context: RegistryContext) {
    const crmEntityScope = await this.crmEntityAccess.prepare(context);
    const salesDealScope = await this.salesDealAccess.prepare(context);
    return [crmEntityScope, salesDealScope].filter((scope): scope is SQL => scope !== null);
  }

  private async loadDocumentForWrite(
    context: RegistryContext,
    id: string,
    includeDeleted = false,
  ) {
    const accessScopes = await this.prepareAccessScopes(context);
    const conditions = [
      eq(registryDocuments.id, id),
      eq(registryDocuments.portalUrl, context.portalUrl),
      ...accessScopes,
    ];
    if (!includeDeleted) conditions.push(isNull(registryDocuments.deletedAt));

    const [item] = await this.database
      .select({
        id: registryDocuments.id,
        number: registryDocuments.number,
        title: registryDocuments.title,
        documentDate: registryDocuments.documentDate,
        amount: registryDocuments.amount,
        currency: registryDocuments.currency,
        legalEntityId: registryDocuments.legalEntityId,
        legalEntityName: registryDocuments.legalEntityName,
        counterpartyId: registryDocuments.counterpartyId,
        counterpartyName: registryDocuments.counterpartyName,
        dealStageId: registryDocuments.dealStageId,
        status: registryDocuments.status,
        comment: registryDocuments.comment,
        responsibleId: registryDocuments.responsibleId,
        responsibleName: registryDocuments.responsibleName,
        createdBy: registryDocuments.createdBy,
        createdAt: registryDocuments.createdAt,
        deletedAt: registryDocuments.deletedAt,
        supersedesId: registryDocuments.supersedesId,
        sectionCode: registrySections.code,
        typeCode: registryDocumentTypes.code,
        typeId: registryDocumentTypes.id,
        isFinancial: registryDocumentTypes.isFinancial,
        numberFormat: registryDocumentTypes.numberFormat,
        numberAutoGenerate: registryDocumentTypes.numberAutoGenerate,
        numberUniquenessEnabled: registryDocumentTypes.numberUniquenessEnabled,
        contentRequired: registryDocumentTypes.contentRequired,
        lifecycleConfig: registryLifecycles.config,
      })
      .from(registryDocuments)
      .innerJoin(registrySections, eq(registryDocuments.sectionId, registrySections.id))
      .innerJoin(
        registryDocumentTypes,
        eq(registryDocuments.typeId, registryDocumentTypes.id),
      )
      .innerJoin(
        registryLifecycles,
        eq(registryDocumentTypes.lifecycleId, registryLifecycles.id),
      )
      .where(and(...conditions))
      .limit(1);

    if (!item) {
      throw new ApiError(404, 'document_not_found', 'Document was not found.');
    }
    if (!includeDeleted && item.status === 'archived') {
      throw new ApiError(
        409,
        'document_archived_read_only',
        'Archived documents are read-only.',
      );
    }
    return item;
  }

  private async loadRelationsForDocuments(
    context: RegistryContext,
    documentIds: string[],
    policy: RegistryPolicy,
    accessScopes: SQL[],
  ) {
    type RelationSummary = {
      id: string;
      number: string | null;
      title: string;
      status: string;
      section: { code: string; name: string; color: string | null };
      type: { code: string; name: string };
      relationType: string;
    };
    const result = new Map<string, { parent: RelationSummary | null; children: RelationSummary[] }>();
    for (const documentId of documentIds) result.set(documentId, { parent: null, children: [] });
    if (!documentIds.length) return result;

    const relationRows = await this.database
      .select()
      .from(registryDocumentRelations)
      .where(and(
        eq(registryDocumentRelations.portalUrl, context.portalUrl),
        or(
          inArray(registryDocumentRelations.parentDocumentId, documentIds),
          inArray(registryDocumentRelations.childDocumentId, documentIds),
        ),
      ));
    if (!relationRows.length) return result;

    const relatedIds = [...new Set(relationRows.flatMap((relation) => [
      relation.parentDocumentId,
      relation.childDocumentId,
    ]))];
    const conditions: SQL[] = [
      eq(registryDocuments.portalUrl, context.portalUrl),
      inArray(registryDocuments.id, relatedIds),
      isNull(registryDocuments.deletedAt),
      ne(registryDocuments.status, 'archived'),
      inArray(registrySections.code, policy.visibleSectionCodes),
    ];
    conditions.push(...accessScopes);
    if (policy.visibleTypeCodes) {
      conditions.push(inArray(registryDocumentTypes.code, policy.visibleTypeCodes));
    }
    const hiddenTypeCodes = Object.entries(policy.permissions.byType ?? {})
      .filter(([, permissions]) => permissions.view === false)
      .map(([typeCode]) => typeCode);
    if (hiddenTypeCodes.length) {
      conditions.push(notInArray(registryDocumentTypes.code, hiddenTypeCodes));
    }
    const summaries = await this.database
      .select({
        id: registryDocuments.id,
        number: registryDocuments.number,
        title: registryDocuments.title,
        status: registryDocuments.status,
        sectionCode: registrySections.code,
        sectionName: registrySections.name,
        sectionColor: registrySections.color,
        typeCode: registryDocumentTypes.code,
        typeName: registryDocumentTypes.name,
      })
      .from(registryDocuments)
      .innerJoin(registrySections, eq(registryDocuments.sectionId, registrySections.id))
      .innerJoin(registryDocumentTypes, eq(registryDocuments.typeId, registryDocumentTypes.id))
      .where(and(...conditions));
    const summaryById = new Map(summaries.map((summary) => [summary.id, summary]));
    const relatedSummary = (documentId: string, relationType: string): RelationSummary | null => {
      const summary = summaryById.get(documentId);
      if (!summary) return null;
      return {
        id: summary.id,
        number: summary.number,
        title: summary.title,
        status: summary.status,
        section: {
          code: summary.sectionCode,
          name: summary.sectionName,
          color: summary.sectionColor,
        },
        type: { code: summary.typeCode, name: summary.typeName },
        relationType,
      };
    };
    for (const relation of relationRows) {
      if (result.has(relation.childDocumentId)) {
        const parent = relatedSummary(relation.parentDocumentId, relation.relationType);
        if (parent) result.get(relation.childDocumentId)!.parent = parent;
      }
      if (result.has(relation.parentDocumentId)) {
        const child = relatedSummary(relation.childDocumentId, relation.relationType);
        if (child) result.get(relation.parentDocumentId)!.children.push(child);
      }
    }
    for (const relations of result.values()) {
      relations.children.sort((left, right) =>
        (left.number || left.title).localeCompare(right.number || right.title, 'ru'));
    }
    return result;
  }

  private async upsertFieldValues(
    database: Database,
    context: RegistryContext,
    documentId: string,
    typeId: string,
    fields: Record<string, unknown>,
  ) {
    const keys = Object.keys(fields);
    if (!keys.length) return;
    const definitions = await database
      .select({ id: registryFieldDefinitions.id, key: registryFieldDefinitions.key })
      .from(registryFieldDefinitions)
      .innerJoin(
        registryTypeFields,
        eq(registryTypeFields.fieldDefinitionId, registryFieldDefinitions.id),
      )
      .where(
        and(
          eq(registryFieldDefinitions.portalUrl, context.portalUrl),
          eq(registryTypeFields.portalUrl, context.portalUrl),
          eq(registryTypeFields.typeId, typeId),
          eq(registryFieldDefinitions.isActive, true),
          inArray(registryFieldDefinitions.key, keys),
        ),
      );
    const definitionByKey = new Map(definitions.map((item) => [item.key, item.id]));
    const unknownKeys = keys.filter((key) => !definitionByKey.has(key));
    if (unknownKeys.length) {
      throw new ApiError(
        400,
        'unknown_document_fields',
        'Unknown document fields were provided.',
        { keys: unknownKeys },
      );
    }

    for (const key of keys) {
      const value = fields[key];
      const isEmpty = value === null || value === undefined || value === ''
        || (Array.isArray(value) && value.length === 0);
      if (isEmpty) {
        await database
          .delete(registryDocumentFieldValues)
          .where(
            and(
              eq(registryDocumentFieldValues.portalUrl, context.portalUrl),
              eq(registryDocumentFieldValues.documentId, documentId),
              eq(
                registryDocumentFieldValues.fieldDefinitionId,
                definitionByKey.get(key)!,
              ),
            ),
          );
        continue;
      }
      await database
        .insert(registryDocumentFieldValues)
        .values({
          portalUrl: context.portalUrl,
          documentId,
          fieldDefinitionId: definitionByKey.get(key)!,
          value,
        })
        .onConflictDoUpdate({
          target: [
            registryDocumentFieldValues.portalUrl,
            registryDocumentFieldValues.documentId,
            registryDocumentFieldValues.fieldDefinitionId,
          ],
          set: { value, updatedAt: new Date() },
        });
    }
  }

  private async validateFieldValues(
    context: RegistryContext,
    typeId: string,
    typeCode: string,
    fields: Record<string, unknown>,
    requireAll: boolean,
    policy?: RegistryPolicy,
  ) {
    const definitions = await this.database
      .select({
        key: registryFieldDefinitions.key,
        dataType: registryFieldDefinitions.dataType,
        options: registryTypeFields.optionsOverride,
        defaultOptions: registryFieldDefinitions.options,
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
          eq(registryTypeFields.typeId, typeId),
          eq(registryFieldDefinitions.portalUrl, context.portalUrl),
          eq(registryFieldDefinitions.isActive, true),
        ),
      );
    const definitionByKey = new Map(definitions.map((item) => [item.key, item]));
    const unknownKeys = Object.keys(fields).filter((key) => !definitionByKey.has(key));
    if (unknownKeys.length) {
      throw new ApiError(
        400,
        'unknown_document_fields',
        'Fields are not configured for this document type.',
        { keys: unknownKeys },
      );
    }

    const forbiddenKeys = policy
      ? Object.keys(fields).filter((key) =>
          isDocumentFieldHidden(policy, {
            key,
            dataType: definitionByKey.get(key)!.dataType,
          }, typeCode),
        )
      : [];
    if (forbiddenKeys.length) {
      throw new ApiError(
        403,
        'document_fields_access_denied',
        'One or more document fields are hidden for this role.',
        { keys: forbiddenKeys },
      );
    }

    const isEmpty = (value: unknown) =>
      value === null || value === undefined || value === '' ||
      (Array.isArray(value) && value.length === 0);
    const missingRequired = definitions
      .filter((definition) => definition.isRequired)
      .filter((definition) =>
        requireAll
          ? !Object.hasOwn(fields, definition.key) || isEmpty(fields[definition.key])
          : Object.hasOwn(fields, definition.key) && isEmpty(fields[definition.key]),
      )
      .map((definition) => definition.key);
    if (missingRequired.length) {
      throw new ApiError(
        400,
        'required_document_fields_missing',
        'Required document fields are missing.',
        { keys: missingRequired },
      );
    }

    for (const [key, value] of Object.entries(fields)) {
      const definition = definitionByKey.get(key)!;
      if (isEmpty(value)) continue;
      const pendingFile = value && typeof value === 'object' && !Array.isArray(value)
        && (value as { pendingUpload?: unknown }).pendingUpload === true
        && typeof (value as { name?: unknown }).name === 'string'
        && (value as { name: string }).name.trim().length > 0
        && (value as { name: string }).name.length <= 255;
      const invalid =
        (definition.dataType === 'text' && typeof value !== 'string') ||
        ((definition.dataType === 'number' || definition.dataType === 'money') &&
          !(typeof value === 'number' || (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value)))) ||
        (definition.dataType === 'date' && !this.isIsoDate(value)) ||
        (definition.dataType === 'boolean' && typeof value !== 'boolean') ||
        (definition.dataType === 'select' &&
          !(definition.options || definition.defaultOptions || []).includes(value)) ||
        (definition.dataType === 'file' && (!requireAll || !pendingFile));
      if (invalid) {
        throw new ApiError(
          400,
          'invalid_document_field_value',
          `Invalid value for document field ${key}.`,
          { key, dataType: definition.dataType },
        );
      }
    }
  }

  private async assertRequiredFileFieldsComplete(
    context: RegistryContext,
    documentId: string,
    typeId: string,
  ) {
    const requiredFields = await this.database
      .select({
        id: registryFieldDefinitions.id,
        key: registryFieldDefinitions.key,
      })
      .from(registryTypeFields)
      .innerJoin(
        registryFieldDefinitions,
        eq(registryTypeFields.fieldDefinitionId, registryFieldDefinitions.id),
      )
      .where(
        and(
          eq(registryTypeFields.portalUrl, context.portalUrl),
          eq(registryTypeFields.typeId, typeId),
          eq(registryTypeFields.isRequired, true),
          eq(registryFieldDefinitions.portalUrl, context.portalUrl),
          eq(registryFieldDefinitions.dataType, 'file'),
          eq(registryFieldDefinitions.isActive, true),
        ),
      );
    if (!requiredFields.length) return;

    const attachments = await this.database
      .select({ fieldDefinitionId: registryAttachments.fieldDefinitionId })
      .from(registryAttachments)
      .where(
        and(
          eq(registryAttachments.portalUrl, context.portalUrl),
          eq(registryAttachments.documentId, documentId),
          eq(registryAttachments.kind, 'file'),
          eq(registryAttachments.isCurrent, true),
          inArray(
            registryAttachments.fieldDefinitionId,
            requiredFields.map((field) => field.id),
          ),
          isNull(registryAttachments.deletedAt),
        ),
      );
    const attached = new Set(attachments.map((item) => item.fieldDefinitionId));
    const missing = requiredFields
      .filter((field) => !attached.has(field.id))
      .map((field) => field.key);
    if (missing.length) {
      throw new ApiError(
        409,
        'required_file_fields_incomplete',
        'Required file fields have not been uploaded yet.',
        { keys: missing },
      );
    }
  }

  private async assertRequiredContentComplete(
    context: RegistryContext,
    documentId: string,
    contentRequired: boolean,
  ) {
    if (!contentRequired) return;
    const [attachment] = await this.database
      .select({ id: registryAttachments.id })
      .from(registryAttachments)
      .where(and(
        eq(registryAttachments.portalUrl, context.portalUrl),
        eq(registryAttachments.documentId, documentId),
        eq(registryAttachments.isCurrent, true),
        isNull(registryAttachments.fieldDefinitionId),
        isNull(registryAttachments.deletedAt),
      ))
      .limit(1);
    if (!attachment) {
      throw new ApiError(
        409,
        'document_content_required',
        'A file or HTTPS link is required for this document type.',
      );
    }
  }

  private isIsoDate(value: unknown) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      return false;
    }
    const date = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
  }

  private assertFinancialFields(
    isFinancial: boolean,
    amount: string | null | undefined,
    currency: string | null | undefined,
  ) {
    if (isFinancial && (!amount || !currency)) {
      throw new ApiError(
        400,
        'financial_fields_required',
        'Amount and currency are required for financial document types.',
      );
    }
  }

  private assertCanEdit(
    policy: RegistryPolicy,
    context: RegistryContext,
    document: { createdBy: number; responsibleId: number; typeCode: string },
  ) {
    assertTypePermission(policy, document.typeCode, 'edit');
    const own =
      document.createdBy === context.userId || document.responsibleId === context.userId;
    if (!policy.permissions.editAny && !(policy.permissions.editOwn && own)) {
      throw new ApiError(403, 'edit_access_denied', 'Document editing is not allowed.');
    }
  }

  private async loadArchiveParticipants(
    context: RegistryContext,
    documentId: string,
    cardCreatorId: number,
  ): Promise<ArchiveParticipants> {
    const uploaders = await this.database
      .selectDistinct({ userId: registryAttachments.createdBy })
      .from(registryAttachments)
      .where(and(
        eq(registryAttachments.portalUrl, context.portalUrl),
        eq(registryAttachments.documentId, documentId),
        eq(registryAttachments.kind, 'file'),
        eq(registryAttachments.isCurrent, true),
        isNull(registryAttachments.deletedAt),
      ));
    const fileUploaderIds = uploaders
      .map((item) => item.userId)
      .filter((userId) => Number.isSafeInteger(userId) && userId > 0)
      .sort((left, right) => left - right);
    return {
      cardCreatorId,
      fileUploaderIds,
      recipientIds: [...new Set([cardCreatorId, ...fileUploaderIds])]
        .sort((left, right) => left - right),
    };
  }

  private async recordArchiveNotificationsForMany(
    context: RegistryContext,
    documents: ArchiveNotificationDocument[],
    action: 'archived' | 'restored',
    participants: Map<string, ArchiveParticipants>,
  ) {
    for (let offset = 0; offset < documents.length; offset += 4) {
      await Promise.all(documents.slice(offset, offset + 4).map((document) =>
        this.recordArchiveNotifications(
          context,
          document,
          action,
          participants.get(document.id)!,
          true,
        )));
    }
  }

  private async recordArchiveNotifications(
    context: RegistryContext,
    document: ArchiveNotificationDocument,
    action: 'archived' | 'restored',
    participants: ArchiveParticipants,
    bulk = false,
  ) {
    const deliveries = await this.notifications.archiveChanged(
      context,
      document,
      action,
      participants.recipientIds,
    );
    try {
      await this.database.insert(registryAuditLog).values({
        portalUrl: context.portalUrl,
        documentId: document.id,
        event: action === 'archived'
          ? 'archive_notifications_dispatched'
          : 'restore_notifications_dispatched',
        actorId: context.userId,
        metadata: {
          bulk,
          cardCreatorId: participants.cardCreatorId,
          fileUploaderIds: participants.fileUploaderIds,
          notificationRecipientIds: participants.recipientIds,
          deliveries,
        },
      });
    } catch (error) {
      logger.error(
        { error, portalUrl: context.portalUrl, documentId: document.id, action },
        'Could not record archive notification deliveries',
      );
    }
  }

  private assertCanTransition(
    policy: RegistryPolicy,
    context: RegistryContext,
    document: { createdBy: number; responsibleId: number; typeCode: string },
  ) {
    assertTypePermission(policy, document.typeCode, 'transition');
    const own =
      document.createdBy === context.userId || document.responsibleId === context.userId;
    if (
      !policy.permissions.transitionAny &&
      !(policy.permissions.transitionOwn && own)
    ) {
      throw new ApiError(403, 'transition_access_denied', 'Status change is not allowed.');
    }
  }

  private auditSnapshot(document: Record<string, unknown>) {
    const { lifecycleConfig: _lifecycleConfig, ...snapshot } = document;
    return snapshot;
  }

  private sanitizeAuditEntry<T extends {
    before: unknown;
    after: unknown;
    metadata: unknown;
  }>(entry: T, policy: RegistryPolicy, typeCode: string): T {
    const hiddenKeys = new Set(policy.hiddenFields);
    if (isMoneyHidden(policy, typeCode)) {
      hiddenKeys.add('amount');
      hiddenKeys.add('currency');
      hiddenKeys.add('originalAmount');
      hiddenKeys.add('convertedAmount');
      hiddenKeys.add('sourceRate');
      hiddenKeys.add('targetRate');
      hiddenKeys.add('conversionRate');
    }
    const sanitize = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(sanitize);
      if (!value || typeof value !== 'object' || value instanceof Date) return value;
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .filter(([key]) => !hiddenKeys.has(key))
          .map(([key, item]) => [key, sanitize(item)]),
      );
    };
    return {
      ...entry,
      before: sanitize(entry.before),
      after: sanitize(entry.after),
      metadata: sanitize(entry.metadata),
    };
  }

  private toResponse<
    T extends {
      amount: string | null;
      currency: string | null;
      sectionCode: string;
      sectionName: string;
      sectionColor: string | null;
      typeCode: string;
      typeName: string;
      isFinancial: boolean;
      internalTypeId?: string;
    },
  >(row: T, policy: RegistryPolicy) {
    const moneyHidden = isMoneyHidden(policy, row.typeCode);
    const {
      sectionCode,
      sectionName,
      sectionColor,
      typeCode,
      typeName,
      isFinancial,
      internalTypeId: _internalTypeId,
      ...document
    } = row;
    return {
      ...document,
      amount: moneyHidden ? null : row.amount,
      currency: moneyHidden ? null : row.currency,
      moneyHidden,
      section: { code: sectionCode, name: sectionName, color: sectionColor },
      type: { code: typeCode, name: typeName, isFinancial },
    };
  }
}

export function createDocumentsService({ database, bitrix }: DocumentsServiceDependencies) {
  return new DocumentsService(
    database,
    bitrix,
    new BitrixNotificationsService(bitrix),
    new CrmEntityAccessService(database, bitrix),
    new SalesDealAccessService(database, bitrix),
  );
}
