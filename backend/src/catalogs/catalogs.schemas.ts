import { z } from 'zod';

import { validateNumberingConfiguration } from '../documents/document-numbering.service.js';

const documentTypeFieldSchema = z.object({
  name: z.string().trim().min(1).max(200),
  dataType: z.enum(['text', 'number', 'date', 'money', 'select', 'boolean', 'file']),
  isRequired: z.boolean().default(false),
});

const updatedDocumentTypeFieldSchema = documentTypeFieldSchema.extend({
  key: z.string().trim().min(1).max(200).optional(),
});

const createDocumentTypeBaseSchema = z.object({
  sectionCode: z.string().trim().min(1).max(100).optional(),
  sectionCodes: z.array(z.string().trim().min(1).max(100)).min(1).max(100).optional(),
  name: z.string().trim().min(1).max(200),
  lifecycleCode: z.string().trim().min(1).max(100),
  numberFormat: z.string().trim().min(1).max(200).nullable().default(null),
  numberAutoGenerate: z.boolean().default(false),
  numberUniquenessEnabled: z.boolean().default(false),
  contentRequired: z.boolean().default(true),
  fields: z.array(documentTypeFieldSchema).max(100).default([]),
});

function validateDocumentType(
  value: { sectionCode?: string; sectionCodes?: string[] },
  context: z.RefinementCtx,
) {
  const sectionCodes = documentTypeSectionCodes(value);
  if (!sectionCodes.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['sectionCodes'],
      message: 'At least one document section is required.',
    });
  }
  if (new Set(sectionCodes).size !== sectionCodes.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['sectionCodes'],
      message: 'Document sections contain duplicate values.',
    });
  }
  const message = validateNumberingConfiguration(value as never);
  if (message) context.addIssue({ code: z.ZodIssueCode.custom, path: ['numberFormat'], message });
}

export const createDocumentTypeSchema = createDocumentTypeBaseSchema.superRefine(validateDocumentType);

export const updateDocumentTypeSchema = createDocumentTypeBaseSchema.extend({
  description: z.string().trim().max(2_000).nullable().optional(),
  sortOrder: z.number().int().min(0).max(1_000_000).optional(),
  isActive: z.boolean().optional(),
  numberFormat: z.string().trim().min(1).max(200).nullable().optional(),
  numberAutoGenerate: z.boolean().optional(),
  numberUniquenessEnabled: z.boolean().optional(),
  contentRequired: z.boolean().optional(),
  fields: z.array(updatedDocumentTypeFieldSchema).max(100).default([]),
}).superRefine(validateDocumentType);

export function documentTypeSectionCodes(input: {
  sectionCode?: string;
  sectionCodes?: string[];
}) {
  return input.sectionCodes?.length
    ? [...input.sectionCodes]
    : (input.sectionCode ? [input.sectionCode] : []);
}
