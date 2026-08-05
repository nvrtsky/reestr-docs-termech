import {
  and,
  eq,
  inArray,
  ne,
  sql,
} from 'drizzle-orm';

import type { BitrixApiClient } from '../bitrix/bitrix-client.js';
import type { Database } from '../db/database.js';
import {
  registryAuditLog,
  registryDocumentLinks,
  registryDocuments,
  registryDocumentTypeSections,
  registryDocumentTypes,
  registryLifecycles,
  registrySections,
  type LifecycleConfig,
} from '../db/schema/index.js';
import { ApiError } from '../http/api-error.js';
import type { RegistryContext } from '../http/registry-context.js';
import {
  assertSectionVisible,
  assertTypeVisible,
  isMoneyHidden,
  isTypePermissionGranted,
  loadRegistryPolicy,
} from '../permissions/policy.service.js';

const BITRIX_PAGE_SIZE = 50;
const MAX_SOURCE_PAGES = 40;

type ExternalSource = 'bitrix_smart_invoice' | 'bitrix_quote';

interface BitrixDeal {
  ID?: string | number;
  TITLE?: string;
  COMPANY_ID?: string | number;
  STAGE_ID?: string;
  CLOSED?: string;
}

interface BitrixCompany {
  ID?: string | number;
  TITLE?: string;
}

interface BitrixItemListResult {
  items?: Array<Record<string, unknown>>;
}

interface ImportTypeConfiguration {
  sectionId: string;
  typeId: string;
  typeCode: string;
  initialStatus: string;
}

interface NormalizedExternalDocument {
  source: ExternalSource;
  entityTypeId: number;
  externalId: number;
  externalStatus: string | null;
  externalUpdatedAt: Date | null;
  number: string;
  title: string;
  documentDate: string;
  amount: string | null;
  currency: string | null;
  responsibleId: number;
  responsibleName: string;
  typeCode: 'client_invoice' | 'client_quote';
}

export interface BitrixDealImportSummary {
  dealId: number;
  created: number;
  updated: number;
  unchanged: number;
  duplicates: 0;
  sourceDuplicatesIgnored: number;
  syncedAt: string;
  items: Array<{
    documentId: string;
    source: ExternalSource;
    entityTypeId: number;
    externalId: number;
    typeCode: string;
    status: 'created' | 'updated' | 'unchanged';
  }>;
}

export class BitrixDealImportService {
  constructor(
    private readonly database: Database,
    private readonly bitrix: BitrixApiClient,
  ) {}

