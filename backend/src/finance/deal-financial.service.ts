import {
  and,
  asc,
  eq,
  inArray,
  isNull,
  ne,
  notInArray,
  type SQL,
} from 'drizzle-orm';

import type { BitrixApiClient } from '../bitrix/bitrix-client.js';
import type { Database } from '../db/database.js';
import {
  registryDocumentLinks,
  registryDocumentTypeSections,
  registryDocuments,
  registryDocumentTypes,
  registrySections,
} from '../db/schema/index.js';
import { ApiError } from '../http/api-error.js';
import type { RegistryContext } from '../http/registry-context.js';
import { CrmEntityAccessService } from '../permissions/crm-entity-access.service.js';
import { SalesDealAccessService } from '../permissions/sales-deal-access.service.js';
import {
  isMoneyHidden,
  isTypePermissionAllowed,
  loadRegistryPolicy,
} from '../permissions/policy.service.js';
import type { ExchangeRateProvider } from './cbr-rates.service.js';

interface BitrixDealIdentity {
  ID?: string | number;
}

export class DealFinancialService {
  private readonly crmEntityAccess: CrmEntityAccessService;
  private readonly salesDealAccess: SalesDealAccessService;

  constructor(
    private readonly database: Database,
    private readonly bitrix: BitrixApiClient,
    private readonly rates: ExchangeRateProvider,
  ) {
    this.crmEntityAccess = new CrmEntityAccessService(database, bitrix);
    this.salesDealAccess = new SalesDealAccessService(database, bitrix);
  }

  async summarize(
    context: RegistryContext,
    dealId: number,
    targetCurrency: string,
    requestedFilters: { sections: string[]; types: string[] } = { sections: [], types: [] },
  ) {
    targetCurrency = targetCurrency.trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(targetCurrency)) {
      throw new ApiError(400, 'currency_invalid', 'Currency code is invalid.');
    }
    await this.assertBitrixDealAccess(context, dealId);
    const policy = await loadRegistryPolicy(this.database, context);
    const crmEntityScope = await this.crmEntityAccess.prepare(context);
    const salesDealScope = await this.salesDealAccess.prepare(context);
    const availableFilters = await this.loadAvailableFilters(context, policy);
    if (!availableFilters.sections.length || !availableFilters.types.length) {
      throw new ApiError(
        403,
        'deal_financial_summary_access_denied',
        'The financial summary is hidden by document type policy.',
      );
    }
    const appliedSections = resolveFinancialFilter(
      requestedFilters.sections,
      availableFilters.sections.map((section) => section.code),
    );
    const appliedTypes = resolveFinancialFilter(
      requestedFilters.types,
      availableFilters.types.map((type) => type.code),
    );
    const filters = { sections: appliedSections, types: appliedTypes };
    if (!appliedSections.length || !appliedTypes.length) {
      return this.emptySummary(dealId, targetCurrency, filters, availableFilters);
    }

    const conditions: SQL[] = [
      eq(registryDocuments.portalUrl, context.portalUrl),
      eq(registryDocuments.isFinalized, true),
      isNull(registryDocuments.deletedAt),
      ne(registryDocuments.status, 'archived'),
      eq(registryDocumentLinks.portalUrl, context.portalUrl),
      eq(registryDocumentLinks.entityType, 'deal'),
      eq(registryDocumentLinks.entityId, dealId),
      inArray(registrySections.code, appliedSections),
      inArray(registryDocumentTypes.code, appliedTypes),
      eq(registryDocumentTypes.isFinancial, true),
    ];
    if (crmEntityScope) conditions.push(crmEntityScope);
    if (salesDealScope) conditions.push(salesDealScope);
    if (policy.visibleTypeCodes) {
      conditions.push(inArray(registryDocumentTypes.code, policy.visibleTypeCodes));
    }
    const hiddenTypeCodes = Object.entries(policy.permissions.byType ?? {})
      .filter(([, permissions]) => permissions.view === false)
      .map(([typeCode]) => typeCode);
    if (hiddenTypeCodes.length) {
      conditions.push(notInArray(registryDocumentTypes.code, hiddenTypeCodes));
    }

    const rawRows = await this.database
      .select({
        id: registryDocuments.id,
        number: registryDocuments.number,
        title: registryDocuments.title,
        documentDate: registryDocuments.documentDate,
        amount: registryDocuments.amount,
        currency: registryDocuments.currency,
        sectionCode: registrySections.code,
        sectionName: registrySections.name,
        typeCode: registryDocumentTypes.code,
        typeName: registryDocumentTypes.name,
      })
      .from(registryDocuments)
      .innerJoin(
        registryDocumentLinks,
        eq(registryDocuments.id, registryDocumentLinks.documentId),
      )
      .innerJoin(registrySections, eq(registryDocuments.sectionId, registrySections.id))
      .innerJoin(registryDocumentTypes, eq(registryDocuments.typeId, registryDocumentTypes.id))
      .where(and(...conditions))
      .orderBy(registryDocuments.documentDate, registryDocuments.createdAt);
    const rows = deduplicateFinancialRows(rawRows);

