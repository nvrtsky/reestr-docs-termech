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
  or,
  type SQL,
} from 'drizzle-orm';

import type { BitrixApiClient } from '../bitrix/bitrix-client.js';
import type { Database } from '../db/database.js';
import {
  registryAttachments,
  registryAuditLog,
  registryDocumentFieldValues,
  registryDocumentLinks,
  registryDocuments,
  registryDocumentTypes,
  registryFieldDefinitions,
  registryLifecycles,
  registrySections,
  registryTypeFields,
} from '../db/schema/index.js';
import { ApiError } from '../http/api-error.js';
import type { RegistryContext } from '../http/registry-context.js';
import { BitrixNotificationsService } from '../notifications/bitrix-notifications.service.js';
import {
  assertSectionVisible,
  assertTypeVisible,
  isDocumentFieldHidden,
  isMoneyHidden,
  loadRegistryPolicy,
  type RegistryPolicy,
} from '../permissions/policy.service.js';
import type {
  AddDocumentLinkInput,
  BulkAssignDocumentsInput,
  BulkDeleteDocumentsInput,
  BulkRestoreDocumentsInput,
  CreateDocumentInput,
  DocumentListQuery,
  UpdateDocumentInput,
} from './documents.schemas.js';

interface DocumentsServiceDependencies {
  database: Database;
  bitrix: BitrixApiClient;
}

export interface DocumentEntityReference {
  entityType: 'deal' | 'company';
  entityId: number;
}

export class DocumentsService {
  constructor(
    private readonly database: Database,
    private readonly notifications: BitrixNotificationsService,
  ) {}

  async list(
    context: RegistryContext,
    query: DocumentListQuery,
    documentIds?: string[],
  ) {
    const policy = await loadRegistryPolicy(this.database, context);
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

    return {
      items: rows.map((row) => this.toResponse(row, policy)),
      meta: { total: totalRow?.value ?? 0, limit: query.limit, offset: query.offset },
    };
  }

  async listOptions(context: RegistryContext) {
    const policy = await loadRegistryPolicy(this.database, context);
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
    if (policy.visibleTypeCodes) {
      visibleConditions.push(inArray(registryDocumentTypes.code, policy.visibleTypeCodes));
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
      await transaction.insert(registryAuditLog).values({
        portalUrl: context.portalUrl,
        documentId,
        event: 'link_removed',
        actorId: context.userId,
        before: removed,
      });
    });

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

  async getById(context: RegistryContext, id: string, deletedOnly = false) {
    const policy = await loadRegistryPolicy(this.database, context);
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

    const [attachments, links, rawFieldValues, history] = await Promise.all([
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
          createdBy: registryAttachments.createdBy,
          createdAt: registryAttachments.createdAt,
        })
        .from(registryAttachments)
        .where(
          and(
            eq(registryAttachments.portalUrl, context.portalUrl),
            eq(registryAttachments.documentId, id),
            isNull(registryAttachments.deletedAt),
          ),
        )
        .orderBy(desc(registryAttachments.createdAt)),
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
      .filter((field) => !isDocumentFieldHidden(policy, field))
      .map((field) => ({
        key: field.key,
        label: field.labelOverride || field.defaultLabel,
        dataType: field.dataType,
        value: field.value,
      }));
    return {
      ...this.toResponse(row, policy),
      attachments,
      links,
      fields: fieldValues,
      history,
    };
  }

