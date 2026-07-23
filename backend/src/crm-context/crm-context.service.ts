import type { BitrixApiClient } from '../bitrix/bitrix-client.js';
import type { RegistryContext } from '../http/registry-context.js';
import type { DocumentEntityReference } from '../documents/documents.service.js';

interface BitrixDeal {
  ID?: string | number;
  TITLE?: string;
  COMPANY_ID?: string | number;
  STAGE_ID?: string;
}

interface BitrixCompany {
  ID?: string | number;
  TITLE?: string;
}

interface BitrixStatus {
  STATUS_ID?: string;
  NAME?: string;
  COLOR?: string;
}

export interface CrmDealContext {
  id: number;
  title: string;
  companyId: number | null;
  stageId: string | null;
  stageName: string;
  stageColor: string;
}

export interface CrmEntityContext {
  entityType: 'deal' | 'company';
  entityId: number;
  entityTitle: string;
  company: { id: number; title: string } | null;
  deal: CrmDealContext | null;
  deals: CrmDealContext[];
  references: DocumentEntityReference[];
  syncUnavailable: boolean;
}

const FALLBACK_STAGE_COLOR = '#d97706';
const BITRIX_PAGE_SIZE = 50;
const MAX_DEAL_PAGES = 20;

export class CrmContextService {
  constructor(private readonly bitrix: BitrixApiClient) {}

  async resolve(
    context: RegistryContext,
    entityType: 'deal' | 'company',
    entityId: number,
  ): Promise<CrmEntityContext> {
    const fallback = this.fallback(entityType, entityId);
    if (!context.bitrix) return fallback;

    try {
      return entityType === 'deal'
        ? await this.resolveDeal(context, entityId)
        : await this.resolveCompany(context, entityId);
    } catch {
      return { ...fallback, syncUnavailable: true };
    }
  }

  async resolveEntityTitle(
    context: RegistryContext,
    entityType: 'deal' | 'company',
    entityId: number,
    fallbackTitle?: string,
  ) {
    const defaultTitle = fallbackTitle || this.defaultTitle(entityType, entityId);
    if (!context.bitrix) return defaultTitle;
    try {
      if (entityType === 'deal') {
        const deal = await this.call<BitrixDeal>(context, 'crm.deal.get', { id: entityId });
        return this.entityTitle(deal.TITLE, defaultTitle);
      }
      const company = await this.call<BitrixCompany>(context, 'crm.company.get', { id: entityId });
      return this.entityTitle(company.TITLE, defaultTitle);
    } catch {
      return defaultTitle;
    }
  }

  private async resolveDeal(context: RegistryContext, entityId: number): Promise<CrmEntityContext> {
    const deal = await this.call<BitrixDeal>(context, 'crm.deal.get', { id: entityId });
    const dealId = this.positiveId(deal.ID) || entityId;
    const companyId = this.positiveId(deal.COMPANY_ID);
    const [company, stages] = await Promise.all([
      companyId
        ? this.call<BitrixCompany>(context, 'crm.company.get', { id: companyId }).catch(() => null)
        : Promise.resolve(null),
      this.loadStageMap(context).catch(() => new Map<string, BitrixStatus>()),
    ]);
    const normalizedDeal = this.normalizeDeal(deal, dealId, stages);
    const companyTitle = companyId
      ? this.entityTitle(company?.TITLE, this.defaultTitle('company', companyId))
      : null;
    const references: DocumentEntityReference[] = [{ entityType: 'deal', entityId: dealId }];
    if (companyId) references.push({ entityType: 'company', entityId: companyId });
    return {
      entityType: 'deal',
      entityId: dealId,
      entityTitle: normalizedDeal.title,
      company: companyId ? { id: companyId, title: companyTitle! } : null,
      deal: normalizedDeal,
      deals: [normalizedDeal],
      references,
      syncUnavailable: false,
    };
  }

