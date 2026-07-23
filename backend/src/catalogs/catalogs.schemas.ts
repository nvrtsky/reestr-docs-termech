import { z } from 'zod';

const documentTypeFieldSchema = z.object({
  name: z.string().trim().min(1).max(200),
  dataType: z.enum(['text', 'number', 'date', 'money', 'select', 'boolean', 'file']),
  isRequired: z.boolean().default(false),
});

const updatedDocumentTypeFieldSchema = documentTypeFieldSchema.extend({
  key: z.string().trim().min(1).max(200).optional(),
});

export const createDocumentTypeSchema = z.object({
  sectionCode: z.string().trim().min(1).max(100),
  name: z.string().trim().min(1).max(200),
  lifecycleCode: z.string().trim().min(1).max(100),
  fields: z.array(documentTypeFieldSchema).max(100).default([]),
});

export const updateDocumentTypeSchema = createDocumentTypeSchema.extend({
  description: z.string().trim().max(2_000).nullable().optional(),
  sortOrder: z.number().int().min(0).max(1_000_000).optional(),
  isActive: z.boolean().optional(),
  fields: z.array(updatedDocumentTypeFieldSchema).max(100).default([]),
});
