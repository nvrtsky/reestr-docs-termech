import assert from 'node:assert/strict';
import { once } from 'node:events';

import { and, eq, isNotNull, isNull, like } from 'drizzle-orm';

import { createApp } from '../backend/src/app.js';
import { AttachmentsService } from '../backend/src/attachments/attachments.service.js';
import { createDocumentsService } from '../backend/src/documents/documents.service.js';
import type { BitrixApiClient } from '../backend/src/bitrix/bitrix-client.js';
import { loadConfig } from '../backend/src/config.js';
import { createDatabase } from '../backend/src/db/database.js';
import {
  registryAttachmentCopies,
  registryAttachments,
  registryAuditLog,
  registryDocumentLinks,
  registryDocuments,
  registryDocumentTypes,
  registrySettings,
} from '../backend/src/db/schema/index.js';

class NoopBitrixClient implements BitrixApiClient {
  normalizeDomain(value: string) { return value; }
  async call<T>(): Promise<T> { throw new Error('Unexpected Bitrix API call.'); }
  async upload<T>(): Promise<T> { throw new Error('Unexpected Bitrix upload.'); }
}

class FakeCopyingDiskClient implements BitrixApiClient {
  nextFolderId = 70_000;
  nextFileId = 80_000;
  uploadFolderId = 0;
  uploadName = '';
  failCopyNumber: number | null = null;
  copyCalls: Array<{ sourceFileId: number; targetFolderId: number; copyFileId: number }> = [];
  deletedFileIds: number[] = [];
  restoredFileIds: number[] = [];
  files = new Map<number, Record<string, unknown>>();

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
      this.uploadName = String((params.data as { NAME: string }).NAME);
      return { uploadUrl: 'https://thermech.bitrix24.ru/upload/stage7', field: 'file' } as T;
    }
    if (method === 'disk.file.get') return this.files.get(Number(params.id)) as T;
    if (method === 'disk.file.copyto') {
      const copyNumber = this.copyCalls.length + 1;
      if (this.failCopyNumber === copyNumber) throw new Error('Stage7 simulated copy failure');
      const sourceFileId = Number(params.id);
      const targetFolderId = Number(params.targetFolderId);
      const source = this.files.get(sourceFileId);
      if (!source) throw new Error('Stage7 copy source is missing');
      const copyFileId = ++this.nextFileId;
      const copied = {
        ...source,
        ID: copyFileId,
        PARENT_ID: targetFolderId,
        DETAIL_URL: `https://thermech.bitrix24.ru/disk/file/${copyFileId}`,
      };
      this.files.set(copyFileId, copied);
      this.copyCalls.push({ sourceFileId, targetFolderId, copyFileId });
      return copied as T;
    }
    if (method === 'disk.file.markdeleted') {
      const id = Number(params.id);
      this.deletedFileIds.push(id);
      const file = this.files.get(id);
      if (file) file.DELETED_TYPE = '3';
      return true as T;
    }
    if (method === 'disk.file.restore') {
      const id = Number(params.id);
      this.restoredFileIds.push(id);
      const file = this.files.get(id);
      if (file) file.DELETED_TYPE = '0';
      return true as T;
    }
    throw new Error(`Unexpected Bitrix method: ${method}`);
  }

  async upload<T>(): Promise<T> {
    const id = ++this.nextFileId;
    const file = {
      ID: id,
      NAME: this.uploadName,
      TYPE: 'file',
      PARENT_ID: this.uploadFolderId,
      DELETED_TYPE: '0',
      SIZE: 4,
      DETAIL_URL: `https://thermech.bitrix24.ru/disk/file/${id}`,
    };
    this.files.set(id, file);
    return file as T;
  }
}

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('TEST_DATABASE_URL is required.');

