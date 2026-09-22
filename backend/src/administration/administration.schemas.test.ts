import assert from 'node:assert/strict';
import test from 'node:test';

import {
  previewRegistryRulesSchema,
  updateRegistryRulesSchema,
} from './administration.schemas.js';

test('registry rules preview does not require confirmation', () => {
  const parsed = previewRegistryRulesSchema.parse({
    expectedVersion: 4,
    responsibilityMode: 'all_deal_owners',
  });

  assert.equal(parsed.expectedVersion, 4);
  assert.equal(parsed.responsibilityMode, 'all_deal_owners');
});

test('registry rules update requires explicit apply-to-all confirmation', () => {
  assert.equal(updateRegistryRulesSchema.safeParse({
    expectedVersion: 4,
    responsibilityMode: 'manual',
  }).success, false);
  assert.equal(updateRegistryRulesSchema.safeParse({
    expectedVersion: 4,
    responsibilityMode: 'manual',
    confirmApplyToAll: false,
  }).success, false);

  const parsed = updateRegistryRulesSchema.parse({
    expectedVersion: 4,
    responsibilityMode: 'manual',
    confirmApplyToAll: true,
  });
  assert.equal(parsed.confirmApplyToAll, true);
});
