import { and, asc, eq, inArray, isNull, lt, or, sql, type SQL } from 'drizzle-orm';

import type { BitrixApiClient } from '../bitrix/bitrix-client.js';
import type { Database } from '../db/database.js';
import { registryDocumentLinks, registryDocuments } from '../db/schema/index.js';
import { ApiError } from '../http/api-error.js';
import type { RegistryContext } from '../http/registry-context.js';

interface BitrixDealState {
  ID?: string | number;
  CLOSED?: string | boolean | number;
  STAGE_SEMANTIC_ID?: string;
}

// Access revocation and deal closure must take effect on the next request.
// Batching remains; a smarter scoped cache can be introduced later without
// weakening this fail-closed rule.
const STATE_TTL_MS = 0;
const BATCH_SIZE = 50;

export class SalesDealAccessService {
  constructor(
    private readonly database: Database,
    private readonly bitrix: BitrixApiClient,
  ) {}

  async prepare(context: RegistryContext): Promise<SQL | null> {
    if (context.roleCode !== 'sales') return null;
    return eq(registryDocuments.responsibleId, context.userId);
  }

  async assertWritable(
    context: RegistryContext,
    documentId: string,
    accessibleDealIds?: ReadonlySet<number>,
  ) {
    if (context.roleCode !== 'sales') return;
    const links = await this.documentDealLinks(context, documentId);
    if (!links.length) return;
    const relevantLinks = accessibleDealIds
      ? links.filter((link) => accessibleDealIds.has(link.entityId))
      : links;
    if (!relevantLinks.length) {
      throw new ApiError(403, 'deal_access_denied', 'Нет доступной связанной сделки.');
    }

    const checkedAfter = new Date(Date.now() - STATE_TTL_MS);
    const staleIds = relevantLinks
      .filter((link) => !link.dealStateCheckedAt || link.dealStateCheckedAt < checkedAfter)
      .map((link) => link.entityId);
    if (staleIds.length) await this.refreshDealIds(context, staleIds);

    const refreshed = await this.documentDealLinks(context, documentId);
    const writable = hasWritableDealState(refreshed, accessibleDealIds, checkedAfter);
    if (!writable) {
      throw new ApiError(
        409,
        'document_closed_deals_read_only',
        'Документ доступен только для чтения: все доступные связанные сделки закрыты или их состояние неизвестно.',
      );
    }
  }

  async documentStates(context: RegistryContext, documentId: string) {
    const checkedAfter = new Date(Date.now() - STATE_TTL_MS);
    const links = await this.documentDealLinks(context, documentId);
    const staleIds = links
      .filter((link) => !link.dealStateCheckedAt || link.dealStateCheckedAt < checkedAfter)
      .map((link) => link.entityId);
    if (context.bitrix && staleIds.length) {
      try {
        await this.refreshDealIds(context, staleIds);
      } catch {
        // Card rendering remains available for administrators and other roles;
        // an unknown state is displayed if Bitrix24 is temporarily unavailable.
        // Sales access itself still fails closed through prepare().
      }
    }
    return new Map((await this.documentDealLinks(context, documentId)).map((link) => [
      link.entityId,
      {
        dealClosed: link.dealClosed,
        dealStateCheckedAt: link.dealStateCheckedAt,
      },
    ]));
  }

  private async refreshStaleStates(context: RegistryContext, checkedAfter: Date) {
    if (!context.bitrix) return;
    const stale = await this.database
      .selectDistinct({ entityId: registryDocumentLinks.entityId })
      .from(registryDocumentLinks)
      .where(
        and(
          eq(registryDocumentLinks.portalUrl, context.portalUrl),
          eq(registryDocumentLinks.entityType, 'deal'),
          or(
            isNull(registryDocumentLinks.dealStateCheckedAt),
            lt(registryDocumentLinks.dealStateCheckedAt, checkedAfter),
          ),
        ),
      )
      .orderBy(asc(registryDocumentLinks.entityId));
    if (!stale.length) return;
    await this.refreshDealIds(context, stale.map((item) => item.entityId));
  }

