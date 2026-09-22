import { z } from 'zod';

const positiveId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const nullableName = z.string().trim().min(1).max(500).nullable().optional();
const money = z.string().regex(/^-?\d{1,16}(?:\.\d{1,2})?$/).nullable();
const base64 = z.string().min(4).refine(
  (value) => value.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(value),
  'PDF content must be canonical base64.',
);

const internalUrl = z.string().url().max(2048).superRefine((value, context) => {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Internal document links must use HTTPS and cannot include credentials.',
    });
  }
  for (const key of url.searchParams.keys()) {
    if (/(?:access|auth|refresh|session)?[_-]?token|auth_id/i.test(key)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Internal document links cannot include tokens.',
      });
      break;
    }
  }
});

export const documentReleaseSchema = z.object({
  portalUrl: z.string().url().max(500),
  source: z.enum(['kp_constructor', 'bitrix_smart_invoice']),
  externalDocumentId: z.string().trim().min(1).max(200),
  externalEntityTypeId: z.number().int().positive().optional(),
  externalEntityId: positiveId.optional(),
  versionId: z.string().trim().min(1).max(200),
  releasedAt: z.string().datetime({ offset: true }),
  document: z.object({
    number: z.string().trim().min(1).max(500).nullable(),
    title: z.string().trim().min(1).max(1000),
    documentDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    amount: money,
    currency: z.string().regex(/^[A-Z]{3}$/).nullable(),
    legalEntityId: positiveId.nullable().optional(),
    legalEntityName: nullableName,
    counterpartyId: positiveId.nullable().optional(),
    counterpartyName: nullableName,
    responsibleId: positiveId,
    responsibleName: nullableName,
  }),
  crm: z.object({
    company: z.object({
      id: positiveId,
      title: z.string().trim().min(1).max(500),
    }).nullable().optional(),
    deals: z.array(z.object({
      id: positiveId,
      title: z.string().trim().min(1).max(500),
      closed: z.boolean().nullable().optional(),
    })).max(50).default([]).superRefine((deals, context) => {
      const ids = new Set<number>();
      deals.forEach((deal, index) => {
        if (ids.has(deal.id)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: [index, 'id'],
            message: 'Deal IDs must be unique.',
          });
        }
        ids.add(deal.id);
      });
    }),
  }).default({ deals: [] }),
  internalUrl,
  pdf: z.object({
    name: z.string().trim().min(1).max(255).refine(
      (value) => value.toLowerCase().endsWith('.pdf'),
      'Released file name must use the .pdf extension.',
    ),
    mimeType: z.literal('application/pdf'),
    sizeBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    contentBase64: base64,
  }),
}).superRefine((value, context) => {
  if (value.source === 'bitrix_smart_invoice') {
    if (value.externalEntityTypeId !== 31 || !value.externalEntityId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['externalEntityId'],
        message: 'A smart invoice requires entity type 31 and its Bitrix24 entity ID.',
      });
    } else if (value.externalDocumentId !== String(value.externalEntityId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['externalDocumentId'],
        message: 'A smart invoice external document ID must match its Bitrix24 entity ID.',
      });
    }
  } else if (value.externalEntityId || value.externalEntityTypeId) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['externalEntityId'],
      message: 'Constructor commercial offers use only their string external document ID.',
    });
  } else if (!z.string().uuid().safeParse(value.externalDocumentId).success) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['externalDocumentId'],
      message: 'A constructor commercial offer requires its UUID external document ID.',
    });
  }
  if ((value.document.amount === null) !== (value.document.currency === null)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['document', 'currency'],
      message: 'Amount and currency must both be set or both be null.',
    });
  }
  if ((value.crm.company?.id ?? null) !== (value.document.counterpartyId ?? null)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['crm', 'company'],
      message: 'CRM company must match the document counterparty.',
    });
  }
});

export type DocumentReleaseInput = z.infer<typeof documentReleaseSchema>;
