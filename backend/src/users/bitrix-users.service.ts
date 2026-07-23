import type { BitrixApiClient } from '../bitrix/bitrix-client.js';
import { ApiError } from '../http/api-error.js';
import type { RegistryContext } from '../http/registry-context.js';

interface BitrixUserRecord {
  ID: string | number;
  ACTIVE?: boolean;
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
}

const PAGE_SIZE = 50;
const MAX_USERS = 10_000;

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
    }];
  }

  const users = new Map<number, RegistryUserOption>();
  for (let start = 0; start < MAX_USERS; start += PAGE_SIZE) {
    const page = await bitrix.call<BitrixUserRecord[]>(
      context.bitrix.domain,
      context.bitrix.accessToken,
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
      });
    }
    if (page.length < PAGE_SIZE) break;
  }

  return [...users.values()].sort((left, right) =>
    left.name.localeCompare(right.name, 'ru') || left.id - right.id,
  );
}