  async synchronize(
    context: RegistryContext,
    dealId: number,
  ): Promise<BitrixDealImportSummary> {
    if (!context.bitrix) {
      throw new ApiError(
        401,
        'bitrix_import_session_required',
        'A verified Bitrix24 session is required for synchronization.',
      );
    }

    const deal = await this.call<BitrixDeal>(context, 'crm.deal.get', { id: dealId });
    if (this.positiveId(deal.ID) !== dealId) {
      throw new ApiError(
        403,
        'bitrix_deal_access_denied',
        'The Bitrix24 deal is unavailable.',
      );
    }
    if (context.roleCode === 'sales' && String(deal.CLOSED || '').toUpperCase() === 'Y') {
      throw new ApiError(
        403,
        'closed_deal_access_denied',
        'Sales users cannot synchronize documents of a closed deal.',
      );
    }

    const types = await this.loadAndAuthorizeTypes(context);
    const companyId = this.positiveId(deal.COMPANY_ID);
    const company = companyId
      ? await this.call<BitrixCompany>(context, 'crm.company.get', { id: companyId })
      : null;
    const dealTitle = this.nonEmptyText(deal.TITLE) || `Сделка #${dealId}`;
    const companyName = companyId
      ? this.nonEmptyText(company?.TITLE) || `Компания #${companyId}`
      : null;

    const [invoiceRows, quoteRows] = await Promise.all([
      this.loadAllItems(context, 31, { parentId2: dealId }),
      this.loadAllItems(context, 7, { dealId }),
    ]);
    const normalized = [
      ...invoiceRows.map((row) => this.normalize(row, 'bitrix_smart_invoice', context.userId)),
      ...quoteRows.map((row) => this.normalize(row, 'bitrix_quote', context.userId)),
    ].filter((row): row is NormalizedExternalDocument => row !== null);

    const uniqueItems = new Map<string, NormalizedExternalDocument>();
    let sourceDuplicatesIgnored = 0;
    for (const item of normalized) {
      const key = `${item.source}:${item.entityTypeId}:${item.externalId}`;
      if (uniqueItems.has(key)) sourceDuplicatesIgnored += 1;
      uniqueItems.set(key, item);
    }

    const syncedAt = new Date();
    const result = await this.database.transaction(async (transaction) => {
      await transaction.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`registry-bitrix-import:${context.portalUrl}`}))`,
      );
      let created = 0;
      let updated = 0;
      let unchanged = 0;
      const items: BitrixDealImportSummary['items'] = [];

      for (const item of uniqueItems.values()) {
        const config = types.get(item.typeCode)!;
        const [existing] = await transaction
          .select({
            id: registryDocuments.id,
            typeId: registryDocuments.typeId,
            number: registryDocuments.number,
            title: registryDocuments.title,
            documentDate: registryDocuments.documentDate,
            amount: registryDocuments.amount,
            currency: registryDocuments.currency,
            counterpartyId: registryDocuments.counterpartyId,
            counterpartyName: registryDocuments.counterpartyName,
            dealStageId: registryDocuments.dealStageId,
            responsibleId: registryDocuments.responsibleId,
            responsibleName: registryDocuments.responsibleName,
            externalStatus: registryDocuments.externalStatus,
            externalUpdatedAt: registryDocuments.externalUpdatedAt,
            deletedAt: registryDocuments.deletedAt,
          })
          .from(registryDocuments)
          .where(and(
            eq(registryDocuments.portalUrl, context.portalUrl),
            eq(registryDocuments.externalSource, item.source),
            eq(registryDocuments.externalEntityTypeId, item.entityTypeId),
            eq(registryDocuments.externalEntityId, item.externalId),
          ))
          .limit(1);

        const values = {
          sectionId: config.sectionId,
          typeId: config.typeId,
          number: item.number,
          title: item.title,
          documentDate: item.documentDate,
          amount: item.amount,
          currency: item.currency,
          counterpartyId: companyId,
          counterpartyName: companyName,
          dealStageId: this.nonEmptyText(deal.STAGE_ID),
          responsibleId: item.responsibleId,
          responsibleName: item.responsibleName,
          externalStatus: item.externalStatus,
          externalUpdatedAt: item.externalUpdatedAt,
          externalSyncedAt: syncedAt,
          deletedAt: null,
          deletedBy: null,
        };

        let documentId: string;
        let status: 'created' | 'updated' | 'unchanged';
        if (!existing) {
          const [inserted] = await transaction
            .insert(registryDocuments)
            .values({
              portalUrl: context.portalUrl,
              ...values,
              numberUniquenessKey: null,
              status: config.initialStatus,
              comment: 'Автоимпорт из Bitrix24',
              createdBy: context.userId,
              externalSource: item.source,
              externalEntityTypeId: item.entityTypeId,
              externalEntityId: item.externalId,
            })
            .returning({ id: registryDocuments.id });
          documentId = inserted.id;
          status = 'created';
          created += 1;
          await transaction.insert(registryAuditLog).values({
            portalUrl: context.portalUrl,
            documentId,
            event: 'bitrix_document_imported',
            actorId: context.userId,
            after: {
              source: item.source,
              entityTypeId: item.entityTypeId,
              externalId: item.externalId,
              dealId,
            },
          });
        } else {
          documentId = existing.id;
          const changed = this.hasChanges(existing, values);
          status = changed ? 'updated' : 'unchanged';
          if (changed) updated += 1;
          else unchanged += 1;
          await transaction
            .update(registryDocuments)
            .set(changed
              ? { ...values, updatedBy: context.userId, updatedAt: syncedAt }
              : { externalSyncedAt: syncedAt })
            .where(and(
              eq(registryDocuments.portalUrl, context.portalUrl),
              eq(registryDocuments.id, documentId),
            ));
          if (changed) {
            await transaction.insert(registryAuditLog).values({
              portalUrl: context.portalUrl,
              documentId,
              event: 'bitrix_document_synchronized',
              actorId: context.userId,
              before: existing,
              after: {
                source: item.source,
                entityTypeId: item.entityTypeId,
                externalId: item.externalId,
                dealId,
                ...values,
              },
            });
          }
        }

        await transaction
          .delete(registryDocumentLinks)
          .where(and(
            eq(registryDocumentLinks.portalUrl, context.portalUrl),
            eq(registryDocumentLinks.documentId, documentId),
            eq(registryDocumentLinks.entityType, 'deal'),
            ne(registryDocumentLinks.entityId, dealId),
          ));
        await transaction
          .insert(registryDocumentLinks)
          .values({
            portalUrl: context.portalUrl,
            documentId,
            entityType: 'deal',
            entityId: dealId,
            entityTitle: dealTitle,
            linkRole: 'bitrix_import',
            dealClosed: String(deal.CLOSED || '').toUpperCase() === 'Y',
            dealStateCheckedAt: syncedAt,
          })
          .onConflictDoUpdate({
            target: [
              registryDocumentLinks.portalUrl,
              registryDocumentLinks.documentId,
              registryDocumentLinks.entityType,
              registryDocumentLinks.entityId,
            ],
            set: {
              entityTitle: dealTitle,
              linkRole: 'bitrix_import',
              dealClosed: String(deal.CLOSED || '').toUpperCase() === 'Y',
              dealStateCheckedAt: syncedAt,
            },
          });
        items.push({
          documentId,
          source: item.source,
          entityTypeId: item.entityTypeId,
          externalId: item.externalId,
          typeCode: item.typeCode,
          status,
        });
      }

      return { created, updated, unchanged, items };
    });

    return {
      dealId,
      ...result,
      duplicates: 0,
      sourceDuplicatesIgnored,
      syncedAt: syncedAt.toISOString(),
    };
  }

  private async loadAndAuthorizeTypes(context: RegistryContext) {
    const policy = await loadRegistryPolicy(this.database, context);
    assertSectionVisible(policy, 'client');
    const rows = await this.database
      .select({
        sectionId: registrySections.id,
        sectionCode: registrySections.code,
        typeId: registryDocumentTypes.id,
        typeCode: registryDocumentTypes.code,
        lifecycle: registryLifecycles.config,
      })
      .from(registryDocumentTypes)
      .innerJoin(
        registryDocumentTypeSections,
        eq(registryDocumentTypes.id, registryDocumentTypeSections.typeId),
      )
      .innerJoin(registrySections, eq(registryDocumentTypeSections.sectionId, registrySections.id))
      .innerJoin(registryLifecycles, eq(registryDocumentTypes.lifecycleId, registryLifecycles.id))
      .where(and(
        eq(registryDocumentTypes.portalUrl, context.portalUrl),
        eq(registryDocumentTypeSections.portalUrl, context.portalUrl),
        eq(registrySections.portalUrl, context.portalUrl),
        eq(registryLifecycles.portalUrl, context.portalUrl),
        eq(registrySections.code, 'client'),
        inArray(registryDocumentTypes.code, ['client_invoice', 'client_quote']),
        eq(registryDocumentTypes.isActive, true),
        eq(registrySections.isActive, true),
        eq(registryLifecycles.isActive, true),
      ));
    if (rows.length !== 2) {
      throw new ApiError(
        409,
        'bitrix_import_catalog_missing',
        'Invoice or quote document type is not configured.',
      );
    }
    const configurations = new Map<string, ImportTypeConfiguration>();
    for (const row of rows) {
      assertTypeVisible(policy, row.typeCode);
      if (!isTypePermissionGranted(
        policy,
        row.typeCode,
        'create',
        policy.permissions.create,
      )) {
        throw new ApiError(
          403,
          'bitrix_import_access_denied',
          'The current role cannot import this document type.',
          { typeCode: row.typeCode },
        );
      }
      if (isMoneyHidden(policy, row.typeCode)) {
        throw new ApiError(
          403,
          'financial_document_create_denied',
          'A role with hidden financial data cannot synchronize Bitrix24 financial cards.',
          { typeCode: row.typeCode },
        );
      }
      configurations.set(row.typeCode, {
        sectionId: row.sectionId,
        typeId: row.typeId,
        typeCode: row.typeCode,
        initialStatus: (row.lifecycle as LifecycleConfig).initialStatus,
      });
    }
    return configurations;
  }

  private async loadAllItems(
    context: RegistryContext,
    entityTypeId: number,
    filter: Record<string, number>,
  ) {
    const items: Array<Record<string, unknown>> = [];
    for (let page = 0; page < MAX_SOURCE_PAGES; page += 1) {
      const result = await this.call<BitrixItemListResult>(context, 'crm.item.list', {
        entityTypeId,
        select: ['*'],
        filter,
        order: { id: 'ASC' },
        start: page * BITRIX_PAGE_SIZE,
      });
      if (!result || !Array.isArray(result.items)) {
        throw new ApiError(
          502,
          'bitrix_import_response_invalid',
          'Bitrix24 returned an invalid CRM item list.',
          { entityTypeId },
        );
      }
      items.push(...result.items);
      if (result.items.length < BITRIX_PAGE_SIZE) return items;
    }
    throw new ApiError(
      409,
      'bitrix_import_limit_exceeded',
      'The deal contains too many invoices or quotes for one synchronization.',
      { entityTypeId, limit: BITRIX_PAGE_SIZE * MAX_SOURCE_PAGES },
    );
  }

  private normalize(
    item: Record<string, unknown>,
    source: ExternalSource,
    fallbackResponsibleId: number,
  ): NormalizedExternalDocument | null {
    const entityTypeId = source === 'bitrix_smart_invoice' ? 31 : 7;
    const externalId = this.positiveId(this.read(item, 'id', 'ID'));
    if (!externalId) return null;
    const isInvoice = source === 'bitrix_smart_invoice';
    const fallbackPrefix = isInvoice ? 'Счёт' : 'КП';
    const number = this.nonEmptyText(this.read(
      item,
      isInvoice ? 'accountNumber' : 'quoteNumber',
      isInvoice ? 'ACCOUNT_NUMBER' : 'QUOTE_NUMBER',
    )) || `${isInvoice ? 'SI' : 'КП'}-${externalId}`;
    const title = this.nonEmptyText(this.read(item, 'title', 'TITLE'))
      || `${fallbackPrefix} Bitrix24 #${externalId}`;
    const documentDate = this.isoDate(
      this.read(item, 'begindate', 'beginDate', 'BEGINDATE', 'createdTime', 'dateCreate', 'DATE_CREATE'),
    ) || new Date().toISOString().slice(0, 10);
    const currencyCandidate = this.nonEmptyText(this.read(item, 'currencyId', 'CURRENCY_ID'))
      ?.toUpperCase();
    const currency = currencyCandidate && /^[A-Z]{3}$/.test(currencyCandidate)
      ? currencyCandidate
      : null;
    const amount = this.money(this.read(item, 'opportunity', 'OPPORTUNITY'));
    const responsibleId = this.positiveId(
      this.read(item, 'assignedById', 'ASSIGNED_BY_ID'),
    ) || fallbackResponsibleId;
    return {
      source,
      entityTypeId,
      externalId,
      externalStatus: this.nonEmptyText(this.read(item, 'stageId', 'statusId', 'STATUS_ID')),
      externalUpdatedAt: this.dateTime(
        this.read(item, 'updatedTime', 'dateModify', 'DATE_MODIFY'),
      ),
      number,
      title,
      documentDate,
      amount: amount !== null && currency ? amount : null,
      currency: amount !== null && currency ? currency : null,
      responsibleId,
      responsibleName: `Пользователь #${responsibleId}`,
      typeCode: isInvoice ? 'client_invoice' : 'client_quote',
    };
  }

  private hasChanges(
    current: Record<string, unknown>,
    next: Record<string, unknown>,
  ) {
    const scalarKeys = [
      'typeId',
      'number',
      'title',
      'documentDate',
      'amount',
      'currency',
      'counterpartyId',
      'counterpartyName',
      'dealStageId',
      'responsibleId',
      'responsibleName',
      'externalStatus',
    ];
    if (scalarKeys.some((key) => String(current[key] ?? '') !== String(next[key] ?? ''))) {
      return true;
    }
    const currentUpdated = current.externalUpdatedAt instanceof Date
      ? current.externalUpdatedAt.getTime()
      : current.externalUpdatedAt
        ? new Date(String(current.externalUpdatedAt)).getTime()
        : null;
    const nextUpdated = next.externalUpdatedAt instanceof Date
      ? next.externalUpdatedAt.getTime()
      : next.externalUpdatedAt
        ? new Date(String(next.externalUpdatedAt)).getTime()
        : null;
    return currentUpdated !== nextUpdated || current.deletedAt !== null;
  }

  private read(item: Record<string, unknown>, ...keys: string[]) {
    for (const key of keys) {
      if (item[key] !== undefined && item[key] !== null) return item[key];
    }
    return undefined;
  }

  private positiveId(value: unknown) {
    const number = Number(value);
    return Number.isSafeInteger(number) && number > 0 ? number : null;
  }

  private nonEmptyText(value: unknown) {
    if (typeof value !== 'string' && typeof value !== 'number') return null;
    const text = String(value).trim();
    return text ? text.slice(0, 1000) : null;
  }

  private isoDate(value: unknown) {
    if (typeof value !== 'string') return null;
    const match = /^(\d{4}-\d{2}-\d{2})/.exec(value.trim());
    if (!match) return null;
    const parsed = new Date(`${match[1]}T00:00:00.000Z`);
    return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== match[1]
      ? null
      : match[1];
  }

  private dateTime(value: unknown) {
    if (typeof value !== 'string') return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  private money(value: unknown) {
    if (value === null || value === undefined || value === '') return null;
    const amount = Number(String(value).replace(',', '.'));
    return Number.isFinite(amount) && amount >= 0 ? amount.toFixed(2) : null;
  }

  private call<T>(context: RegistryContext, method: string, params: object) {
    return this.bitrix.call<T>(
      context.bitrix!.domain,
      context.bitrix!.accessToken,
      method,
      params,
    );
  }
}
