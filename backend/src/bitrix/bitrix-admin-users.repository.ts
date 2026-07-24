import { and, eq, sql } from 'drizzle-orm';

import type { Database } from '../db/database.js';
import { registrySettings } from '../db/schema/index.js';

const BITRIX_ADMIN_USERS_SETTING = 'bitrix_admin_user_ids';

export async function saveBitrixAdminStatus(
  database: Database,
  portalUrl: string,
  userId: number,
  isAdmin: boolean,
) {
  const value = isAdmin ? { [String(userId)]: true } : {};
  await database
    .insert(registrySettings)
    .values({
      portalUrl,
      key: BITRIX_ADMIN_USERS_SETTING,
      value,
    })
    .onConflictDoUpdate({
      target: [registrySettings.portalUrl, registrySettings.key],
      set: {
        value: isAdmin
          ? sql`${registrySettings.value} || excluded.value`
          : sql`${registrySettings.value} - ${String(userId)}`,
        updatedAt: new Date(),
      },
    });
}

export async function loadKnownBitrixAdminIds(
  database: Database,
  portalUrl: string,
) {
  const [setting] = await database
    .select({ value: registrySettings.value })
    .from(registrySettings)
    .where(
      and(
        eq(registrySettings.portalUrl, portalUrl),
        eq(registrySettings.key, BITRIX_ADMIN_USERS_SETTING),
      ),
    )
    .limit(1);

  if (!setting || !isRecord(setting.value)) return new Set<number>();
  return new Set(
    Object.entries(setting.value)
      .filter(([, enabled]) => enabled === true)
      .map(([userId]) => Number(userId))
      .filter((userId) => Number.isSafeInteger(userId) && userId > 0),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
