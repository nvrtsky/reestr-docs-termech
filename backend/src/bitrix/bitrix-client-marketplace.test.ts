import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BitrixClient } from './bitrix-client.js';

test('marketplace mode accepts official cloud portals', () => {
  const client = new BitrixClient([], 1_000, 1_000, true);
  assert.equal(client.normalizeDomain('https://example.bitrix24.ru/'), 'example.bitrix24.ru');
  assert.equal(client.normalizeDomain('company.bitrix24.com'), 'company.bitrix24.com');
});

test('marketplace mode accepts box portals but rejects IP literals', () => {
  const client = new BitrixClient([], 1_000, 1_000, true);
  assert.equal(client.normalizeDomain('portal.example.com'), 'portal.example.com');
  assert.throws(() => client.normalizeDomain('127.0.0.1'));
});

test('marketplace mode rejects box portals on private networks before fetch', async () => {
  const client = new BitrixClient([], 1_000, 1_000, true, async () => ['127.0.0.1']);
  await assert.rejects(
    client.call('portal.example.com', 'secret', 'scope'),
    (error: unknown) => error instanceof Error && error.message.includes('public network'),
  );
});

test('local mode keeps the explicit portal allowlist', () => {
  const client = new BitrixClient(['thermech.bitrix24.ru'], 1_000);
  assert.equal(client.normalizeDomain('thermech.bitrix24.ru'), 'thermech.bitrix24.ru');
  assert.throws(() => client.normalizeDomain('another.bitrix24.ru'));
});