    const financeDenied = rows.filter((row) =>
      !isTypePermissionAllowed(policy, row.typeCode, 'finance')
      || isMoneyHidden(policy, row.typeCode));
    if (financeDenied.length) {
      throw new ApiError(
        403,
        'deal_financial_summary_access_denied',
        'The financial summary is hidden by document type policy.',
        { deniedTypeCodes: [...new Set(financeDenied.map((row) => row.typeCode))] },
      );
    }
    if (!rows.length) {
      return this.emptySummary(dealId, targetCurrency, filters, availableFilters);
    }

    const currenciesByDate = new Map<string, Set<string>>();
    for (const row of rows) {
      if (row.amount === null) continue;
      const currency = row.currency?.toUpperCase();
      if (!currency) {
        throw new ApiError(
          409,
          'financial_currency_missing',
          'A document with an amount has no currency.',
          { documentId: row.id },
        );
      }
      const currencies = currenciesByDate.get(row.documentDate) ?? new Set<string>();
      currencies.add(currency);
      currencies.add(targetCurrency);
      currenciesByDate.set(row.documentDate, currencies);
    }
    const ratesByDate = new Map<string, Awaited<ReturnType<ExchangeRateProvider['getRates']>>>();
    const rateRequests = [...currenciesByDate];
    for (let offset = 0; offset < rateRequests.length; offset += 4) {
      const batch = rateRequests.slice(offset, offset + 4);
      const resolved = await Promise.all(batch.map(async ([date, currencies]) => [
        date,
        await this.rates.getRates(context.portalUrl, date, [...currencies]),
      ] as const));
      for (const [date, quotes] of resolved) ratesByDate.set(date, quotes);
    }

