import assert from 'node:assert/strict';
import { once } from 'node:events';

import { and, eq, like } from 'drizzle-orm';

import { createApp } from '../backend/src/app.js';
import type { BitrixApiClient } from '../backend/src/bitrix/bitrix-client.js';
import { loadConfig } from '../backend/src/config.js';
import { createDatabase } from '../backend/src/db/database.js';
import type { RolePermissions } from '../backend/src/db/schema/access.js';
import {
  registryDepartmentRoles,
  registryDocumentLinks,
  registryDocuments,
  registryRolePolicies,
} from '../backend/src/db/schema/index.js';

class NoopBitrixClient implements BitrixApiClient {
  normalizeDomain(value: string) {
    return value;
  }

  async call<T>(): Promise<T> {
    throw new Error('Unexpected Bitrix API call in development-context verification.');
  }

  async upload<T>(): Promise<T> {
    throw new Error('Unexpected Bitrix upload in development-context verification.');
  }
}

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('TEST_DATABASE_URL is required.');

const portalUrl = 'https://stage1.local.bitrix24.test';
const isolationPortalUrl = 'https://stage1-isolation.local.bitrix24.test';
const config = loadConfig({
  NODE_ENV: 'test',
  API_HOST: '127.0.0.1',
  API_PORT: '3101',
  WEB_ORIGIN: 'http://127.0.0.1:4173',
  DATABASE_URL: databaseUrl,
  DEVELOPMENT_PORTAL_URL: portalUrl,
  DEVELOPMENT_USER_ID: '501',
  DEVELOPMENT_ROLE: 'admin',
  BITRIX_ALLOWED_DOMAINS: 'stage1.local.bitrix24.test',
});
const database = createDatabase(config);
const bitrix = new NoopBitrixClient();
const app = createApp({
  config,
  database: database.db,
  bitrixClient: bitrix,
  readinessCheck: database.checkConnection,
});
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const address = server.address();
if (!address || typeof address === 'string') throw new Error('Test server address is unavailable.');
const baseUrl = `http://127.0.0.1:${address.port}/api/v1/registry`;
const results: string[] = [];
let originalSalesPolicy: Record<string, unknown> | null = null;