  async create(context: RegistryContext, input: CreateDocumentInput) {
    const policy = await loadRegistryPolicy(this.database, context);
    if (!policy.permissions.create) {
      throw new ApiError(403, 'create_access_denied', 'Document creation is not allowed.');
    }

    const typeConfig = await this.loadTypeConfiguration(
      context,
      input.sectionCode,
      input.typeCode,
    );
    assertSectionVisible(policy, typeConfig.sectionCode);
    assertTypeVisible(policy, typeConfig.typeCode);
    if (typeConfig.isFinancial && isMoneyHidden(policy)) {
      throw new ApiError(
        403,
        'financial_document_create_denied',
        'A role with hidden financial fields cannot create financial documents.',
      );
    }
    if (isMoneyHidden(policy) && (input.amount !== undefined || input.currency !== undefined)) {
      throw new ApiError(
        403,
        'financial_fields_access_denied',
        'Financial fields are hidden for this role.',
      );
    }
    this.assertFinancialFields(typeConfig.isFinancial, input.amount, input.currency);
    await this.validateFieldValues(context, typeConfig.typeId, input.fields, true, policy);

    const superseded = input.supersedesId
      ? await this.loadDocumentForWrite(context, input.supersedesId)
      : null;
    if (superseded) {
      assertSectionVisible(policy, superseded.sectionCode);
      assertTypeVisible(policy, superseded.typeCode);
      this.assertCanEdit(policy, context, superseded);
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

    const documentId = await this.database.transaction(async (transaction) => {
      const [document] = await transaction
        .insert(registryDocuments)
        .values({
          portalUrl: context.portalUrl,
          sectionId: typeConfig.sectionId,
          typeId: typeConfig.typeId,
          number: input.number ?? null,
          title: input.title,
          documentDate: input.documentDate,
          amount: input.amount ?? null,
          currency: input.currency ?? null,
          legalEntityId: input.legalEntityId ?? null,
          legalEntityName: input.legalEntityName ?? null,
          counterpartyId: input.counterpartyId ?? null,
          counterpartyName: input.counterpartyName ?? null,
          dealStageId: input.dealStageId ?? null,
          status: typeConfig.lifecycleConfig.initialStatus,
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
          sectionCode: typeConfig.sectionCode,
          typeCode: typeConfig.typeCode,
          status: typeConfig.lifecycleConfig.initialStatus,
        },
        metadata: superseded ? { supersedesId: superseded.id } : null,
      });

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

    if (isMoneyHidden(policy) && (input.amount !== undefined || input.currency !== undefined)) {
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
      await this.validateFieldValues(context, current.typeId, fields, false, policy);
    }

    await this.database.transaction(async (transaction) => {
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
    if (!policy.permissions.softDelete) {
      throw new ApiError(403, 'delete_access_denied', 'Soft-delete is not allowed.');
    }

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
      });
    });
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
    if (!policy.permissions.softDelete) {
      throw new ApiError(403, 'delete_access_denied', 'Soft-delete is not allowed.');
    }
    const documents = await Promise.all(
      input.documentIds.map((id) => this.loadDocumentForWrite(context, id)),
    );
    for (const document of documents) {
      assertSectionVisible(policy, document.sectionCode);
      assertTypeVisible(policy, document.typeCode);
    }

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
          metadata: { bulk: true },
        });
      }
    });
    return { deleted: documents.length };
  }

  async bulkRestore(context: RegistryContext, input: BulkRestoreDocumentsInput) {
    const policy = await loadRegistryPolicy(this.database, context);
    if (!policy.permissions.restore) {
      throw new ApiError(403, 'restore_access_denied', 'Восстановление документов недоступно для вашей роли.');
    }
    const documents = await Promise.all(
      input.documentIds.map((id) => this.loadDocumentForWrite(context, id, true)),
    );
    for (const document of documents) {
      assertSectionVisible(policy, document.sectionCode);
      assertTypeVisible(policy, document.typeCode);
      if (!document.deletedAt) {
        throw new ApiError(409, 'document_not_deleted', 'Документ не находится в архиве.');
      }
    }

    const restoredAt = new Date();
    await this.database.transaction(async (transaction) => {
      for (const document of documents) {
        await transaction
          .update(registryDocuments)
          .set({
            deletedAt: null,
            deletedBy: null,
            updatedBy: context.userId,
            updatedAt: restoredAt,
          })
          .where(
            and(
              eq(registryDocuments.id, document.id),
              eq(registryDocuments.portalUrl, context.portalUrl),
              isNotNull(registryDocuments.deletedAt),
            ),
          );
        await transaction.insert(registryAuditLog).values({
          portalUrl: context.portalUrl,
          documentId: document.id,
          event: 'document_restored',
          actorId: context.userId,
          metadata: { bulk: true },
        });
      }
    });
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
    const [attachmentCount] = await this.database
      .select({ value: count(registryAttachments.id) })
      .from(registryAttachments)
      .where(
        and(
          eq(registryAttachments.portalUrl, context.portalUrl),
          eq(registryAttachments.documentId, id),
          isNull(registryAttachments.deletedAt),
        ),
      );
    if (attachmentCount?.value) {
      throw new ApiError(
        409,
        'document_abandon_has_attachments',
        'A document with uploaded attachments cannot be abandoned.',
      );
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
        event: 'document_creation_abandoned',
        actorId: context.userId,
        before: this.auditSnapshot(current),
        metadata: { reason: 'attachment_upload_failed' },
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
  }

  async restore(context: RegistryContext, id: string) {
    const policy = await loadRegistryPolicy(this.database, context);
    if (!policy.permissions.restore) {
      throw new ApiError(403, 'restore_access_denied', 'Restore is not allowed.');
    }
    const current = await this.loadDocumentForWrite(context, id, true);
    assertSectionVisible(policy, current.sectionCode);
    assertTypeVisible(policy, current.typeCode);
    if (!current.deletedAt) {
      throw new ApiError(409, 'document_not_deleted', 'Document is not deleted.');
    }

    await this.database.transaction(async (transaction) => {
      await transaction
        .update(registryDocuments)
        .set({
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
      });
    });

    return this.getById(context, id, current.status === 'archived');
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
        lifecycleConfig: registryLifecycles.config,
      })
      .from(registryDocumentTypes)
      .innerJoin(registrySections, eq(registryDocumentTypes.sectionId, registrySections.id))
      .innerJoin(
        registryLifecycles,
        eq(registryDocumentTypes.lifecycleId, registryLifecycles.id),
      )
      .where(
        and(
          eq(registryDocumentTypes.portalUrl, context.portalUrl),
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

  private async loadDocumentForWrite(
    context: RegistryContext,
    id: string,
    includeDeleted = false,
  ) {
    const conditions = [
      eq(registryDocuments.id, id),
      eq(registryDocuments.portalUrl, context.portalUrl),
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
          }),
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
      const invalid =
        (definition.dataType === 'text' && typeof value !== 'string') ||
        ((definition.dataType === 'number' || definition.dataType === 'money') &&
          !(typeof value === 'number' || (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value)))) ||
        (definition.dataType === 'date' && !this.isIsoDate(value)) ||
        (definition.dataType === 'boolean' && typeof value !== 'boolean') ||
        (definition.dataType === 'select' &&
          !(definition.options || definition.defaultOptions || []).includes(value));
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
    document: { createdBy: number; responsibleId: number },
  ) {
    const own =
      document.createdBy === context.userId || document.responsibleId === context.userId;
    if (!policy.permissions.editAny && !(policy.permissions.editOwn && own)) {
      throw new ApiError(403, 'edit_access_denied', 'Document editing is not allowed.');
    }
  }

  private assertCanTransition(
    policy: RegistryPolicy,
    context: RegistryContext,
    document: { createdBy: number; responsibleId: number },
  ) {
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
    const moneyHidden = isMoneyHidden(policy);
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
  return new DocumentsService(database, new BitrixNotificationsService(bitrix));
}
