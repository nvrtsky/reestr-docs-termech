import { and, eq, isNotNull, sql, type SQL } from 'drizzle-orm';

import type { BitrixApiClient } from '../bitrix/bitrix-client.js';
import type { Database } from '../db/database.js';
import { registryDocumentLinks, registryDocuments } from '../db/schema/index.js';
import { ApiError } from '../http/api-error.js';
import type { RegistryContext } from '../http/registry-context.js';

type CrmEntityType = 'deal' | 'company';

interface BitrixEntityIdentity {
  ID?: string | number;
  id?: string | number;
}

interface AccessDecision {
  allowed: boolean;
  expiresAt: number;
}

// CRM permissions are security data, so a cached allow decision must not
// survive into a later request after Bitrix24 access has been revoked.
const ACCESS_TTL_MS = 0;
const BATCH_SIZE = 50;
const decisionCache = new Map<string, Map<number, AccessDecision>>();

export class CrmEntityAccessService {
  constructor(
    private readonly database: Database,
    private readonly bitrix: BitrixApiClient,
  ) {}

  async prepare(context: RegistryContext): Promise<SQL | null> {
    if (
      context.source !== 'bitrix'
      || context.roleSource === 'bitrix_admin'
      || !context.bitrix
    ) return null;

    const [links, counterparties] = await Promise.all([
      this.database
        .selectDistinct({
          entityType: registryDocumentLinks.entityType,
          entityId: registryDocumentLinks.entityId,
        })
        .from(registryDocumentLinks)
        .where(eq(registryDocumentLinks.portalUrl, context.portalUrl)),
      this.database
        .selectDistinct({ entityId: registryDocuments.counterpartyId })
        .from(registryDocuments)
        .where(and(
          eq(registryDocuments.portalUrl, context.portalUrl),
          isNotNull(registryDocuments.counterpartyId),
        )),
    ]);

    const dealIds = uniquePositiveIds(
      links.filter(link => link.entityType === 'deal').map(link => link.entityId),
    );
    const companyIds = uniquePositiveIds([
      ...links.filter(link => link.entityType === 'company').map(link => link.entityId),
      ...counterparties.map(item => item.entityId),
    ]);
    if (!dealIds.length && !companyIds.length) return null;

    try {
      const [allowedDeals, allowedCompanies] = await Promise.all([
        this.allowedIds(context, 'deal', dealIds),
        this.allowedIds(context, 'company', companyIds),
      ]);
      return sql`(
        ${this.noDeniedLinkedEntities('deal', allowedDeals)}
        AND ${this.noDeniedLinkedEntities('company', allowedCompanies)}
        AND ${this.counterpartyAllowed(allowedCompanies)}
      )`;
    } catch (error) {
      throw new ApiError(
        503,
        'crm_access_unavailable',
        'Не удалось проверить права Bitrix24 на связанные компании и сделки. Доступ временно закрыт.',
        { cause: error instanceof Error ? error.message : 'unknown' },
      );
    }
  }

  private async allowedIds(
    context: RegistryContext,
    entityType: CrmEntityType,
    ids: number[],
  ) {
    if (!ids.length) return [];
    const cacheKey = `${context.portalUrl}|${context.userId}|${entityType}`;
    const cache = decisionCache.get(cacheKey) ?? new Map<number, AccessDecision>();
    decisionCache.set(cacheKey, cache);
    const now = Date.now();
    const missing = ids.filter(id => {
      const decision = cache.get(id);
      return !decision || decision.expiresAt <= now;
    });

    for (let offset = 0; offset < missing.length; offset += BATCH_SIZE) {
      const batch = missing.slice(offset, offset + BATCH_SIZE);
      const method = entityType === 'deal' ? 'crm.deal.list' : 'crm.company.list';
      const entities = await this.bitrix.call<BitrixEntityIdentity[]>(
        context.bitrix!.domain,
        context.bitrix!.accessToken,
        method,
        {
          order: { ID: 'ASC' },
          filter: { '@ID': batch },
          select: ['ID'],
          start: 0,
        },
      );
      if (!Array.isArray(entities)) throw new Error(`Invalid ${method} response.`);
      const visible = new Set(uniquePositiveIds(entities.map(entity => entity.ID ?? entity.id)));
      const expiresAt = Date.now() + ACCESS_TTL_MS;
      for (const id of batch) cache.set(id, { allowed: visible.has(id), expiresAt });
    }

    if (cache.size > 10_000) {
      for (const [id, decision] of cache) {
        if (decision.expiresAt <= now) cache.delete(id);
      }
    }
    return ids.filter(id => cache.get(id)?.allowed === true);
  }

  private noDeniedLinkedEntities(entityType: CrmEntityType, allowedIds: number[]) {
    const denied = allowedIds.length
      ? sql`crm_acl_link.entity_id NOT IN (${sql.join(allowedIds.map(id => sql`${id}`), sql`, `)})`
      : sql`TRUE`;
    return sql`NOT EXISTS (
      SELECT 1 FROM registry_document_links AS crm_acl_link
      WHERE crm_acl_link.portal_url = registry_documents.portal_url
        AND crm_acl_link.document_id = registry_documents.id
        AND crm_acl_link.entity_type = ${entityType}
        AND ${denied}
    )`;
  }

  private counterpartyAllowed(allowedCompanyIds: number[]) {
    if (!allowedCompanyIds.length) return sql`registry_documents.counterparty_id IS NULL`;
    return sql`(
      registry_documents.counterparty_id IS NULL
      OR registry_documents.counterparty_id IN (${sql.join(allowedCompanyIds.map(id => sql`${id}`), sql`, `)})
    )`;
  }
}

function uniquePositiveIds(values: unknown[]) {
  return [...new Set(values
    .map(value => Number(value))
    .filter(value => Number.isSafeInteger(value) && value > 0))]
    .sort((left, right) => left - right);
}