  private async resolveCompany(
    context: RegistryContext,
    entityId: number,
  ): Promise<CrmEntityContext> {
    const [company, rawDeals, stages] = await Promise.all([
      this.call<BitrixCompany>(context, 'crm.company.get', { id: entityId }),
      this.loadCompanyDeals(context, entityId),
      this.loadStageMap(context).catch(() => new Map<string, BitrixStatus>()),
    ]);
    const companyId = this.positiveId(company.ID) || entityId;
    const companyTitle = this.entityTitle(company.TITLE, this.defaultTitle('company', companyId));
    const deals = rawDeals.map((deal) =>
      this.normalizeDeal(deal, this.positiveId(deal.ID)!, stages),
    );
    return {
      entityType: 'company',
      entityId: companyId,
      entityTitle: companyTitle,
      company: { id: companyId, title: companyTitle },
      deal: null,
      deals,
      references: [
        { entityType: 'company', entityId: companyId },
        ...deals.map((deal) => ({ entityType: 'deal' as const, entityId: deal.id })),
      ],
      syncUnavailable: false,
    };
  }

  private async loadCompanyDeals(context: RegistryContext, companyId: number) {
    const deals: BitrixDeal[] = [];
    for (let page = 0; page < MAX_DEAL_PAGES; page += 1) {
      const items = await this.call<BitrixDeal[]>(context, 'crm.deal.list', {
        order: { ID: 'ASC' },
        filter: { COMPANY_ID: companyId },
        select: ['ID', 'TITLE', 'COMPANY_ID', 'STAGE_ID'],
        start: page * BITRIX_PAGE_SIZE,
      });
      const validItems = items.filter((item) => this.positiveId(item.ID));
      deals.push(...validItems);
      if (items.length < BITRIX_PAGE_SIZE) break;
    }
    return deals;
  }

  private async loadStageMap(context: RegistryContext) {
    const rows = await this.call<BitrixStatus[]>(context, 'crm.status.list', {
      order: { SORT: 'ASC' },
      filter: {},
    });
    return new Map(
      rows
        .filter((row) => typeof row.STATUS_ID === 'string' && row.STATUS_ID)
        .map((row) => [row.STATUS_ID!, row]),
    );
  }

  private normalizeDeal(
    deal: BitrixDeal,
    id: number,
    stages: Map<string, BitrixStatus>,
  ): CrmDealContext {
    const stageId = typeof deal.STAGE_ID === 'string' && deal.STAGE_ID ? deal.STAGE_ID : null;
    const stage = stageId ? stages.get(stageId) : undefined;
    return {
      id,
      title: this.entityTitle(deal.TITLE, this.defaultTitle('deal', id)),
      companyId: this.positiveId(deal.COMPANY_ID),
      stageId,
      stageName: this.entityTitle(stage?.NAME, stageId || 'Не указана'),
      stageColor: this.validColor(stage?.COLOR) || FALLBACK_STAGE_COLOR,
    };
  }

  private fallback(entityType: 'deal' | 'company', entityId: number): CrmEntityContext {
    const entityTitle = this.defaultTitle(entityType, entityId);
    const deal = entityType === 'deal'
      ? {
          id: entityId,
          title: entityTitle,
          companyId: null,
          stageId: null,
          stageName: 'Не указана',
          stageColor: FALLBACK_STAGE_COLOR,
        }
      : null;
    return {
      entityType,
      entityId,
      entityTitle,
      company: entityType === 'company' ? { id: entityId, title: entityTitle } : null,
      deal,
      deals: deal ? [deal] : [],
      references: [{ entityType, entityId }],
      syncUnavailable: false,
    };
  }

  private call<T>(context: RegistryContext, method: string, params: object) {
    return this.bitrix.call<T>(
      context.bitrix!.domain,
      context.bitrix!.accessToken,
      method,
      params,
    );
  }

  private positiveId(value: unknown) {
    const id = Number(value);
    return Number.isSafeInteger(id) && id > 0 ? id : null;
  }

  private entityTitle(value: unknown, fallback: string) {
    return typeof value === 'string' && value.trim() ? value.trim().slice(0, 500) : fallback;
  }

  private defaultTitle(entityType: 'deal' | 'company', entityId: number) {
    return entityType === 'deal' ? `Сделка #${entityId}` : `Компания #${entityId}`;
  }

  private validColor(value: unknown) {
    return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value : null;
  }
}
