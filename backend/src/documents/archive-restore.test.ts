import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { resolveLegacyArchiveRestoreStatus } from './documents.service.js';

const lifecycle = {
  initialStatus: 'draft',
  states: [
    { code: 'draft' },
    { code: 'signed' },
    { code: 'archived', terminal: true },
  ],
};

describe('legacy archived lifecycle recovery', () => {
  it('restores the state recorded immediately before archived', () => {
    assert.equal(resolveLegacyArchiveRestoreStatus([
      { before: { status: 'signed' }, after: { status: 'archived' } },
      { before: { status: 'draft' }, after: { status: 'signed' } },
    ], lifecycle), 'signed');
  });

  it('falls back to the lifecycle initial state for incomplete legacy history', () => {
    assert.equal(resolveLegacyArchiveRestoreStatus([
      { before: null, after: { status: 'archived' } },
    ], lifecycle), 'draft');
  });
});
