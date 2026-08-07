import assert from 'node:assert/strict';
import { once } from 'node:events';

import { and, eq, like } from 'drizzle-orm';

import { createApp } from '../backend/src/app.js';
import type { BitrixApiClient } from '../backend/src/bitrix/bitrix-client.js';
import { loadConfig } from '../backend/src/config.js';
import { CrmContextService } from '../backend/src/crm-context/crm-context.service.js';
import { createDatabase } from '../backend/src/db/database.js';
import {
  registryDocuments,
  registryDocumentTypes,
} from '../backend/src/db/schema/index.js';

class NoopBitrixClient implements BitrixApiClient {
  normalizeDomain(value: string) { return value; }
  async call<T>(): Promise<T> { throw new Error('Unexpected Bitrix API call.'); }
  async upload<T>(): Promise<T> { throw new Error('Unexpected Bitrix upload.'); }
}

class FakeCrmBitrixClient implements BitrixApiClient {
  normalizeDomain(value: string) { return value; }
  async call<T>(_domain: string, _token: string, method: string, params: Record<string, unknown>): Promise<T> {
    if (method === 'scope') return ['task'] as T;
    if (method === 'crm.company.get') {
      return { ID: params.id, TITLE: `Verified company ${params.id}` } as T;
    }
    if (method === 'tasks.task.get') {
      return { task: { id: params.taskId, title: `Verified task ${params.taskId}` } } as T;
    }
    if (method === 'tasks.task.list') {
      return { tasks: [{ id: 8801, title: 'Existing task from Bitrix24' }] } as T;
    }
    throw new Error(`Unexpected Bitrix method: ${method}`);
  }
  async upload<T>(): Promise<T> { throw new Error('Unexpected Bitrix upload.'); }
}

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('TEST_DATABASE_URL is required.');