    let totalMinor = 0n;
    const details = rows.map((row) => {
      const emptyAmount = row.amount === null;
      let originalMinor = 0n;
      try {
        originalMinor = emptyAmount ? 0n : decimalToMinor(row.amount!, 2);
      } catch {
        throw new ApiError(409, 'financial_amount_invalid', 'Document amount is invalid.', {
          documentId: row.id,
        });
      }
      if (emptyAmount) {
        return {
          documentId: row.id,
          number: row.number,
          title: row.title,
          sectionCode: row.sectionCode,
          sectionName: row.sectionName,
          typeCode: row.typeCode,
          typeName: row.typeName,
          documentDate: row.documentDate,
          emptyAmount: true,
          originalAmount: '0.00',
          originalCurrency: null,
          sourceRate: null,
          targetRate: null,
          conversionRate: null,
          rateDate: null,
          convertedAmount: '0.00',
          targetCurrency,
        };
      }
      const originalCurrency = row.currency!.toUpperCase();
      const dailyRates = ratesByDate.get(row.documentDate)!;
      const source = dailyRates.get(originalCurrency);
      const target = dailyRates.get(targetCurrency);
      if (!source || !target) {
        throw new ApiError(503, 'cbr_rates_incomplete', 'Required exchange rates are missing.');
      }
      const conversionRate = source.rubPerUnit / target.rubPerUnit;
      const convertedMinor = divideRounded(
        originalMinor
          * decimalToMinor(source.rubValue.toFixed(8), 8)
          * BigInt(target.nominal),
        BigInt(source.nominal)
          * decimalToMinor(target.rubValue.toFixed(8), 8),
      );
      totalMinor += convertedMinor;
      return {
        documentId: row.id,
        number: row.number,
        title: row.title,
        sectionCode: row.sectionCode,
        sectionName: row.sectionName,
        typeCode: row.typeCode,
        typeName: row.typeName,
        documentDate: row.documentDate,
        emptyAmount: false,
        originalAmount: formatMinor(originalMinor, 2),
        originalCurrency,
        sourceRate: source.rubPerUnit.toFixed(8),
        targetRate: target.rubPerUnit.toFixed(8),
        conversionRate: conversionRate.toFixed(10),
        rateDate: source.rateDate,
        convertedAmount: formatMinor(convertedMinor, 2),
        targetCurrency,
      };
    });
    return {
      dealId,
      targetCurrency,
      total: formatMinor(totalMinor, 2),
      documentCount: details.length,
      zeroAmountCount: details.filter((row) => row.emptyAmount).length,
      source: 'CBR',
      filters,
      availableFilters,
      details,
    };
  }

  private async loadAvailableFilters(
    context: RegistryContext,
    policy: Awaited<ReturnType<typeof loadRegistryPolicy>>,
  ) {
    if (!policy.visibleSectionCodes.length) return { sections: [], types: [] };
    const rows = await this.database
      .selectDistinct({
        sectionCode: registrySections.code,
        sectionName: registrySections.name,
        sectionSortOrder: registrySections.sortOrder,
        typeCode: registryDocumentTypes.code,
        typeName: registryDocumentTypes.name,
        typeSortOrder: registryDocumentTypes.sortOrder,
      })
      .from(registryDocumentTypes)
      .innerJoin(
        registryDocumentTypeSections,
        and(
          eq(registryDocumentTypeSections.typeId, registryDocumentTypes.id),
          eq(registryDocumentTypeSections.portalUrl, context.portalUrl),
        ),
      )
      .innerJoin(registrySections, eq(registryDocumentTypeSections.sectionId, registrySections.id))
      .where(and(
        eq(registryDocumentTypes.portalUrl, context.portalUrl),
        eq(registrySections.portalUrl, context.portalUrl),
        eq(registryDocumentTypes.isActive, true),
        eq(registrySections.isActive, true),
        eq(registryDocumentTypes.isFinancial, true),
        inArray(registrySections.code, policy.visibleSectionCodes),
        ...(policy.visibleTypeCodes
          ? [inArray(registryDocumentTypes.code, policy.visibleTypeCodes)]
          : []),
      ))
      .orderBy(
        asc(registrySections.sortOrder),
        asc(registryDocumentTypes.sortOrder),
        asc(registryDocumentTypes.name),
      );
    const permitted = rows.filter((row) =>
      isTypePermissionAllowed(policy, row.typeCode, 'view')
      && isTypePermissionAllowed(policy, row.typeCode, 'finance')
      && !isMoneyHidden(policy, row.typeCode));
    const sections = new Map<string, { code: string; name: string; sortOrder: number }>();
    const types = new Map<string, {
      code: string;
      name: string;
      sortOrder: number;
      sectionCodes: string[];
    }>();
    for (const row of permitted) {
      sections.set(row.sectionCode, {
        code: row.sectionCode,
        name: row.sectionName,
        sortOrder: row.sectionSortOrder,
      });
      const type = types.get(row.typeCode) ?? {
        code: row.typeCode,
        name: row.typeName,
        sortOrder: row.typeSortOrder,
        sectionCodes: [],
      };
      if (!type.sectionCodes.includes(row.sectionCode)) type.sectionCodes.push(row.sectionCode);
      types.set(row.typeCode, type);
    }
    return { sections: [...sections.values()], types: [...types.values()] };
  }

  private async assertBitrixDealAccess(context: RegistryContext, dealId: number) {
    if (!context.bitrix) return;
    const deal = await this.bitrix.call<BitrixDealIdentity>(
      context.bitrix.domain,
      context.bitrix.accessToken,
      'crm.deal.get',
      { id: dealId },
    );
    if (Number(deal.ID) !== dealId) {
      throw new ApiError(403, 'bitrix_deal_access_denied', 'The Bitrix24 deal is unavailable.');
    }
  }

  private emptySummary(
    dealId: number,
    targetCurrency: string,
    filters: { sections: string[]; types: string[] },
    availableFilters: {
      sections: Array<{ code: string; name: string }>;
      types: Array<{ code: string; name: string; sectionCodes: string[] }>;
    },
  ) {
    return {
      dealId,
      targetCurrency,
      total: '0.00',
      documentCount: 0,
      zeroAmountCount: 0,
      source: 'CBR',
      filters,
      availableFilters,
      details: [],
    };
  }
}

export function resolveFinancialFilter(requested: string[], available: string[]) {
  const availableSet = new Set(available);
  const selected = requested.length ? requested : available;
  return [...new Set(selected.filter((code) => availableSet.has(code)))];
}

export function deduplicateFinancialRows<T extends { id: string }>(rows: T[]) {
  return [...new Map(rows.map((row) => [row.id, row])).values()];
}

function decimalToMinor(value: string, scale: number) {
  const normalized = value.trim();
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(normalized);
  if (!match) throw new Error('invalid decimal');
  const fraction = (match[3] || '').padEnd(scale, '0');
  if (fraction.length > scale) throw new Error('invalid scale');
  const minor = BigInt(match[2]) * (10n ** BigInt(scale)) + BigInt(fraction || '0');
  return match[1] ? -minor : minor;
}

function divideRounded(numerator: bigint, denominator: bigint) {
  if (denominator <= 0n) throw new Error('invalid denominator');
  const negative = numerator < 0n;
  const absolute = negative ? -numerator : numerator;
  const quotient = absolute / denominator;
  const remainder = absolute % denominator;
  const rounded = quotient + (remainder * 2n >= denominator ? 1n : 0n);
  return negative ? -rounded : rounded;
}

function formatMinor(value: bigint, scale: number) {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const base = 10n ** BigInt(scale);
  return `${negative ? '-' : ''}${absolute / base}.${String(absolute % base).padStart(scale, '0')}`;
}
