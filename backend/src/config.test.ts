import assert from 'node:assert/strict';
import { test } from 'node:test';

import { loadConfig } from './config.js';

test('accepts the root Marketplace placement path', () => {
  const config = loadConfig({
    BITRIX_APP_PATH: '/',
    PUBLIC_BASE_URL: 'https://reestr.navrotsky.ru',
  });
  assert.equal(config.BITRIX_APP_PATH, '/');
  assert.equal(config.PUBLIC_BASE_URL, 'https://reestr.navrotsky.ru');
});

test('rejects ambiguous placement paths', () => {
  assert.throws(() => loadConfig({ BITRIX_APP_PATH: 'registry/' }));
  assert.throws(() => loadConfig({ BITRIX_APP_PATH: '/registry' }));
  assert.throws(() => loadConfig({ BITRIX_APP_PATH: '//registry/' }));
});

test('loads document release tokens per exact portal origin', () => {
  const config = loadConfig({
    DOCUMENT_RELEASE_TOKENS_JSON: JSON.stringify({
      'https://TENANT.bitrix24.ru/': 'release-token-with-at-least-thirty-two-characters',
    }),
  });
  assert.deepEqual(config.DOCUMENT_RELEASE_TOKENS_JSON, {
    'https://tenant.bitrix24.ru': 'release-token-with-at-least-thirty-two-characters',
  });
});

test('rejects weak release tokens and portal paths', () => {
  assert.throws(() => loadConfig({
    DOCUMENT_RELEASE_TOKENS_JSON: '{"https://tenant.bitrix24.ru":"short"}',
  }));
  assert.throws(() => loadConfig({
    DOCUMENT_RELEASE_TOKENS_JSON: JSON.stringify({
      'https://tenant.bitrix24.ru/path': 'release-token-with-at-least-thirty-two-characters',
    }),
  }));
});
