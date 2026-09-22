import { Router } from 'express';
import { z } from 'zod';

import type { BitrixApiClient } from '../bitrix/bitrix-client.js';
import type { Database } from '../db/database.js';
import {
  documentLinkIdSchema,
  entityDocumentsQuerySchema,
  taskSearchQuerySchema,
} from '../documents/documents.schemas.js';
import { createDocumentsService } from '../documents/documents.service.js';
import { requireRegistryContext } from '../http/registry-context.js';
import { CrmContextService } from './crm-context.service.js';

export function createCrmContextRouter({
  database,
  bitrix,
}: {
  database: Database;
  bitrix: BitrixApiClient;
}) {
  const router = Router();
  const documents = createDocumentsService({ database, bitrix });
  const crmContext = new CrmContextService(bitrix);

  router.get('/tasks', async (request, response, next) => {
    try {
      const context = requireRegistryContext(request);
      const query = taskSearchQuerySchema.parse(request.query);
      response.json({ items: await crmContext.searchTasks(context, query.search, query.limit) });
    } catch (error) {
      next(error);
    }
  });

  router.get('/companies/:companyId/deals', async (request, response, next) => {
    try {
      const context = requireRegistryContext(request);
      const companyId = z.coerce.number().int().positive().safe().parse(request.params.companyId);
      const company = await crmContext.resolve(context, 'company', companyId);
      response.json({
        company: company.company,
        items: company.deals.map((deal) => ({
          entityType: 'deal' as const,
          entityId: deal.id,
          entityTitle: deal.title,
          stageId: deal.stageId,
          stageName: deal.stageName,
        })),
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/by-entity', async (request, response, next) => {
    try {
      const context = requireRegistryContext(request);
      const { entityType, entityId, ...query } = entityDocumentsQuerySchema.parse(request.query);
      const entityContext = await crmContext.resolve(context, entityType, entityId);
      const result = await documents.listLinked(context, query, entityContext.references);
      response.json({ ...result, context: entityContext });
    } catch (error) {
      next(error);
    }
  });

  router.delete('/links/:linkId', async (request, response, next) => {
    try {
      const context = requireRegistryContext(request);
      const linkId = documentLinkIdSchema.parse(request.params.linkId);
      response.json(await documents.removeLinkById(context, linkId));
    } catch (error) {
      next(error);
    }
  });

  return router;
}
