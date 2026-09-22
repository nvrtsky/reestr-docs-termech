import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BitrixClient } from './bitrix-client.js';

test('marketplace mode accepts official cloud portals', () => {
  const client = new BitrixClient([], 1_000, 1_000, true);
  assert.equal(client.normalizeDomain('https://example.bitrix24.ru/'), 'example.bitrix24.ru');
  assert.equal(client.normalizeDomain('company.bitrix24.com'), 'company.bitrix24.com');
});

test('marketplace mode rejects arbitrary hosts and IP addresses', () => {
  const client = new BitrixClient([], 1_000, 1_000, true);
  assert.throws(() => client.normalizeDomain('evil.example.com'));
  assert.throws(() => client.normalizeDomain('127.0.0.1'));
  assert.throws(() => client.normalizeDomain('portal.bitrix24.ru.evil.example'));
});

test('local mode keeps the explicit portal allowlist', () => {
  const client = new BitrixClient(['thermech.bitrix24.ru'], 1_000);
  assert.equal(client.normalizeDomain('thermech.bitrix24.ru'), 'thermech.bitrix24.ru');
  assert.throws(() => client.normalizeDomain('another.bitrix24.ru'));
});
