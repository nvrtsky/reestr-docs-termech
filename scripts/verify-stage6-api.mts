import assert from 'node:assert/strict';
import { once } from 'node:events';

import { and, eq, like } from 'drizzle-orm';

import { createApp } from '../backend/src/app.js';
import type { BitrixApiClient } from '../backend/src/bitrix/bitrix-client.js';
import { loadConfig } from '../backend/src/config.js';
import { createDatabase } from '../backend/src/db/database.js';
import {
  registryAuditLog,
  registryDocumentLinks,
  registryDocumentRelations,
  registryDocuments,
  registryDocumentTypes,
  registrySections,
} from '../backend/src/db/schema/index.js';

class NoopBitrixClient implements BitrixApiClient {
  normalizeDomain(value: string) { return value; }
  async call<T>(): Promise<T> { throw new Error('Unexpected Bitrix API call.'); }
  async upload<T>(): Promise<T> { throw new Error('Unexpected Bitrix upload.'); }
}

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('TEST_DATABASE_URL is required.');

const portalUrl = 'https://thermech.bitrix24.ru';
const otherPortalUrl = 'https://stage6-other.bitrix24.ru';
const config = loadConfig({
  NODE_ENV: 'test',
  API_HOST: '127.0.0.1',
  API_PORT: '3106',
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
  const contractType = await createType('Stage6 QA Contract');
  const addendumType = await createType('Stage6 QA Addendum');
  const appendixType = await createType('Stage6 QA Appendix');
  const contract = await createDocument(contractType.code, 'Stage6 QA Main contract', 'К-2026/45');
  const secondContract = await createDocument(contractType.code, 'Stage6 QA Second contract', 'К-2026/46');
  const addendum = await createDocument(addendumType.code, 'Stage6 QA Addendum 1', 'ДС-1');
  const appendix = await createDocument(appendixType.code, 'Stage6 QA Appendix 1', 'П-1');

  const linkedAddendum = await api(`/documents/${addendum.id}/relations/parent`, 'admin', {
    method: 'PUT',
    body: { parentDocumentId: contract.id, relationType: 'addendum' },
  });
  assert.equal(linkedAddendum.relations.parent.id, contract.id);
  assert.equal(linkedAddendum.relations.parent.relationType, 'addendum');
  await api(`/documents/${appendix.id}/relations/parent`, 'admin', {
    method: 'PUT',
    body: { parentDocumentId: contract.id, relationType: 'appendix' },
  });
  const contractDetails = await api(`/documents/${contract.id}`, 'admin');
  assert.deepEqual(
    contractDetails.relations.children.map((item: { id: string }) => item.id).sort(),
    [addendum.id, appendix.id].sort(),
  );
  checks.push('bidirectional_parent_and_children');

  const searched = await api('/documents?search=%D0%9A-2026%2F45', 'admin');
  assert.equal(searched.meta.total, 1);
  assert.equal(searched.items[0].id, contract.id);
  assert.equal(searched.items[0].relations.children.length, 2);
  assert.equal(searched.items[0].relations.children.some((item: { id: string }) => item.id === addendum.id), true);
  checks.push('contract_search_returns_expandable_dependents');

  await database.db.insert(registryDocumentLinks).values({
    portalUrl,
    documentId: contract.id,
    entityType: 'company',
    entityId: 7301,
    entityTitle: 'Stage6 QA CRM company',
  });
  const independent = await api(`/documents/${contract.id}`, 'admin');
  assert.equal(independent.links.length, 1);
  assert.equal(independent.relations.children.length, 2);
  const [relationRow] = await database.db.select().from(registryDocumentRelations)
    .where(eq(registryDocumentRelations.childDocumentId, addendum.id));
  assert.equal(relationRow.parentDocumentId, contract.id);
  checks.push('relations_are_independent_from_crm_links_and_filenames');

  await api(`/documents/${contract.id}/relations/parent`, 'admin', {
    method: 'PUT',
    body: { parentDocumentId: addendum.id, relationType: 'other' },
  }, 409, 'document_relation_cycle');
  await api(`/documents/${contract.id}/relations/parent`, 'admin', {
    method: 'PUT',
    body: { parentDocumentId: contract.id, relationType: 'other' },
  }, 400, 'document_relation_self_reference');
  checks.push('self_reference_and_cycles_rejected');

  const moved = await api(`/documents/${addendum.id}/relations/parent`, 'admin', {
    method: 'PUT',
    body: { parentDocumentId: secondContract.id, relationType: 'addendum' },
  });
  assert.equal(moved.relations.parent.id, secondContract.id);
  const formerParent = await api(`/documents/${contract.id}`, 'admin');
  assert.equal(formerParent.relations.children.some((item: { id: string }) => item.id === addendum.id), false);
  const currentParent = await api(`/documents/${secondContract.id}`, 'admin');
  assert.equal(currentParent.relations.children.some((item: { id: string }) => item.id === addendum.id), true);
  checks.push('single_parent_can_be_changed_consistently');

  await database.db.update(registryDocuments)
    .set({ createdBy: 999, responsibleId: 999 })
    .where(eq(registryDocuments.id, appendix.id));
  await api(`/documents/${appendix.id}/relations/parent`, 'sales', {
    method: 'PUT',
    body: { parentDocumentId: secondContract.id, relationType: 'appendix' },
  }, 403, 'edit_access_denied');
  checks.push('both_documents_require_edit_permission');

  const [typeRow] = await database.db.select({ id: registryDocumentTypes.id })
    .from(registryDocumentTypes).where(and(
      eq(registryDocumentTypes.portalUrl, portalUrl),
      eq(registryDocumentTypes.code, contractType.code),
    ));
  const [sectionRow] = await database.db.select({ id: registrySections.id })
    .from(registrySections).where(and(
      eq(registrySections.portalUrl, portalUrl),
      eq(registrySections.code, 'client'),
    ));
  const [foreignDocument] = await database.db.insert(registryDocuments).values({
    portalUrl: otherPortalUrl,
    sectionId: sectionRow.id,
    typeId: typeRow.id,
    number: 'FOREIGN-1',
    title: 'Stage6 QA foreign portal',
    documentDate: '2026-08-04',
    status: 'draft',
    responsibleId: 501,
    createdBy: 501,
  }).returning();
  await api(`/documents/${addendum.id}/relations/parent`, 'admin', {
    method: 'PUT',
    body: { parentDocumentId: foreignDocument.id, relationType: 'other' },
  }, 404, 'document_not_found');
  checks.push('portal_isolation_enforced');

  const unlinked = await api(`/documents/${addendum.id}/relations/parent`, 'admin', {
    method: 'DELETE',
  });
  assert.equal(unlinked.relations.parent, null);
  const afterRemoval = await api(`/documents/${secondContract.id}`, 'admin');
  assert.equal(afterRemoval.relations.children.length, 0);
  const auditEvents = await database.db.select({ event: registryAuditLog.event })
    .from(registryAuditLog)
    .where(and(
      eq(registryAuditLog.portalUrl, portalUrl),
      eq(registryAuditLog.documentId, addendum.id),
    ));
  assert.equal(auditEvents.some((item) => item.event === 'relation_parent_added'), true);
  assert.equal(auditEvents.some((item) => item.event === 'relation_parent_changed'), true);
  assert.equal(auditEvents.some((item) => item.event === 'relation_parent_removed'), true);
  checks.push('unlink_is_bidirectional_and_audited');

  process.stdout.write(`${JSON.stringify({ ok: true, checks }, null, 2)}\n`);
} finally {
  await cleanup().catch(() => undefined);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await database.close();
}

async function createType(name: string) {
  return api('/types', 'admin', {
    method: 'POST',
    body: {
      sectionCode: 'client',
      name,
      lifecycleCode: 'simple',
      contentRequired: false,
      fields: [],
    },
  }, 201);
}

async function createDocument(typeCode: string, title: string, number: string) {
  return api('/documents', 'admin', {
    method: 'POST',
    body: {
      sectionCode: 'client',
      typeCode,
      number,
      title,
      documentDate: '2026-08-04',
      responsibleId: 501,
      responsibleName: 'Stage6 QA',
      links: [],
      taskLinks: [],
      fields: {},
    },
  }, 201);
}

async function api(
  path: string,
  role: string,
  options: { method?: string; body?: unknown } = {},
  expectedStatus = 200,
  expectedCode?: string,
) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method || 'GET',
    headers: {
      accept: 'application/json',
      'x-registry-development-role': role,
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
    eq(registryDocuments.portalUrl, otherPortalUrl),
    like(registryDocuments.title, 'Stage6 QA%'),
  ));
  await database.db.delete(registryDocuments).where(and(
    eq(registryDocuments.portalUrl, portalUrl),
    like(registryDocuments.title, 'Stage6 QA%'),
  ));
  await database.db.delete(registryDocumentTypes).where(and(
    eq(registryDocumentTypes.portalUrl, portalUrl),
    like(registryDocumentTypes.name, 'Stage6 QA%'),
  ));
}
