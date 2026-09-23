import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseExpirySeconds } from './portal-installations.service.js';

test('normalizes OAuth expiry values', () => {
  assert.equal(parseExpirySeconds('3600'), 3600);
  assert.equal(parseExpirySeconds(120.9), 120);
  assert.equal(parseExpirySeconds(1_700_003_600, 1_700_000_000_000), 3600);
  assert.equal(parseExpirySeconds(0), undefined);
  assert.equal(parseExpirySeconds('invalid'), undefined);
});
