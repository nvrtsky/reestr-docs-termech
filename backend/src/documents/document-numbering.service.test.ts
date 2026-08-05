import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  documentNumberUniquenessKey,
  validateNumberingConfiguration,
} from './document-numbering.service.js';

describe('document numbering configuration', () => {
  it('requires a sequence token for automatic numbering', () => {
    assert.equal(
      validateNumberingConfiguration({
        numberFormat: '{TYPE}-{YYYY}',
        numberAutoGenerate: true,
      }),
      'Автоматический формат должен содержать {SEQ} или {SEQ:N}.',
    );
    assert.equal(
      validateNumberingConfiguration({
        numberFormat: '{TYPE}-{YYYY}-{SEQ:4}',
        numberAutoGenerate: true,
      }),
      null,
    );
  });

  it('rejects unknown and repeated sequence placeholders', () => {
    assert.match(
      validateNumberingConfiguration({
        numberFormat: '{UNKNOWN}-{SEQ}',
        numberAutoGenerate: false,
      }) ?? '',
      /неизвестный/i,
    );
    assert.match(
      validateNumberingConfiguration({
        numberFormat: '{SEQ}-{SEQ:3}',
        numberAutoGenerate: false,
      }) ?? '',
      /только один раз/i,
    );
  });

  it('normalizes uniqueness inside company scope', () => {
    assert.equal(
      documentNumberUniquenessKey('  ДС-001  ', 42),
      documentNumberUniquenessKey('дс-001', 42),
    );
    assert.notEqual(
      documentNumberUniquenessKey('ДС-001', 42),
      documentNumberUniquenessKey('ДС-001', 43),
    );
  });
});
