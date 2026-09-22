import { z } from 'zod';

const documentReleaseTokensSchema = z.string().default('{}').transform((value, context) => {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error();
    const tokens: Record<string, string> = {};
    for (const [portal, token] of Object.entries(parsed)) {
      const url = new URL(portal);
      if (
        url.protocol !== 'https:'
        || url.username
        || url.password
        || url.pathname !== '/'
        || url.search
        || url.hash
        || typeof token !== 'string'
        || token.length < 32
      ) {
        throw new Error();
      }
      tokens[url.origin.toLowerCase()] = token;
    }
    return tokens;
  } catch {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'DOCUMENT_RELEASE_TOKENS_JSON must map HTTPS portal origins to 32+ character tokens.',
    });
    return z.NEVER;
  }
});

const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_HOST: z.string().min(1).default('127.0.0.1'),
  API_PORT: z.coerce.number().int().positive().default(3001),
  WEB_ORIGIN: z.string().url().default('http://127.0.0.1:4173'),
  PUBLIC_BASE_URL: z.string().url().default('http://127.0.0.1:4173'),
  BITRIX_APP_PATH: z.string().refine(
    (value) => value === '/' || (/^\/.*\/$/.test(value) && !value.includes('//')),
    'BITRIX_APP_PATH must be / or a slash-delimited path.',
  ).default('/registry/'),
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
  BITRIX_MARKETPLACE_MODE: z.preprocess(
    (value) => value === true || value === 'true' || value === '1',
    z.boolean().default(false),
  ),
  BITRIX_CLIENT_ID: z.string().default(''),
  BITRIX_CLIENT_SECRET: z.string().default(''),
  BITRIX_APP_CODE: z.string().default(''),
  TOKEN_ENCRYPTION_KEY: z.string().default(''),
  BITRIX_OAUTH_URL: z.string().url().default('https://oauth.bitrix.info/oauth/token/'),
  DATA_RETENTION_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  SUPPORT_EMAIL: z.string().email().default('alexandr@navrotsky.ru'),
  BITRIX_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1000).max(30000).default(10000),
  BITRIX_UPLOAD_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(10000)
    .max(3600000)
    .default(600000),
  BITRIX_EVENT_APPLICATION_TOKEN: z.preprocess(
    (value) => value === '' ? undefined : value,
    z.string().min(16).optional(),
  ),
  DOCUMENT_RELEASE_TOKENS_JSON: documentReleaseTokensSchema,
  DOCUMENT_RELEASE_MAX_PDF_BYTES: z.coerce
    .number()
    .int()
    .min(1024)
    .max(100 * 1024 * 1024)
    .default(20 * 1024 * 1024),
});

export type AppConfig = z.infer<typeof environmentSchema>;

export function loadConfig(environment = process.env): AppConfig {
  const config = environmentSchema.parse(environment);
  if (config.BITRIX_MARKETPLACE_MODE) {
    const missing = [
      ['BITRIX_CLIENT_ID', config.BITRIX_CLIENT_ID],
      ['BITRIX_CLIENT_SECRET', config.BITRIX_CLIENT_SECRET],
      ['BITRIX_APP_CODE', config.BITRIX_APP_CODE],
      ['TOKEN_ENCRYPTION_KEY', config.TOKEN_ENCRYPTION_KEY],
    ].filter(([, value]) => !value).map(([name]) => name);
    if (missing.length) {
      throw new Error(`Marketplace configuration is incomplete: ${missing.join(', ')}`);
    }
  }
  return config;
}