try {
  await cleanup();
  const policies = await api('/admin/role-policies', 'admin');
  originalSalesPolicy = policies.items.find((item: { roleCode: string }) => item.roleCode === 'sales');
  assert.ok(originalSalesPolicy, 'Seeded sales policy was not found.');
  await database.db.insert(registryRolePolicies).values({
    portalUrl: isolationPortalUrl,
    roleCode: 'sales',
    roleName: 'Isolation marker',
    visibleSectionCodes: ['client'],
    visibleTypeCodes: null,
    hiddenFields: [],
    permissions: {
      ...(originalSalesPolicy.permissions as RolePermissions),
      create: false,
      byType: {},
    },
    hideMoney: false,
    isActive: true,
  });
  await database.db.insert(registryDepartmentRoles).values({
    portalUrl: isolationPortalUrl,
    departmentId: 10,
    roleCode: 'accountant',
    priority: 777,
  });

  const byType = {
    client_contract: typePermissions({ view: false, export: false }),
    client_appendix: typePermissions({
      view: true,
      create: false,
      edit: false,
      transition: false,
      content: false,
      archive: false,
      restore: false,
      export: true,
      finance: false,
    }),
  };
  const salesPolicy = {
    ...originalSalesPolicy,
    permissions: {
      ...(originalSalesPolicy.permissions as Record<string, unknown>),
      byType,
    },
  };
  delete (salesPolicy as { roleCode?: string }).roleCode;
  await api('/admin/role-policies/sales', 'admin', { method: 'PUT', body: salesPolicy });
  const persisted = await api('/admin/role-policies', 'admin');
  const savedSales = persisted.items.find((item: { roleCode: string }) => item.roleCode === 'sales');
  assert.deepEqual(savedSales.permissions.byType, byType);
  const isolatedPolicy = await database.db
    .select({ roleName: registryRolePolicies.roleName, permissions: registryRolePolicies.permissions })
    .from(registryRolePolicies)
    .where(and(
      eq(registryRolePolicies.portalUrl, isolationPortalUrl),
      eq(registryRolePolicies.roleCode, 'sales'),
    ))
    .then(rows => rows[0]);
  assert.equal(isolatedPolicy?.roleName, 'Isolation marker');
  assert.equal(isolatedPolicy?.permissions.create, false);
  results.push('matrix_persisted');

  const contract = await createDocument('admin', {
    sectionCode: 'client',
    typeCode: 'client_contract',
    title: 'Stage1 QA hidden contract',
    fields: { contract_subject: 'Проверка матрицы' },
  });
  const appendix = await createDocument('admin', {
    sectionCode: 'client',
    typeCode: 'client_appendix',
    title: 'Stage1 QA type actions',
  });

  const salesTypes = await api('/types', 'sales');
  assert.equal(salesTypes.items.some((item: { code: string }) => item.code === 'client_contract'), false);
  const hiddenList = await api('/documents?search=Stage1%20QA%20hidden%20contract', 'sales');
  assert.equal(hiddenList.meta.total, 0);
  await api(`/documents/${contract.id}`, 'sales', {}, 403, 'type_access_denied');
  results.push('view_denied_everywhere');

  await api('/documents', 'sales', {
    method: 'POST',
    body: documentInput({
      sectionCode: 'client',
      typeCode: 'client_appendix',
      title: 'Stage1 QA forbidden create',
    }),
  }, 403, 'create_access_denied');
  await api(`/documents/${appendix.id}`, 'sales', {
    method: 'PATCH',
    body: { title: 'Stage1 QA forbidden edit' },
  }, 403, 'type_permission_denied');
  const exportResponse = await rawApi(
    '/documents/export.xlsx?type=client_appendix&search=Stage1%20QA%20type%20actions',
    'sales',
  );
  assert.equal(exportResponse.status, 200);
  assert.equal(exportResponse.headers.get('x-export-row-count'), '1');
  results.push('actions_enforced');

  await api('/admin/department-roles', 'admin', {
    method: 'PUT',
    body: {
      items: [
        { departmentId: 10, roleCode: 'sales', priority: 50 },
        { departmentId: 20, roleCode: 'lawyer', priority: 20 },
      ],
    },
  });
  const departments = await api('/admin/department-roles', 'admin');
  assert.equal(departments.items.length, 2);
  assert.equal(departments.departments.length, 2);
  const isolatedDepartment = await database.db
    .select({ roleCode: registryDepartmentRoles.roleCode, priority: registryDepartmentRoles.priority })
    .from(registryDepartmentRoles)
    .where(and(
      eq(registryDepartmentRoles.portalUrl, isolationPortalUrl),
      eq(registryDepartmentRoles.departmentId, 10),
    ))
    .then(rows => rows[0]);
  assert.deepEqual(isolatedDepartment, { roleCode: 'accountant', priority: 777 });
  await api('/admin/department-roles', 'admin', {
    method: 'PUT',
    body: {
      items: [
        { departmentId: 10, roleCode: 'sales', priority: 50 },
        { departmentId: 10, roleCode: 'lawyer', priority: 20 },
      ],
    },
  }, 400, 'validation_error');
  results.push('department_mapping_persisted');
  results.push('portal_isolation_preserved');

  const linked = await createDocument('admin', {
    sectionCode: 'client',
    typeCode: 'client_appendix',
    title: 'Stage1 QA deal access',
    links: [
      { entityType: 'deal', entityId: 7001, entityTitle: 'Открытая сделка' },
      { entityType: 'deal', entityId: 7002, entityTitle: 'Закрытая сделка' },
    ],
  });
  const checkedAt = new Date();
  await database.db.update(registryDocumentLinks)
    .set({ dealClosed: true, dealStateCheckedAt: checkedAt })
    .where(
      and(
        eq(registryDocumentLinks.portalUrl, portalUrl),
        eq(registryDocumentLinks.documentId, linked.id),
        eq(registryDocumentLinks.entityId, 7002),
      ),
    );
  await database.db.update(registryDocumentLinks)
    .set({ dealClosed: false, dealStateCheckedAt: checkedAt })
    .where(
      and(
        eq(registryDocumentLinks.portalUrl, portalUrl),
        eq(registryDocumentLinks.documentId, linked.id),
        eq(registryDocumentLinks.entityId, 7001),
      ),
    );
  const visibleWithOpenDeal = await api('/documents?search=Stage1%20QA%20deal%20access', 'sales');
  assert.equal(visibleWithOpenDeal.meta.total, 1);

  await database.db.update(registryDocumentLinks)
    .set({ dealClosed: true, dealStateCheckedAt: new Date() })
    .where(
      and(
        eq(registryDocumentLinks.portalUrl, portalUrl),
        eq(registryDocumentLinks.documentId, linked.id),
      ),
    );
  const hiddenAfterClose = await api('/documents?search=Stage1%20QA%20deal%20access', 'sales');
  assert.equal(hiddenAfterClose.meta.total, 0);
  await api(`/documents/${linked.id}`, 'sales', {}, 404, 'document_not_found');
  const stillVisibleToAccountant = await api('/documents?search=Stage1%20QA%20deal%20access', 'accountant');
  assert.equal(stillVisibleToAccountant.meta.total, 1);
  results.push('closed_deals_server_gate');

  process.stdout.write(`${JSON.stringify({ ok: true, checks: results }, null, 2)}\n`);
} finally {
  if (originalSalesPolicy) {
    const restore = { ...originalSalesPolicy };
    delete (restore as { roleCode?: string }).roleCode;
    await api('/admin/role-policies/sales', 'admin', { method: 'PUT', body: restore }).catch(() => {});
  }
  await cleanup().catch(() => {});
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await database.close();
}

