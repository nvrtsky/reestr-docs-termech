import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { companyDealsQuerySchema, documentListQuerySchema } from './documents.schemas.js';

describe('company-scoped document queries', () => {
  it('parses an exact company filter for relation candidates', () => {
    const query = documentListQuerySchema.parse({ counterpartyId: '77' });

    assert.equal(query.counterpartyId, 77);
  });

  it('requires a positive company id for the deal list', () => {
    assert.deepEqual(companyDealsQuerySchema.parse({ companyId: '77' }), { companyId: 77 });
    assert.equal(companyDealsQuerySchema.safeParse({ companyId: '0' }).success, false);
  });
});
