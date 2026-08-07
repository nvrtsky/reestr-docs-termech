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
  replaceDocumentLinksSchema,
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
      if (input.counterpartyId !== undefined) {
        const current = await documents.getById(context, id);
        await assertDealCompanyCompatibility(
          context,
          current.links,
          input.counterpartyId,
          crmContext,
        );
      }
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
      const context = requireRegistryContext(request);
      const input = bulkAssignDocumentsSchema.parse(request.body);
      const responsible = await crmContext.resolveUserSelection(
        context,
        input.responsibleId,
        input.responsibleName,
      );
      response.json(
        await documents.bulkAssign(context, {
          ...input,
          responsibleId: responsible.id,
          responsibleName: responsible.name,
        }),
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
      if (input.entityType === 'deal') {
        const deal = await crmContext.resolveDealSelection(
          context,
          input.entityId,
          input.entityTitle,
        );
        response.status(201).json(await documents.addLink(context, documentId, {
          ...input,
          entityId: deal.id,
          entityTitle: deal.title,
          dealCompanyId: deal.companyId,
        }));
        return;
      }
      const company = await crmContext.resolveCompanySelection(
        context,
        input.entityId,
        input.entityTitle,
      );
      response.status(201).json(await documents.addLink(context, documentId, {
        ...input,
        entityId: company.id,
        entityTitle: company.title,
      }));
    } catch (error) {
      next(error);
    }
  });

  router.put('/:id/links', async (request, response, next) => {
    try {
      const context = requireRegistryContext(request);
      const documentId = documentIdSchema.parse(request.params.id);
      const input = replaceDocumentLinksSchema.parse(request.body);
      const current = await documents.getById(context, documentId);
      const selected = await canonicalizeExistingDocumentLinks(
        context,
        input.items,
        crmContext,
        current.counterpartyId,
        current.counterpartyName,
      );
      response.json(await replaceDocumentLinksSafely(
        context,
        documentId,
        current.links,
        selected,
        documents,
      ));
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
  const [resolvedLinks, taskLinks, responsible] = await Promise.all([
    Promise.all(input.links.map(async (link) => {
      if (link.entityType === 'deal') {
        const deal = await crmContext.resolveDealSelection(
          context,
          link.entityId,
          link.entityTitle,
        );
        return { ...link, entityId: deal.id, entityTitle: deal.title, companyId: deal.companyId };
      }
      const company = await crmContext.resolveCompanySelection(
        context,
        link.entityId,
        link.entityTitle,
      );
      return { ...link, entityId: company.id, entityTitle: company.title, companyId: company.id };
    })),
    Promise.all(input.taskLinks.map(async (link) => {
      const task = await crmContext.resolveTaskSelection(
        context,
        link.taskId,
        link.taskTitle,
      );
      return { taskId: task.id, taskTitle: task.title };
    })),
    input.responsibleId
      ? crmContext.resolveUserSelection(context, input.responsibleId, input.responsibleName)
      : Promise.resolve({ id: context.userId, name: context.userName || `Пользователь #${context.userId}` }),
  ]);
  const liveDealCompanyIds = resolvedLinks
    .filter((link) => link.entityType === 'deal' && link.companyId !== undefined)
    .map((link) => link.companyId);
  if (liveDealCompanyIds.some((companyId) => companyId === null)) {
    throw new ApiError(
      409,
      'deal_company_required',
      'Every selected deal must be linked to a Bitrix24 company.',
    );
  }
  const dealCompanyIds = new Set(liveDealCompanyIds.filter((id): id is number => id !== null));
  const selectedCompanyIds = new Set(
    resolvedLinks.filter((link) => link.entityType === 'company').map((link) => link.entityId),
  );
  if (dealCompanyIds.size > 1 || selectedCompanyIds.size > 1) {
    throw new ApiError(
      409,
      'crm_company_scope_mismatch',
      'All selected deals and company links must belong to one company.',
    );
  }
  const inferredCompanyId = [...selectedCompanyIds][0] ?? [...dealCompanyIds][0] ?? null;
  if (input.counterpartyId && inferredCompanyId && input.counterpartyId !== inferredCompanyId) {
    throw new ApiError(
      409,
      'counterparty_company_link_mismatch',
      'The selected deals and company must match the document counterparty.',
    );
  }
  const company = await canonicalizeCompanyCreate(
    context,
    {
      ...input,
      counterpartyId: input.counterpartyId ?? inferredCompanyId,
      counterpartyName: input.counterpartyName
        ?? resolvedLinks.find((link) => link.entityType === 'company')?.entityTitle
        ?? null,
    },
    crmContext,
  );
  if (dealCompanyIds.size && !dealCompanyIds.has(company.counterpartyId!)) {
    throw new ApiError(
      409,
      'crm_company_scope_mismatch',
      'All selected deals must belong to the document counterparty company.',
    );
  }
  const links = resolvedLinks
    .filter((link) => link.entityType === 'deal')
    .map(({ companyId: _companyId, ...link }) => link);
  if (company.counterpartyId && company.counterpartyName) {
    links.push({
      entityType: 'company',
      entityId: company.counterpartyId,
      entityTitle: company.counterpartyName,
      linkRole: 'counterparty',
    });
  }
  return {
    ...company,
    legalEntityId: null,
    legalEntityName: null,
    links,
    taskLinks,
    responsibleId: responsible.id,
    responsibleName: responsible.name,
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
  let normalized = input;
  if (input.responsibleId !== undefined) {
    const responsible = await crmContext.resolveUserSelection(
      context,
      input.responsibleId,
      input.responsibleName,
    );
    normalized = {
      ...normalized,
      responsibleId: responsible.id,
      responsibleName: responsible.name,
    };
  } else if (input.responsibleName !== undefined) {
    throw new ApiError(
      400,
      'responsible_user_selection_required',
      'Responsible must be selected from Bitrix24 users.',
    );
  }
  if (input.counterpartyId === undefined && input.counterpartyName === undefined) return normalized;
  if (!input.counterpartyId) {
    if (input.counterpartyName) {
      throw new ApiError(
        400,
        'counterparty_company_selection_required',
        'Counterparty must be selected from Bitrix24 companies.',
      );
    }
    return { ...normalized, counterpartyId: null, counterpartyName: null };
  }
  const company = await crmContext.resolveCompanySelection(
    context,
    input.counterpartyId,
    input.counterpartyName,
  );
  return { ...normalized, counterpartyId: company.id, counterpartyName: company.title };
}

async function canonicalizeExistingDocumentLinks(
  context: ReturnType<typeof requireRegistryContext>,
  items: Array<ReturnType<typeof addDocumentLinkSchema.parse>>,
  crmContext: CrmContextService,
  counterpartyId: number | null,
  counterpartyName: string | null,
) {
  const resolved = await Promise.all(items.map(async (item) => {
    if (item.entityType === 'deal') {
      const deal = await crmContext.resolveDealSelection(
        context,
        item.entityId,
        item.entityTitle,
      );
      if (deal.companyId !== undefined && deal.companyId !== counterpartyId) {
        throw new ApiError(
          409,
          'crm_company_scope_mismatch',
          'The selected deal must belong to the document counterparty company.',
          { dealId: deal.id, dealCompanyId: deal.companyId, counterpartyId },
        );
      }
      return {
        ...item,
        entityId: deal.id,
        entityTitle: deal.title,
        dealCompanyId: deal.companyId,
      };
    }
    const company = await crmContext.resolveCompanySelection(
      context,
      item.entityId,
      item.entityTitle,
    );
    if (company.id !== counterpartyId) {
      throw new ApiError(
        409,
        'counterparty_company_link_mismatch',
        'The company link is managed through the document counterparty field.',
      );
    }
    return { ...item, entityId: company.id, entityTitle: company.title };
  }));
  const withoutCompanies = resolved.filter((item) => item.entityType !== 'company');
  if (counterpartyId) {
    withoutCompanies.push({
      entityType: 'company',
      entityId: counterpartyId,
      entityTitle: counterpartyName || `Компания #${counterpartyId}`,
      linkRole: 'counterparty',
    });
  }
  return withoutCompanies;
}

async function assertDealCompanyCompatibility(
  context: ReturnType<typeof requireRegistryContext>,
  links: Array<{
    entityType: 'deal' | 'company';
    entityId: number;
    entityTitle: string;
  }>,
  counterpartyId: number | null,
  crmContext: CrmContextService,
) {
  const deals = await Promise.all(
    links
      .filter((link) => link.entityType === 'deal')
      .map((link) => crmContext.resolveDealSelection(
        context,
        link.entityId,
        link.entityTitle,
      )),
  );
  const mismatch = deals.find((deal) =>
    deal.companyId !== undefined && deal.companyId !== counterpartyId);
  if (mismatch) {
    throw new ApiError(
      409,
      'crm_company_scope_mismatch',
      'Change the linked deals first: every deal must belong to the selected counterparty company.',
      {
        dealId: mismatch.id,
        dealCompanyId: mismatch.companyId,
        counterpartyId,
      },
    );
  }
}

async function replaceDocumentLinksSafely(
  context: ReturnType<typeof requireRegistryContext>,
  documentId: string,
  currentLinks: Array<{
    id: string;
    entityType: 'deal' | 'company';
    entityId: number;
    entityTitle: string;
    linkRole: string | null;
  }>,
  selected: Array<{
    entityType: 'deal' | 'company';
    entityId: number;
    entityTitle: string;
    linkRole?: string | null;
    dealCompanyId?: number | null;
  }>,
  documents: ReturnType<typeof createDocumentsService>,
) {
  const keyOf = (item: { entityType: string; entityId: number }) =>
    `${item.entityType}:${item.entityId}`;
  const currentByKey = new Map(currentLinks.map((item) => [keyOf(item), item]));
  const selectedByKey = new Map(selected.map((item) => [keyOf(item), item]));
  const additions = [...selectedByKey.entries()]
    .filter(([key]) => !currentByKey.has(key))
    .map(([, item]) => item);
  const removals = [...currentByKey.entries()]
    .filter(([key]) => !selectedByKey.has(key))
    .map(([, item]) => item)
    .filter((item) => item.entityType !== 'company');
  const addedKeys: string[] = [];
  const removed: typeof removals = [];
  try {
    for (const item of additions) {
      await documents.addLink(context, documentId, item);
      addedKeys.push(keyOf(item));
    }
    for (const item of removals) {
      await documents.removeLink(context, documentId, item.id);
      removed.push(item);
    }
    return documents.getById(context, documentId);
  } catch (error) {
    for (const item of [...removed].reverse()) {
      await documents.addLink(context, documentId, item).catch(() => undefined);
    }
    const fresh = await documents.getById(context, documentId).catch(() => null);
    if (fresh) {
      for (const key of [...addedKeys].reverse()) {
        const link = fresh.links.find((item) => keyOf(item) === key);
        if (link) await documents.removeLink(context, documentId, link.id).catch(() => undefined);
      }
    }
    throw error;
  }
}
