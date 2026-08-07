import assert from 'node:assert/strict';
import { once } from 'node:events';

import { and, eq, like } from 'drizzle-orm';

import { createApp } from '../backend/src/app.js';
import { AttachmentsService } from '../backend/src/attachments/attachments.service.js';
import type { BitrixApiClient } from '../backend/src/bitrix/bitrix-client.js';
import { loadConfig } from '../backend/src/config.js';
import { createDatabase } from '../backend/src/db/database.js';
import {
  registryDocuments,
  registryDocumentTypes,
  registryFieldDefinitions,
  registryLifecycles,
  registrySections,
  registrySettings,
} from '../backend/src/db/schema/index.js';
import { documentNumberUniquenessKey } from '../backend/src/documents/document-numbering.service.js';

class NoopBitrixClient implements BitrixApiClient {
  normalizeDomain(value: string) { return value; }
  async call<T>(): Promise<T> { throw new Error('Unexpected Bitrix API call.'); }
  async upload<T>(): Promise<T> { throw new Error('Unexpected Bitrix upload.'); }
}

class FakeDiskBitrixClient implements BitrixApiClient {
  private nextFolderId = 8_000;
  private nextFileId = 9_000;
  private uploadFolderId = 0;
  private file: Record<string, unknown> | null = null;

  normalizeDomain(value: string) { return value; }
  async call<T>(_domain: string, _token: string, method: string, params: Record<string, unknown>): Promise<T> {
    if (method === 'disk.folder.getchildren') return [] as T;
    if (method === 'disk.folder.addsubfolder') {
      const data = params.data as { NAME: string };
      return {
        ID: ++this.nextFolderId,
        NAME: data.NAME,
        TYPE: 'folder',
        PARENT_ID: params.id,
      } as T;
    }
    if (method === 'disk.folder.uploadfile') {
      this.uploadFolderId = Number(params.id);
      return { uploadUrl: 'https://upload.stage2.test', field: 'file' } as T;
    }
    if (method === 'disk.file.get') return this.file as T;
    if (method === 'disk.file.markdeleted' || method === 'disk.file.restore') return true as T;
    throw new Error(`Unexpected Bitrix method: ${method}`);
  }
  async upload<T>(_domain: string, _url: string, _body: AsyncIterable<Uint8Array>): Promise<T> {
    const id = ++this.nextFileId;
    this.file = {
      ID: id,
      NAME: 'required.pdf',
      TYPE: 'file',
      PARENT_ID: this.uploadFolderId,
      DELETED_TYPE: '0',
      SIZE: 3,
      DETAIL_URL: 'https://thermech.bitrix24.ru/disk/file',
    };
    return this.file as T;
  }
}

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('TEST_DATABASE_URL is required.');

