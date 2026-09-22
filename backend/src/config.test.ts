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
