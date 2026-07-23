import { and, eq, inArray } from 'drizzle-orm';

import type { BitrixApiClient } from '../bitrix/bitrix-client.js';
import type { Database } from '../db/database.js';
import {
  registryAuditLog,
  registryDocumentLinks,
  registryDocuments,
} from '../db/schema/index.js';
import { ApiError } from '../http/api-error.js';
import type { CrmEvent } from './crm-events.schemas.js';

type EntityType = 'deal' | 'company';

interface BitrixEntity {
  ID?: string | number;
  TITLE?: string;
}

interface DocumentChange {
  documentId: string;
  previousLinkTitles: string[];
  previousCounterpartyName?: string | null;
}

export class CrmEventsService {
  constructor(
    private readonly database: Database,
    private readonly bitrix: BitrixApiClient,
  ) {}

  async process(event: CrmEvent, domain: string) {
    const entityType: EntityType = event.event.includes('DEAL') ? 'deal' : 'company';
    const entityId = event.data.FIELDS.ID;
    if (event.event.endsWith('DELETE')) {
      return this.removeEntityLinks(`https://${domain}`, entityType, entityId);
    }

    if (!event.auth.access_token) {
      throw new ApiError(
        503,
        'bitrix_event_access_token_missing',
        'Bitrix24 event does not contain an access token; retry is required.',
      );
    }
    const method = entityType === 'deal' ? 'crm.deal.get' : 'crm.company.get';
    const entity = await this.bitrix.call<BitrixEntity>(
      domain,
      event.auth.access_token,
      method,
      { id: entityId },
    );
    const title = typeof entity.TITLE === 'string' ? entity.TITLE.trim().slice(0, 500) : '';
    if (!title) {
      throw new ApiError(
        502,
        'bitrix_entity_title_missing',
        'Bitrix24 returned an entity without a title.',
      );
    }
    return this.synchronizeTitle(`https://${domain}`, entityType, entityId, title);
  }

  private async synchronizeTitle(
    portalUrl: string,
    entityType: EntityType,
    entityId: number,
    title: string,
  ) {
    const links = await this.database
      .select({
        id: registryDocumentLinks.id,
        documentId: registryDocumentLinks.documentId,
        entityTitle: registryDocumentLinks.entityTitle,
      })
      .from(registryDocumentLinks)
      .where(
        and(
          eq(registryDocumentLinks.portalUrl, portalUrl),
          eq(registryDocumentLinks.entityType, entityType),
          eq(registryDocumentLinks.entityId, entityId),
        ),
      );
    const counterpartyDocuments = entityType === 'company'
      ? await this.database
          .select({
            documentId: registryDocuments.id,
            counterpartyName: registryDocuments.counterpartyName,
          })
          .from(registryDocuments)
          .where(
            and(
              eq(registryDocuments.portalUrl, portalUrl),
              eq(registryDocuments.counterpartyId, entityId),
            ),
          )
      : [];

    const changes = new Map<string, DocumentChange>();
    for (const link of links) {
      if (link.entityTitle === title) continue;
      const change = changes.get(link.documentId) ?? {
        documentId: link.documentId,
        previousLinkTitles: [],
      };
      change.previousLinkTitles.push(link.entityTitle);
      changes.set(link.documentId, change);
    }
    for (const document of counterpartyDocuments) {
      if (document.counterpartyName === title) continue;
      const change = changes.get(document.documentId) ?? {
        documentId: document.documentId,
        previousLinkTitles: [],
      };
      change.previousCounterpartyName = document.counterpartyName;
      changes.set(document.documentId, change);
    }
    if (!changes.size) {
      return { status: 'unchanged' as const, entityType, entityId, affectedDocuments: 0 };
    }

    await this.database.transaction(async (transaction) => {
      await transaction
        .update(registryDocumentLinks)
        .set({ entityTitle: title })
        .where(
          and(
            eq(registryDocumentLinks.portalUrl, portalUrl),
            eq(registryDocumentLinks.entityType, entityType),
            eq(registryDocumentLinks.entityId, entityId),
          ),
        );
      if (entityType === 'company') {
        await transaction
          .update(registryDocuments)
          .set({ counterpartyName: title, updatedAt: new Date() })
          .where(
            and(
              eq(registryDocuments.portalUrl, portalUrl),
              eq(registryDocuments.counterpartyId, entityId),
            ),
          );
      }
      await transaction.insert(registryAuditLog).values(
        [...changes.values()].map((change) => ({
          portalUrl,
          documentId: change.documentId,
          event: 'crm_entity_title_updated',
          actorName: 'Система',
          before: {
            entityType,
            entityId,
            linkTitles: change.previousLinkTitles,
            ...(Object.hasOwn(change, 'previousCounterpartyName')
              ? { counterpartyName: change.previousCounterpartyName }
              : {}),
          },
          after: { entityType, entityId, title },
          metadata: { source: 'bitrix_webhook' },
        })),
      );
    });
    return {
      status: 'updated' as const,
      entityType,
      entityId,
      affectedDocuments: changes.size,
    };
  }

  private async removeEntityLinks(
    portalUrl: string,
    entityType: EntityType,
    entityId: number,
  ) {
    const links = await this.database
      .select()
      .from(registryDocumentLinks)
      .where(
        and(
          eq(registryDocumentLinks.portalUrl, portalUrl),
          eq(registryDocumentLinks.entityType, entityType),
          eq(registryDocumentLinks.entityId, entityId),
        ),
      );
    if (!links.length) {
      return { status: 'unchanged' as const, entityType, entityId, affectedDocuments: 0 };
    }

    await this.database.transaction(async (transaction) => {
      await transaction
        .delete(registryDocumentLinks)
        .where(inArray(registryDocumentLinks.id, links.map((link) => link.id)));
      await transaction.insert(registryAuditLog).values(
        links.map((link) => ({
          portalUrl,
          documentId: link.documentId,
          event: 'crm_entity_deleted',
          actorName: 'Система',
          before: link,
          after: null,
          metadata: { source: 'bitrix_webhook', entityType, entityId },
        })),
      );
    });
    return {
      status: 'removed' as const,
      entityType,
      entityId,
      affectedDocuments: new Set(links.map((link) => link.documentId)).size,
    };
  }
}
