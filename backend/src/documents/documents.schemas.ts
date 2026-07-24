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
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export type DocumentListQuery = z.infer<typeof documentListQuerySchema>;

const exportColumns = z
  .string().max(200)
  .optional()
  .transform((value) => value === undefined
    ? undefined
    : value.split(',').map((item) => item.trim()).filter(Boolean))
  .refine(
    (value) => value === undefined || (
      value.length <= 6
      && value.every((item) => [
        'section',
        'counterparty',
        'status',
        'amount',
        'docDate',
        'responsible',
      ].includes(item))
    ),
    'Invalid export columns.',
  );

export const documentExportQuerySchema = documentListQuerySchema.omit({
  limit: true,
  offset: true,
}).extend({ columns: exportColumns });

export type DocumentExportQuery = z.infer<typeof documentExportQuerySchema>;

export const documentIdSchema = z.string().uuid();
export const documentLinkIdSchema = z.string().uuid();
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
  fields: z.record(z.unknown()).default({}),
});

export type CreateDocumentInput = z.infer<typeof createDocumentSchema>;

export const updateDocumentSchema = createDocumentSchema
  .omit({ sectionCode: true, typeCode: true, links: true, supersedesId: true })
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