const portalUrl = 'https://thermech.bitrix24.ru';
const isolationPortalUrl = 'https://stage2-isolation.local.bitrix24.test';
const config = loadConfig({
  NODE_ENV: 'test',
  API_HOST: '127.0.0.1',
  API_PORT: '3102',
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
  const sharedType = await api('/types', {
    method: 'POST',
    body: {
      sectionCodes: ['internal', 'legal'],
      name: 'Stage2 QA Shared Type',
      lifecycleCode: 'simple',
      contentRequired: false,
      fields: [],
    },
  }, 201);
  assert.deepEqual(sharedType.sectionCodes, ['internal', 'legal']);
  let catalog = await api('/sections');
  for (const sectionCode of ['internal', 'legal']) {
    const section = catalog.items.find((item: { code: string }) => item.code === sectionCode);
    assert.equal(section.types.filter((type: { code: string }) => type.code === sharedType.code).length, 1);
  }
  let sharedAdminRows = (await api('/admin/types')).items
    .filter((type: { code: string }) => type.code === sharedType.code);
  assert.equal(sharedAdminRows.length, 1);
  assert.deepEqual(sharedAdminRows[0].sectionCodes, ['internal', 'legal']);
  await api(`/types/${sharedType.code}`, {
    method: 'PUT',
    body: {
      sectionCodes: ['supplier', 'internal'],
      name: 'Stage2 QA Shared Type',
      lifecycleCode: 'simple',
      contentRequired: false,
      fields: [],
    },
  });
  catalog = await api('/sections');
  assert.equal(catalog.items.find((item: { code: string }) => item.code === 'legal').types
    .some((type: { code: string }) => type.code === sharedType.code), false);
  for (const sectionCode of ['supplier', 'internal']) {
    assert.equal(catalog.items.find((item: { code: string }) => item.code === sectionCode).types
      .filter((type: { code: string }) => type.code === sharedType.code).length, 1);
  }
  sharedAdminRows = (await api('/admin/types')).items
    .filter((type: { code: string }) => type.code === sharedType.code);
  assert.equal(sharedAdminRows.length, 1);
  assert.deepEqual(sharedAdminRows[0].sectionCodes, ['supplier', 'internal']);
  await api(`/admin/types/${sharedType.code}`, { method: 'DELETE' }, 204);
  checks.push('shared_document_type_multiple_sections_without_duplicates');

  const createdType = await api('/types', {
    method: 'POST',
    body: {
      sectionCode: 'internal',
      name: 'Stage2 QA Numbered',
      lifecycleCode: 'simple',
      numberFormat: '{TYPE}-{YYYY}-{SEQ:4}',
      numberAutoGenerate: true,
      numberUniquenessEnabled: true,
      contentRequired: false,
      fields: [
        { name: 'Stage2 QA Marker', dataType: 'text', isRequired: false },
        { name: 'Stage2 QA File', dataType: 'file', isRequired: false },
      ],
    },
  }, 201);
  const marker = createdType.fields.find((field: { name: string }) => field.name === 'Stage2 QA Marker');
  const file = createdType.fields.find((field: { name: string }) => field.name === 'Stage2 QA File');
  assert.ok(marker?.key && file?.key);

  const first = await createDocument(createdType.code, 'Stage2 QA first', 101, {
    [marker.key]: 'alpha marker',
  });
  const second = await createDocument(createdType.code, 'Stage2 QA second', 101, {
    [marker.key]: 'beta marker',
  });
  const otherCompany = await createDocument(createdType.code, 'Stage2 QA other company', 102, {
    [marker.key]: 'alpha other',
  });
  assert.match(first.number, /-2026-0001$/);
  assert.match(second.number, /-2026-0002$/);
  assert.match(otherCompany.number, /-2026-0001$/);
  checks.push('automatic_numbering_per_company');

  const manualNumber = `${createdType.code}-2026-0099`;
  await createDocument(createdType.code, 'Stage2 QA manual', 101, {}, manualNumber);
  const duplicate = await api('/documents', {
    method: 'POST',
    body: documentInput(createdType.code, 'Stage2 QA duplicate', 101, {}, manualNumber),
  }, 201);
  await api(
    `/documents/${duplicate.id}/finalize`,
    { method: 'POST' },
    409,
    'document_number_conflict',
  );
  await createDocument(createdType.code, 'Stage2 QA duplicate other company', 102, {}, manualNumber);
  checks.push('manual_number_and_scoped_uniqueness');

  const [isolationSection] = await database.db.insert(registrySections).values({
    portalUrl: isolationPortalUrl,
    code: 'internal',
    name: 'Stage2 isolation',
  }).returning({ id: registrySections.id });
  const [isolationLifecycle] = await database.db.insert(registryLifecycles).values({
    portalUrl: isolationPortalUrl,
    code: 'simple',
    name: 'Stage2 isolation',
    config: {
      initialStatus: 'draft',
      states: [{ code: 'draft', label: 'Черновик' }],
      transitions: [],
    },
  }).returning({ id: registryLifecycles.id });
  const [isolationType] = await database.db.insert(registryDocumentTypes).values({
    portalUrl: isolationPortalUrl,
    sectionId: isolationSection.id,
    lifecycleId: isolationLifecycle.id,
    code: createdType.code,
    name: 'Stage2 isolation',
    numberFormat: '{TYPE}-{YYYY}-{SEQ:4}',
    numberAutoGenerate: true,
    numberUniquenessEnabled: true,
  }).returning({ id: registryDocumentTypes.id });
  await database.db.insert(registryDocuments).values({
    portalUrl: isolationPortalUrl,
    sectionId: isolationSection.id,
    typeId: isolationType.id,
    number: manualNumber,
    numberUniquenessKey: documentNumberUniquenessKey(manualNumber, 101),
    title: 'Stage2 QA isolation',
    documentDate: '2026-08-04',
    counterpartyId: 101,
    status: 'draft',
    responsibleId: 501,
    createdBy: 501,
  });
  checks.push('number_uniqueness_portal_isolation');

  const filters = encodeURIComponent(JSON.stringify({ [marker.key]: 'alpha' }));
  const filtered = await api(`/documents?type=${createdType.code}&fieldFilters=${filters}`);
  assert.equal(filtered.meta.total, 2);
  assert.ok(filtered.items.every((item: { fields: Array<{ key: string }> }) =>
    item.fields.some((fieldValue) => fieldValue.key === marker.key)));
  const exported = await rawApi(
    `/documents/export.xlsx?type=${createdType.code}&fieldFilters=${filters}&columns=field:${marker.key}`,
  );
  assert.equal(exported.status, 200);
  assert.equal(exported.headers.get('x-export-row-count'), '2');
  checks.push('dynamic_filter_list_and_xlsx');

  const adminTypes = await api('/admin/types');
  assert.ok(adminTypes.fieldLibrary.some((fieldDefinition: { key: string }) =>
    fieldDefinition.key === marker.key));
  await api('/types', {
    method: 'POST',
    body: {
      sectionCode: 'internal',
      name: 'Stage2 QA Conflict',
      lifecycleCode: 'simple',
      fields: [{ name: 'Stage2 QA Marker', dataType: 'date', isRequired: false }],
    },
  }, 409, 'field_definition_type_conflict');
  checks.push('field_library_type_conflict');

  await api(`/types/${createdType.code}`, {
    method: 'PUT',
    body: {
      sectionCode: 'internal',
      name: 'Stage2 QA Numbered',
      lifecycleCode: 'simple',
      numberFormat: '{TYPE}-{YYYY}-{SEQ:4}',
      numberAutoGenerate: true,
      numberUniquenessEnabled: true,
      contentRequired: false,
      fields: [
        { key: marker.key, name: 'Stage2 QA Marker', dataType: 'text', isRequired: false },
        { key: file.key, name: 'Stage2 QA File', dataType: 'file', isRequired: true },
      ],
    },
  });
  await api('/documents', {
    method: 'POST',
    body: documentInput(createdType.code, 'Stage2 QA missing file', 103, {}),
  }, 400, 'required_document_fields_missing');
  const pending = await api('/documents', {
    method: 'POST',
    body: documentInput(createdType.code, 'Stage2 QA pending file', 103, {
      [file.key]: { pendingUpload: true, name: 'required.pdf' },
    }),
  }, 201);
  await api(`/documents/${pending.id}/finalize`, { method: 'POST' }, 409, 'required_file_fields_incomplete');
  await database.db.insert(registrySettings).values({
    portalUrl,
    key: 'bitrix_disk_root_folder_id',
    value: { id: 7_999 },
  }).onConflictDoUpdate({
    target: [registrySettings.portalUrl, registrySettings.key],
    set: { value: { id: 7_999 }, updatedAt: new Date() },
  });
  const disk = new FakeDiskBitrixClient();
  const attachments = new AttachmentsService(database.db, disk);
  const attachmentContext = {
    portalUrl,
    userId: 501,
    roleCode: 'admin',
    roleSource: 'bitrix_admin' as const,
    departmentIds: [],
    source: 'bitrix' as const,
    bitrix: {
      domain: 'thermech.bitrix24.ru',
      accessToken: 'stage2-test-token',
    },
  };
  const initialized = await attachments.initializeFileUpload(attachmentContext, pending.id, {
    name: 'required.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 3,
    fieldKey: file.key,
  });
  const uploaded = await attachments.uploadFile(
    attachmentContext,
    pending.id,
    initialized.uploadId,
    bytes([1, 2, 3]),
    'multipart/form-data',
  );
  assert.equal(uploaded.fieldKey, file.key);
  assert.equal(uploaded.version, 1);
  await api(`/documents/${pending.id}/finalize`, { method: 'POST' });
  await assert.rejects(
    attachments.softDelete(attachmentContext, pending.id, uploaded.id),
    (error: unknown) => !!error && typeof error === 'object'
      && (error as { code?: string }).code === 'required_file_field_delete_denied',
  );
  const replacementInit = await attachments.initializeFileUpload(attachmentContext, pending.id, {
    name: 'required-v2.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 3,
    fieldKey: file.key,
    replacesAttachmentId: uploaded.id,
  });
  const replacement = await attachments.uploadFile(
    attachmentContext,
    pending.id,
    replacementInit.uploadId,
    bytes([4, 5, 6]),
    'multipart/form-data',
  );
  assert.equal(replacement.fieldKey, file.key);
  assert.equal(replacement.version, 2);
  checks.push('required_file_disk_binding_and_versions');

  process.stdout.write(`${JSON.stringify({ ok: true, checks }, null, 2)}\n`);
} finally {
  await cleanup().catch(() => undefined);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await database.close();
}

function documentInput(
  typeCode: string,
  title: string,
  counterpartyId: number,
  fields: Record<string, unknown>,
  number: string | null = null,
) {
  return {
    sectionCode: 'internal',
    typeCode,
    title,
    number,
    documentDate: '2026-08-04',
    counterpartyId,
    counterpartyName: `Company ${counterpartyId}`,
    responsibleId: 501,
    responsibleName: 'Stage2 QA',
    links: [],
    fields,
  };
}

async function createDocument(
  typeCode: string,
  title: string,
  counterpartyId: number,
  fields: Record<string, unknown>,
  number: string | null = null,
) {
  const document = await api('/documents', {
    method: 'POST',
    body: documentInput(typeCode, title, counterpartyId, fields, number),
  }, 201);
  return api(`/documents/${document.id}/finalize`, { method: 'POST' });
}

async function api(
  path: string,
  options: { method?: string; body?: unknown } = {},
  expectedStatus = 200,
  expectedCode?: string,
) {
  const response = await rawApi(path, options);
  const payload = await response.json().catch(() => null);
  assert.equal(response.status, expectedStatus, `${options.method || 'GET'} ${path}: ${JSON.stringify(payload)}`);
  if (expectedCode) assert.equal(payload?.error?.code, expectedCode);
  return payload;
}

function rawApi(path: string, options: { method?: string; body?: unknown } = {}) {
  return fetch(`${baseUrl}${path}`, {
    method: options.method || 'GET',
    headers: {
      accept: 'application/json',
      'x-registry-development-role': 'admin',
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
}

async function* bytes(values: number[]) {
  yield Uint8Array.from(values);
}

async function cleanup() {
  await database.db.delete(registryDocuments).where(
    eq(registryDocuments.portalUrl, isolationPortalUrl),
  );
  await database.db.delete(registryDocumentTypes).where(
    eq(registryDocumentTypes.portalUrl, isolationPortalUrl),
  );
  await database.db.delete(registrySections).where(
    eq(registrySections.portalUrl, isolationPortalUrl),
  );
  await database.db.delete(registryLifecycles).where(
    eq(registryLifecycles.portalUrl, isolationPortalUrl),
  );
  await database.db.delete(registryDocuments).where(and(
    eq(registryDocuments.portalUrl, portalUrl),
    like(registryDocuments.title, 'Stage2 QA%'),
  ));
  await database.db.delete(registryDocumentTypes).where(and(
    eq(registryDocumentTypes.portalUrl, portalUrl),
    like(registryDocumentTypes.name, 'Stage2 QA%'),
  ));
  await database.db.delete(registryFieldDefinitions).where(and(
    eq(registryFieldDefinitions.portalUrl, portalUrl),
    like(registryFieldDefinitions.label, 'Stage2 QA%'),
  ));
}
