import { and, asc, eq, inArray, isNull, lt, or, sql, type SQL } from 'drizzle-orm';

import type { BitrixApiClient } from '../bitrix/bitrix-client.js';
import type { Database } from '../db/database.js';
import { registryDocumentLinks } from '../db/schema/index.js';
import { ApiError } from '../http/api-error.js';
import type { RegistryContext } from '../http/registry-context.js';

interface BitrixDealState {
  ID?: string | number;
  CLOSED?: string | boolean | number;
  STAGE_SEMANTIC_ID?: string;
}

const STATE_TTL_MS = 5 * 60 * 1_000;
const BATCH_SIZE = 50;

export class SalesDealAccessService {
  constructor(
    private readonly database: Database,
    private readonly bitrix: BitrixApiClient,
  ) {}

  async prepare(context: RegistryContext): Promise<SQL | null> {
    if (context.roleCode !== 'sales') return null;
    const checkedAfter = new Date(Date.now() - STATE_TTL_MS);
    await this.refreshStaleStates(context, checkedAfter);
    return sql`(
      NOT EXISTS (
        SELECT 1 FROM registry_document_links AS sales_deal_any
        WHERE sales_deal_any.portal_url = ${context.portalUrl}
          AND sales_deal_any.document_id = registry_documents.id
          AND sales_deal_any.entity_type = 'deal'
      )
      OR EXISTS (
        SELECT 1 FROM registry_document_links AS sales_deal_open
        WHERE sales_deal_open.portal_url = ${context.portalUrl}
          AND sales_deal_open.document_id = registry_documents.id
          AND sales_deal_open.entity_type = 'deal'
          AND sales_deal_open.deal_closed = false
          AND sales_deal_open.deal_state_checked_at >= ${checkedAfter.toISOString()}
      )
    )`;
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

    const checkedAt = new Date();
    try {
      for (let offset = 0; offset < stale.length; offset += BATCH_SIZE) {
        const ids = stale.slice(offset, offset + BATCH_SIZE).map((item) => item.entityId);
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
