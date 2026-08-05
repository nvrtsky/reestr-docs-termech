import { Router, type RequestHandler } from 'express';

import { createAttachmentsRouter } from '../attachments/attachments.router.js';
import type { BitrixApiClient } from '../bitrix/bitrix-client.js';
import { CrmContextService } from '../crm-context/crm-context.service.js';
import type { Database } from '../db/database.js';
import { ApiError } from '../http/api-error.js';
import { CbrRatesService, type ExchangeRateProvider } from '../finance/cbr-rates.service.js';
import { DealFinancialService } from '../finance/deal-financial.service.js';
import { localizedApiErrorMessage } from '../http/error-localization.js';
import { requireRegistryContext } from '../http/registry-context.js';
import { DocumentsExportService } from './documents-export.service.js';
import { BitrixDealImportService } from './bitrix-deal-import.service.js';
import {
  addDocumentLinkSchema,
  addTaskLinkSchema,
  bulkAssignDocumentsSchema,
  bulkDeleteDocumentsSchema,
  bulkRestoreDocumentsSchema,
  bulkUploadDocumentsSchema,
  createDocumentSchema,
  documentDetailsQuerySchema,
  dealFinancialSummaryQuerySchema,
  dealIdSchema,
  documentLinkIdSchema,
  documentExportQuerySchema,
  documentIdSchema,
  documentListQuerySchema,
  setParentRelationSchema,
  taskLinkIdSchema,
  transitionDocumentSchema,
  updateDocumentSchema,
} from './documents.schemas.js';
import { createDocumentsService } from './documents.service.js';

