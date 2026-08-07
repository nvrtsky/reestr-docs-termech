import type { BitrixApiClient } from '../bitrix/bitrix-client.js';
import type { RegistryContext } from '../http/registry-context.js';
import type { DocumentEntityReference } from '../documents/documents.service.js';
import { ApiError } from '../http/api-error.js';

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

interface BitrixTask {
  ID?: string | number;
  TITLE?: string;
  id?: string | number;
  title?: string;
}

interface BitrixTaskResult {
  item?: BitrixTask;
  items?: BitrixTask[];
  task?: BitrixTask;
  tasks?: BitrixTask[];
}

interface BitrixUser {
  ID?: string | number;
  NAME?: string;
  LAST_NAME?: string;
  SECOND_NAME?: string;
  ACTIVE?: string | boolean | number;
}

export interface CrmDealSelection {
  id: number;
  title: string;
  /** undefined means that a live Bitrix24 lookup was unavailable. */
  companyId: number | null | undefined;
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
const BITRIX_V3_TASK_PAGE_SIZE = 1_000;
const MAX_TASK_SEARCH_PAGES = 50;

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
    if (entityType === 'deal') {
      const deal = await this.call<BitrixDeal>(context, 'crm.deal.get', { id: entityId });
      return this.entityTitle(deal.TITLE, defaultTitle);
    }
    const company = await this.call<BitrixCompany>(context, 'crm.company.get', { id: entityId });
    return this.entityTitle(company.TITLE, defaultTitle);
  }

  async resolveDealSelection(
    context: RegistryContext,
    dealId: number,
    fallbackTitle?: string | null,
  ): Promise<CrmDealSelection> {
    const defaultTitle = fallbackTitle || this.defaultTitle('deal', dealId);
    if (!context.bitrix) {
      return { id: dealId, title: defaultTitle, companyId: undefined };
    }
    const deal = await this.call<BitrixDeal>(context, 'crm.deal.get', { id: dealId });
    const resolvedId = this.positiveId(deal.ID) || dealId;
    return {
      id: resolvedId,
      title: this.entityTitle(deal.TITLE, defaultTitle),
      companyId: this.positiveId(deal.COMPANY_ID),
    };
  }

  async resolveCompanySelection(
    context: RegistryContext,
    companyId: number,
    fallbackTitle?: string | null,
  ) {
    const title = await this.resolveEntityTitle(
      context,
      'company',
      companyId,
      fallbackTitle || undefined,
    );
    return { id: companyId, title };
  }

  async resolveTaskSelection(
    context: RegistryContext,
    taskId: number,
    fallbackTitle?: string,
  ) {
    const defaultTitle = fallbackTitle || `Задача #${taskId}`;
    if (!context.bitrix) return { id: taskId, title: defaultTitle };
    const taskApiVersion = await this.taskApiVersion(context);
    const result = await this.call<BitrixTask | BitrixTaskResult>(
      context,
      'tasks.task.get',
      taskApiVersion === 'v3'
        ? { id: taskId, select: ['id', 'title'] }
        : { taskId, select: ['ID', 'TITLE'] },
      taskApiVersion,
    );
    const rawTask = result && typeof result === 'object'
      ? ('item' in result
          ? result.item
          : ('task' in result ? result.task : result as BitrixTask))
      : result as BitrixTask;
    const resolvedId = this.positiveId(rawTask?.id ?? rawTask?.ID) || taskId;
    return {
      id: resolvedId,
      title: this.entityTitle(rawTask?.title ?? rawTask?.TITLE, defaultTitle),
    };
  }

  async resolveUserSelection(
    context: RegistryContext,
    userId: number,
    fallbackName?: string | null,
  ) {
    const defaultName = fallbackName || `Пользователь #${userId}`;
    if (!context.bitrix) return { id: userId, name: defaultName };
    const result = await this.call<BitrixUser[]>(context, 'user.get', {
      FILTER: { ID: userId },
      start: 0,
    });
    const user = result.find((item) => this.positiveId(item.ID) === userId);
    const active = user?.ACTIVE;
    if (
      !user
      || active === false
      || active === 0
      || (typeof active === 'string' && ['n', '0', 'false'].includes(active.toLowerCase()))
    ) {
      throw new ApiError(
        400,
        'bitrix_responsible_not_found',
        'The responsible user was not found or is inactive in Bitrix24.',
        { userId },
      );
    }
    const name = [user.LAST_NAME, user.NAME, user.SECOND_NAME]
      .filter((part): part is string => typeof part === 'string' && !!part.trim())
      .map((part) => part.trim())
      .join(' ');
    return { id: userId, name: this.entityTitle(name, defaultName) };
  }

  async searchTasks(context: RegistryContext, search: string, limit: number) {
    if (!context.bitrix) return [];
    const taskApiVersion = await this.taskApiVersion(context);
    const normalizedSearch = search.trim().toLocaleLowerCase('ru');
    const exactTaskId = /^\d+$/.test(normalizedSearch)
      ? this.positiveId(normalizedSearch)
      : null;

    if (taskApiVersion === 'legacy') {
      const result = await this.call<BitrixTask[] | BitrixTaskResult>(
        context,
        'tasks.task.list',
        {
          order: { ID: 'DESC' },
          filter: exactTaskId
            ? { ID: exactTaskId }
            : (normalizedSearch ? { TITLE: `%${search.trim()}%` } : {}),
          select: ['ID', 'TITLE'],
          start: 0,
        },
        taskApiVersion,
      );
      const tasks = Array.isArray(result) ? result : result.tasks || result.items || [];
      return this.normalizeTasks(tasks)
        .filter((task) => !normalizedSearch
          || task.id === exactTaskId
          || task.title.toLocaleLowerCase('ru').includes(normalizedSearch))
        .slice(0, limit);
    }

    // REST v3 only supports filtering tasks by `id`. Resolve an entered numeric
    // identifier directly; for title search, scan the accessible pages and
    // apply the case-insensitive title filter locally.
    if (exactTaskId) {
      const result = await this.call<BitrixTask[] | BitrixTaskResult>(
        context,
        'tasks.task.list',
        {
          order: { id: 'DESC' },
          filter: [['id', exactTaskId]],
          select: ['id', 'title'],
          pagination: { page: 1, limit: 1, offset: 0 },
        },
        taskApiVersion,
      );
      const tasks = Array.isArray(result) ? result : result.items || result.tasks || [];
      return this.normalizeTasks(tasks)
        .filter((task) => task.id === exactTaskId)
        .slice(0, limit);
    }

    const matches = new Map<number, { id: number; title: string }>();
    let cursorId = 0;
    for (let page = 1; page <= MAX_TASK_SEARCH_PAGES; page += 1) {
      const result = await this.call<BitrixTask[] | BitrixTaskResult>(
        context,
        'tasks.task.list',
        {
          order: { id: 'ASC' },
          filter: [['id', '>', cursorId]],
          select: ['id', 'title'],
          pagination: { page: 1, limit: BITRIX_V3_TASK_PAGE_SIZE, offset: 0 },
        },
        taskApiVersion,
      );
      const tasks = Array.isArray(result) ? result : result.items || result.tasks || [];
      const normalizedTasks = this.normalizeTasks(tasks);
      const pageMatches = normalizedTasks.filter((task) => !normalizedSearch
        || task.title.toLocaleLowerCase('ru').includes(normalizedSearch));
      for (const task of pageMatches) matches.set(task.id, task);
      const exactTitleFound = !!normalizedSearch && pageMatches.some(
        (task) => task.title.toLocaleLowerCase('ru') === normalizedSearch,
      );
      const nextCursorId = normalizedTasks.reduce(
        (maximum, task) => Math.max(maximum, task.id),
        cursorId,
      );
      // Some Bitrix24 portals cap a page below the requested REST v3 limit and
      // do not advance reliably when page and offset are combined. The only
      // supported task filter is id, so keyset pagination guarantees progress.
      if (
        exactTitleFound
        || matches.size >= limit
        || tasks.length === 0
        || nextCursorId <= cursorId
      ) break;
      cursorId = nextCursorId;
    }
    return [...matches.values()].slice(0, limit);
  }

  private normalizeTasks(tasks: BitrixTask[]) {
    return tasks
      .map((task) => ({
        id: this.positiveId(task.id ?? task.ID),
        title: this.entityTitle(task.title ?? task.TITLE, ''),
      }))
      .filter((task): task is { id: number; title: string } => !!task.id && !!task.title);
  }

  private async taskApiVersion(context: RegistryContext): Promise<'legacy' | 'v3'> {
    const scopes = await this.call<string[]>(context, 'scope', {});
    return scopes.some((scope) => String(scope).trim().toLowerCase() === 'tasks')
      ? 'v3'
      : 'legacy';
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
    // The deal placement must show documents linked to this exact deal. The
    // company remains creation context, but must not broaden the list to every
    // document linked only to the same company.
    const references: DocumentEntityReference[] = [{ entityType: 'deal', entityId: dealId }];
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

  private call<T>(
    context: RegistryContext,
    method: string,
    params: object,
    apiVersion: 'legacy' | 'v3' = 'legacy',
  ) {
    return this.bitrix.call<T>(
      context.bitrix!.domain,
      context.bitrix!.accessToken,
      method,
      params,
      apiVersion,
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
