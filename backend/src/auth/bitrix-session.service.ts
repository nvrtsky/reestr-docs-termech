import { createHash } from 'node:crypto';

import { and, asc, eq, inArray } from 'drizzle-orm';

import { saveBitrixAdminStatus } from '../bitrix/bitrix-admin-users.repository.js';
import type { BitrixApiClient } from '../bitrix/bitrix-client.js';
import type { Database } from '../db/database.js';
import { registryDepartmentRoles, registryUserRoles } from '../db/schema/index.js';
import { ApiError } from '../http/api-error.js';
import type { RegistryContext } from '../http/registry-context.js';

interface BitrixProfile {
  ID: string;
  ADMIN?: boolean;
}

interface BitrixUser {
  ID: string;
  ACTIVE: boolean;
  NAME?: string;
  LAST_NAME?: string;
  SECOND_NAME?: string;
  UF_DEPARTMENT?: Array<string | number> | string | number;
}

interface CachedSession {
  expiresAt: number;
  context: RegistryContext;
}

export interface BitrixSessionResolver {
  resolve(domain: string, accessToken: string, memberId?: string): Promise<RegistryContext>;
  invalidatePortal?(portalUrl: string): void;
}

export class BitrixSessionService implements BitrixSessionResolver {
  private readonly cache = new Map<string, CachedSession>();
  private readonly pending = new Map<string, Promise<RegistryContext>>();

  constructor(
    private readonly database: Database,
    private readonly client: BitrixApiClient,
  ) {}

  invalidatePortal(portalUrl: string) {
    const normalized = portalUrl.replace(/\/$/, '').toLowerCase();
    for (const [key, item] of this.cache) {
      if (item.context.portalUrl.replace(/\/$/, '').toLowerCase() === normalized) {
        this.cache.delete(key);
      }
    }
  }

  async resolve(domainInput: string, accessToken: string, memberId?: string) {
    const domain = this.client.normalizeDomain(domainInput);
    const cacheKey = createHash('sha256')
      .update(`${domain}\0${accessToken}`)
      .digest('hex');
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.context;

    const pending = this.pending.get(cacheKey);
    if (pending) return pending;

    const resolution = this.resolveVerifiedSession(
      domain,
      accessToken,
      memberId,
      cacheKey,
    ).finally(() => {
      this.pending.delete(cacheKey);
    });
    this.pending.set(cacheKey, resolution);
    return resolution;
  }

  private async resolveVerifiedSession(
    domain: string,
    accessToken: string,
    memberId: string | undefined,
    cacheKey: string,
  ) {
    const profile = await this.client.call<BitrixProfile>(
      domain,
      accessToken,
      'profile',
    );
    const user = await this.client.call<BitrixUser>(
      domain,
      accessToken,
      'user.current',
    );
    const userId = Number(user.ID);
    if (!Number.isSafeInteger(userId) || userId <= 0 || !user.ACTIVE || profile.ID !== user.ID) {
      throw new ApiError(401, 'bitrix_user_invalid', 'Bitrix24 user is not active.');
    }

    const portalUrl = `https://${domain}`;
    await saveBitrixAdminStatus(
      this.database,
      portalUrl,
      userId,
      profile.ADMIN === true,
    );
    if (profile.ADMIN) {
      await this.database
        .delete(registryUserRoles)
        .where(
          and(
            eq(registryUserRoles.portalUrl, portalUrl),
            eq(registryUserRoles.userId, userId),
          ),
        );
    }
    const departmentIds = this.departmentIds(user.UF_DEPARTMENT);
    const role = profile.ADMIN
      ? { roleCode: 'admin', roleSource: 'bitrix_admin' as const }
      : await this.resolveUserRole(portalUrl, userId, departmentIds);
    const context: RegistryContext = {
      portalUrl,
      userId,
      userName: bitrixUserName(user) || `Пользователь #${userId}`,
      roleCode: role.roleCode,
      roleSource: role.roleSource,
      ...('roleDepartmentId' in role ? { roleDepartmentId: role.roleDepartmentId } : {}),
      departmentIds,
      source: 'bitrix',
      bitrix: { domain, accessToken, memberId },
    };
    if (this.cache.size >= 500) {
      for (const [key, item] of this.cache) {
        if (item.expiresAt <= Date.now()) this.cache.delete(key);
      }
      if (this.cache.size >= 500) this.cache.delete(this.cache.keys().next().value!);
    }
    this.cache.set(cacheKey, { context, expiresAt: Date.now() + 60_000 });
    return context;
  }

  private async resolveUserRole(
    portalUrl: string,
    userId: number,
    departmentIds: number[],
  ) {
    const [mapping] = await this.database
      .select({ roleCode: registryUserRoles.roleCode })
      .from(registryUserRoles)
      .where(
        and(
          eq(registryUserRoles.portalUrl, portalUrl),
          eq(registryUserRoles.userId, userId),
        ),
      )
      .limit(1);
    if (mapping) return { roleCode: mapping.roleCode, roleSource: 'user' as const };
    if (departmentIds.length) {
      const [departmentMapping] = await this.database
        .select({
          roleCode: registryDepartmentRoles.roleCode,
          roleDepartmentId: registryDepartmentRoles.departmentId,
        })
        .from(registryDepartmentRoles)
        .where(
          and(
            eq(registryDepartmentRoles.portalUrl, portalUrl),
            inArray(registryDepartmentRoles.departmentId, departmentIds),
          ),
        )
        .orderBy(
          asc(registryDepartmentRoles.priority),
          asc(registryDepartmentRoles.departmentId),
          asc(registryDepartmentRoles.roleCode),
        )
        .limit(1);
      if (departmentMapping) {
        return {
          ...departmentMapping,
          roleSource: 'department' as const,
        };
      }
    }
    throw new ApiError(
      403,
      'registry_access_not_assigned',
      'Доступ к реестру не назначен.',
    );
  }

  private departmentIds(value: BitrixUser['UF_DEPARTMENT']) {
    const source = Array.isArray(value) ? value : value === undefined ? [] : [value];
    return [...new Set(source
      .map((item) => Number(item))
      .filter((id) => Number.isSafeInteger(id) && id > 0))]
      .sort((left, right) => left - right);
  }
}

export function bitrixUserName(user: Pick<BitrixUser, 'LAST_NAME' | 'NAME' | 'SECOND_NAME'>) {
  return [user.LAST_NAME, user.NAME, user.SECOND_NAME]
    .map((part) => part?.trim())
    .filter(Boolean)
    .join(' ');
}
