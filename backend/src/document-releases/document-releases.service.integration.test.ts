import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, describe, it } from 'node:test';

import { and, asc, eq } from 'drizzle-orm';

import type { BitrixApiClient } from '../bitrix/bitrix-client.js';
import type { PortalInstallationsService } from '../bitrix/portal-installations.service.js';
import { loadConfig } from '../config.js';
import { createDatabase } from '../db/database.js';
import {
  registryAttachments,
  registryAuditLog,
  registryDocumentLinks,
  registryDocumentReleases,
  registryDocuments,
  registryDocumentTypes,
  registryLifecycles,
  registrySections,
  registrySettings,
} from '../db/schema/index.js';
import type { DocumentReleaseInput } from './document-releases.schemas.js';
import { DocumentReleasesService } from './document-releases.service.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const portalDomain = 'release-import.bitrix24.test';
const portalUrl = `https://${portalDomain}`;
const integration = databaseUrl ? describe : describe.skip;
const config = loadConfig({
  NODE_ENV: 'test',
  DATABASE_URL: databaseUrl || undefined,
  BITRIX_ALLOWED_DOMAINS: portalDomain,
  DOCUMENT_RELEASE_TOKENS_JSON: JSON.stringify({
    [portalUrl]: 'integration-release-token-with-at-least-thirty-two-characters',
  }),
});
const database = databaseUrl ? createDatabase(config) : null;

class FakeBitrixClient implements BitrixApiClient {
  private nextId = 200;
  private uploadFolderId = 0;
  private readonly folders = new Map<number, { ID: number; NAME: string; TYPE: 'folder'; PARENT_ID: number }>();
  private readonly files = new Map<number, {
    ID: number;
    NAME: string;
    TYPE: 'file';
    PARENT_ID: number;
    SIZE: number;
    DELETED_TYPE: number;
    DETAIL_URL: string;
  }>();
  expectedPdfSize = 0;

  normalizeDomain(value: string) {
    return value;
  }

  async call<T>(_domain: string, _token: string, method: string, params: Record<string, unknown> = {}) {
    if (method === 'disk.folder.getchildren') return [] as T;
    if (method === 'disk.folder.addsubfolder') {
      const id = this.nextId++;
      const folder = {
        ID: id,
        NAME: String((params.data as { NAME: string }).NAME),
        TYPE: 'folder' as const,
        PARENT_ID: Number(params.id),
      };
      this.folders.set(id, folder);
      return folder as T;
    }
    if (method === 'disk.folder.get') return this.folders.get(Number(params.id)) as T;
    if (method === 'disk.folder.uploadfile') {
      this.uploadFolderId = Number(params.id);
      return { uploadUrl: `${portalUrl}/upload`, field: 'file' } as T;
    }
    if (method === 'disk.file.get') return this.files.get(Number(params.id)) as T;
    if (method === 'disk.file.markdeleted') {
      const file = this.files.get(Number(params.id));
      if (file) file.DELETED_TYPE = 1;
      return true as T;
    }
    throw new Error(`Unexpected Bitrix method: ${method}`);
  }

  async upload<T>(
    _domain: string,
    _uploadUrl: string,
    body: AsyncIterable<Uint8Array>,
  ) {
    for await (const _chunk of body) {
      // Consume the stream to cover the same contract as the production client.
    }
    const id = this.nextId++;
    const file = {
      ID: id,
      NAME: `release-${id}.pdf`,
      TYPE: 'file' as const,
      PARENT_ID: this.uploadFolderId,
      SIZE: this.expectedPdfSize,
      DELETED_TYPE: 0,
      DETAIL_URL: `${portalUrl}/company/personal/user/1/disk/file/${id}/`,
    };
    this.files.set(id, file);
    return file as T;
  }
}

