import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { findMissingRequiredFields, isEmptyRequiredValue } from './documents.service.js';

const fields = [
  { id: 'text-id', key: 'subject', dataType: 'text' },
  { id: 'amount-id', key: 'amount', dataType: 'money' },
  { id: 'file-id', key: 'signed_copy', dataType: 'file' },
];

describe('required document state validation', () => {
  it('uses stored values when an update omits required fields', () => {
    const missing = findMissingRequiredFields(
      fields,
      [
        { fieldDefinitionId: 'text-id', value: 'Поставка' },
        { fieldDefinitionId: 'amount-id', value: 0 },
      ],
      ['file-id'],
      { unrelated: 'value' },
    );

    assert.deepEqual(missing, { values: [], files: [] });
  });

  it('rejects a save when a newly required stored field is absent', () => {
    const missing = findMissingRequiredFields(
      fields,
      [{ fieldDefinitionId: 'amount-id', value: 10 }],
      ['file-id'],
      { unrelated: 'value' },
    );

    assert.deepEqual(missing, { values: ['subject'], files: [] });
  });

  it('applies submitted values over stored values and treats whitespace as empty', () => {
    const missing = findMissingRequiredFields(
      fields,
      [
        { fieldDefinitionId: 'text-id', value: 'Поставка' },
        { fieldDefinitionId: 'amount-id', value: 10 },
      ],
      [],
      { subject: '   ' },
    );

    assert.deepEqual(missing, { values: ['subject'], files: ['signed_copy'] });
  });

  it('distinguishes zero from an empty required value', () => {
    assert.equal(isEmptyRequiredValue('   '), true);
    assert.equal(isEmptyRequiredValue([]), true);
    assert.equal(isEmptyRequiredValue(0), false);
    assert.equal(isEmptyRequiredValue(false), false);
  });
});
