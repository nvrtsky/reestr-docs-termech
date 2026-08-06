import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { rolePolicyCapabilities } from './system-roles.js';

describe('system role policy capabilities', () => {
  it('keeps the Bitrix24 administrator fully read-only', () => {
    assert.deepEqual(rolePolicyCapabilities('admin'), {
      isSystem: true,
      canEditPolicy: false,
      canEditName: false,
      canDelete: false,
      fixedName: 'Администратор',
      systemNote: 'Администраторы Bitrix24 получают полный доступ автоматически. Права роли фиксированы.',
    });
  });

  it('allows sales policy edits but preserves its identity and mandatory rule', () => {
    const capabilities = rolePolicyCapabilities('sales');
    assert.equal(capabilities.isSystem, true);
    assert.equal(capabilities.canEditPolicy, true);
    assert.equal(capabilities.canEditName, false);
    assert.equal(capabilities.canDelete, false);
    assert.equal(capabilities.fixedName, 'Менеджер продаж');
    assert.match(capabilities.systemNote || '', /закрытия всех связанных сделок/);
  });

  it('leaves a custom role fully configurable', () => {
    assert.deepEqual(rolePolicyCapabilities('custom_logistics'), {
      isSystem: false,
      canEditPolicy: true,
      canEditName: true,
      canDelete: true,
      fixedName: null,
      systemNote: null,
    });
  });
});