integration('released document delivery', () => {
  const bitrix = new FakeBitrixClient();
  const installations = {
    async assertActive(domain: string) {
      assert.equal(domain, portalDomain);
    },
    async accessToken(domain: string) {
      assert.equal(domain, portalDomain);
      return 'stored-installation-access-token';
    },
  } as unknown as PortalInstallationsService;
  const service = database
    ? new DocumentReleasesService(database.db, bitrix, installations, config)
    : null;

  before(async () => {
    await clearPortal();
    const [section] = await database!.db.insert(registrySections).values({
      portalUrl,
      code: 'client',
      name: 'Клиентские',
    }).returning({ id: registrySections.id });
    const [lifecycle] = await database!.db.insert(registryLifecycles).values({
      portalUrl,
      code: 'simple',
      name: 'Простой',
      config: {
        initialStatus: 'draft',
        states: [
          { code: 'draft', label: 'Черновик' },
          { code: 'archived', label: 'Архив', terminal: true },
        ],
        transitions: [],
      },
    }).returning({ id: registryLifecycles.id });
    await database!.db.insert(registryDocumentTypes).values([
      {
        portalUrl,
        sectionId: section.id,
        lifecycleId: lifecycle.id,
        code: 'client_quote',
        name: 'Коммерческое предложение',
      },
      {
        portalUrl,
        sectionId: section.id,
        lifecycleId: lifecycle.id,
        code: 'client_invoice',
        name: 'Счёт',
      },
    ]);
    await database!.db.insert(registrySettings).values({
      portalUrl,
      key: 'bitrix_disk_root_folder_id',
      value: { id: 100 },
    });
  });

  after(async () => {
    await clearPortal();
    await database!.close();
  });

  it('is idempotent, preserves manual card state, and keeps delayed versions non-current', async () => {
    const first = release({ versionId: 'v2', releasedAt: '2026-09-22T12:00:00.000Z' });
    bitrix.expectedPdfSize = Buffer.from(first.pdf.contentBase64, 'base64').length;
    const created = await service!.receive(first);
    assert.equal(created.status, 'stored');
    assert.equal(created.current, true);

    const replayed = await service!.receive(first);
    assert.equal(replayed.status, 'replayed');
    assert.equal(replayed.attachmentId, created.attachmentId);

    await database!.db.update(registryDocuments).set({
      responsibleId: 999,
      responsibleName: 'Назначен вручную',
      comment: 'Ручной комментарий',
      status: 'archived',
      deletedAt: new Date('2026-09-22T12:30:00.000Z'),
      deletedBy: 999,
    }).where(eq(registryDocuments.id, created.documentId));

    const latest = release({
      versionId: 'v3',
      releasedAt: '2026-09-22T13:00:00.000Z',
      document: { ...first.document, title: 'Актуальное КП', amount: '200.00' },
    });
    bitrix.expectedPdfSize = Buffer.from(latest.pdf.contentBase64, 'base64').length;
    const updated = await service!.receive(latest);
    assert.equal(updated.status, 'stored');
    assert.equal(updated.current, true);

    const delayed = release({
      versionId: 'v1',
      releasedAt: '2026-09-22T11:00:00.000Z',
      document: { ...first.document, title: 'Устаревшее КП', amount: '50.00' },
    });
    bitrix.expectedPdfSize = Buffer.from(delayed.pdf.contentBase64, 'base64').length;
    const storedDelayed = await service!.receive(delayed);
    assert.equal(storedDelayed.status, 'stored_stale');
    assert.equal(storedDelayed.current, false);

    const [document] = await database!.db.select().from(registryDocuments).where(
      eq(registryDocuments.id, created.documentId),
    );
    assert.equal(document.title, 'Актуальное КП');
    assert.equal(document.amount, '200.00');
    assert.equal(document.responsibleId, 999);
    assert.equal(document.responsibleName, 'Назначен вручную');
    assert.equal(document.comment, 'Ручной комментарий');
    assert.equal(document.status, 'archived');
    assert.ok(document.deletedAt);
    assert.equal(document.deletedBy, 999);

    const attachments = await database!.db
      .select({ id: registryAttachments.id, version: registryAttachments.version, current: registryAttachments.isCurrent })
      .from(registryAttachments)
      .where(and(
        eq(registryAttachments.portalUrl, portalUrl),
        eq(registryAttachments.documentId, created.documentId),
        eq(registryAttachments.kind, 'file'),
      ))
      .orderBy(asc(registryAttachments.version));
    assert.deepEqual(attachments.map(item => item.version), [1, 2, 3]);
    assert.equal(attachments.filter(item => item.current).length, 1);
    assert.equal(attachments.find(item => item.current)?.id, updated.attachmentId);

    const releases = await database!.db
      .select()
      .from(registryDocumentReleases)
      .where(eq(registryDocumentReleases.documentId, created.documentId));
    assert.equal(releases.length, 3);
  });

  it('updates the existing numeric smart-invoice card instead of duplicating it', async () => {
    const [type] = await database!.db
      .select({ id: registryDocumentTypes.id, sectionId: registryDocumentTypes.sectionId })
      .from(registryDocumentTypes)
      .where(and(
        eq(registryDocumentTypes.portalUrl, portalUrl),
        eq(registryDocumentTypes.code, 'client_invoice'),
      ));
    const [existing] = await database!.db.insert(registryDocuments).values({
      portalUrl,
      sectionId: type.sectionId,
      typeId: type.id,
      title: 'Счёт из ручной синхронизации',
      documentDate: '2026-09-20',
      status: 'draft',
      responsibleId: 777,
      responsibleName: 'Ручной ответственный',
      createdBy: 777,
      externalSource: 'bitrix_smart_invoice',
      externalEntityTypeId: 31,
      externalEntityId: 42,
    }).returning({ id: registryDocuments.id });

    const input = release({
      source: 'bitrix_smart_invoice',
      externalDocumentId: '42',
      externalEntityTypeId: 31,
      externalEntityId: 42,
      versionId: 'invoice-v1',
      document: {
        ...release().document,
        number: 'СЧ-42',
        title: 'Выпущенный счёт',
      },
    });
    bitrix.expectedPdfSize = Buffer.from(input.pdf.contentBase64, 'base64').length;
    const result = await service!.receive(input);
    assert.equal(result.documentId, existing.id);
    const cards = await database!.db.select({ id: registryDocuments.id }).from(registryDocuments).where(and(
      eq(registryDocuments.portalUrl, portalUrl),
      eq(registryDocuments.externalSource, 'bitrix_smart_invoice'),
      eq(registryDocuments.externalEntityId, 42),
    ));
    assert.equal(cards.length, 1);
    const [card] = await database!.db.select().from(registryDocuments).where(eq(registryDocuments.id, existing.id));
    assert.equal(card.externalDocumentId, '42');
    assert.equal(card.responsibleId, 777);
  });
});

