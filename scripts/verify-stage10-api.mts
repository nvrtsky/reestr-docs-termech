import assert from 'node:assert/strict';
import { once } from 'node:events';

import { and, desc, eq, like } from 'drizzle-orm';

import { createApp } from '../backend/src/app.js';
import type { BitrixSessionResolver } from '../backend/src/auth/bitrix-session.service.js';
import type { BitrixApiClient } from '../backend/src/bitrix/bitrix-client.js';
import { loadConfig } from '../backend/src/config.js';
import { createDatabase } from '../backend/src/db/database.js';
import {
  registryAttachments,
  registryAuditLog,
  registryDocuments,
} from '../backend/src/db/schema/index.js';
import type { RegistryContext } from '../backend/src/http/registry-context.js';

class FakeNotificationClient implements BitrixApiClient {
  notificationCalls: Array<{ userId: number; message: string; tag: string }> = [];
  failUserId: number | null = null;

  normalizeDomain(value: string) { return value.replace(/^https?:\/\//, '').replace(/\/$/, ''); }

  async call<T>(
    _domain: string,
    _token: string,
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<T> {
    if (method === 'crm.deal.list' || method === 'crm.company.list') {
      const filter = params.filter as { '@ID'?: unknown[] } | undefined;
      return (filter?.['@ID'] ?? []).map((id) => ({ ID: id })) as T;
    }
    if (method !== 'im.notify.system.add') throw new Error(`Unexpected Bitrix method: ${method}`);
    const userId = Number(params.USER_ID);
    this.notificationCalls.push({
      userId,
      message: String(params.MESSAGE || ''),
      tag: String(params.TAG || ''),
    });
    if (userId === this.failUserId) throw new Error('Stage10 simulated notification failure');
    return this.notificationCalls.length as T;
  }

  async upload<T>(): Promise<T> {
    throw new Error('Unexpected Bitrix upload.');
  }
}

class FakeSessions implements BitrixSessionResolver {
  async resolve(domain: string, accessToken: string): Promise<RegistryContext> {
    const normalized = domain.replace(/^https?:\/\//, '').replace(/\/$/, '');
    const sales = accessToken.startsWith('sales');
    const userId = accessToken.startsWith('creator')
      ? 610
      : accessToken.startsWith('actor')
        ? 699
        : sales
          ? 502
          : 501;
    return {
      portalUrl: `https://${normalized}`,
      userId,
      userName: accessToken.startsWith('actor') ? 'Иван Петров' : `Пользователь #${userId}`,
      roleCode: sales ? 'sales' : 'admin',
      roleSource: sales ? 'user' : 'bitrix_admin',
      departmentIds: [],
      source: 'bitrix',
      bitrix: { domain: normalized, accessToken },
    };
  }
}

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('TEST_DATABASE_URL is required.');
const portalUrl = 'https://thermech.bitrix24.ru';
const config = loadConfig({
  NODE_ENV: 'test',
  API_HOST: '127.0.0.1',
  API_PORT: '3110',
  WEB_ORIGIN: 'http://127.0.0.1:4173',
  DATABASE_URL: databaseUrl,
  DEVELOPMENT_PORTAL_URL: portalUrl,
  DEVELOPMENT_USER_ID: '501',
  DEVELOPMENT_ROLE: 'admin',
  BITRIX_ALLOWED_DOMAINS: 'thermech.bitrix24.ru',
});
const database = createDatabase(config);
const bitrix = new FakeNotificationClient();
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
  const document = await api('/documents', 'creator-access-token', {
    method: 'POST',
    body: {
      sectionCode: 'client',
      typeCode: 'client_contract',
      number: 'STAGE10-ARCHIVE',
      title: 'Stage10 QA archive participants',
      documentDate: '2026-08-05',
      responsibleId: 610,
      responsibleName: 'Stage10 Creator',
      links: [],
      taskLinks: [],
      fields: { contract_subject: 'Stage10 archive notification verification' },
    },
  }, 201);
  await database.db.insert(registryAttachments).values({
    portalUrl,
    documentId: document.id,
    kind: 'file',
    name: 'stage10-uploaded-by-other-user.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 2048,
    version: 1,
    isCurrent: true,
    createdBy: 620,
  });

  await api(`/documents/${document.id}`, 'actor-access-token', { method: 'DELETE' }, 204);
  const archiveCalls = bitrix.notificationCalls.slice();
  assert.deepEqual(archiveCalls.map((call) => call.userId).sort(), [610, 620]);
  assert.equal(archiveCalls.every((call) => call.message.includes('архивирован')), true);
  assert.equal(archiveCalls.every((call) => call.message.includes('Действие выполнил Иван Петров.')), true);
  const [stillStored] = await database.db.select({ id: registryDocuments.id, deletedAt: registryDocuments.deletedAt })
    .from(registryDocuments).where(eq(registryDocuments.id, document.id)).limit(1);
  assert.ok(stillStored?.deletedAt);
  const archiveHistory = await audit(document.id);
  const archived = archiveHistory.find((item) => item.event === 'document_deleted');
  const archiveDispatch = archiveHistory.find((item) => item.event === 'archive_notifications_dispatched');
  assert.deepEqual(metadata(archived).notificationRecipientIds, [610, 620]);
  assert.deepEqual(metadata(archived).fileUploaderIds, [620]);
  assert.equal(metadata(archived).cardCreatorId, 610);
  assert.deepEqual(
    (metadata(archiveDispatch).deliveries as Array<{ status: string }>).map((item) => item.status),
    ['sent', 'sent'],
  );
  checks.push('archive_keeps_document_and_notifies_card_creator_and_current_file_uploader');

  bitrix.failUserId = 620;
  const beforeRestoreCalls = bitrix.notificationCalls.length;
  await api(`/documents/${document.id}/restore`, 'actor-access-token', { method: 'POST' });
  const restoreCalls = bitrix.notificationCalls.slice(beforeRestoreCalls);
  assert.deepEqual(restoreCalls.map((call) => call.userId).sort(), [610, 620]);
  assert.equal(restoreCalls.every((call) => call.message.includes('восстановлен')), true);
  const restoreHistory = await audit(document.id);
  const restored = restoreHistory.find((item) => item.event === 'document_restored');
  const restoreDispatch = restoreHistory.find((item) => item.event === 'restore_notifications_dispatched');
  assert.deepEqual(metadata(restored).notificationRecipientIds, [610, 620]);
  assert.deepEqual(
    (metadata(restoreDispatch).deliveries as Array<{ userId: number; status: string }>),
    [{ userId: 610, status: 'sent' }, { userId: 620, status: 'failed' }],
  );
  checks.push('restore_notifies_both_participants_and_audits_delivery_failure_without_rollback');

  bitrix.failUserId = null;
  await api(`/documents/${document.id}/transition`, 'actor-access-token', {
    method: 'POST',
    body: { status: 'on_review' },
  });
  await api(`/documents/${document.id}/transition`, 'actor-access-token', {
    method: 'POST',
    body: { status: 'signed' },
  });
  const lifecycleArchived = await api(`/documents/${document.id}/transition`, 'actor-access-token', {
    method: 'POST',
    body: { status: 'archived' },
  });
  assert.equal(lifecycleArchived.status, 'signed');
  assert.ok(lifecycleArchived.deletedAt);
  const [unifiedArchiveRow] = await database.db.select({
    status: registryDocuments.status,
    deletedAt: registryDocuments.deletedAt,
  }).from(registryDocuments).where(eq(registryDocuments.id, document.id)).limit(1);
  assert.equal(unifiedArchiveRow.status, 'signed');
  assert.ok(unifiedArchiveRow.deletedAt);
  await api(`/documents/${document.id}/restore`, 'actor-access-token', { method: 'POST' });
  checks.push('lifecycle_archive_uses_the_same_recoverable_soft_archive_model');

  await database.db.update(registryDocuments).set({
    status: 'archived',
    deletedAt: null,
    deletedBy: null,
  }).where(eq(registryDocuments.id, document.id));
  await database.db.insert(registryAuditLog).values({
    portalUrl,
    documentId: document.id,
    event: 'status_changed',
    actorId: 699,
    before: { status: 'signed' },
    after: { status: 'archived' },
  });
  const legacyRestored = await api(
    `/documents/${document.id}/restore`,
    'actor-access-token',
    { method: 'POST' },
  );
  assert.equal(legacyRestored.status, 'signed');
  assert.equal(legacyRestored.deletedAt, null);
  checks.push('legacy_archived_status_restores_to_the_previous_lifecycle_state');

  const financial = await api('/documents', 'creator-access-token', {
    method: 'POST',
    body: {
      sectionCode: 'client',
      typeCode: 'client_invoice',
      number: 'STAGE10-FINANCE',
      title: 'Stage10 QA hidden audit finance',
      documentDate: '2026-08-05',
      amount: '123456.78',
      currency: 'RUB',
      responsibleId: 610,
      responsibleName: 'Stage10 Creator',
      links: [],
      taskLinks: [],
      fields: { payment_due_date: '2026-08-20' },
    },
  }, 201);
  const salesView = await api(`/documents/${financial.id}`, 'sales-access-token');
  assert.equal(salesView.amount, null);
  assert.equal(salesView.currency, null);
  const serializedHistory = JSON.stringify(salesView.history);
  assert.equal(serializedHistory.includes('123456.78'), false);
  assert.equal(serializedHistory.includes('"amount"'), false);
  assert.equal(serializedHistory.includes('"currency"'), false);
  checks.push('immutable_history_does_not_leak_hidden_financial_fields');

  process.stdout.write(`${JSON.stringify({ ok: true, checks }, null, 2)}\n`);
} finally {
  await cleanup().catch(() => undefined);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await database.close();
}

function rawApi(
  path: string,
  token: string,
  options: { method?: string; body?: unknown } = {},
) {
  return fetch(`${baseUrl}${path}`, {
    method: options.method || 'GET',
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${token}`,
      'x-bitrix-domain': 'thermech.bitrix24.ru',
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
}

async function api(
  path: string,
  token: string,
  options: { method?: string; body?: unknown } = {},
  expectedStatus = 200,
) {
  const response = await rawApi(path, token, options);
  const payload = response.status === 204 ? null : await response.json().catch(() => null);
  assert.equal(response.status, expectedStatus, `${options.method || 'GET'} ${path}: ${JSON.stringify(payload)}`);
  return payload;
}

function audit(documentId: string) {
  return database.db.select().from(registryAuditLog).where(and(
    eq(registryAuditLog.portalUrl, portalUrl),
    eq(registryAuditLog.documentId, documentId),
  )).orderBy(desc(registryAuditLog.createdAt));
}

function metadata(entry: { metadata: unknown } | undefined) {
  assert.ok(entry && entry.metadata && typeof entry.metadata === 'object');
  return entry.metadata as Record<string, unknown>;
}

async function cleanup() {
  await database.db.delete(registryDocuments).where(and(
    eq(registryDocuments.portalUrl, portalUrl),
    like(registryDocuments.title, 'Stage10 QA%'),
  ));
}
