import { z } from 'zod';

const safeDisplayName = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), 'Control characters are not allowed.');

export const attachmentIdSchema = z.string().uuid();
export const uploadIdSchema = z.string().uuid();

export const initializeFileUploadSchema = z.object({
  name: safeDisplayName,
  mimeType: z.string().trim().max(255).optional(),
  sizeBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  replacesAttachmentId: attachmentIdSchema.optional(),
});

export const addExternalLinkSchema = z.object({
  name: safeDisplayName.optional(),
  url: z
    .string()
    .trim()
    .max(2048)
    .url()
    .superRefine((value, context) => {
      const url = new URL(value);
      if (url.protocol !== 'https:') {
        context.addIssue({ code: z.ZodIssueCode.custom, message: 'Only HTTPS links are allowed.' });
      }
      if (url.username || url.password) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: 'Credentials are not allowed in links.' });
      }
    }),
});

export type InitializeFileUploadInput = z.infer<typeof initializeFileUploadSchema>;
export type AddExternalLinkInput = z.infer<typeof addExternalLinkSchema>;
