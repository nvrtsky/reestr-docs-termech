import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { and, eq } from 'drizzle-orm';

import type { BitrixApiClient } from '../bitrix/bitrix-client.js';
import { loadConfig } from '../config.js';
import { createDatabase } from '../db/database.js';
import {
  registryDocumentLinks,
  registryDocuments,
  registryDocumentTypeSections,
  registryDocumentTypes,
  registryLifecycles,
  registrySections,
} from '../db/schema/index.js';
import { ApiError } from '../http/api-error.js';
import type { RegistryContext } from '../http/registry-context.js';
import { CrmEntityAccessService } from './crm-entity-access.service.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const portalDomain = 'crm-acl.bitrix24.test';
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
  constructor(
    private readonly allowedDeals: number[],
    private readonly allowedCompanies: number[],
    private readonly fail = false,
  ) {}

  normalizeDomain(value: string) {
    return value;
  }

  async call<T>(_domain: string, _token: string, method: string, params: object = {}): Promise<T> {
    if (this.fail) throw new Error('Bitrix ACL test failure.');
    const requested = new Set(
      (((params as { filter?: { '@ID'?: number[] } }).filter?.['@ID']) ?? []).map(Number),
    );
    const allowed = method === 'crm.deal.list'
      ? this.allowedDeals
      : (method === 'crm.company.list' ? this.allowedCompanies : null);
    if (!allowed) throw new Error(`Unexpected method ${method}.`);
    return allowed
      .filter(id => requested.has(id))
      .map(id => ({ ID: String(id) })) as T;
  }

  async upload<T>(): Promise<T> {
    throw new Error('Upload is not used by this test.');
  }
}

integration('Bitrix24 CRM entity access scope', () => {
  let documentIds: Record<string, string>;

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
      config: { initialStatus: 'draft', states: [{ code: 'draft', label: 'Черновик' }], transitions: [] },
    }).returning({ id: registryLifecycles.id });
    const [type] = await database!.db.insert(registryDocumentTypes).values({
      portalUrl,
      sectionId: section.id,
      lifecycleId: lifecycle.id,
      code: 'test_type',
      name: 'Тестовый тип',
    }).returning({ id: registryDocumentTypes.id });
    await database!.db.insert(registryDocumentTypeSections).values({
      portalUrl,
      typeId: type.id,
      sectionId: section.id,
    });

    const rows = await database!.db.insert(registryDocuments).values([
      documentValue('unlinked', null, section.id, type.id),
      documentValue('allowed deal', null, section.id, type.id),
      documentValue('denied deal', null, section.id, type.id),
      documentValue('allowed company', 21, section.id, type.id),
      documentValue('denied company', 22, section.id, type.id),
      documentValue('mixed denied', 21, section.id, type.id),
    ]).returning({ id: registryDocuments.id, title: registryDocuments.title });
    documentIds = Object.fromEntries(rows.map(row => [row.title, row.id]));
    await database!.db.insert(registryDocumentLinks).values([
      linkValue(documentIds['allowed deal'], 'deal', 11),
      linkValue(documentIds['denied deal'], 'deal', 12),
      linkValue(documentIds['mixed denied'], 'deal', 12),
    ]);
  });

  after(async () => {
    await clearPortal();
    await database!.close();
  });

  it('shows unlinked documents and requires access to every linked deal and company', async () => {
    const service = new CrmEntityAccessService(
      database!.db,
      new FakeBitrixClient([11], [21]),
    );
    const scope = await service.prepare(context(501));
    assert.ok(scope);
    const visible = await database!.db
      .select({ title: registryDocuments.title })
      .from(registryDocuments)
      .where(and(eq(registryDocuments.portalUrl, portalUrl), scope!));
    assert.deepEqual(
      visible.map(row => row.title).sort(),
      ['allowed company', 'allowed deal', 'unlinked'],
    );
  });

  it('bypasses the additional scope only for a verified Bitrix24 administrator', async () => {
    const service = new CrmEntityAccessService(database!.db, new FakeBitrixClient([], []));
    const scope = await service.prepare({ ...context(502), roleCode: 'admin', roleSource: 'bitrix_admin' });
    assert.equal(scope, null);
  });

  it('fails closed when Bitrix24 access cannot be checked', async () => {
    const service = new CrmEntityAccessService(database!.db, new FakeBitrixClient([], [], true));
    await assert.rejects(
      service.prepare(context(503)),
      (error: unknown) => error instanceof ApiError
        && error.status === 503
        && error.code === 'crm_access_unavailable',
    );
  });
});

function context(userId: number): RegistryContext {
  return {
    portalUrl,
    userId,
    roleCode: 'accountant',
    roleSource: 'user',
    departmentIds: [],
    source: 'bitrix',
    bitrix: { domain: portalDomain, accessToken: `token-${userId}` },
  };
}

function documentValue(title: string, counterpartyId: number | null, sectionId: string, typeId: string) {
  return {
    portalUrl,
    sectionId,
    typeId,
    title,
    documentDate: '2026-08-05',
    counterpartyId,
    counterpartyName: counterpartyId ? `Компания #${counterpartyId}` : null,
    status: 'draft',
    responsibleId: 501,
    createdBy: 501,
  };
}

function linkValue(documentId: string, entityType: 'deal' | 'company', entityId: number) {
  return {
    portalUrl,
    documentId,
    entityType,
    entityId,
    entityTitle: `${entityType} #${entityId}`,
  };
}

async function clearPortal() {
  await database!.db.delete(registryDocuments).where(eq(registryDocuments.portalUrl, portalUrl));
  await database!.db.delete(registryDocumentTypeSections).where(eq(registryDocumentTypeSections.portalUrl, portalUrl));
  await database!.db.delete(registryDocumentTypes).where(eq(registryDocumentTypes.portalUrl, portalUrl));
  await database!.db.delete(registryLifecycles).where(eq(registryLifecycles.portalUrl, portalUrl));
  await database!.db.delete(registrySections).where(eq(registrySections.portalUrl, portalUrl));
}
