import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createDocumentTypeSchema } from './catalogs.schemas.js';

const baseType = {
  sectionCodes: ['client'],
  name: 'Тестовый тип',
  lifecycleCode: 'simple',
};

describe('document type select field options', () => {
  it('accepts configured non-duplicate options', () => {
    const parsed = createDocumentTypeSchema.parse({
      ...baseType,
      fields: [{
        name: 'Вид',
        dataType: 'select',
        options: ['Первый', 'Второй'],
      }],
    });
    assert.deepEqual(parsed.fields[0]?.options, ['Первый', 'Второй']);
  });

  it('rejects an empty or duplicate select dictionary', () => {
    assert.equal(createDocumentTypeSchema.safeParse({
      ...baseType,
      fields: [{ name: 'Вид', dataType: 'select', options: [] }],
    }).success, false);
    assert.equal(createDocumentTypeSchema.safeParse({
      ...baseType,
      fields: [{ name: 'Вид', dataType: 'select', options: ['Акт', 'акт'] }],
    }).success, false);
  });
});
