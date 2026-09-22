import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  deduplicateFinancialRows,
  resolveFinancialFilter,
} from './deal-financial.service.js';
import { dealFinancialSummaryQuerySchema } from '../documents/documents.schemas.js';

describe('deal financial API query', () => {
  it('parses unique section and type filters from comma-separated values', () => {
    assert.deepEqual(dealFinancialSummaryQuerySchema.parse({
      currency: 'EUR',
      sections: 'client,supplier,client',
      types: 'client_invoice,supplier_invoice',
    }), {
      currency: 'EUR',
      sections: ['client', 'supplier'],
      types: ['client_invoice', 'supplier_invoice'],
    });
  });

  it('rejects malformed filter codes', () => {
    assert.throws(() => dealFinancialSummaryQuerySchema.parse({
      sections: 'client,../secret',
    }));
  });
});

describe('deal financial filters', () => {
  it('uses every permitted value when the request does not narrow the filter', () => {
    assert.deepEqual(
      resolveFinancialFilter([], ['client', 'supplier', 'logistics']),
      ['client', 'supplier', 'logistics'],
    );
  });

  it('keeps only unique requested values that are permitted', () => {
    assert.deepEqual(
      resolveFinancialFilter(
        ['supplier', 'hidden', 'supplier', 'client'],
        ['client', 'supplier', 'logistics'],
      ),
      ['supplier', 'client'],
    );
  });

  it('returns an empty selection when none of the requested values are permitted', () => {
    assert.deepEqual(resolveFinancialFilter(['hidden'], ['client']), []);
  });
});

describe('deal financial document accounting', () => {
  it('counts each logical document once when joins return repeated rows', () => {
    assert.deepEqual(deduplicateFinancialRows([
      { id: 'one', amount: '10.00' },
      { id: 'one', amount: '10.00' },
      { id: 'two', amount: null },
    ]), [
      { id: 'one', amount: '10.00' },
      { id: 'two', amount: null },
    ]);
  });
});
