import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';

import { and, count, eq, like } from 'drizzle-orm';

import { createApp } from '../backend/src/app.js';
import type { BitrixApiClient } from '../backend/src/bitrix/bitrix-client.js';
import { loadConfig } from '../backend/src/config.js';
import { createDatabase } from '../backend/src/db/database.js';
import {
  registryBulkUploadItems,
  registryDocuments,
  registryDocumentTypes,
} from '../backend/src/db/schema/index.js';

class NoopBitrixClient implements BitrixApiClient {
  normalizeDomain(value: string) { return value; }
  async call<T>(): Promise<T> { throw new Error('Unexpected Bitrix API call.'); }
  async upload<T>(): Promise<T> { throw new Error('Unexpected Bitrix upload.'); }
}

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('TEST_DATABASE_URL is required.');

const portalUrl = 'https://thermech.bitrix24.ru';
const config = loadConfig({
  NODE_ENV: 'test',
  API_HOST: '127.0.0.1',
  API_PORT: '3104',
  WEB_ORIGIN: 'http://127.0.0.1:4173',
  DATABASE_URL: databaseUrl,
  DEVELOPMENT_PORTAL_URL: portalUrl,
  DEVELOPMENT_USER_ID: '501',
  DEVELOPMENT_ROLE: 'admin',
  BITRIX_ALLOWED_DOMAINS: 'thermech.bitrix24.ru',
});
const database = createDatabase(config);
const app = createApp({
  config,
  database: database.db,
  bitrixClient: new NoopBitrixClient(),
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
  const type = await api('/types', {
    method: 'POST',
    body: {
      sectionCode: 'internal',
      name: 'Stage4 QA Bulk Upload',
      lifecycleCode: 'simple',
      contentRequired: false,
      fields: [],
    },
  }, 201);

  const firstKey = randomUUID();
  const secondKey = randomUUID();
  const invalidKey = randomUUID();
  const initialPayload = {
    items: [
      bulkItem('row-1', firstKey, type.code, 'Stage4 QA first'),
      bulkItem('row-2', secondKey, type.code, 'Stage4 QA second'),
      bulkItem('row-invalid', invalidKey, 'missing-stage4-type', 'Stage4 QA invalid'),
    ],
  };
  const prepared = await api('/documents/bulk/upload', {
    method: 'POST',
    body: initialPayload,
  });
  assert.deepEqual(prepared.items.map((item: { status: string }) => item.status), [
    'ready',
    'ready',
    'error',
  ]);
  assert.equal(prepared.items[2].error.code, 'document_type_not_found');
  assert.notEqual(prepared.items[0].document.id, prepared.items[1].document.id);
  checks.push('partial_batch_result_and_row_error');

  const enrichedBase = bulkItem(
    'row-enriched',
    randomUUID(),
    type.code,
    'Stage4 QA enriched common and row fields',
  );
  const enriched = {
    ...enrichedBase,
    document: {
      ...enrichedBase.document,
      status: 'active',
      counterpartyId: 4401,
      counterpartyName: 'Stage4 QA Company',
      links: [
        { entityType: 'company', entityId: 4401, entityTitle: 'Stage4 QA Company' },
        { entityType: 'deal', entityId: 4402, entityTitle: 'Stage4 QA Deal' },
      ],
      taskLinks: [
        { taskId: 4403, taskTitle: 'Stage4 QA Existing Task' },
      ],
    },
  };
  const enrichedPrepared = await api('/documents/bulk/upload', {
    method: 'POST',
    body: { items: [enriched] },
  });
  assert.equal(enrichedPrepared.items[0].document.status, 'active');
  assert.deepEqual(
    enrichedPrepared.items[0].document.links.map((link: { entityType: string; entityId: number }) =>
      `${link.entityType}:${link.entityId}`).sort(),
    ['company:4401', 'deal:4402'],
  );
  assert.deepEqual(
    enrichedPrepared.items[0].document.taskLinks.map((task: { taskId: number }) => task.taskId),
    [4403],
  );
  const invalidStatusBase = bulkItem(
    'row-invalid-status',
    randomUUID(),
    type.code,
    'Stage4 QA invalid initial status',
  );
  const invalidInitialStatus = {
    ...invalidStatusBase,
    document: { ...invalidStatusBase.document, status: 'overdue' },
  };
  const invalidStatusPrepared = await api('/documents/bulk/upload', {
    method: 'POST',
    body: { items: [invalidInitialStatus] },
  });
  assert.equal(invalidStatusPrepared.items[0].status, 'error');
  assert.equal(invalidStatusPrepared.items[0].error.code, 'initial_status_transition_not_allowed');
  checks.push('bulk_deals_existing_task_and_valid_initial_status');

  const beforeReplay = await stage4DocumentCount();
  const replay = await api('/documents/bulk/upload', {
    method: 'POST',
    body: { items: initialPayload.items.slice(0, 2) },
  });
  assert.equal(replay.items[0].document.id, prepared.items[0].document.id);
  assert.equal(replay.items[1].document.id, prepared.items[1].document.id);
  assert.equal(await stage4DocumentCount(), beforeReplay);
  checks.push('idempotent_replay_does_not_duplicate_success');

  const changed = await api('/documents/bulk/upload', {
    method: 'POST',
    body: {
      items: [bulkItem('row-1', firstKey, type.code, 'Stage4 QA changed payload')],
    },
  });
  assert.equal(changed.items[0].status, 'error');
  assert.equal(changed.items[0].error.code, 'bulk_upload_idempotency_conflict');
  checks.push('idempotency_key_rejects_changed_payload');

  const compensationKey = randomUUID();
  const compensationPayload = {
    items: [bulkItem('row-compensation', compensationKey, type.code, 'Stage4 QA compensation')],
  };
  const compensationPrepared = await api('/documents/bulk/upload', {
    method: 'POST',
    body: compensationPayload,
  });
  const abandonedId = compensationPrepared.items[0].document.id;
  await api(`/documents/${abandonedId}/abandon`, { method: 'POST' }, 204);
  await api(`/documents/${abandonedId}`, {}, 404, 'document_not_found');
  const retriedAfterCleanup = await api('/documents/bulk/upload', {
    method: 'POST',
    body: compensationPayload,
  });
  assert.equal(
    retriedAfterCleanup.items[0].status,
    'ready',
    JSON.stringify(retriedAfterCleanup.items[0]),
  );
  assert.notEqual(retriedAfterCleanup.items[0].document.id, abandonedId);
  checks.push('compensating_cleanup_allows_safe_retry');

  const finalizedKey = randomUUID();
  const finalizedPayload = {
    items: [bulkItem('row-finalized', finalizedKey, type.code, 'Stage4 QA finalized response loss')],
  };
  const finalizedPrepared = await api('/documents/bulk/upload', {
    method: 'POST',
    body: finalizedPayload,
  });
  const finalizedId = finalizedPrepared.items[0].document.id;
  await api(`/documents/${finalizedId}/finalize`, { method: 'POST' });
  await api(
    `/documents/${finalizedId}/abandon`,
    { method: 'POST' },
    409,
    'document_abandon_not_allowed',
  );
  const finalizedReplay = await api('/documents/bulk/upload', {
    method: 'POST',
    body: finalizedPayload,
  });
  assert.equal(finalizedReplay.items[0].document.id, finalizedId);
  checks.push('finalized_row_survives_lost_response_and_replays');

  const sharedScopeKey = randomUUID();
  await database.db.insert(registryBulkUploadItems).values([
    {
      portalUrl,
      createdBy: 7001,
      idempotencyKey: sharedScopeKey,
      clientRowId: 'scope-user-a',
      requestHash: 'a'.repeat(64),
    },
    {
      portalUrl,
      createdBy: 7002,
      idempotencyKey: sharedScopeKey,
      clientRowId: 'scope-user-b',
      requestHash: 'b'.repeat(64),
    },
    {
      portalUrl: 'https://stage4-other.bitrix24.ru',
      createdBy: 7001,
      idempotencyKey: sharedScopeKey,
      clientRowId: 'scope-portal-b',
      requestHash: 'c'.repeat(64),
    },
  ]);
  const scopedRows = await database.db
    .select({ portalUrl: registryBulkUploadItems.portalUrl, createdBy: registryBulkUploadItems.createdBy })
    .from(registryBulkUploadItems)
    .where(eq(registryBulkUploadItems.idempotencyKey, sharedScopeKey));
  assert.equal(scopedRows.length, 3);
  checks.push('idempotency_scope_is_portal_and_user');

  await api('/documents/bulk/upload', {
    method: 'POST',
    body: { items: [] },
  }, 400, 'validation_error');
  const duplicateKey = randomUUID();
  await api('/documents/bulk/upload', {
    method: 'POST',
    body: {
      items: [
        bulkItem('duplicate-a', duplicateKey, type.code, 'Stage4 QA duplicate a'),
        bulkItem('duplicate-b', duplicateKey, type.code, 'Stage4 QA duplicate b'),
      ],
    },
  }, 400, 'validation_error');
  checks.push('batch_limits_and_duplicate_keys_validated');

  process.stdout.write(`${JSON.stringify({ ok: true, checks }, null, 2)}\n`);
} finally {
  await cleanup().catch(() => undefined);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await database.close();
}

function bulkItem(clientRowId: string, idempotencyKey: string, typeCode: string, title: string) {
  return {
    clientRowId,
    idempotencyKey,
    document: {
      sectionCode: 'internal',
      typeCode,
      title,
      documentDate: '2026-08-04',
      responsibleId: 501,
      responsibleName: 'Stage4 QA',
      links: [],
      taskLinks: [],
      fields: {},
    },
  };
}

async function stage4DocumentCount() {
  const [result] = await database.db
    .select({ value: count() })
    .from(registryDocuments)
    .where(and(
      eq(registryDocuments.portalUrl, portalUrl),
      like(registryDocuments.title, 'Stage4 QA%'),
    ));
  return result.value;
}

async function api(
  path: string,
  options: { method?: string; body?: unknown } = {},
  expectedStatus = 200,
  expectedCode?: string,
) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method || 'GET',
    headers: {
      accept: 'application/json',
      'x-registry-development-role': 'admin',
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const payload = response.status === 204 ? null : await response.json().catch(() => null);
  assert.equal(response.status, expectedStatus, `${options.method || 'GET'} ${path}: ${JSON.stringify(payload)}`);
  if (expectedCode) assert.equal(payload?.error?.code, expectedCode);
  return payload;
}

async function cleanup() {
  await database.db.delete(registryDocuments).where(and(
    eq(registryDocuments.portalUrl, portalUrl),
    like(registryDocuments.title, 'Stage4 QA%'),
  ));
  await database.db.delete(registryDocumentTypes).where(and(
    eq(registryDocumentTypes.portalUrl, portalUrl),
    like(registryDocumentTypes.name, 'Stage4 QA%'),
  ));
  await database.db.delete(registryBulkUploadItems).where(like(
    registryBulkUploadItems.clientRowId,
    'scope-%',
  ));
}
