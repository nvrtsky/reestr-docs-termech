import { Router, type RequestHandler } from 'express';

import { createAttachmentsRouter } from '../attachments/attachments.router.js';
import type { BitrixApiClient } from '../bitrix/bitrix-client.js';
import { CrmContextService } from '../crm-context/crm-context.service.js';
import type { Database } from '../db/database.js';
import { requireRegistryContext } from '../http/registry-context.js';
import { DocumentsExportService } from './documents-export.service.js';
import {
  addDocumentLinkSchema,
  bulkAssignDocumentsSchema,
  bulkDeleteDocumentsSchema,
  bulkRestoreDocumentsSchema,
  createDocumentSchema,
  documentDetailsQuerySchema,
  documentLinkIdSchema,
  documentExportQuerySchema,
  documentIdSchema,
  documentListQuerySchema,
  transitionDocumentSchema,
  updateDocumentSchema,
} from './documents.schemas.js';
import { createDocumentsService } from './documents.service.js';

export function createDocumentsRouter({
  database,
  bitrix,
}: {
  database: Database;
  bitrix: BitrixApiClient;
}) {
  const router = Router();
  const documents = createDocumentsService({ database, bitrix });
  const documentsExport = new DocumentsExportService({ database, documents, bitrix });
  const crmContext = new CrmContextService(bitrix);
  const updateDocument: RequestHandler = async (request, response, next) => {
    try {
      const id = documentIdSchema.parse(request.params.id);
      const input = updateDocumentSchema.parse(request.body);
      response.json(
        await documents.update(requireRegistryContext(request), id, input),
      );
    } catch (error) {
      next(error);
    }
  };

  router.use('/:id/attachments', createAttachmentsRouter({ database, bitrix }));

  router.get('/options', async (request, response, next) => {
    try {
      response.json(
        await documents.listOptions(requireRegistryContext(request)),
      );
    } catch (error) {
      next(error);
    }
  });

  router.get('/export.xlsx', async (request, response, next) => {
    try {
      const context = requireRegistryContext(request);
      const query = documentExportQuerySchema.parse(request.query);
      const exported = await documentsExport.create(context, query);
      response.setHeader(
        'content-type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      );
      response.setHeader(
        'content-disposition',
        `attachment; filename="${exported.filename}"`,
      );
      response.setHeader('cache-control', 'no-store');
      response.setHeader('x-export-row-count', String(exported.rowCount));
      response.send(exported.buffer);
    } catch (error) {
      next(error);
    }
  });

  router.get('/', async (request, response, next) => {
    try {
      const query = documentListQuerySchema.parse(request.query);
      response.json(await documents.list(requireRegistryContext(request), query));
    } catch (error) {
      next(error);
    }
  });

  router.post('/bulk/assign', async (request, response, next) => {
    try {
      const input = bulkAssignDocumentsSchema.parse(request.body);
      response.json(
        await documents.bulkAssign(requireRegistryContext(request), input),
      );
    } catch (error) {
      next(error);
    }
  });

  router.post('/bulk/delete', async (request, response, next) => {
    try {
      const input = bulkDeleteDocumentsSchema.parse(request.body);
      response.json(
        await documents.bulkDelete(requireRegistryContext(request), input),
      );
    } catch (error) {
      next(error);
    }
  });

  router.post('/bulk/restore', async (request, response, next) => {
    try {
      const input = bulkRestoreDocumentsSchema.parse(request.body);
      response.json(
        await documents.bulkRestore(requireRegistryContext(request), input),
      );
    } catch (error) {
      next(error);
    }
  });

  router.get('/:id', async (request, response, next) => {
    try {
      const id = documentIdSchema.parse(request.params.id);
      const query = documentDetailsQuerySchema.parse(request.query);
      response.json(
        await documents.getById(
          requireRegistryContext(request),
          id,
          query.deleted === 'only',
        ),
      );
    } catch (error) {
      next(error);
    }
  });

  router.post('/', async (request, response, next) => {
    try {
      const input = createDocumentSchema.parse(request.body);
      response
        .status(201)
        .json(await documents.create(requireRegistryContext(request), input));
    } catch (error) {
      next(error);
    }
  });

  router.post('/:id/links', async (request, response, next) => {
    try {
      const context = requireRegistryContext(request);
      const documentId = documentIdSchema.parse(request.params.id);
      const input = addDocumentLinkSchema.parse(request.body);
      const entityTitle = await crmContext.resolveEntityTitle(
        context,
        input.entityType,
        input.entityId,
        input.entityTitle,
      );
      response.status(201).json(
        await documents.addLink(context, documentId, { ...input, entityTitle }),
      );
    } catch (error) {
      next(error);
    }
  });

  router.delete('/:id/links/:linkId', async (request, response, next) => {
    try {
      const context = requireRegistryContext(request);
      const documentId = documentIdSchema.parse(request.params.id);
      const linkId = documentLinkIdSchema.parse(request.params.linkId);
      response.json(await documents.removeLink(context, documentId, linkId));
    } catch (error) {
      next(error);
    }
  });

  router.patch('/:id', updateDocument);
  router.put('/:id', updateDocument);

  router.post('/:id/transition', async (request, response, next) => {
    try {
      const id = documentIdSchema.parse(request.params.id);
      const input = transitionDocumentSchema.parse(request.body);
      response.json(
        await documents.transition(
          requireRegistryContext(request),
          id,
          input.status,
          input.comment,
        ),
      );
    } catch (error) {
      next(error);
    }
  });

  router.post('/:id/abandon', async (request, response, next) => {
    try {
      const id = documentIdSchema.parse(request.params.id);
      await documents.abandonCreation(requireRegistryContext(request), id);
      response.status(204).send();
    } catch (error) {
      next(error);
    }
  });

  router.delete('/:id', async (request, response, next) => {
    try {
      const id = documentIdSchema.parse(request.params.id);
      await documents.softDelete(requireRegistryContext(request), id);
      response.status(204).send();
    } catch (error) {
      next(error);
    }
  });

  router.post('/:id/restore', async (request, response, next) => {
    try {
      const id = documentIdSchema.parse(request.params.id);
      response.json(
        await documents.restore(requireRegistryContext(request), id),
      );
    } catch (error) {
      next(error);
    }
  });

  return router;
}