export function createDocumentsRouter({
  database,
  bitrix,
  exchangeRateProvider,
}: {
  database: Database;
  bitrix: BitrixApiClient;
  exchangeRateProvider?: ExchangeRateProvider;
}) {
  const router = Router();
  const documents = createDocumentsService({ database, bitrix });
  const documentsExport = new DocumentsExportService({ database, documents, bitrix });
  const crmContext = new CrmContextService(bitrix);
  const financial = new DealFinancialService(
    database,
    bitrix,
    exchangeRateProvider ?? new CbrRatesService(database),
  );
  const bitrixDealImport = new BitrixDealImportService(database, bitrix);
  const updateDocument: RequestHandler = async (request, response, next) => {
    try {
      const context = requireRegistryContext(request);
      const id = documentIdSchema.parse(request.params.id);
      const parsed = updateDocumentSchema.parse(request.body);
      const input = await canonicalizeCompanyUpdate(context, parsed, crmContext);
      response.json(
        await documents.update(context, id, input),
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

  router.post('/bulk/upload', async (request, response, next) => {
    try {
      const context = requireRegistryContext(request);
      const input = bulkUploadDocumentsSchema.parse(request.body);
      const items = [];
      for (const item of input.items) {
        try {
          const canonical = await canonicalizeDocumentCreate(
            context,
            item.document,
            crmContext,
          );
          const document = await documents.create(context, canonical, {
            idempotencyKey: item.idempotencyKey,
            clientRowId: item.clientRowId,
          });
          items.push({
            clientRowId: item.clientRowId,
            idempotencyKey: item.idempotencyKey,
            status: 'ready',
            document,
          });
        } catch (error) {
          const apiError = error instanceof ApiError ? error : null;
          items.push({
            clientRowId: item.clientRowId,
            idempotencyKey: item.idempotencyKey,
            status: 'error',
            error: {
              code: apiError?.code || 'bulk_upload_row_failed',
              message: apiError
                ? localizedApiErrorMessage(apiError)
                : 'Не удалось подготовить строку массовой загрузки.',
              details: apiError?.details,
            },
          });
        }
      }
      response.json({ items });
    } catch (error) {
      next(error);
    }
  });

  router.get('/deal/:dealId/financial-summary', async (request, response, next) => {
    try {
      const dealId = dealIdSchema.parse(request.params.dealId);
      const query = dealFinancialSummaryQuerySchema.parse(request.query);
      response.setHeader('cache-control', 'private, no-store');
      response.json(await financial.summarize(
        requireRegistryContext(request),
        dealId,
        query.currency,
      ));
    } catch (error) {
      next(error);
    }
  });

  router.post('/deal/:dealId/sync-bitrix', async (request, response, next) => {
    try {
      const dealId = dealIdSchema.parse(request.params.dealId);
      response.setHeader('cache-control', 'private, no-store');
      response.json(await bitrixDealImport.synchronize(
        requireRegistryContext(request),
        dealId,
      ));
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
      const context = requireRegistryContext(request);
      const parsed = createDocumentSchema.parse(request.body);
      const input = await canonicalizeDocumentCreate(context, parsed, crmContext);
      response
        .status(201)
        .json(await documents.create(context, input));
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

  router.put('/:id/relations/parent', async (request, response, next) => {
    try {
      const context = requireRegistryContext(request);
      const childDocumentId = documentIdSchema.parse(request.params.id);
      const input = setParentRelationSchema.parse(request.body);
      response.json(
        await documents.setParentRelation(context, childDocumentId, input),
      );
    } catch (error) {
      next(error);
    }
  });

  router.delete('/:id/relations/parent', async (request, response, next) => {
    try {
      const context = requireRegistryContext(request);
      const childDocumentId = documentIdSchema.parse(request.params.id);
      response.json(
        await documents.removeParentRelation(context, childDocumentId),
      );
    } catch (error) {
      next(error);
    }
  });

  router.post('/:id/tasks', async (request, response, next) => {
    try {
      const context = requireRegistryContext(request);
      const documentId = documentIdSchema.parse(request.params.id);
      const input = addTaskLinkSchema.parse(request.body);
      const task = await crmContext.resolveTaskSelection(
        context,
        input.taskId,
        input.taskTitle,
      );
      response.status(201).json(
        await documents.addTaskLink(context, documentId, {
          taskId: task.id,
          taskTitle: task.title,
        }),
      );
    } catch (error) {
      next(error);
    }
  });

  router.delete('/:id/tasks/:taskLinkId', async (request, response, next) => {
    try {
      const context = requireRegistryContext(request);
      const documentId = documentIdSchema.parse(request.params.id);
      const taskLinkId = taskLinkIdSchema.parse(request.params.taskLinkId);
      response.json(await documents.removeTaskLink(context, documentId, taskLinkId));
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

  router.post('/:id/finalize', async (request, response, next) => {
    try {
      const id = documentIdSchema.parse(request.params.id);
      response.json(
        await documents.finalizeCreation(requireRegistryContext(request), id),
      );
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

async function canonicalizeDocumentCreate(
  context: ReturnType<typeof requireRegistryContext>,
  input: ReturnType<typeof createDocumentSchema.parse>,
  crmContext: CrmContextService,
) {
  const company = await canonicalizeCompanyCreate(context, input, crmContext);
  const [links, taskLinks] = await Promise.all([
    Promise.all(company.links.map(async (link) => ({
      ...link,
      entityTitle: await crmContext.resolveEntityTitle(
        context,
        link.entityType,
        link.entityId,
        link.entityTitle,
      ),
    }))),
    Promise.all(company.taskLinks.map(async (link) => {
      const task = await crmContext.resolveTaskSelection(
        context,
        link.taskId,
        link.taskTitle,
      );
      return { taskId: task.id, taskTitle: task.title };
    })),
  ]);
  return {
    ...company,
    legalEntityId: null,
    legalEntityName: null,
    links,
    taskLinks,
  };
}

async function canonicalizeCompanyCreate(
  context: ReturnType<typeof requireRegistryContext>,
  input: ReturnType<typeof createDocumentSchema.parse>,
  crmContext: CrmContextService,
) {
  if (!input.counterpartyId) {
    if (input.counterpartyName) {
      throw new ApiError(
        400,
        'counterparty_company_selection_required',
        'Counterparty must be selected from Bitrix24 companies.',
      );
    }
    return { ...input, counterpartyId: null, counterpartyName: null };
  }
  const company = await crmContext.resolveCompanySelection(
    context,
    input.counterpartyId,
    input.counterpartyName,
  );
  return { ...input, counterpartyId: company.id, counterpartyName: company.title };
}

async function canonicalizeCompanyUpdate(
  context: ReturnType<typeof requireRegistryContext>,
  input: ReturnType<typeof updateDocumentSchema.parse>,
  crmContext: CrmContextService,
) {
  if (input.counterpartyId === undefined && input.counterpartyName === undefined) return input;
  if (!input.counterpartyId) {
    if (input.counterpartyName) {
      throw new ApiError(
        400,
        'counterparty_company_selection_required',
        'Counterparty must be selected from Bitrix24 companies.',
      );
    }
    return { ...input, counterpartyId: null, counterpartyName: null };
  }
  const company = await crmContext.resolveCompanySelection(
    context,
    input.counterpartyId,
    input.counterpartyName,
  );
  return { ...input, counterpartyId: company.id, counterpartyName: company.title };
}
