import { z } from 'zod';

const commaSeparated = z
  .string()
  .optional()
  .transform((value) =>
    value
      ? value
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean)
      : [],
  );

const fieldFilters = z.string().max(8_000).optional().transform((value, context) => {
  if (!value) return {} as Record<string, string | number | boolean>;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    const entries = Object.entries(parsed as Record<string, unknown>);
    if (entries.length > 20 || entries.some(([key, item]) =>
      !/^[a-z0-9_:-]{1,200}$/i.test(key)
      || !['string', 'number', 'boolean'].includes(typeof item)
      || (typeof item === 'string' && item.length > 500))) {
      throw new Error();
    }
    return Object.fromEntries(entries) as Record<string, string | number | boolean>;
  } catch {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid dynamic field filters.' });
    return z.NEVER;
  }
});

export const documentListQuerySchema = z.object({
  search: z.string().trim().max(200).optional(),
  view: z.enum(['all', 'mine', 'work', 'draft']).default('all'),
  deleted: z.enum(['exclude', 'only']).default('exclude'),
  sections: commaSeparated,
  statuses: commaSeparated,
  type: z.string().trim().max(100).optional(),
  responsibleId: z.coerce.number().int().positive().optional(),
  counterparty: z.string().trim().max(200).optional(),
  from: z.string().date().optional(),
  to: z.string().date().optional(),
  fieldFilters,
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export type DocumentListQuery = z.infer<typeof documentListQuerySchema>;

const exportColumns = z
  .string().max(8_000)
  .optional()
  .transform((value) => value === undefined
    ? undefined
    : value.split(',').map((item) => item.trim()).filter(Boolean))
  .refine(
    (value) => value === undefined || (
      value.length <= 50
      && value.every((item) => [
        'section',
        'counterparty',
        'status',
        'amount',
        'docDate',
        'responsible',
      ].includes(item) || /^field:[a-z0-9_:-]{1,200}$/i.test(item))
    ),
    'Invalid export columns.',
  );

export const documentExportQuerySchema = documentListQuerySchema.omit({
  limit: true,
  offset: true,
}).extend({ columns: exportColumns });

export type DocumentExportQuery = z.infer<typeof documentExportQuerySchema>;

export const documentIdSchema = z.string().uuid();
export const dealIdSchema = z.coerce.number().int().positive();
export const dealFinancialSummaryQuerySchema = z.object({
  currency: z.enum(['RUB', 'USD', 'EUR', 'CNY']).default('RUB'),
});
export const documentLinkIdSchema = z.string().uuid();
export const setParentRelationSchema = z.object({
  parentDocumentId: documentIdSchema,
  relationType: z.enum(['addendum', 'appendix', 'other']),
});
export type SetParentRelationInput = z.infer<typeof setParentRelationSchema>;
export const taskLinkIdSchema = z.string().uuid();
export const documentDetailsQuerySchema = z.object({
  deleted: z.enum(['exclude', 'only']).default('exclude'),
});

export const entityDocumentsQuerySchema = documentListQuerySchema.extend({
  entityType: z.enum(['deal', 'company']),
  entityId: z.coerce.number().int().positive(),
  limit: z.coerce.number().int().min(1).max(1000).default(100),
});

export type EntityDocumentsQuery = z.infer<typeof entityDocumentsQuerySchema>;

export const addDocumentLinkSchema = z.object({
  entityType: z.enum(['deal', 'company']),
  entityId: z.number().int().positive(),
  entityTitle: z.string().trim().min(1).max(500).optional(),
  linkRole: z.string().trim().max(100).nullable().optional(),
});

export type AddDocumentLinkInput = z.infer<typeof addDocumentLinkSchema>;

export const replaceDocumentLinksSchema = z.object({
  items: z.array(addDocumentLinkSchema).max(50),
}).superRefine(({ items }, context) => {
  const keys = new Set<string>();
  for (const [index, item] of items.entries()) {
    const key = `${item.entityType}:${item.entityId}`;
    if (keys.has(key)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['items', index, 'entityId'],
        message: `CRM entity ${key} is selected more than once.`,
      });
    }
    keys.add(key);
  }
});

