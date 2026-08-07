import assert from 'node:assert/strict';
import { once } from 'node:events';

import { and, eq, inArray, like } from 'drizzle-orm';

import { createApp } from '../backend/src/app.js';
import type { BitrixApiClient } from '../backend/src/bitrix/bitrix-client.js';
import { loadConfig } from '../backend/src/config.js';
import { createDatabase } from '../backend/src/db/database.js';
import {
  registryDocumentLinks,
  registryDocuments,
  registryDocumentTypes,
  registryExchangeRates,
  registryRolePolicies,
  registrySections,
} from '../backend/src/db/schema/index.js';
import {
  CbrRatesService,
  type ExchangeRateProvider,
  type ExchangeRateQuote,
} from '../backend/src/finance/cbr-rates.service.js';

class NoopBitrixClient implements BitrixApiClient {
  normalizeDomain(value: string) { return value; }
  async call<T>(): Promise<T> { throw new Error('Unexpected Bitrix API call.'); }
  async upload<T>(): Promise<T> { throw new Error('Unexpected Bitrix upload.'); }
}

class FixedRates implements ExchangeRateProvider {
  calls: Array<{ portalUrl: string; date: string; currencies: string[] }> = [];
  private readonly rubPerUnit: Record<string, number> = {
    RUB: 1,
    USD: 90,
    EUR: 100,
    CNY: 12.5,
  };

  async getRates(portalUrl: string, date: string, currencies: string[]) {
    this.calls.push({ portalUrl, date, currencies: [...currencies].sort() });
    return new Map(currencies.map((currency) => {
      const rate = this.rubPerUnit[currency];
      assert.ok(rate, `Unexpected test currency ${currency}`);
      return [currency, {
        currency,
        nominal: 1,
        rubValue: rate,
        rubPerUnit: rate,
        rateDate: date === '2026-04-04' ? '2026-04-03' : date,
      } satisfies ExchangeRateQuote];
    }));
  }
}

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('TEST_DATABASE_URL is required.');

const portalUrl = 'https://thermech.bitrix24.ru';
const isolationPortalUrl = 'https://stage8-isolated.bitrix24.ru';
const cachePortalUrl = 'https://stage8-cache.bitrix24.ru';
const config = loadConfig({
  NODE_ENV: 'test',
  API_HOST: '127.0.0.1',
  API_PORT: '3108',
  WEB_ORIGIN: 'http://127.0.0.1:4173',
  DATABASE_URL: databaseUrl,
  DEVELOPMENT_PORTAL_URL: portalUrl,
  DEVELOPMENT_USER_ID: '501',
  DEVELOPMENT_ROLE: 'admin',
  BITRIX_ALLOWED_DOMAINS: 'thermech.bitrix24.ru',
});
const database = createDatabase(config);
const fixedRates = new FixedRates();
const app = createApp({
  config,
  database: database.db,
  bitrixClient: new NoopBitrixClient(),
  exchangeRateProvider: fixedRates,
  readinessCheck: database.checkConnection,
});
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const address = server.address();
if (!address || typeof address === 'string') throw new Error('Test server address is unavailable.');
const baseUrl = `http://127.0.0.1:${address.port}/api/v1/registry`;
const checks: string[] = [];
let originalSalesPolicy: typeof registryRolePolicies.$inferSelect | null = null;

