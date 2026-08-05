import assert from 'node:assert/strict';
import { once } from 'node:events';

import { and, eq, inArray, like } from 'drizzle-orm';

import { createApp } from '../backend/src/app.js';
import type { BitrixSessionResolver } from '../backend/src/auth/bitrix-session.service.js';
import type { BitrixApiClient } from '../backend/src/bitrix/bitrix-client.js';
import { loadConfig } from '../backend/src/config.js';
import { createDatabase } from '../backend/src/db/database.js';
import {
  registryDocuments,
  registryDocumentTypeSections,
  registryDocumentTypes,
  registryLifecycles,
  registryRolePolicies,
  registrySections,
} from '../backend/src/db/schema/index.js';
import type { RegistryContext } from '../backend/src/http/registry-context.js';

class FakeBitrixImportClient implements BitrixApiClient {
  revision = 1;
  calls: Array<{ domain: string; method: string; params: Record<string, unknown> }> = [];

  normalizeDomain(value: string) { return value.replace(/^https?:\/\//, '').replace(/\/$/, ''); }

  async call<T>(
    domain: string,
    _token: string,
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<T> {
    this.calls.push({ domain, method, params });
    if (method === 'crm.deal.get') {
      const id = Number(params.id);
      return {
        ID: id,
        TITLE: id === 9102 ? 'Stage9 Concurrent Deal' : `Stage9 Deal ${id}`,
        COMPANY_ID: 77,
        STAGE_ID: 'C1:NEW',
        CLOSED: id === 9199 ? 'Y' : 'N',
      } as T;
    }
    if (method === 'crm.company.get') {
      return { ID: 77, TITLE: 'Stage9 Company' } as T;
    }
    if (method === 'crm.item.list') {
      const entityTypeId = Number(params.entityTypeId);
      const filter = params.filter as Record<string, unknown>;
      const dealId = Number(filter.parentId2 ?? filter.dealId);
      const start = Number(params.start || 0);
      const all = this.items(entityTypeId, dealId);
      return { items: all.slice(start, start + 50) } as T;
    }
    throw new Error(`Unexpected Bitrix method: ${method}`);
  }

  async upload<T>(): Promise<T> {
    throw new Error('Unexpected Bitrix upload.');
  }

  private items(entityTypeId: number, dealId: number) {
    if (dealId === 9102) {
      return entityTypeId === 31
        ? [this.invoice(3101)]
        : [this.quote(4101)];
    }
    if (dealId !== 9101) return [];
    if (entityTypeId === 31) {
      return Array.from({ length: 51 }, (_, index) => this.invoice(1001 + index));
    }
    const quotes = [this.quote(2001), this.quote(2002)];
    return [...quotes, { ...quotes[0] }];
  }

  private invoice(id: number) {
    const changed = id === 1001 && this.revision > 1;
    return {
      id,
      title: changed ? 'Stage9 Invoice 1001 updated' : `Stage9 Invoice ${id}`,
      accountNumber: `SI-${id}`,
      stageId: 'DT31_1:N',
      opportunity: changed ? '1999.50' : '1000.00',
      currencyId: 'RUB',
      assignedById: 501,
      begindate: '2026-07-01',
      createdTime: '2026-07-01T08:00:00+03:00',
      updatedTime: changed ? '2026-08-05T10:00:00+03:00' : '2026-08-04T10:00:00+03:00',
      parentId2: 9101,
    };
  }

  private quote(id: number) {
    return {
      id,
      title: `Stage9 Quote ${id}`,
      quoteNumber: `Q-${id}`,
      statusId: 'SENT',
      opportunity: '2500.00',
      currencyId: 'USD',
      assignedById: 502,
      begindate: '2026-07-02',
      dateModify: '2026-08-04T11:00:00+03:00',
      dealId: 9101,
    };
  }
}

class FakeSessions implements BitrixSessionResolver {
  async resolve(domain: string, accessToken: string): Promise<RegistryContext> {
    const normalized = domain.replace(/^https?:\/\//, '').replace(/\/$/, '');
    return {
      portalUrl: `https://${normalized}`,
      userId: accessToken.startsWith('sales') ? 502 : 501,
      roleCode: accessToken.startsWith('sales') ? 'sales' : 'admin',
      roleSource: accessToken.startsWith('sales') ? 'user' : 'bitrix_admin',
      departmentIds: [],
      source: 'bitrix',
      bitrix: { domain: normalized, accessToken },
    };
  }
}

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('TEST_DATABASE_URL is required.');

const portalUrl = 'https://thermech.bitrix24.ru';
const isolationPortalUrl = 'https://stage9-isolated.bitrix24.ru';
const config = loadConfig({
  NODE_ENV: 'test',
  API_HOST: '127.0.0.1',
  API_PORT: '3109',
  WEB_ORIGIN: 'http://127.0.0.1:4173',
  DATABASE_URL: databaseUrl,
  DEVELOPMENT_PORTAL_URL: portalUrl,
  DEVELOPMENT_USER_ID: '501',
  DEVELOPMENT_ROLE: 'admin',
  BITRIX_ALLOWED_DOMAINS: 'thermech.bitrix24.ru,stage9-isolated.bitrix24.ru',
});
const database = createDatabase(config);
const bitrix = new FakeBitrixImportClient();
const app = createApp({
  config,
  database: database.db,
  bitrixClient: bitrix,
  bitrixSessionResolver: new FakeSessions(),
  readinessCheck: database.checkConnection,
});
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const address = server.address();
if (!address || typeof address === 'string') throw new Error('Test server address is unavailable.');
const baseUrl = `http://127.0.0.1:${address.port}/api/v1/registry`;
const checks: string[] = [];

try {
  await cleanup();
  await seedIsolationPortal();

  const first = await api('/documents/deal/9101/sync-bitrix', 'admin-access-token', 'thermech.bitrix24.ru');
  assert.equal(first.created, 53);
  assert.equal(first.updated, 0);
  assert.equal(first.unchanged, 0);
  assert.equal(first.duplicates, 0);
  assert.equal(first.sourceDuplicatesIgnored, 1);
  const firstRows = await importedRows(portalUrl);
  assert.equal(firstRows.length, 53);
  assert.equal(new Set(firstRows.map((row) => `${row.externalSource}:${row.externalEntityId}`)).size, 53);
  assert.equal(bitrix.calls.some((call) =>
    call.method === 'crm.item.list'
    && Number(call.params.entityTypeId) === 31
    && Number(call.params.start) === 50), true);
  checks.push('all_51_invoices_and_2_quotes_are_paginated_and_created_once');

  bitrix.revision = 2;
  const second = await api('/documents/deal/9101/sync-bitrix', 'admin-access-token', 'thermech.bitrix24.ru');
  assert.equal(second.created, 0);
  assert.equal(second.updated, 1);
  assert.equal(second.unchanged, 52);
  assert.equal(second.duplicates, 0);
  const updated = (await importedRows(portalUrl)).find((row) => row.externalEntityId === 1001);
  assert.equal(updated?.title, 'Stage9 Invoice 1001 updated');
  assert.equal(updated?.amount, '1999.50');
  checks.push('second_run_updates_by_external_id_and_creates_zero_duplicates');

  const concurrent = await Promise.all([
    api('/documents/deal/9102/sync-bitrix', 'admin-access-token', 'thermech.bitrix24.ru'),
    api('/documents/deal/9102/sync-bitrix', 'admin-access-token', 'thermech.bitrix24.ru'),
  ]);
  assert.equal(concurrent.reduce((sum, item) => sum + item.created, 0), 2);
  assert.equal(concurrent.every((item) => item.duplicates === 0), true);
  assert.equal((await importedRows(portalUrl)).filter((row) =>
    row.externalEntityId === 3101 || row.externalEntityId === 4101).length, 2);
  checks.push('concurrent_synchronization_is_serialized_without_duplicates');

  const isolated = await api(
    '/documents/deal/9101/sync-bitrix',
    'admin-access-token',
    'stage9-isolated.bitrix24.ru',
  );
  assert.equal(isolated.created, 53);
  assert.equal((await importedRows(isolationPortalUrl)).length, 53);
  assert.equal((await importedRows(portalUrl)).length, 55);
  checks.push('same_external_ids_are_isolated_by_portal');

  const itemListCallsBeforeDenied = bitrix.calls.filter((call) => call.method === 'crm.item.list').length;
  const denied = await rawApi(
    '/documents/deal/9101/sync-bitrix',
    'sales-access-token',
    'thermech.bitrix24.ru',
  );
  assert.equal(denied.status, 403);
  assert.equal((await denied.json()).error.code, 'financial_document_create_denied');
  assert.equal(
    bitrix.calls.filter((call) => call.method === 'crm.item.list').length,
    itemListCallsBeforeDenied,
  );
  checks.push('role_denial_happens_before_source_items_are_loaded');

  const closed = await rawApi(
    '/documents/deal/9199/sync-bitrix',
    'sales-access-token',
    'thermech.bitrix24.ru',
  );
  assert.equal(closed.status, 403);
  assert.equal((await closed.json()).error.code, 'closed_deal_access_denied');
  checks.push('sales_role_cannot_import_a_closed_deal');

  const noSession = await fetch(`${baseUrl}/documents/deal/9101/sync-bitrix`, { method: 'POST' });
  assert.equal(noSession.status, 401);
  assert.equal((await noSession.json()).error.code, 'bitrix_import_session_required');
  checks.push('real_bitrix_session_is_required');

  process.stdout.write(`${JSON.stringify({ ok: true, checks }, null, 2)}\n`);
} finally {
  await cleanup().catch(() => undefined);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await database.close();
}

function rawApi(path: string, token: string, domain: string) {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${token}`,
      'x-bitrix-domain': domain,
    },
  });
}

async function api(path: string, token: string, domain: string) {
  const response = await rawApi(path, token, domain);
  const payload = await response.json().catch(() => null);
  assert.equal(response.status, 200, `POST ${path}: ${JSON.stringify(payload)}`);
  return payload;
}

function importedRows(currentPortalUrl: string) {
  return database.db.select({
    id: registryDocuments.id,
    title: registryDocuments.title,
    amount: registryDocuments.amount,
    externalSource: registryDocuments.externalSource,
    externalEntityTypeId: registryDocuments.externalEntityTypeId,
    externalEntityId: registryDocuments.externalEntityId,
    externalUpdatedAt: registryDocuments.externalUpdatedAt,
  }).from(registryDocuments).where(and(
    eq(registryDocuments.portalUrl, currentPortalUrl),
    like(registryDocuments.externalSource, 'bitrix_%'),
  ));
}

async function seedIsolationPortal() {
  const [sourceSection] = await database.db.select().from(registrySections).where(and(
    eq(registrySections.portalUrl, portalUrl),
    eq(registrySections.code, 'client'),
  )).limit(1);
  const [sourceLifecycle] = await database.db.select().from(registryLifecycles).where(and(
    eq(registryLifecycles.portalUrl, portalUrl),
    eq(registryLifecycles.code, 'simple'),
  )).limit(1);
  const sourceTypes = await database.db.select().from(registryDocumentTypes).where(and(
    eq(registryDocumentTypes.portalUrl, portalUrl),
    inArray(registryDocumentTypes.code, ['client_invoice', 'client_quote']),
  ));
  const [sourcePolicy] = await database.db.select().from(registryRolePolicies).where(and(
    eq(registryRolePolicies.portalUrl, portalUrl),
    eq(registryRolePolicies.roleCode, 'admin'),
  )).limit(1);
  assert.ok(sourceSection && sourceLifecycle && sourceTypes.length === 2 && sourcePolicy);

  const [section] = await database.db.insert(registrySections).values({
    portalUrl: isolationPortalUrl,
    code: sourceSection.code,
    name: sourceSection.name,
    description: sourceSection.description,
    color: sourceSection.color,
    sortOrder: sourceSection.sortOrder,
    isActive: true,
  }).returning();
  const [lifecycle] = await database.db.insert(registryLifecycles).values({
    portalUrl: isolationPortalUrl,
    code: sourceLifecycle.code,
    name: sourceLifecycle.name,
    config: sourceLifecycle.config,
    isActive: true,
  }).returning();
  const insertedTypes = await database.db.insert(registryDocumentTypes).values(sourceTypes.map((type) => ({
    portalUrl: isolationPortalUrl,
    sectionId: section.id,
    lifecycleId: lifecycle.id,
    code: type.code,
    name: type.name,
    description: type.description,
    isFinancial: type.isFinancial,
    contentRequired: type.contentRequired,
    isActive: true,
    sortOrder: type.sortOrder,
  }))).returning({ id: registryDocumentTypes.id });
  await database.db.insert(registryDocumentTypeSections).values(insertedTypes.map((type, index) => ({
    portalUrl: isolationPortalUrl,
    typeId: type.id,
    sectionId: section.id,
    sortOrder: sourceTypes[index]?.sortOrder ?? index * 10,
  })));
  await database.db.insert(registryRolePolicies).values({
    portalUrl: isolationPortalUrl,
    roleCode: sourcePolicy.roleCode,
    roleName: sourcePolicy.roleName,
    visibleSectionCodes: sourcePolicy.visibleSectionCodes,
    visibleTypeCodes: sourcePolicy.visibleTypeCodes,
    hiddenFields: sourcePolicy.hiddenFields,
    permissions: sourcePolicy.permissions,
    hideMoney: sourcePolicy.hideMoney,
    isActive: true,
  });
}

async function cleanup() {
  await database.db.delete(registryDocuments).where(and(
    inArray(registryDocuments.portalUrl, [portalUrl, isolationPortalUrl]),
    like(registryDocuments.externalSource, 'bitrix_%'),
  ));
  await database.db.delete(registryRolePolicies).where(eq(registryRolePolicies.portalUrl, isolationPortalUrl));
  await database.db.delete(registryDocumentTypes).where(eq(registryDocumentTypes.portalUrl, isolationPortalUrl));
  await database.db.delete(registryLifecycles).where(eq(registryLifecycles.portalUrl, isolationPortalUrl));
  await database.db.delete(registrySections).where(eq(registrySections.portalUrl, isolationPortalUrl));
}
