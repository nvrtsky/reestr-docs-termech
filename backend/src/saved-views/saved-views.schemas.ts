import { z } from 'zod';

const codeSchema = z.string().trim().min(1).max(100).regex(/^[a-z0-9_]+$/);

export const savedViewColumns = [
  'section',
  'counterparty',
  'status',
  'amount',
  'docDate',
  'responsible',
] as const;

const savedViewFiltersSchema = z.object({
  search: z.string().trim().max(500).default(''),
  view: z.enum(['all', 'mine', 'awaiting', 'draft']).default('all'),
  sections: z.array(codeSchema).max(100).default([]),
  statuses: z.array(codeSchema).max(100).default([]),
  type: codeSchema.nullable().default(null),
  responsibleId: z.number().int().positive().safe().nullable().default(null),
  counterparty: z.string().trim().max(1_000).default(''),
  from: z.string().date().nullable().default(null),
  to: z.string().date().nullable().default(null),
});

export const createSavedViewSchema = z.object({
  name: z.string().trim().min(1).max(100),
  filters: savedViewFiltersSchema,
  columns: z.array(z.enum(savedViewColumns)).max(savedViewColumns.length),
  isShared: z.boolean().default(false),
});

export const updateSavedViewSchema = createSavedViewSchema;

export type CreateSavedViewInput = z.infer<typeof createSavedViewSchema>;
