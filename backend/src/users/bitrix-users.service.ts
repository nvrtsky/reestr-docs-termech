import type { BitrixApiClient } from '../bitrix/bitrix-client.js';
import { ApiError } from '../http/api-error.js';
import type { RegistryContext } from '../http/registry-context.js';

interface BitrixUserRecord {
  ID: string | number;
  ACTIVE?: boolean;
  ADMIN?: boolean | number | string;
  IS_ADMIN?: boolean | number | string;
  IS_INTEGRATOR?: boolean | number | string;
  NAME?: string;
  LAST_NAME?: string;
  SECOND_NAME?: string;
  EMAIL?: string;
  WORK_POSITION?: string;
}

export interface RegistryUserOption {
  id: number;
  name: string;
  email: string | null;
  position: string | null;
  isBitrixAdmin: boolean;
}

const PAGE_SIZE = 50;
const MAX_USERS = 10_000;
const CACHE_TTL_MS = 60_000;

interface CachedUsers {
  expiresAt: number;
  items: RegistryUserOption[];
}

const usersCache = new Map<string, CachedUsers>();
const pendingUsers = new Map<string, Promise<RegistryUserOption[]>>();

export async function listBitrixUsers(
  context: RegistryContext,
  bitrix: BitrixApiClient,
): Promise<RegistryUserOption[]> {
  if (!context.bitrix) {
    return [{
      id: context.userId,
      name: `Пользователь #${context.userId}`,
      email: null,
      position: null,
      isBitrixAdmin: context.roleCode === 'admin',
    }];
  }
  const { domain, accessToken } = context.bitrix;

  const cacheKey = `${context.portalUrl}\0${context.userId}`;
  const cached = usersCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.items;
  const pending = pendingUsers.get(cacheKey);
  if (pending) return pending;

  const loading = loadBitrixUsers(domain, accessToken, context, bitrix)
    .then((items) => {
      usersCache.set(cacheKey, {
        items,
        expiresAt: Date.now() + CACHE_TTL_MS,
      });
      return items;
    })
    .finally(() => {
      pendingUsers.delete(cacheKey);
    });
  pendingUsers.set(cacheKey, loading);
  return loading;
}

async function loadBitrixUsers(
  domain: string,
  accessToken: string,
  context: RegistryContext,
  bitrix: BitrixApiClient,
) {
  const users = new Map<number, RegistryUserOption>();
  for (let start = 0; start < MAX_USERS; start += PAGE_SIZE) {
    const page = await bitrix.call<BitrixUserRecord[]>(
      domain,
      accessToken,
      'user.get',
      { ACTIVE: true, SORT: 'ID', ORDER: 'ASC', start },
    );
    if (!Array.isArray(page)) {
      throw new ApiError(502, 'bitrix_users_invalid', 'Bitrix24 returned an invalid user list.');
    }

    for (const item of page) {
      const id = Number(item.ID);
      if (!Number.isSafeInteger(id) || id <= 0 || item.ACTIVE === false) continue;
      const name = [item.LAST_NAME, item.NAME, item.SECOND_NAME]
        .map((part) => part?.trim())
        .filter(Boolean)
        .join(' ') || `Пользователь #${id}`;
      users.set(id, {
        id,
        name,
        email: item.EMAIL?.trim() || null,
        position: item.WORK_POSITION?.trim() || null,
        isBitrixAdmin: isEnabled(item.ADMIN)
          || isEnabled(item.IS_ADMIN)
          || isEnabled(item.IS_INTEGRATOR)
          || (id === context.userId && context.roleCode === 'admin'),
      });
    }
    if (page.length < PAGE_SIZE) break;
  }

  return [...users.values()].sort((left, right) =>
    left.name.localeCompare(right.name, 'ru') || left.id - right.id,
  );
}

function isEnabled(value: boolean | number | string | undefined) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value === 1;
  return typeof value === 'string' && ['1', 'Y', 'YES', 'TRUE'].includes(value.trim().toUpperCase());
}