export const taskSearchQuerySchema = z.object({
  search: z.string().trim().max(200).default(''),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export const addTaskLinkSchema = z.object({
  taskId: z.number().int().positive(),
  taskTitle: z.string().trim().min(1).max(500).optional(),
});

export type AddTaskLinkInput = z.infer<typeof addTaskLinkSchema>;

const optionalText = z.string().trim().max(1000).nullable().optional();
const money = z
  .union([z.string(), z.number()])
  .transform((value) => String(value).replace(',', '.'))
  .refine((value) => /^\d+(\.\d{1,2})?$/.test(value), 'Invalid money value');

export const createDocumentSchema = z.object({
  sectionCode: z.string().trim().min(1).max(100),
  typeCode: z.string().trim().min(1).max(100),
  number: optionalText,
  title: z.string().trim().min(1).max(500),
  documentDate: z.string().date(),
  amount: money.nullable().optional(),
  currency: z.string().trim().length(3).toUpperCase().nullable().optional(),
  legalEntityId: z.number().int().positive().nullable().optional(),
  legalEntityName: optionalText,
  counterpartyId: z.number().int().positive().nullable().optional(),
  counterpartyName: optionalText,
  dealStageId: optionalText,
  status: z.string().trim().min(1).max(100).optional(),
  comment: optionalText,
  responsibleId: z.coerce.number().int().positive().optional(),
  responsibleName: optionalText,
  supersedesId: documentIdSchema.optional(),
  links: z
    .array(
      z.object({
        entityType: z.enum(['deal', 'company']),
        entityId: z.number().int().positive(),
        entityTitle: z.string().trim().min(1).max(500),
        linkRole: z.string().trim().max(100).nullable().optional(),
      }),
    )
    .max(50)
    .default([]),
  taskLinks: z.array(addTaskLinkSchema).max(20).default([]),
  fields: z.record(z.unknown()).default({}),
});

export type CreateDocumentInput = z.infer<typeof createDocumentSchema>;

export const bulkUploadDocumentsSchema = z.object({
  items: z.array(z.object({
    clientRowId: z.string().trim().min(1).max(100),
    idempotencyKey: z.string().uuid(),
    document: createDocumentSchema,
  })).min(1).max(50)
    .refine(
      (items) => new Set(items.map((item) => item.clientRowId)).size === items.length,
      'Идентификаторы строк массовой загрузки не должны повторяться.',
    )
    .refine(
      (items) => new Set(items.map((item) => item.idempotencyKey)).size === items.length,
      'Ключи идемпотентности массовой загрузки не должны повторяться.',
    ),
});

export type BulkUploadDocumentsInput = z.infer<typeof bulkUploadDocumentsSchema>;

export const updateDocumentSchema = createDocumentSchema
  .omit({ sectionCode: true, typeCode: true, status: true, links: true, taskLinks: true, supersedesId: true })
  .partial()
  .extend({ fields: z.record(z.unknown()).optional() })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'At least one field must be provided.',
  });

export type UpdateDocumentInput = z.infer<typeof updateDocumentSchema>;

export const transitionDocumentSchema = z.object({
  status: z.string().trim().min(1).max(100),
  comment: z.string().trim().max(1000).optional(),
});

const bulkDocumentIds = z.array(documentIdSchema).min(1).max(100)
  .refine((items) => new Set(items).size === items.length, 'Идентификаторы документов не должны повторяться.');

export const bulkAssignDocumentsSchema = z.object({
  documentIds: bulkDocumentIds,
  responsibleId: z.number().int().positive(),
  responsibleName: z.string().trim().min(1).max(300).nullable().optional(),
});
export type BulkAssignDocumentsInput = z.infer<typeof bulkAssignDocumentsSchema>;

export const bulkDeleteDocumentsSchema = z.object({
  documentIds: bulkDocumentIds,
});
export type BulkDeleteDocumentsInput = z.infer<typeof bulkDeleteDocumentsSchema>;

export const bulkRestoreDocumentsSchema = z.object({
  documentIds: bulkDocumentIds,
});
export type BulkRestoreDocumentsInput = z.infer<typeof bulkRestoreDocumentsSchema>;
