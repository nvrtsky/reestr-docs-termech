import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ApiError } from '../http/api-error.js';
import { authorizeDocumentRelease } from './document-releases.router.js';
import { canonicalPortalUrl, isReleaseStale } from './document-releases.service.js';

describe('document release service boundary', () => {
  const tokens = {
    'https://one.bitrix24.ru': 'one-portal-token-that-is-long-enough',
    'https://two.bitrix24.ru': 'two-portal-token-that-is-long-enough',
  };

  it('binds every service token to one exact portal', () => {
    assert.equal(
      authorizeDocumentRelease(
        'https://one.bitrix24.ru',
        `Bearer ${tokens['https://one.bitrix24.ru']}`,
        tokens,
      ),
      'https://one.bitrix24.ru',
    );
    assert.throws(
      () => authorizeDocumentRelease(
        'https://two.bitrix24.ru',
        `Bearer ${tokens['https://one.bitrix24.ru']}`,
        tokens,
      ),
      (error: unknown) => error instanceof ApiError && error.status === 401,
    );
  });

  it('accepts only an exact HTTPS portal origin', () => {
    assert.equal(canonicalPortalUrl('https://ONE.bitrix24.ru/'), 'https://one.bitrix24.ru');
    assert.throws(() => canonicalPortalUrl('https://one.bitrix24.ru/rest/'));
    assert.throws(() => canonicalPortalUrl('http://one.bitrix24.ru'));
  });

  it('keeps an equal or older delayed release from becoming current', () => {
    const latest = new Date('2026-09-22T12:00:00.000Z');
    assert.equal(isReleaseStale(latest, new Date('2026-09-22T11:59:59.000Z')), true);
    assert.equal(isReleaseStale(latest, new Date('2026-09-22T12:00:00.000Z')), true);
    assert.equal(isReleaseStale(latest, new Date('2026-09-22T12:00:01.000Z')), false);
    assert.equal(isReleaseStale(undefined, new Date('2026-09-22T12:00:00.000Z')), false);
  });
});