const portalUrl = 'https://thermech.bitrix24.ru';
const config = loadConfig({
  NODE_ENV: 'test',
  API_HOST: '127.0.0.1',
  API_PORT: '3103',
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
  const requiredType = await api('/types', {
    method: 'POST',
    body: {
      sectionCode: 'internal',
      name: 'Stage3 QA Required Content',
      lifecycleCode: 'simple',
      contentRequired: true,
      fields: [],
    },
  }, 201);
  const optionalType = await api('/types', {
    method: 'POST',
    body: {
      sectionCode: 'internal',
      name: 'Stage3 QA Optional Content',
      lifecycleCode: 'simple',
      contentRequired: false,
      fields: [],
    },
  }, 201);
  assert.equal(requiredType.contentRequired, true);
  assert.equal(optionalType.contentRequired, false);
  checks.push('content_requirement_per_type');

  await api('/documents', {
    method: 'POST',
    body: documentInput(requiredType.code, 'Stage3 QA arbitrary company', {
      counterpartyName: 'Typed but not selected',
    }),
  }, 400, 'counterparty_company_selection_required');

  const created = await api('/documents', {
    method: 'POST',
    body: documentInput(requiredType.code, 'Stage3 QA linked document', {
      counterpartyId: 7701,
      counterpartyName: 'Selected company',
      dealStageId: 'C1:NEW',
      comment: 'Stage3 context comment',
      links: [
        { entityType: 'deal', entityId: 9901, entityTitle: 'Linked deal' },
        { entityType: 'company', entityId: 7701, entityTitle: 'Selected company' },
      ],
      taskLinks: [{ taskId: 8801, taskTitle: 'Existing task' }],
    }),
  }, 201);
  assert.equal(created.legalEntityId, null);
  assert.equal(created.legalEntityName, null);
  assert.equal(created.counterpartyId, 7701);
  assert.equal(created.dealStageId, 'C1:NEW');
  assert.equal(created.comment, 'Stage3 context comment');
  assert.equal(created.taskLinks.length, 1);
  assert.equal(created.taskLinks[0].taskId, 8801);
  checks.push('company_crm_links_task_and_context_fields');

  await api(`/documents/${created.id}/finalize`, { method: 'POST' }, 409, 'document_content_required');
  const firstLink = await api(`/documents/${created.id}/attachments/link`, {
    method: 'POST',
    body: { name: 'Source', url: 'https://example.test/document.pdf#fragment' },
  }, 201);
  const finalized = await api(`/documents/${created.id}/finalize`, { method: 'POST' });
  assert.equal(finalized.attachments[0].url, 'https://example.test/document.pdf');
  await api(
    `/documents/${created.id}/attachments/${firstLink.id}`,
    { method: 'DELETE' },
    409,
    'document_content_delete_denied',
  );
  await api(`/documents/${created.id}/attachments/link`, {
    method: 'POST',
    body: { name: 'Replacement', url: 'https://example.test/replacement.pdf' },
  }, 201);
  await api(`/documents/${created.id}/attachments/${firstLink.id}`, { method: 'DELETE' }, 204);
  checks.push('required_file_or_https_link_lifecycle');

  const optional = await api('/documents', {
    method: 'POST',
    body: documentInput(optionalType.code, 'Stage3 QA optional document', {}),
  }, 201);
  await api(`/documents/${optional.id}/finalize`, { method: 'POST' });
  checks.push('content_can_be_added_later');

  const withSecondTask = await api(`/documents/${created.id}/tasks`, {
    method: 'POST',
    body: { taskId: 8802, taskTitle: 'Another existing task' },
  }, 201);
  const added = withSecondTask.taskLinks.find((link: { taskId: number }) => link.taskId === 8802);
  assert.ok(added?.id);
  const afterRemove = await api(`/documents/${created.id}/tasks/${added.id}`, { method: 'DELETE' });
  assert.equal(afterRemove.taskLinks.some((link: { taskId: number }) => link.taskId === 8802), false);
  const taskSearch = await api('/tasks?search=existing');
  assert.deepEqual(taskSearch.items, []);
  checks.push('manual_existing_task_link_management');

  await api(`/documents/${created.id}`, {
    method: 'PATCH',
    body: { counterpartyName: 'Arbitrary replacement' },
  }, 400, 'counterparty_company_selection_required');
  const companyUpdated = await api(`/documents/${created.id}`, {
    method: 'PATCH',
    body: { counterpartyId: 7702, counterpartyName: 'Selected replacement' },
  });
  assert.equal(companyUpdated.counterpartyId, 7702);
  assert.equal(companyUpdated.counterpartyName, 'Selected replacement');
  checks.push('company_update_requires_bound_id');

  const crm = new CrmContextService(new FakeCrmBitrixClient());
  const bitrixContext = {
    portalUrl,
    userId: 501,
    roleCode: 'admin',
    roleSource: 'bitrix_admin' as const,
    departmentIds: [],
    source: 'bitrix' as const,
    bitrix: { domain: 'thermech.bitrix24.ru', accessToken: 'stage3-test-token' },
  };
  const verifiedCompany = await crm.resolveCompanySelection(bitrixContext, 7703, 'Untrusted');
  const verifiedTask = await crm.resolveTaskSelection(bitrixContext, 8803, 'Untrusted');
  const tasks = await crm.searchTasks(bitrixContext, 'existing', 20);
  assert.deepEqual(verifiedCompany, { id: 7703, title: 'Verified company 7703' });
  assert.deepEqual(verifiedTask, { id: 8803, title: 'Verified task 8803' });
  assert.deepEqual(tasks, [{ id: 8801, title: 'Existing task from Bitrix24' }]);
  checks.push('bitrix_company_and_task_canonicalization');

  process.stdout.write(`${JSON.stringify({ ok: true, checks }, null, 2)}\n`);
} finally {
  await cleanup().catch(() => undefined);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await database.close();
}

function documentInput(
  typeCode: string,
  title: string,
  overrides: Record<string, unknown>,
) {
  return {
    sectionCode: 'internal',
    typeCode,
    title,
    documentDate: '2026-08-04',
    responsibleId: 501,
    responsibleName: 'Stage3 QA',
    links: [],
    taskLinks: [],
    fields: {},
    ...overrides,
  };
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
    like(registryDocuments.title, 'Stage3 QA%'),
  ));
  await database.db.delete(registryDocumentTypes).where(and(
    eq(registryDocumentTypes.portalUrl, portalUrl),
    like(registryDocumentTypes.name, 'Stage3 QA%'),
  ));
}
