import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  missingRequiredBitrixScopes,
  normalizeBitrixScopes,
} from './bitrix-scopes.js';

const baseScopes = ['crm', 'placement', 'user', 'department', 'disk', 'im'];

describe('Bitrix24 application scopes', () => {
  it('accepts the legacy task scope', () => {
    assert.deepEqual(missingRequiredBitrixScopes([...baseScopes, 'task']), []);
  });

  it('accepts the REST 3.0 tasks scope', () => {
    assert.deepEqual(missingRequiredBitrixScopes([...baseScopes, 'tasks']), []);
  });

  it('still reports task when neither task scope was granted', () => {
    assert.deepEqual(missingRequiredBitrixScopes(baseScopes), ['task']);
  });

  it('normalizes case, whitespace, duplicates, and invalid responses', () => {
    assert.deepEqual(normalizeBitrixScopes([' CRM ', 'tasks', 'TASKS']), ['crm', 'tasks']);
    assert.deepEqual(normalizeBitrixScopes(null), []);
  });
});