  private async refreshDealIds(context: RegistryContext, entityIds: number[]) {
    if (!context.bitrix || !entityIds.length) return;
    const idsToRefresh = [...new Set(entityIds)].sort((left, right) => left - right);
    const checkedAt = new Date();
    try {
      for (let offset = 0; offset < idsToRefresh.length; offset += BATCH_SIZE) {
        const ids = idsToRefresh.slice(offset, offset + BATCH_SIZE);
        const deals = await this.bitrix.call<BitrixDealState[]>(
          context.bitrix.domain,
          context.bitrix.accessToken,
          'crm.deal.list',
          {
            order: { ID: 'ASC' },
            filter: { '@ID': ids },
            select: ['ID', 'CLOSED', 'STAGE_SEMANTIC_ID'],
            start: 0,
          },
        );
        if (!Array.isArray(deals)) throw new Error('Invalid deal list.');
        const stateById = new Map<number, boolean | null>();
        for (const deal of deals) {
          const id = positiveId(deal.ID);
          if (id) stateById.set(id, closedDealState(deal));
        }
        const groups = new Map<boolean | null, number[]>([
          [true, []],
          [false, []],
          [null, []],
        ]);
        for (const id of ids) groups.get(stateById.get(id) ?? null)!.push(id);
        for (const [dealClosed, groupIds] of groups) {
          if (!groupIds.length) continue;
          await this.database
            .update(registryDocumentLinks)
            .set({ dealClosed, dealStateCheckedAt: checkedAt })
            .where(
              and(
                eq(registryDocumentLinks.portalUrl, context.portalUrl),
                eq(registryDocumentLinks.entityType, 'deal'),
                inArray(registryDocumentLinks.entityId, groupIds),
              ),
            );
        }
      }
    } catch (error) {
      throw new ApiError(
        503,
        'deal_access_state_unavailable',
        'Не удалось проверить состояние связанных сделок. Доступ менеджера временно закрыт.',
        { cause: error instanceof Error ? error.message : 'unknown' },
      );
    }
  }

  private documentDealLinks(context: RegistryContext, documentId: string) {
    return this.database
      .select({
        entityId: registryDocumentLinks.entityId,
        dealClosed: registryDocumentLinks.dealClosed,
        dealStateCheckedAt: registryDocumentLinks.dealStateCheckedAt,
      })
      .from(registryDocumentLinks)
      .where(and(
        eq(registryDocumentLinks.portalUrl, context.portalUrl),
        eq(registryDocumentLinks.documentId, documentId),
        eq(registryDocumentLinks.entityType, 'deal'),
      ))
      .orderBy(asc(registryDocumentLinks.entityId));
  }
}

export function hasWritableDealState(
  links: Array<{
    entityId: number;
    dealClosed: boolean | null;
    dealStateCheckedAt: Date | null;
  }>,
  accessibleDealIds: ReadonlySet<number> | undefined,
  checkedAfter: Date,
) {
  return links.some((link) =>
    (!accessibleDealIds || accessibleDealIds.has(link.entityId))
    && link.dealClosed === false
    && !!link.dealStateCheckedAt
    && link.dealStateCheckedAt >= checkedAfter);
}

function positiveId(value: unknown) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

export function closedDealState(deal: Pick<BitrixDealState, 'CLOSED' | 'STAGE_SEMANTIC_ID'>) {
  if (isEnabled(deal.CLOSED)) return true;
  if (isDisabled(deal.CLOSED)) return false;
  const semantic = deal.STAGE_SEMANTIC_ID?.trim().toUpperCase();
  if (semantic === 'S' || semantic === 'F') return true;
  if (semantic === 'P') return false;
  return null;
}

function isEnabled(value: unknown) {
  return value === true || value === 1
    || (typeof value === 'string' && ['1', 'Y', 'YES', 'TRUE'].includes(value.trim().toUpperCase()));
}

function isDisabled(value: unknown) {
  return value === false || value === 0
    || (typeof value === 'string' && ['0', 'N', 'NO', 'FALSE'].includes(value.trim().toUpperCase()));
}
