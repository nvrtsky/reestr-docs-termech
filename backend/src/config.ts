import { z } from 'zod';

const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_HOST: z.string().min(1).default('127.0.0.1'),
  API_PORT: z.coerce.number().int().positive().default(3001),
  WEB_ORIGIN: z.string().url().default('http://127.0.0.1:4173'),
  DATABASE_URL: z
    .string()
    .min(1)
    .default('postgresql://registry:registry@127.0.0.1:55432/registry'),
  DEVELOPMENT_PORTAL_URL: z
    .string()
    .url()
    .default('https://thermech.bitrix24.ru'),
  DEVELOPMENT_USER_ID: z.coerce.number().int().positive().default(1),
  DEVELOPMENT_ROLE: z.string().min(1).default('admin'),
  BITRIX_ALLOWED_DOMAINS: z
    .string()
    .default('thermech.bitrix24.ru')
    .transform((value) => value.split(',').map((domain) => domain.trim()).filter(Boolean)),
  BITRIX_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1000).max(30000).default(10000),
  BITRIX_UPLOAD_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(10000)
    .max(3600000)
    .default(600000),
  BITRIX_EVENT_APPLICATION_TOKEN: z.string().min(16).optional(),
});

export type AppConfig = z.infer<typeof environmentSchema>;

export function loadConfig(environment = process.env): AppConfig {
  return environmentSchema.parse(environment);
}
