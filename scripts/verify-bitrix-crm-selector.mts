import assert from 'node:assert/strict';

import {
  constrainCrmSelection,
  normalizeSelection,
  selectCrmEntities,
} from '../frontend/src/bitrix-crm-selector.ts';

assert.deepEqual(
  normalizeSelection({
    deal: [{ id: 'D_17', title: 'Поставка' }],
    company: [{ id: 'CO_9', title: 'Контрагент' }],
  }),
  [
    { entityType: 'deal', entityId: 17, entityTitle: 'Поставка' },
    { entityType: 'company', entityId: 9, entityTitle: 'Контрагент' },
  ],
);

assert.deepEqual(
  normalizeSelection({
    deal: { D_18: { ID: 'D_18', TITLE: 'Монтаж' } },
    company: { entityId: 10, entityTitle: 'Поставщик' },
  }),
  [
    { entityType: 'deal', entityId: 18, entityTitle: 'Монтаж' },
    { entityType: 'company', entityId: 10, entityTitle: 'Поставщик' },
  ],
);

assert.deepEqual(
  normalizeSelection({
    deal: { items: { first: { entity_id: 'D_19', name: 'Сервис' } } },
    company: null,
  }),
  [{ entityType: 'deal', entityId: 19, entityTitle: 'Сервис' }],
);

const oldCompany = { entityType: 'company' as const, entityId: 9, entityTitle: 'Старая компания' };
const newCompany = { entityType: 'company' as const, entityId: 10, entityTitle: 'Новая компания' };
assert.deepEqual(
  constrainCrmSelection([oldCompany, newCompany], { deal: [], company: [9] }, false),
  [newCompany],
  'single company selector must replace the preselected company',
);
assert.deepEqual(
  constrainCrmSelection([newCompany, oldCompany], { deal: [], company: [9] }, false),
  [newCompany],
  'single company replacement must not depend on callback order',
);
assert.deepEqual(
  constrainCrmSelection([oldCompany], { deal: [], company: [9] }, false),
  [oldCompany],
  'cancelling without a replacement must preserve the current company',
);

const deals = [
  { entityType: 'deal' as const, entityId: 17, entityTitle: 'Поставка' },
  { entityType: 'deal' as const, entityId: 18, entityTitle: 'Монтаж' },
  { entityType: 'deal' as const, entityId: 19, entityTitle: 'Сервис' },
];
assert.deepEqual(
  constrainCrmSelection(deals, { deal: [17], company: [] }, true),
  deals,
  'multiple deal selector must preserve every selected deal',
);

let sdkOptions: unknown;
(globalThis as typeof globalThis & { window: unknown }).window = {
  BX24: {
    init(callback: () => void) { callback(); },
    selectCRM(options: unknown, callback: (result: unknown) => void) {
      sdkOptions = options;
      callback({ company: [oldCompany, newCompany] });
    },
  },
  setTimeout,
  clearTimeout,
};
assert.deepEqual(
  await selectCrmEntities({ deal: [], company: [9] }, ['company'], false),
  [newCompany],
  'the complete Bitrix24 selector path must return the replacement company',
);
assert.deepEqual(
  sdkOptions,
  {
    entityType: ['company'],
    multiple: false,
    value: { deal: [], company: [9] },
  },
  'the company picker must request a single selection from Bitrix24',
);

console.log('Bitrix24 CRM selector normalization: OK');
