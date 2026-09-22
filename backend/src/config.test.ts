import assert from 'node:assert/strict';
import { test } from 'node:test';

import { loadConfig } from './config.js';

test('accepts the root Marketplace placement path', () => {
  const config = loadConfig({ BITRIX_APP_PATH: '/' });
  assert.equal(config.BITRIX_APP_PATH, '/');
});

test('rejects ambiguous placement paths', () => {
  assert.throws(() => loadConfig({ BITRIX_APP_PATH: 'registry/' }));
  assert.throws(() => loadConfig({ BITRIX_APP_PATH: '/registry' }));
  assert.throws(() => loadConfig({ BITRIX_APP_PATH: '//registry/' }));
});
