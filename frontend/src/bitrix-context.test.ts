import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { extractDeepLinkDocumentId } from './bitrix-context';

const documentId = 'c30d81a5-fefe-454e-bad7-f95fc581e385';

describe('Bitrix24 Registry deep links', () => {
  it('reads a document id from the application query', () => {
    assert.equal(extractDeepLinkDocumentId({
      search: `?document=${documentId}`,
    }), documentId);
  });

  it('reads a document id from the Bitrix24 parent referrer', () => {
    assert.equal(extractDeepLinkDocumentId({
      referrer: `https://thermech.bitrix24.ru/marketplace/app/42/?document=${documentId}`,
    }), documentId);
  });

  it('reads nested placement parameters passed by Bitrix24', () => {
    assert.equal(extractDeepLinkDocumentId({
      placementOptions: JSON.stringify({
        PLACEMENT_OPTIONS: { params: `document=${documentId}` },
      }),
    }), documentId);
  });

  it('rejects malformed and unrelated identifiers', () => {
    assert.equal(extractDeepLinkDocumentId({
      search: '?document=../../etc/passwd',
      placementOptions: { ENTITY_ID: documentId },
    }), null);
  });
});
