import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { documentReleaseSchema } from './document-releases.schemas.js';

describe('document release contract', () => {
  it('keeps constructor IDs as strings and rejects numeric CRM identity fields', () => {
    const valid = release({
      source: 'kp_constructor',
      externalDocumentId: '93fe60d8-31c3-4a4a-8468-40209d874f1c',
    });
    assert.equal(documentReleaseSchema.parse(valid).externalDocumentId, valid.externalDocumentId);
    assert.throws(() => documentReleaseSchema.parse({
      ...valid,
      externalEntityTypeId: 31,
      externalEntityId: 42,
    }));
  });

  it('requires smart invoice string and numeric identities to match', () => {
    const valid = release({
      source: 'bitrix_smart_invoice',
      externalDocumentId: '42',
      externalEntityTypeId: 31,
      externalEntityId: 42,
    });
    assert.equal(documentReleaseSchema.parse(valid).externalEntityId, 42);
    assert.throws(() => documentReleaseSchema.parse({ ...valid, externalDocumentId: '43' }));
  });

  it('rejects user tokens in the permanent internal link', () => {
    assert.throws(() => documentReleaseSchema.parse(release({
      internalUrl: 'https://kp.example.test/documents/42?access_token=secret',
    })));
  });

  it('requires amount and currency together', () => {
    assert.throws(() => documentReleaseSchema.parse(release({
      document: { ...release().document, amount: '100.00', currency: null },
    })));
  });
});

function release(overrides: Record<string, unknown> = {}) {
  const pdf = Buffer.from('%PDF-test');
  return {
    portalUrl: 'https://tenant.bitrix24.ru',
    source: 'kp_constructor',
    externalDocumentId: '93fe60d8-31c3-4a4a-8468-40209d874f1c',
    versionId: 'version-1',
    releasedAt: '2026-09-22T12:00:00.000Z',
    document: {
      number: 'КП-42',
      title: 'Коммерческое предложение КП-42',
      documentDate: '2026-09-22',
      amount: '100.00',
      currency: 'RUB',
      counterpartyId: 7,
      counterpartyName: 'ООО Ромашка',
      responsibleId: 5,
      responsibleName: 'Менеджер',
    },
    crm: { company: { id: 7, title: 'ООО Ромашка' }, deals: [] },
    internalUrl: 'https://kp.example.test/documents/kp-42',
    pdf: {
      name: 'kp-42.pdf',
      mimeType: 'application/pdf',
      sizeBytes: pdf.length,
      sha256: '0'.repeat(64),
      contentBase64: pdf.toString('base64'),
    },
    ...overrides,
  };
}
