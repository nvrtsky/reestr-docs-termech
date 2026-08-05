import type { BitrixApiClient } from '../bitrix/bitrix-client.js';
import { ApiError } from '../http/api-error.js';
import type { RegistryContext } from '../http/registry-context.js';

interface BitrixDepartmentRecord {
  ID: string | number;
  NAME?: string;
  SORT?: string | number;
  PARENT?: string | number;
  UF_HEAD?: string | number;
}

export interface RegistryDepartmentOption {
  id: number;
  name: string;
  path: string;
  parentId: number | null;
  headId: number | null;
  sortOrder: number;
}

const PAGE_SIZE = 50;
const MAX_DEPARTMENTS = 10_000;
const CACHE_TTL_MS = 60_000;

const cache = new Map<string, { expiresAt: number; items: RegistryDepartmentOption[] }>();
const pending = new Map<string, Promise<RegistryDepartmentOption[]>>();

export async function listBitrixDepartments(
  context: RegistryContext,
  bitrix: BitrixApiClient,
): Promise<RegistryDepartmentOption[]> {
  if (!context.bitrix) return [];
  const cached = cache.get(context.portalUrl);
  if (cached && cached.expiresAt > Date.now()) return cached.items;
  const active = pending.get(context.portalUrl);
  if (active) return active;

  const loading = loadDepartments(context, bitrix)
    .then((items) => {
      cache.set(context.portalUrl, { items, expiresAt: Date.now() + CACHE_TTL_MS });
      return items;
    })
    .finally(() => pending.delete(context.portalUrl));
  pending.set(context.portalUrl, loading);
  return loading;
}

async function loadDepartments(context: RegistryContext, bitrix: BitrixApiClient) {
  const { domain, accessToken } = context.bitrix!;
  const raw = new Map<number, Omit<RegistryDepartmentOption, 'path'>>();
  for (let start = 0; start < MAX_DEPARTMENTS; start += PAGE_SIZE) {
    const page = await bitrix.call<BitrixDepartmentRecord[]>(
      domain,
      accessToken,
      'department.get',
      { sort: 'SORT', order: 'ASC', START: start },
    );
    if (!Array.isArray(page)) {
      throw new ApiError(
        502,
        'bitrix_departments_invalid',
        'Bitrix24 returned an invalid department list.',
      );
    }
    for (const item of page) {
      const id = positiveId(item.ID);
      if (!id) continue;
      raw.set(id, {
        id,
        name: item.NAME?.trim() || `Подразделение #${id}`,
        parentId: positiveId(item.PARENT),
        headId: positiveId(item.UF_HEAD),
        sortOrder: integer(item.SORT, 500),
      });
    }
    if (page.length < PAGE_SIZE) break;
  }

  const paths = new Map<number, string>();
  const resolvePath = (id: number, visited = new Set<number>()): string => {
    const cachedPath = paths.get(id);
    if (cachedPath) return cachedPath;
    const department = raw.get(id);
    if (!department) return `Подразделение #${id}`;
    if (visited.has(id)) return department.name;
    const nextVisited = new Set(visited).add(id);
    const parentPath = department.parentId && raw.has(department.parentId)
      ? resolvePath(department.parentId, nextVisited)
      : '';
    const path = parentPath ? `${parentPath} / ${department.name}` : department.name;
    paths.set(id, path);
    return path;
  };

  return [...raw.values()]
    .map((department) => ({ ...department, path: resolvePath(department.id) }))
    .sort((left, right) =>
      left.path.localeCompare(right.path, 'ru') || left.id - right.id,
    );
}

function positiveId(value: unknown) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function integer(value: unknown, fallback: number) {
  const result = Number(value);
  return Number.isSafeInteger(result) ? result : fallback;
}