function release(overrides: Partial<DocumentReleaseInput> = {}): DocumentReleaseInput {
  const pdf = Buffer.from(`%PDF-release-${String(overrides.versionId || 'v2')}`);
  const base: DocumentReleaseInput = {
    portalUrl,
    source: 'kp_constructor',
    externalDocumentId: '93fe60d8-31c3-4a4a-8468-40209d874f1c',
    versionId: 'v2',
    releasedAt: '2026-09-22T12:00:00.000Z',
    document: {
      number: 'КП-42',
      title: 'Коммерческое предложение',
      documentDate: '2026-09-22',
      amount: '100.00',
      currency: 'RUB',
      counterpartyId: 7,
      counterpartyName: 'ООО Ромашка',
      responsibleId: 5,
      responsibleName: 'Менеджер',
    },
    crm: {
      company: { id: 7, title: 'ООО Ромашка' },
      deals: [{ id: 11, title: 'Сделка 11', closed: false }],
    },
    internalUrl: 'https://kp.example.test/documents/kp-integration-42',
    pdf: {
      name: 'release.pdf',
      mimeType: 'application/pdf',
      sizeBytes: pdf.length,
      sha256: createHash('sha256').update(pdf).digest('hex'),
      contentBase64: pdf.toString('base64'),
    },
  };
  return { ...base, ...overrides } as DocumentReleaseInput;
}

async function clearPortal() {
  if (!database) return;
  await database.db.delete(registryAuditLog).where(eq(registryAuditLog.portalUrl, portalUrl));
  await database.db.delete(registryDocumentReleases).where(eq(registryDocumentReleases.portalUrl, portalUrl));
  await database.db.delete(registryAttachments).where(eq(registryAttachments.portalUrl, portalUrl));
  await database.db.delete(registryDocumentLinks).where(eq(registryDocumentLinks.portalUrl, portalUrl));
  await database.db.delete(registryDocuments).where(eq(registryDocuments.portalUrl, portalUrl));
  await database.db.delete(registryDocumentTypes).where(eq(registryDocumentTypes.portalUrl, portalUrl));
  await database.db.delete(registryLifecycles).where(eq(registryLifecycles.portalUrl, portalUrl));
  await database.db.delete(registrySections).where(eq(registrySections.portalUrl, portalUrl));
  await database.db.delete(registrySettings).where(eq(registrySettings.portalUrl, portalUrl));
}
