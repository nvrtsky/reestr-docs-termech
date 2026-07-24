import { createHash, timingSafeEqual } from 'node:crypto';

import { eq, and } from 'drizzle-orm';

import type { Database } from '../db/database.js';
import { registrySettings } from '../db/schema/index.js';

export const BITRIX_EVENT_TOKEN_HASH_SETTING = 'bitrix_event_application_token_sha256';

interface StoredTokenHash {
  sha256?: unknown;
}

export async function saveBitrixEventTokenHash(
  database: Database,
  portalUrl: string,
  applicationToken: string,
  memberId?: string,
) {
  const value = {
    sha256: hashToken(applicationToken),
    memberId: memberId || null,
    installedAt: new Date().toISOString(),
  };
  await database
    .insert(registrySettings)
    .values({
      portalUrl,
      key: BITRIX_EVENT_TOKEN_HASH_SETTING,
      value,
    })
    .onConflictDoUpdate({
      target: [registrySettings.portalUrl, registrySettings.key],
      set: {
        value,
        updatedAt: new Date(),
      },
    });
}

export async function loadBitrixEventTokenHash(database: Database, portalUrl: string) {
  const [setting] = await database
    .select({ value: registrySettings.value })
    .from(registrySettings)
    .where(
      and(
        eq(registrySettings.portalUrl, portalUrl),
        eq(registrySettings.key, BITRIX_EVENT_TOKEN_HASH_SETTING),
      ),
    )
    .limit(1);
  const value = setting?.value as StoredTokenHash | undefined;
  return typeof value?.sha256 === 'string' && /^[a-f0-9]{64}$/i.test(value.sha256)
    ? value.sha256.toLowerCase()
    : null;
}

export function eventTokenMatchesHash(applicationToken: string, expectedHash: string) {
  const actual = Buffer.from(hashToken(applicationToken), 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function hashToken(applicationToken: string) {
  return createHash('sha256').update(applicationToken).digest('hex');
}
