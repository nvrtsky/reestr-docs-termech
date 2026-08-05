import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { and, eq } from 'drizzle-orm';

import type { BitrixApiClient } from '../bitrix/bitrix-client.js';
import { loadConfig } from '../config.js';
import { createDatabase } from '../db/database.js';
import {
  registryDepartmentRoles,
  registrySettings,
  registryUserRoles,
} from '../db/schema/index.js';
import { ApiError } from '../http/api-error.js';
import { BitrixSessionService } from './bitrix-session.service.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const portalDomain = 'stage1-access.bitrix24.test';
const portalUrl = `https://${portalDomain}`;
const integration = databaseUrl ? describe : describe.skip;
const database = databaseUrl
  ? createDatabase(loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: databaseUrl,
      BITRIX_ALLOWED_DOMAINS: portalDomain,
    }))
  : null;

class FakeBitrixClient implements BitrixApiClient {
  constructor(private readonly users: Record<string, {
    id: number;
    admin?: boolean;
    departments?: number[];
  }>) {}

  normalizeDomain(value: string) {
    return value;
  }

  async call<T>(_domain: string, accessToken: string, method: string): Promise<T> {
    const user = this.users[accessToken];
    if (!user) throw new Error('Unknown test token.');
    if (method === 'profile') {
      return { ID: String(user.id), ADMIN: user.admin === true } as T;
    }
    if (method === 'user.current') {
      return {
        ID: String(user.id),
        ACTIVE: true,
        UF_DEPARTMENT: user.departments || [],
      } as T;
    }
    throw new Error(`Unexpected method ${method}.`);
  }

  async upload<T>(): Promise<T> {
    throw new Error('Upload is not used by this test.');
  }
}

integration('Bitrix role assignment precedence', () => {
  before(async () => {
    await clearPortal();
    await database!.db.insert(registryDepartmentRoles).values([
      { portalUrl, departmentId: 10, roleCode: 'sales', priority: 50 },
      { portalUrl, departmentId: 20, roleCode: 'lawyer', priority: 20 },
    ]);
    await database!.db.insert(registryUserRoles).values([
      {
        portalUrl,
        userId: 1,
        userName: 'Admin override candidate',
        roleCode: 'accountant',
        assignedBy: 99,
      },
      {
        portalUrl,
        userId: 2,
        userName: 'Manual role',
        roleCode: 'accountant',
        assignedBy: 99,
      },
    ]);
  });

  after(async () => {
    await clearPortal();
    await database!.close();
  });

  it('keeps Bitrix administrator above manual and department mappings', async () => {
    const service = createService({ admin: { id: 1, admin: true, departments: [10] } });
    const context = await service.resolve(portalDomain, 'admin');
    assert.equal(context.roleCode, 'admin');
    assert.equal(context.roleSource, 'bitrix_admin');
  });

  it('keeps a manual assignment above the department role', async () => {
    const service = createService({ manual: { id: 2, departments: [10] } });
    const context = await service.resolve(portalDomain, 'manual');
    assert.equal(context.roleCode, 'accountant');
    assert.equal(context.roleSource, 'user');
  });

  it('uses the lowest-priority mapping when several departments match', async () => {
    const service = createService({ department: { id: 3, departments: [10, 20] } });
    const context = await service.resolve(portalDomain, 'department');
    assert.equal(context.roleCode, 'lawyer');
    assert.equal(context.roleSource, 'department');
    assert.equal(context.roleDepartmentId, 20);
  });

  it('denies a user without a manual or department assignment', async () => {
    const service = createService({ missing: { id: 4, departments: [30] } });
    await assert.rejects(
      service.resolve(portalDomain, 'missing'),
      (error: unknown) => error instanceof ApiError
        && error.status === 403
        && error.code === 'registry_access_not_assigned',
    );
  });
});

function createService(users: ConstructorParameters<typeof FakeBitrixClient>[0]) {
  return new BitrixSessionService(database!.db, new FakeBitrixClient(users));
}

async function clearPortal() {
  await database!.db.delete(registryUserRoles).where(eq(registryUserRoles.portalUrl, portalUrl));
  await database!.db.delete(registryDepartmentRoles).where(eq(registryDepartmentRoles.portalUrl, portalUrl));
  await database!.db.delete(registrySettings).where(
    and(
      eq(registrySettings.portalUrl, portalUrl),
      eq(registrySettings.key, 'bitrix_admin_user_ids'),
    ),
  );
}
