import { z } from 'zod';

const eventNameSchema = z.preprocess(
  (value) => typeof value === 'string' ? value.toUpperCase() : value,
  z.enum([
    'ONCRMDEALUPDATE',
    'ONCRMDEALDELETE',
    'ONCRMCOMPANYUPDATE',
    'ONCRMCOMPANYDELETE',
  ]),
);

export const crmEventSchema = z.object({
  event: eventNameSchema,
  event_handler_id: z.coerce.number().int().positive().optional(),
  data: z.object({
    FIELDS: z.object({
      ID: z.coerce.number().int().positive(),
    }),
  }),
  ts: z.coerce.number().int().positive().optional(),
  auth: z.object({
    domain: z.string().min(1),
    application_token: z.string().min(1),
    access_token: z.string().min(1).optional(),
    member_id: z.string().min(1).optional(),
  }),
});

export type CrmEvent = z.infer<typeof crmEventSchema>;
