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
  fieldFilters: z.record(z.union([z.string().max(500), z.number(), z.boolean()])).default({}),
});

export const createSavedViewSchema = z.object({
  name: z.string().trim().min(1).max(100),
  filters: savedViewFiltersSchema,
  columns: z.array(z.string().max(206).refine((value) =>
    (savedViewColumns as readonly string[]).includes(value)
    || /^field:[a-z0-9_:-]{1,200}$/i.test(value),
  )).max(50),
  isShared: z.boolean().default(false),
});

export const updateSavedViewSchema = createSavedViewSchema;

export type CreateSavedViewInput = z.infer<typeof createSavedViewSchema>;
