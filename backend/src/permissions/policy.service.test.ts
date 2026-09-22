import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  isMoneyHidden,
  isTypePermissionAllowed,
  isTypePermissionGranted,
} from './policy.service.js';
import { closedDealState, hasWritableDealState } from './sales-deal-access.service.js';

function policy(byType: Record<string, Record<string, boolean>> = {}) {
  return {
    roleCode: 'sales',
    hiddenFields: ['amount', 'currency'],
    hideMoney: true,
    permissions: { byType },
  } as never;
}

describe('type permission matrix', () => {
  it('uses the common permission when a type has no override', () => {
    const current = policy();
    assert.equal(isTypePermissionGranted(current, 'client_contract', 'create', true), true);
    assert.equal(isTypePermissionGranted(current, 'client_contract', 'create', false), false);
  });

  it('authoritatively denies a configured action', () => {
    const current = policy({ client_contract: { view: false } });
    assert.equal(isTypePermissionAllowed(current, 'client_contract', 'view'), false);
    assert.equal(isTypePermissionAllowed(current, 'client_invoice', 'view'), true);
  });

  it('can explicitly grant a non-scoped action for one type', () => {
    const current = policy({ client_contract: { export: true } });
    assert.equal(isTypePermissionGranted(current, 'client_contract', 'export', false), true);
    assert.equal(isTypePermissionGranted(current, 'client_invoice', 'export', false), false);
  });

  it('uses the legacy content permission for both split content actions', () => {
    const current = policy({ client_contract: { content: false } });
    assert.equal(isTypePermissionAllowed(current, 'client_contract', 'contentRead'), false);
    assert.equal(isTypePermissionAllowed(current, 'client_contract', 'contentWrite'), false);
  });

  it('allows download while denying content changes', () => {
    const current = policy({
      client_contract: { contentRead: true, contentWrite: false },
    });
    assert.equal(isTypePermissionAllowed(current, 'client_contract', 'contentRead'), true);
    assert.equal(isTypePermissionAllowed(current, 'client_contract', 'contentWrite'), false);
  });

  it('uses the finance override before common hidden fields', () => {
    const visible = policy({ client_contract: { finance: true } });
    const hidden = policy({ client_contract: { finance: false } });
    assert.equal(isMoneyHidden(visible, 'client_contract'), false);
    assert.equal(isMoneyHidden(hidden, 'client_contract'), true);
    assert.equal(isMoneyHidden(visible, 'client_invoice'), true);
  });
});

describe('Bitrix deal state normalization', () => {
  it('recognizes successful and failed terminal states as closed', () => {
    assert.equal(closedDealState({ CLOSED: 'Y' }), true);
    assert.equal(closedDealState({ STAGE_SEMANTIC_ID: 'S' }), true);
    assert.equal(closedDealState({ STAGE_SEMANTIC_ID: 'F' }), true);
  });

  it('recognizes an active state and preserves unknown state', () => {
    assert.equal(closedDealState({ CLOSED: 'N' }), false);
    assert.equal(closedDealState({ STAGE_SEMANTIC_ID: 'P' }), false);
    assert.equal(closedDealState({}), null);
  });
});

describe('sales document write access', () => {
  const checkedAfter = new Date('2026-09-22T09:00:00.000Z');
  const checkedAt = new Date('2026-09-22T09:01:00.000Z');

  it('allows changes when at least one accessible deal is confirmed open', () => {
    assert.equal(hasWritableDealState([
      { entityId: 11, dealClosed: true, dealStateCheckedAt: checkedAt },
      { entityId: 12, dealClosed: false, dealStateCheckedAt: checkedAt },
    ], new Set([11, 12]), checkedAfter), true);
  });

  it('keeps closed, unknown, stale, and inaccessible deals read-only', () => {
    assert.equal(hasWritableDealState([
      { entityId: 11, dealClosed: true, dealStateCheckedAt: checkedAt },
      { entityId: 12, dealClosed: null, dealStateCheckedAt: checkedAt },
      { entityId: 13, dealClosed: false, dealStateCheckedAt: new Date('2026-09-22T08:59:00.000Z') },
      { entityId: 14, dealClosed: false, dealStateCheckedAt: checkedAt },
    ], new Set([11, 12, 13]), checkedAfter), false);
  });
});