const portalUrl = 'https://thermech.bitrix24.ru';
const config = loadConfig({
  NODE_ENV: 'test',
  API_HOST: '127.0.0.1',
  API_PORT: '3107',
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
let originalRootSetting: unknown;

try {
  await cleanup();
  [originalRootSetting] = await database.db.select({ value: registrySettings.value })
    .from(registrySettings)
    .where(and(
      eq(registrySettings.portalUrl, portalUrl),
      eq(registrySettings.key, 'bitrix_disk_root_folder_id'),
    ));
  await database.db.insert(registrySettings).values({
    portalUrl,
    key: 'bitrix_disk_root_folder_id',
    value: { id: 69_999 },
  }).onConflictDoUpdate({
    target: [registrySettings.portalUrl, registrySettings.key],
    set: { value: { id: 69_999 }, updatedAt: new Date() },
  });

  const type = await api('/types', {
    method: 'POST',
    body: {
      sectionCode: 'client',
      name: 'Stage7 QA Stored Document',
      lifecycleCode: 'simple',
      contentRequired: false,
      fields: [],
    },
  }, 201);
  const document = await api('/documents', {
    method: 'POST',
    body: {
      sectionCode: 'client',
      typeCode: type.code,
      number: 'STORAGE-7',
      title: 'Stage7 QA two deal copies',
      documentDate: '2026-08-04',
      responsibleId: 501,
      responsibleName: 'Stage7 QA',
      links: [],
      taskLinks: [],
      fields: {},
    },
  }, 201);
  await database.db.insert(registryDocumentLinks).values([
    { portalUrl, documentId: document.id, entityType: 'deal', entityId: 7101, entityTitle: 'Stage7 Deal Alpha' },
    { portalUrl, documentId: document.id, entityType: 'deal', entityId: 7102, entityTitle: 'Stage7 Deal Beta' },
  ]);

  const disk = new FakeCopyingDiskClient();
  const attachments = new AttachmentsService(database.db, disk);
  const context = {
    portalUrl,
    userId: 501,
    roleCode: 'admin',
    roleSource: 'bitrix_admin' as const,
    departmentIds: [],
    source: 'bitrix' as const,
    bitrix: {
      domain: 'thermech.bitrix24.ru',
      accessToken: 'stage7-test-token',
    },
  };

  const firstInit = await attachments.initializeFileUpload(context, document.id, {
    name: 'contract-stage7.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 4,
  });
  const first = await attachments.uploadFile(
    context,
    document.id,
    firstInit.uploadId,
    bytes([1, 2, 3, 4]),
    'multipart/form-data',
  );
  assert.equal(first.storageCopies.length, 2);
  assert.equal(new Set(first.storageCopies.map((copy: { diskFileId: number }) => copy.diskFileId)).size, 2);
  assert.equal(new Set(first.storageCopies.map((copy: { diskFolderId: number }) => copy.diskFolderId)).size, 2);
  assert.equal(first.storageCopies.every((copy: { storagePath: string }) => copy.storagePath.includes('Клиентские')), true);
  assert.equal(first.storageCopies.some((copy: { storagePath: string }) => copy.storagePath.includes('Stage7 Deal Alpha [7101]')), true);
  assert.equal(first.storageCopies.some((copy: { storagePath: string }) => copy.storagePath.includes('Stage7 Deal Beta [7102]')), true);
  assert.equal(first.storageCopies.some((copy: { diskFileId: number }) => copy.diskFileId === first.diskFileId), false);
  checks.push('one_independent_physical_copy_per_linked_deal');

  const firstDetails = await api(`/documents/${document.id}`);
  assert.equal(firstDetails.attachments[0].storageCopies.length, 2);
  assert.equal(firstDetails.attachments[0].storageCopies.every((copy: { url: string }) => copy.url.startsWith('https://thermech.bitrix24.ru/')), true);
  checks.push('deal_storage_paths_are_returned_to_the_card');

  const secondInit = await attachments.initializeFileUpload(context, document.id, {
    name: 'contract-stage7-v2.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 4,
    replacesAttachmentId: first.id,
  });
  const second = await attachments.uploadFile(
    context,
    document.id,
    secondInit.uploadId,
    bytes([5, 6, 7, 8]),
    'multipart/form-data',
  );
  assert.equal(second.version, 2);
  assert.equal(second.storageCopies.length, 2);
  assert.equal(disk.copyCalls.filter((call) => call.sourceFileId === first.diskFileId).length, 2);
  assert.equal(disk.copyCalls.filter((call) => call.sourceFileId === second.diskFileId).length, 2);
  const allCopies = await database.db.select().from(registryAttachmentCopies)
    .where(and(
      eq(registryAttachmentCopies.portalUrl, portalUrl),
      isNull(registryAttachmentCopies.deletedAt),
    ));
  assert.equal(allCopies.length, 4);
  assert.equal(new Set(allCopies.map((copy) => copy.attachmentId)).size, 2);
  checks.push('new_version_refreshes_every_deal_copy_and_keeps_one_history');

  const [gammaLink] = await database.db.insert(registryDocumentLinks).values({
    portalUrl,
    documentId: document.id,
    entityType: 'deal',
    entityId: 7103,
    entityTitle: 'Stage7 Deal Gamma',
  }).returning();
  const synchronized = await attachments.syncDealCopies(context, document.id, 7103);
  assert.equal(synchronized.created, 1);
  const synchronizedCopies = await database.db.select().from(registryAttachmentCopies)
    .where(and(
      eq(registryAttachmentCopies.attachmentId, second.id),
      eq(registryAttachmentCopies.dealId, 7103),
      isNull(registryAttachmentCopies.deletedAt),
    ));
  assert.equal(synchronizedCopies.length, 1);
  assert.equal(synchronizedCopies[0].storagePath.includes('Stage7 Deal Gamma [7103]'), true);
  checks.push('deal_link_added_after_upload_receives_its_own_copy');

  const documents = createDocumentsService({ database: database.db, bitrix: disk });
  const afterDealRemoval = await documents.removeLink(context, document.id, gammaLink.id);
  const activeGammaCopies = await database.db.select().from(registryAttachmentCopies)
    .where(and(
      eq(registryAttachmentCopies.attachmentId, second.id),
      eq(registryAttachmentCopies.dealId, 7103),
      isNull(registryAttachmentCopies.deletedAt),
    ));
  assert.equal(activeGammaCopies.length, 0);
  assert.equal(afterDealRemoval.attachments[0].storageCopies.length, 2);
  assert.equal(disk.deletedFileIds.includes(synchronizedCopies[0].diskFileId), true);
  checks.push('deal_link_removal_deletes_its_physical_copies');

  const beforeFailedAttachmentCount = await database.db.select({ id: registryAttachments.id })
    .from(registryAttachments)
    .where(eq(registryAttachments.documentId, document.id));
  disk.failCopyNumber = disk.copyCalls.length + 2;
  const failedInit = await attachments.initializeFileUpload(context, document.id, {
    name: 'contract-stage7-failed.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 4,
  });
  await assert.rejects(
    attachments.uploadFile(
      context,
      document.id,
      failedInit.uploadId,
      bytes([9, 9, 9, 9]),
      'multipart/form-data',
    ),
    /Stage7 simulated copy failure/,
  );
  const afterFailedAttachmentCount = await database.db.select({ id: registryAttachments.id })
    .from(registryAttachments)
    .where(eq(registryAttachments.documentId, document.id));
  assert.equal(afterFailedAttachmentCount.length, beforeFailedAttachmentCount.length);
  assert.equal(disk.deletedFileIds.length >= 2, true);
  checks.push('partial_copy_failure_is_compensated_before_commit');

  await attachments.softDelete(context, document.id, second.id);
  const deletedCopies = await database.db.select().from(registryAttachmentCopies)
    .where(and(
      eq(registryAttachmentCopies.attachmentId, second.id),
      isNotNull(registryAttachmentCopies.deletedAt),
    ));
  assert.equal(deletedCopies.length, 3);
  assert.equal(disk.deletedFileIds.includes(second.diskFileId), true);
  assert.equal(second.storageCopies.every((copy: { diskFileId: number }) =>
    disk.deletedFileIds.includes(copy.diskFileId)), true);
  assert.equal(disk.deletedFileIds.includes(synchronizedCopies[0].diskFileId), true);
  checks.push('attachment_delete_removes_canonical_and_deal_copies');

  const audits = await database.db.select({ event: registryAuditLog.event, metadata: registryAuditLog.metadata })
    .from(registryAuditLog)
    .where(eq(registryAuditLog.documentId, document.id));
  const uploadAudits = audits.filter((audit) => ['attachment_added', 'attachment_replaced'].includes(audit.event));
  assert.equal(uploadAudits.length, 2);
  assert.equal(uploadAudits.every((audit) =>
    (audit.metadata as { dealCopyCount?: number } | null)?.dealCopyCount === 2), true);
  checks.push('copy_count_and_deals_are_audited_per_version');

  process.stdout.write(`${JSON.stringify({ ok: true, checks }, null, 2)}\n`);
} finally {
  if (originalRootSetting && typeof originalRootSetting === 'object' && 'value' in originalRootSetting) {
    await database.db.update(registrySettings)
      .set({ value: (originalRootSetting as { value: unknown }).value, updatedAt: new Date() })
      .where(and(
        eq(registrySettings.portalUrl, portalUrl),
        eq(registrySettings.key, 'bitrix_disk_root_folder_id'),
      ))
      .catch(() => undefined);
  }
  await cleanup().catch(() => undefined);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await database.close();
}

async function api(
  path: string,
  options: { method?: string; body?: unknown } = {},
  expectedStatus = 200,
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
  const payload = await response.json().catch(() => null);
  assert.equal(response.status, expectedStatus, `${options.method || 'GET'} ${path}: ${JSON.stringify(payload)}`);
  return payload;
}

async function* bytes(values: number[]) {
  yield Uint8Array.from(values);
}

async function cleanup() {
  await database.db.delete(registryDocuments).where(and(
    eq(registryDocuments.portalUrl, portalUrl),
    like(registryDocuments.title, 'Stage7 QA%'),
  ));
  await database.db.delete(registryDocumentTypes).where(and(
    eq(registryDocumentTypes.portalUrl, portalUrl),
    like(registryDocumentTypes.name, 'Stage7 QA%'),
  ));
}