async function createDocument(role: string, partial: Record<string, unknown>) {
  return api('/documents', role, {
    method: 'POST',
    body: documentInput(partial),
  }, 201);
}

function documentInput(partial: Record<string, unknown>) {
  return {
    number: null,
    documentDate: '2026-08-04',
    responsibleId: 501,
    responsibleName: 'Stage1 QA',
    links: [],
    fields: {},
    ...partial,
  };
}

function typePermissions(overrides: Record<string, boolean>) {
  return {
    view: true,
    create: true,
    edit: true,
    transition: true,
    content: true,
    archive: true,
    restore: true,
    export: true,
    finance: true,
    ...overrides,
  };
}

async function api(
  path: string,
  role: string,
  options: { method?: string; body?: unknown } = {},
  expectedStatus = 200,
  expectedCode?: string,
) {
  const response = await rawApi(path, role, options);
  const payload = await response.json().catch(() => null);
  assert.equal(
    response.status,
    expectedStatus,
    `${options.method || 'GET'} ${path}: ${JSON.stringify(payload)}`,
  );
  if (expectedCode) assert.equal(payload?.error?.code, expectedCode);
  return payload;
}

function rawApi(
  path: string,
  role: string,
  options: { method?: string; body?: unknown } = {},
) {
  return fetch(`${baseUrl}${path}`, {
    method: options.method || 'GET',
    headers: {
      accept: 'application/json',
      'x-registry-development-role': role,
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
}

async function cleanup() {
  await database.db.delete(registryDocuments).where(
    and(
      eq(registryDocuments.portalUrl, portalUrl),
      like(registryDocuments.title, 'Stage1 QA%'),
    ),
  );
  await database.db.delete(registryDepartmentRoles).where(
    eq(registryDepartmentRoles.portalUrl, portalUrl),
  );
  await database.db.delete(registryDepartmentRoles).where(
    eq(registryDepartmentRoles.portalUrl, isolationPortalUrl),
  );
  await database.db.delete(registryRolePolicies).where(
    eq(registryRolePolicies.portalUrl, isolationPortalUrl),
  );
}
