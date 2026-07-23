import { Router } from 'express';

import type { BitrixApiClient } from '../bitrix/bitrix-client.js';
import type { Database } from '../db/database.js';
import {
  documentLinkIdSchema,
  entityDocumentsQuerySchema,
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