try {
  await cleanup();
  const [storedPolicy] = await database.db.select().from(registryRolePolicies)
    .where(and(
      eq(registryRolePolicies.portalUrl, portalUrl),
      eq(registryRolePolicies.roleCode, 'sales'),
    ))
    .limit(1);
  assert.ok(storedPolicy, 'Seed sales policy is required for stage 8 verification.');
  originalSalesPolicy = storedPolicy || null;

  const type = await api('/types', 'admin', {
    method: 'POST',
    body: {
      sectionCode: 'client',
      name: 'Stage8 QA Financial Summary',
      lifecycleCode: 'simple',
      contentRequired: false,
      fields: [],
    },
  }, 201);
  const inputs = [
    ['Stage8 QA RUB', '2026-04-01', '1000.00', 'RUB'],
    ['Stage8 QA USD', '2026-04-02', '100.00', 'USD'],
    ['Stage8 QA EUR weekend', '2026-04-04', '50.00', 'EUR'],
    ['Stage8 QA empty amount', '2026-04-04', null, null],
  ] as const;
  const documents = [];
  for (const [title, documentDate, amount, currency] of inputs) {
    const document = await api('/documents', 'admin', {
      method: 'POST',
      body: {
        sectionCode: 'client',
        typeCode: type.code,
        number: title.replace('Stage8 QA ', 'S8-'),
        title,
        documentDate,
        amount,
        currency,
        responsibleId: 501,
        responsibleName: 'Stage8 QA',
        links: [],
        taskLinks: [],
        fields: {},
      },
    }, 201);
    documents.push(await api(`/documents/${document.id}/finalize`, 'admin', { method: 'POST' }));
  }
  await database.db.insert(registryDocumentLinks).values(documents.map((document) => ({
    portalUrl,
    documentId: document.id,
    entityType: 'deal' as const,
    entityId: 8101,
    entityTitle: 'Stage8 QA Deal',
    dealClosed: false,
    // The production rule intentionally uses a zero-TTL deal-state check.
    // Development-role tests have no Bitrix token to refresh it, so keep the
    // synthetic open state valid for the duration of this isolated request.
    dealStateCheckedAt: new Date(Date.now() + 60_000),
  })));

  const [foreignSection] = await database.db.insert(registrySections).values({
    portalUrl: isolationPortalUrl,
    code: 'stage8_client',
    name: 'Stage8 isolated',
    color: '#000000',
  }).returning();
  const [foreignType] = await database.db.insert(registryDocumentTypes).values({
    portalUrl: isolationPortalUrl,
    sectionId: foreignSection.id,
    code: 'stage8_foreign',
    name: 'Stage8 foreign',
    contentRequired: false,
  }).returning();
  const [foreignDocument] = await database.db.insert(registryDocuments).values({
    portalUrl: isolationPortalUrl,
    sectionId: foreignSection.id,
    typeId: foreignType.id,
    number: 'S8-FOREIGN',
    title: 'Stage8 QA foreign tenant amount',
    documentDate: '2026-04-01',
    amount: '999999.00',
    currency: 'RUB',
    status: 'draft',
    responsibleId: 501,
    createdBy: 501,
  }).returning();
  await database.db.insert(registryDocumentLinks).values({
    portalUrl: isolationPortalUrl,
    documentId: foreignDocument.id,
    entityType: 'deal',
    entityId: 8101,
    entityTitle: 'Stage8 foreign deal',
  });

  const rub = await api('/documents/deal/8101/financial-summary?currency=RUB', 'admin');
  assert.equal(rub.total, '15000.00');
  assert.equal(rub.documentCount, 4);
  assert.equal(rub.zeroAmountCount, 1);
  assert.equal(rub.details.find((row: { title: string }) => row.title.includes('weekend')).rateDate, '2026-04-03');
  assert.equal(rub.details.find((row: { emptyAmount: boolean }) => row.emptyAmount).convertedAmount, '0.00');
  assert.equal(rub.details.some((row: { title: string }) => row.title.includes('foreign tenant')), false);
  checks.push('rub_total_uses_each_document_date_and_excludes_other_portals');

  const usd = await api('/documents/deal/8101/financial-summary?currency=USD', 'admin');
  assert.equal(usd.total, '166.67');
  assert.equal(usd.details.find((row: { originalCurrency: string }) => row.originalCurrency === 'EUR').targetRate, '90.00000000');
  checks.push('selected_target_currency_has_auditable_cross_rate_breakdown');

  await database.db.update(registryRolePolicies).set({
    visibleSectionCodes: [...new Set([...(storedPolicy.visibleSectionCodes || []), 'client'])],
    visibleTypeCodes: null,
    hideMoney: false,
    hiddenFields: (storedPolicy.hiddenFields || []).filter((field) => !['amount', 'currency'].includes(field)),
    permissions: {
      ...storedPolicy.permissions,
      byType: {
        ...(storedPolicy.permissions.byType || {}),
        [type.code]: {
          view: true,
          create: true,
          edit: true,
          transition: true,
          content: true,
          archive: true,
          restore: true,
          export: true,
          finance: false,
        },
      },
    },
    updatedAt: new Date(),
  }).where(eq(registryRolePolicies.id, storedPolicy.id));
  const denied = await rawApi('/documents/deal/8101/financial-summary?currency=RUB', 'sales');
  assert.equal(denied.status, 403);
  const deniedPayload = await denied.json();
  assert.equal(deniedPayload.error.code, 'deal_financial_summary_access_denied');
  assert.equal(JSON.stringify(deniedPayload).includes('15000'), false);
  assert.equal(JSON.stringify(deniedPayload).includes('originalAmount'), false);
  checks.push('finance_denial_hides_total_details_and_rates_without_partial_leak');

  const invalidCurrency = await rawApi('/documents/deal/8101/financial-summary?currency=GBP', 'admin');
  assert.equal(invalidCurrency.status, 400);
  checks.push('target_currency_is_allowlisted');

  let fetchCount = 0;
  const cbr = new CbrRatesService(database.db, async () => {
    fetchCount += 1;
    return new Response(`<?xml version="1.0"?><ValCurs Date="03.04.2026">
      <Valute ID="USD"><CharCode>USD</CharCode><Nominal>1</Nominal><Value>90,0000</Value></Valute>
      <Valute ID="EUR"><CharCode>EUR</CharCode><Nominal>1</Nominal><Value>100,0000</Value></Valute>
    </ValCurs>`, { status: 200, headers: { 'content-type': 'application/xml' } });
  });
  const cachedFirst = await cbr.getRates(cachePortalUrl, '2026-04-04', ['RUB', 'USD']);
  const cachedSecond = await cbr.getRates(cachePortalUrl, '2026-04-04', ['USD', 'RUB']);
  assert.equal(fetchCount, 1);
  assert.equal(cachedFirst.get('USD')?.rateDate, '2026-04-03');
  assert.equal(cachedSecond.get('USD')?.rubPerUnit, 90);
  await cbr.getRates(isolationPortalUrl, '2026-04-04', ['RUB', 'USD']);
  assert.equal(fetchCount, 2);
  checks.push('official_rate_cache_is_reused_and_portal_isolated');

  assert.equal(fixedRates.calls.some((call) => call.date === '2026-04-04'), true);
  checks.push('rate_provider_receives_original_document_dates');

  process.stdout.write(`${JSON.stringify({ ok: true, checks }, null, 2)}\n`);
} finally {
  if (originalSalesPolicy) {
    await database.db.update(registryRolePolicies).set({
      roleName: originalSalesPolicy.roleName,
      visibleSectionCodes: originalSalesPolicy.visibleSectionCodes,
      visibleTypeCodes: originalSalesPolicy.visibleTypeCodes,
      hiddenFields: originalSalesPolicy.hiddenFields,
      permissions: originalSalesPolicy.permissions,
      hideMoney: originalSalesPolicy.hideMoney,
      isActive: originalSalesPolicy.isActive,
      updatedAt: originalSalesPolicy.updatedAt,
    }).where(eq(registryRolePolicies.id, originalSalesPolicy.id)).catch(() => undefined);
  }
  await cleanup().catch(() => undefined);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await database.close();
}

async function api(
  path: string,
  role: string,
  options: { method?: string; body?: unknown } = {},
  expectedStatus = 200,
) {
  const response = await rawApi(path, role, options);
  const payload = await response.json().catch(() => null);
  assert.equal(response.status, expectedStatus, `${options.method || 'GET'} ${path}: ${JSON.stringify(payload)}`);
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
  await database.db.delete(registryDocuments).where(like(registryDocuments.title, 'Stage8 QA%'));
  await database.db.delete(registryDocumentTypes).where(like(registryDocumentTypes.name, 'Stage8 QA%'));
  await database.db.delete(registryDocumentTypes).where(eq(registryDocumentTypes.portalUrl, isolationPortalUrl));
  await database.db.delete(registrySections).where(eq(registrySections.portalUrl, isolationPortalUrl));
  await database.db.delete(registryExchangeRates).where(
    inArray(registryExchangeRates.portalUrl, [cachePortalUrl, isolationPortalUrl]),
  );
}
