import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appUrl = process.env.TERMECH_APP_URL || 'http://127.0.0.1:4173/';
const debuggerUrl = process.env.TERMECH_DEBUGGER_URL || 'http://127.0.0.1:9223';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const evidenceDirectory = path.join(root, 'artifacts', 'v2.1-baseline');

const permissions = {
  create: true,
  editOwn: true,
  editAny: true,
  transitionOwn: true,
  transitionAny: true,
  softDelete: true,
  restore: true,
  export: true,
  administer: true,
  byType: {},
};

const typePermissions = overrides => ({
  view: true,
  create: true,
  edit: true,
  transition: true,
  content: true,
  archive: true,
  restore: true,
  export: true,
  finance: true,
  ...overrides,
});

const sections = [
  ['client', 'Клиентские', '#6366f1'],
  ['supplier', 'Поставщик', '#0d9488'],
  ['logistics', 'Логистика', '#d97706'],
  ['customs', 'Таможня', '#dc2626'],
  ['legal', 'Юридические', '#7c3aed'],
  ['internal', 'Внутренние', '#64748b'],
].map(([code, name, color], index) => ({
  code,
  name,
  color,
  sortOrder: (index + 1) * 10,
  isActive: true,
}));

const types = [
  ['client_contract', 'client', 'Договор', false],
  ['client_invoice', 'client', 'Счёт', true],
  ['client_quote', 'client', 'Коммерческое предложение', false],
  ['supplier_contract', 'supplier', 'Договор поставщика', false],
  ['supplier_invoice', 'supplier', 'Инвойс', true],
  ['logistics_request', 'logistics', 'Заявка на перевозку', false],
  ['customs_declaration', 'customs', 'Декларация', false],
  ['legal_claim', 'legal', 'Претензия', false],
  ['internal_memo', 'internal', 'Служебная записка', false],
].map(([code, sectionCode, name, isFinancial], index) => ({
  code,
  sectionCode,
  sectionName: sections.find(section => section.code === sectionCode)?.name,
  sectionColor: sections.find(section => section.code === sectionCode)?.color,
  name,
  description: null,
  lifecycleCode: 'default',
  contentRequired: code !== 'internal_memo',
  isFinancial,
  numberFormat: code === 'client_contract' ? '{TYPE}-{YYYY}-{SEQ:4}' : null,
  numberAutoGenerate: code === 'client_contract',
  numberUniquenessEnabled: code === 'client_contract',
  fields: code === 'client_contract'
    ? [
        { key: 'contract_subject', name: 'Предмет договора', label: 'Предмет договора', dataType: 'text', options: [], isRequired: true, sortOrder: 10 },
        { key: 'signed_copy', name: 'Подписанная копия', label: 'Подписанная копия', dataType: 'file', options: [], isRequired: true, sortOrder: 20 },
      ]
    : [],
  sortOrder: (index + 1) * 10,
  isActive: true,
}));

const lifecycle = {
  code: 'default',
  name: 'Основной',
  isActive: true,
  config: {
    initialStatus: 'draft',
    states: [
      { code: 'draft', label: 'Черновик', color: '#71717a' },
      { code: 'on_review', label: 'На согласовании', color: '#b45309' },
      { code: 'signed', label: 'Подписан', color: '#15803d' },
      { code: 'archived', label: 'В архиве', color: '#71717a', terminal: true },
    ],
    transitions: [
      { from: 'draft', to: 'on_review', roles: ['admin'] },
      { from: 'on_review', to: 'signed', roles: ['admin'] },
      { from: 'signed', to: 'archived', roles: ['admin'] },
    ],
  },
};

const users = [
  { id: 1, name: 'Администратор', isBitrixAdmin: true },
  { id: 2, name: 'А. Петров', isBitrixAdmin: false },
  { id: 3, name: 'М. Смирнова', isBitrixAdmin: false },
];

const documentItems = [
  {
    id: '11111111-1111-4111-8111-111111111111',
    number: 'К-2026/45',
    title: 'Договор поставки оборудования',
    section: { code: 'client', name: 'Клиентские', color: '#6366f1' },
    type: { code: 'client_contract', name: 'Договор', lifecycleCode: 'default', isFinancial: false },
    status: 'signed',
    counterpartyId: 77,
    counterpartyName: 'ООО «Ромашка»',
    legalEntityId: null,
    legalEntityName: null,
    dealStageId: 'C1:WON',
    amount: '21000000.00',
    currency: 'RUB',
    documentDate: '2026-04-01',
    comment: 'Baseline v2.1',
    responsibleId: 2,
    responsibleName: 'А. Петров',
    createdBy: 2,
    moneyHidden: false,
    deletedAt: null,
    attachments: [{
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      kind: 'file',
      name: 'contract-equipment-v3.pdf',
      sizeBytes: 845312,
      version: 3,
      isCurrent: true,
      url: null,
      storageCopies: [{
        id: 'abababab-abab-4bab-8bab-ababababab01',
        dealId: 1234,
        dealTitle: 'Поставка оборудования',
        diskFileId: 91001,
        diskFolderId: 92001,
        storagePath: 'Клиентские / ООО «Ромашка» [77] / Поставка оборудования [1234] / Клиентские',
        url: 'https://thermech.bitrix24.ru/disk/showFile/91001/',
        createdAt: '2026-08-03T11:20:00.000Z',
      }, {
        id: 'abababab-abab-4bab-8bab-ababababab02',
        dealId: 5678,
        dealTitle: 'Монтаж и пусконаладка',
        diskFileId: 91002,
        diskFolderId: 92002,
        storagePath: 'Клиентские / ООО «Ромашка» [77] / Монтаж и пусконаладка [5678] / Клиентские',
        url: 'https://thermech.bitrix24.ru/disk/showFile/91002/',
        createdAt: '2026-08-03T11:20:00.000Z',
      }],
    }, {
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab',
      kind: 'file',
      name: 'contract-equipment-v2.pdf',
      sizeBytes: 812034,
      version: 2,
      isCurrent: false,
      url: null,
    }, {
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaac',
      kind: 'file',
      name: 'contract-equipment-v1.pdf',
      sizeBytes: 790412,
      version: 1,
      isCurrent: false,
      url: null,
    }],
    links: [
      { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', entityType: 'deal', entityId: 1234, entityTitle: 'Поставка оборудования' },
      { id: 'bcbcbcbc-bcbc-4bcb-8bcb-bcbcbcbcbcbc', entityType: 'deal', entityId: 5678, entityTitle: 'Монтаж и пусконаладка' },
      { id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', entityType: 'company', entityId: 77, entityTitle: 'ООО «Ромашка»' },
    ],
    taskLinks: [{ id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', taskId: 8801, taskTitle: 'Проверить договор' }],
    fields: [{ key: 'contract_subject', label: 'Предмет договора', dataType: 'text', value: 'Поставка линии розлива' }],
    history: [
      { event: 'archive_notifications_dispatched', actorId: 1, createdAt: '2026-08-03T12:00:00.000Z', metadata: { notificationRecipientIds: [2, 7], deliveries: [{ userId: 2, status: 'sent' }, { userId: 7, status: 'sent' }] } },
      { event: 'attachment_replaced', actorId: 2, createdAt: '2026-08-03T11:20:00.000Z' },
      { event: 'status_changed', actorId: 3, createdAt: '2026-08-02T09:10:00.000Z', before: { status: 'draft' }, after: { status: 'on_review' }, metadata: { comment: 'Передано на проверку' } },
      { event: 'document_created', actorId: 2, createdAt: '2026-08-01T08:00:00.000Z' },
    ],
  },
  {
    id: '22222222-2222-4222-8222-222222222222',
    number: 'СЧ-8842',
    title: 'Счёт на предоплату 50%',
    section: { code: 'client', name: 'Клиентские', color: '#6366f1' },
    type: { code: 'client_invoice', name: 'Счёт', lifecycleCode: 'default', isFinancial: true },
    status: 'on_review',
    counterpartyId: 77,
    counterpartyName: 'ООО «Ромашка»',
    amount: '10500000.00',
    currency: 'RUB',
    documentDate: '2026-04-12',
    responsibleId: 3,
    responsibleName: 'М. Смирнова',
    createdBy: 3,
    moneyHidden: false,
    deletedAt: null,
    attachments: [],
    links: [{ id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', entityType: 'deal', entityId: 1234, entityTitle: 'Поставка оборудования' }],
    fields: [],
    history: [],
    externalSource: 'bitrix_smart_invoice',
    externalEntityTypeId: 31,
    externalEntityId: 8842,
    externalStatus: 'DT31_1:N',
    externalUpdatedAt: '2026-08-03T12:15:00.000Z',
    externalSyncedAt: '2026-08-04T08:00:00.000Z',
  },
  {
    id: '33333333-3333-4333-8333-333333333333',
    number: 'SUP-19',
    title: 'Договор поставщика Acme Trading',
    section: { code: 'supplier', name: 'Поставщик', color: '#0d9488' },
    type: { code: 'supplier_contract', name: 'Договор поставщика', lifecycleCode: 'default', isFinancial: false },
    status: 'draft',
    counterpartyId: 91,
    counterpartyName: 'Acme Trading Ltd',
    amount: null,
    currency: null,
    documentDate: '2026-04-22',
    responsibleId: 2,
    responsibleName: 'А. Петров',
    createdBy: 2,
    moneyHidden: false,
    deletedAt: null,
    attachments: [],
    links: [],
    fields: [],
    history: [],
  },
  {
    id: '44444444-4444-4444-8444-444444444444',
    number: 'ДС-2026/45-1',
    title: 'Дополнительное соглашение №1',
    section: { code: 'client', name: 'Клиентские', color: '#6366f1' },
    type: { code: 'client_addendum', name: 'Доп. соглашение', lifecycleCode: 'default', isFinancial: false },
    status: 'signed',
    counterpartyId: 77,
    counterpartyName: 'ООО «Ромашка»',
    amount: null,
    currency: null,
    documentDate: '2026-05-10',
    responsibleId: 2,
    responsibleName: 'А. Петров',
    createdBy: 2,
    moneyHidden: false,
    deletedAt: null,
    attachments: [],
    links: [],
    taskLinks: [],
    fields: [],
    history: [{ event: 'relation_parent_added', actorId: 2, createdAt: '2026-05-10T10:00:00.000Z' }],
    externalSource: 'bitrix_quote',
    externalEntityTypeId: 7,
    externalEntityId: 491,
    externalStatus: 'SENT',
    externalUpdatedAt: '2026-08-02T09:30:00.000Z',
    externalSyncedAt: '2026-08-04T08:00:00.000Z',
  },
  {
    id: '55555555-5555-4555-8555-555555555555',
    number: 'ПР-2026/45-1',
    title: 'Приложение — спецификация оборудования',
    section: { code: 'client', name: 'Клиентские', color: '#6366f1' },
    type: { code: 'client_appendix', name: 'Приложение', lifecycleCode: 'default', isFinancial: false },
    status: 'active',
    counterpartyId: 77,
    counterpartyName: 'ООО «Ромашка»',
    amount: null,
    currency: null,
    documentDate: '2026-05-12',
    responsibleId: 2,
    responsibleName: 'А. Петров',
    createdBy: 2,
    moneyHidden: false,
    deletedAt: null,
    attachments: [],
    links: [],
    taskLinks: [],
    fields: [],
    history: [],
  },
];

const relationSummary = (item, relationType) => ({
  id: item.id,
  number: item.number,
  title: item.title,
  status: item.status,
  section: item.section,
  type: { code: item.type.code, name: item.type.name },
  relationType,
});
documentItems.forEach(item => { item.relations = { parent: null, children: [] }; });
documentItems[0].relations.children = [
  relationSummary(documentItems[3], 'addendum'),
  relationSummary(documentItems[4], 'appendix'),
];
documentItems[3].relations.parent = relationSummary(documentItems[0], 'addendum');
documentItems[4].relations.parent = relationSummary(documentItems[0], 'appendix');

const rolePolicies = [
  {
    roleCode: 'sales',
    roleName: 'Менеджер продаж',
    visibleSectionCodes: ['client', 'internal'],
    visibleTypeCodes: null,
    hiddenFields: ['amount', 'currency'],
    permissions: {
      ...permissions,
      administer: false,
      editAny: false,
      transitionAny: false,
      softDelete: false,
      restore: false,
      byType: {
        client_contract: typePermissions({ archive: false, restore: false, finance: false }),
        client_invoice: typePermissions({ edit: false, content: false, finance: false }),
        internal_memo: typePermissions({ transition: false, export: false, finance: false }),
      },
    },
    hideMoney: true,
    isActive: true,
  },
  {
    roleCode: 'accountant',
    roleName: 'Бухгалтер',
    visibleSectionCodes: ['client', 'supplier'],
    visibleTypeCodes: null,
    hiddenFields: [],
    permissions: { ...permissions, administer: false, editAny: false, byType: {} },
    hideMoney: false,
    isActive: true,
  },
];

function mockPayload(url) {
  const parsed = new URL(url);
  const pathname = parsed.pathname;
  if (pathname.endsWith('/me/policy')) {
    return {
      roleCode: 'admin',
      roleName: 'Администратор',
      userId: 1,
      visibleSectionCodes: sections.map(section => section.code),
      visibleTypeCodes: null,
      hiddenFields: [],
      permissions,
      hideMoney: false,
    };
  }
  if (pathname.endsWith('/admin/sections')) return { items: sections.map(section => ({ ...section, typeCount: types.filter(type => type.sectionCode === section.code).length })) };
  if (pathname.endsWith('/admin/types')) return {
    items: types,
    fieldLibrary: types.flatMap(type => type.fields).map(field => ({
      key: field.key,
      name: field.name,
      dataType: field.dataType,
      options: field.options,
    })),
  };
  if (pathname.endsWith('/admin/lifecycles')) return { items: [lifecycle] };
  if (pathname.endsWith('/admin/role-policies')) return { items: rolePolicies };
  if (pathname.endsWith('/admin/user-roles')) return { users, items: [{ userId: 2, userName: 'А. Петров', roleCode: 'sales' }] };
  if (pathname.endsWith('/admin/department-roles')) {
    return {
      departments: [
        { id: 10, name: 'Отдел продаж', parentId: 1, path: 'Компания / Отдел продаж' },
        { id: 20, name: 'Юридический отдел', parentId: 1, path: 'Компания / Юридический отдел' },
        { id: 30, name: 'Бухгалтерия', parentId: 1, path: 'Компания / Бухгалтерия' },
      ],
      items: [
        { departmentId: 10, roleCode: 'sales', priority: 20 },
        { departmentId: 30, roleCode: 'accountant', priority: 30 },
      ],
    };
  }
  if (pathname.endsWith('/sections')) {
    return { items: sections.map(section => ({ ...section, types: types.filter(type => type.sectionCode === section.code) })) };
  }
  if (pathname.endsWith('/lifecycles')) return { items: [lifecycle] };
  if (pathname.endsWith('/users')) return { items: users };
  if (pathname.endsWith('/saved-views')) return { items: [] };
  if (pathname.endsWith('/tasks')) return { items: [{ id: 8801, title: 'Проверить договор' }, { id: 8802, title: 'Согласовать комплект' }] };
  if (pathname.endsWith('/documents/options')) {
    return {
      scopeTotal: documentItems.length,
      archiveTotal: 0,
      sections: Object.fromEntries(sections.map(section => [section.code, documentItems.filter(item => item.section.code === section.code).length])),
      views: { all: documentItems.length, mine: 2, work: 1, draft: 1 },
      responsibles: users.slice(1).map(user => ({ id: user.id, name: user.name, count: documentItems.filter(item => item.responsibleId === user.id).length })),
    };
  }
  if (/\/documents\/deal\/\d+\/financial-summary$/.test(pathname)) {
    const targetCurrency = parsed.searchParams.get('currency') || 'RUB';
    const rubRates = { RUB: 1, USD: 90, EUR: 100, CNY: 12.5 };
    const sourceRows = [
      { documentId: 'f1000000-0000-4000-8000-000000000001', number: 'ФИН-RUB', title: 'Аванс в рублях', documentDate: '2026-04-01', amount: 1000, currency: 'RUB', rateDate: '2026-04-01' },
      { documentId: 'f1000000-0000-4000-8000-000000000002', number: 'ФИН-USD', title: 'Счёт в долларах США', documentDate: '2026-04-02', amount: 100, currency: 'USD', rateDate: '2026-04-02' },
      { documentId: 'f1000000-0000-4000-8000-000000000003', number: 'ФИН-EUR', title: 'Инвойс в евро', documentDate: '2026-04-04', amount: 50, currency: 'EUR', rateDate: '2026-04-03' },
      { documentId: 'f1000000-0000-4000-8000-000000000004', number: 'ФИН-0', title: 'Документ без суммы', documentDate: '2026-04-04', amount: null, currency: null, rateDate: null },
    ];
    const details = sourceRows.map(row => {
      const emptyAmount = row.amount === null;
      const conversionRate = emptyAmount ? null : rubRates[row.currency] / rubRates[targetCurrency];
      const convertedAmount = emptyAmount ? 0 : Math.round(row.amount * conversionRate * 100) / 100;
      return {
        documentId: row.documentId,
        number: row.number,
        title: row.title,
        typeCode: 'client_invoice',
        typeName: 'Счёт',
        documentDate: row.documentDate,
        emptyAmount,
        originalAmount: (row.amount || 0).toFixed(2),
        originalCurrency: row.currency,
        sourceRate: emptyAmount ? null : rubRates[row.currency].toFixed(8),
        targetRate: emptyAmount ? null : rubRates[targetCurrency].toFixed(8),
        conversionRate: emptyAmount ? null : conversionRate.toFixed(10),
        rateDate: row.rateDate,
        convertedAmount: convertedAmount.toFixed(2),
        targetCurrency,
      };
    });
    const total = details.reduce((sum, row) => sum + Number(row.convertedAmount), 0);
    return {
      dealId: Number(pathname.match(/\/deal\/(\d+)/)[1]),
      targetCurrency,
      total: total.toFixed(2),
      documentCount: details.length,
      zeroAmountCount: 1,
      source: 'CBR',
      details,
    };
  }
  if (/\/documents\/deal\/\d+\/sync-bitrix$/.test(pathname)) {
    return {
      dealId: Number(pathname.match(/\/deal\/(\d+)/)[1]),
      created: 0,
      updated: 1,
      unchanged: 1,
      duplicates: 0,
      sourceDuplicatesIgnored: 0,
      syncedAt: '2026-08-04T10:00:00.000Z',
      items: [],
    };
  }
  if (pathname.endsWith('/by-entity')) {
    const entityType = parsed.searchParams.get('entityType');
    const entityId = Number(parsed.searchParams.get('entityId'));
    const deal = {
      id: 1234,
      title: 'Поставка оборудования',
      companyId: 77,
      stageId: 'C1:WON',
      stageName: 'Сделка успешна',
      stageColor: '#15803d',
    };
    const company = { id: 77, title: 'ООО «Ромашка»' };
    const context = entityType === 'deal'
      ? {
          entityType: 'deal',
          entityId,
          entityTitle: deal.title,
          company,
          deal,
          deals: [deal],
          references: [{ entityType: 'deal', entityId }, { entityType: 'company', entityId: company.id }],
          syncUnavailable: false,
        }
      : {
          entityType: 'company',
          entityId,
          entityTitle: company.title,
          company,
          deal: null,
          deals: [deal],
          references: [{ entityType: 'company', entityId }, { entityType: 'deal', entityId: deal.id }],
          syncUnavailable: false,
        };
    const items = entityType === 'deal' ? documentItems.slice(0, 4) : documentItems.slice(0, 2);
    return { items, meta: { total: items.length, limit: 1000, offset: 0 }, context };
  }
  const documentMatch = pathname.match(/\/documents\/([0-9a-f-]+)$/i);
  if (documentMatch) return documentItems.find(item => item.id === documentMatch[1]) || {};
  if (pathname.endsWith('/documents')) {
    const search = (parsed.searchParams.get('search') || '').trim().toLocaleLowerCase('ru');
    const items = search
      ? documentItems.filter(item => [item.number, item.title, item.counterpartyName, item.type.name]
          .some(value => String(value || '').toLocaleLowerCase('ru').includes(search)))
      : documentItems;
    return { items, meta: { total: items.length, limit: 50, offset: 0 } };
  }
  return {};
}

const pages = await fetch(`${debuggerUrl}/json/list`).then(response => response.json());
const page = pages.find(item => item.type === 'page');
if (!page) throw new Error('Headless browser page was not found.');

const socket = new WebSocket(page.webSocketDebuggerUrl);
const pending = new Map();
let nextId = 1;

socket.addEventListener('message', event => {
  const message = JSON.parse(event.data);
  if (message.method === 'Fetch.requestPaused') {
    const payload = mockPayload(message.params.request.url);
    void command('Fetch.fulfillRequest', {
      requestId: message.params.requestId,
      responseCode: 200,
      responseHeaders: [{ name: 'content-type', value: 'application/json; charset=utf-8' }],
      body: Buffer.from(JSON.stringify(payload)).toString('base64'),
    });
    return;
  }
  if (!message.id || !pending.has(message.id)) return;
  const request = pending.get(message.id);
  pending.delete(message.id);
  if (message.error) request.reject(new Error(message.error.message));
  else request.resolve(message.result);
});

await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true });
  socket.addEventListener('error', reject, { once: true });
});

function command(method, params = {}) {
  const id = nextId++;
  socket.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

async function evaluate(expression) {
  const result = await command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'Browser evaluation failed.');
  return result.result.value;
}

async function waitFor(expression, label, timeout = 15_000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    try {
      if (await evaluate(expression)) return;
    } catch {
      // Navigation can replace the execution context.
    }
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error(`Timeout while waiting for ${label}.`);
}

async function clickIframeButton(text) {
  const clicked = await evaluate(`(() => {
    const doc = document.querySelector('iframe')?.contentDocument;
    const button = doc && [...doc.querySelectorAll('button')].find(item => {
      const rect = item.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && item.innerText.includes(${JSON.stringify(text)});
    });
    button?.click();
    return !!button;
  })()`);
  if (!clicked) throw new Error(`Button was not found: ${text}`);
  await new Promise(resolve => setTimeout(resolve, 250));
}

async function clickIframeText(text) {
  const clicked = await evaluate(`(() => {
    const doc = document.querySelector('iframe')?.contentDocument;
    const label = doc && [...doc.querySelectorAll('*')].find(item => {
      const rect = item.getBoundingClientRect();
      return item.children.length === 0
        && rect.width > 0
        && rect.height > 0
        && item.textContent.trim() === ${JSON.stringify(text)};
    });
    const target = label?.closest('button,[onclick],[style*="cursor:pointer"],[style*="cursor: pointer"]');
    target?.click();
    return !!target;
  })()`);
  if (!clicked) throw new Error(`Clickable text was not found: ${text}`);
  await new Promise(resolve => setTimeout(resolve, 250));
}

async function clickLastIframeButtonExact(text) {
  const clicked = await evaluate(`(() => {
    const doc = document.querySelector('iframe')?.contentDocument;
    const buttons = doc && [...doc.querySelectorAll('button')].filter(item => {
      const rect = item.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && item.innerText.trim() === ${JSON.stringify(text)};
    });
    const button = buttons && buttons[buttons.length - 1];
    button?.click();
    return !!button;
  })()`);
  if (!clicked) throw new Error(`Button was not found: ${text}`);
  await new Promise(resolve => setTimeout(resolve, 250));
}

async function setPlacement(code, entityId) {
  await evaluate(`(() => {
    const frame = document.querySelector('iframe');
    frame.contentWindow.postMessage({
      type: 'registry-bitrix-context',
      context: {
        auth: null,
        placement: {
          code: ${JSON.stringify(code)},
          title: '',
          options: { ID: ${JSON.stringify(String(entityId))} },
          entityId: ${JSON.stringify(String(entityId))},
          isSliderMode: false,
        },
      },
    }, window.location.origin);
  })()`);
}

async function screenshot(name, width, height) {
  await command('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  await new Promise(resolve => setTimeout(resolve, 180));
  const capture = await command('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: false,
    fromSurface: true,
  });
  await writeFile(path.join(evidenceDirectory, name), Buffer.from(capture.data, 'base64'));
}

await mkdir(evidenceDirectory, { recursive: true });
await command('Runtime.enable');
await command('Page.enable');
await command('Fetch.enable', { patterns: [{ urlPattern: '*api/v1/registry/*' }] });
await command('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
await command('Page.navigate', { url: appUrl });
await waitFor(`document.querySelector('iframe')?.contentDocument?.body?.innerText.includes('Договор поставки оборудования')`, 'registry baseline');
await screenshot('registry-1440x1000.png', 1440, 1000);
await screenshot('registry-1280x900.png', 1280, 900);
const registryEvidence = await evaluate(`(() => {
  const text = document.querySelector('iframe').contentDocument.body.innerText;
  return {
    loaded: text.includes('Реестр документов'),
    documentCount: text.includes('Показано 5 из 5 документов'),
  };
})()`);

await evaluate(`(() => {
  const doc = document.querySelector('iframe').contentDocument;
  const input = doc.querySelector('input[placeholder^="Поиск по"]');
  const setter = Object.getOwnPropertyDescriptor(input.ownerDocument.defaultView.HTMLInputElement.prototype, 'value').set;
  setter.call(input, 'К-2026/45');
  input.dispatchEvent(new input.ownerDocument.defaultView.Event('input', { bubbles: true }));
  return true;
})()`);
await waitFor(`document.querySelector('iframe').contentDocument.body.innerText.includes('Показано 1 из 1 документов')`, 'contract relation search');
await evaluate(`(() => {
  const doc = document.querySelector('iframe').contentDocument;
  doc.querySelector('button[title="Показать связанные документы"]')?.click();
})()`);
await waitFor(`document.querySelector('iframe').contentDocument.body.innerText.includes('Дополнительное соглашение №1')`, 'expanded dependent documents');
await screenshot('contract-search-relations-expanded-1440x1000.png', 1440, 1000);
await screenshot('contract-search-relations-expanded-1280x900.png', 1280, 900);
const relationSearchEvidence = await evaluate(`(() => {
  const doc = document.querySelector('iframe').contentDocument;
  const toggle = doc.querySelector('button[title="Показать связанные документы"]');
  return toggle?.getAttribute('aria-expanded') === 'true'
    && doc.body.innerText.includes('Дополнительное соглашение №1')
    && doc.body.innerText.includes('Приложение — спецификация оборудования')
    && doc.body.innerText.includes('Показано 1 из 1 документов');
})()`);
await evaluate(`(() => {
  const doc = document.querySelector('iframe').contentDocument;
  [...doc.querySelectorAll('button')].find(button => button.innerText.includes('Дополнительное соглашение №1'))?.click();
})()`);
await waitFor(`!!document.querySelector('iframe').contentDocument.querySelector('button[title="Открыть основной документ"]')`, 'addendum parent backlink');
await screenshot('addendum-parent-link-1440x1000.png', 1440, 1000);
await screenshot('addendum-parent-link-1280x900.png', 1280, 900);
const addendumBacklinkEvidence = await evaluate(`(() => {
  const doc = document.querySelector('iframe').contentDocument;
  const parent = doc.querySelector('button[title="Открыть основной документ"]');
  return parent?.innerText.includes('Договор поставки оборудования')
    && parent?.innerText.includes('К-2026/45')
    && doc.body.innerText.includes('Дополнительное соглашение №1');
})()`);
await evaluate(`document.querySelector('iframe').contentDocument.querySelector('button[title="Открыть основной документ"]')?.click()`);
await waitFor(`(() => {
  const doc = document.querySelector('iframe').contentDocument;
  return [...doc.querySelectorAll('button')].some(button => button.innerText.includes('＋ Добавить зависимый'))
    && doc.body.innerText.includes('Договор поставки оборудования');
})()`, 'return to main contract');
await evaluate(`(() => {
  const doc = document.querySelector('iframe').contentDocument;
  [...doc.querySelectorAll('button')].find(button => button.innerText.includes('＋ Добавить зависимый'))?.click();
})()`);
await waitFor(`!!document.querySelector('iframe').contentDocument.querySelector('[aria-labelledby="document-relation-editor-title"]')`, 'relation editor dialog');
await screenshot('document-relation-editor-1440x1000.png', 1440, 1000);
const relationEditorEvidence = await evaluate(`(() => {
  const doc = document.querySelector('iframe').contentDocument;
  const dialog = doc.querySelector('[aria-labelledby="document-relation-editor-title"]');
  return dialog?.innerText.includes('Добавить зависимый документ')
    && dialog?.innerText.includes('Вид зависимости')
    && !!dialog.querySelector('input[placeholder="Например, К-2026/45"]')
    && !!dialog.querySelector('select');
})()`);
await evaluate(`document.querySelector('iframe').contentDocument.querySelector('button[aria-label="Закрыть выбор связанного документа"]')?.click()`);
await waitFor(`!document.querySelector('iframe').contentDocument.querySelector('[aria-labelledby="document-relation-editor-title"]')`, 'relation editor close');
await waitFor(`document.querySelector('iframe').contentDocument.body.innerText.includes('История версий и изменений')`, 'document drawer');
await screenshot('document-drawer-1440x1000.png', 1440, 1000);
await screenshot('document-drawer-compact-1280x900.png', 1280, 900);
const compactDrawerEvidence = await evaluate(`(() => {
  const doc = document.querySelector('iframe').contentDocument;
  const bodyText = doc.body.innerText;
  const additional = [...doc.querySelectorAll('button')].find(button => button.innerText.includes('Дополнительные сведения'));
  const links = [...doc.querySelectorAll('button')].find(button => button.innerText.includes('Привязки Bitrix24'));
  const storage = [...doc.querySelectorAll('button')].find(button => button.innerText.includes('Хранение на Bitrix24 Диске'));
  const history = [...doc.querySelectorAll('button')].find(button => button.innerText.includes('История версий и изменений'));
  const company = doc.querySelector('button[title="Открыть компанию в Bitrix24"]');
  const currentAttachmentRows = [...doc.querySelectorAll('*')].filter(item => item.children.length === 0 && item.textContent.trim() === 'contract-equipment-v3.pdf');
  return {
    companyLink: !!company && company.innerText.includes('ООО «Ромашка»'),
    primaryContentVisible: currentAttachmentRows.length === 1,
    previousVersionsHidden: !bodyText.includes('contract-equipment-v2.pdf'),
    secondaryCollapsed: additional?.getAttribute('aria-expanded') === 'false'
      && links?.getAttribute('aria-expanded') === 'false'
      && storage?.getAttribute('aria-expanded') === 'false',
    separateHistory: !!history && history.innerText.includes('3 верс.') && history.innerText.includes('4 соб.'),
  };
})()`);
await evaluate(`(() => {
  const doc = document.querySelector('iframe').contentDocument;
  [...doc.querySelectorAll('button')].find(button => button.innerText.includes('Хранение на Bitrix24 Диске'))?.click();
})()`);
await waitFor(`(() => {
  const doc = document.querySelector('iframe').contentDocument;
  return doc.body.innerText.includes('Монтаж и пусконаладка [5678]')
    && doc.body.innerText.includes('Поставка оборудования [1234]');
})()`, 'two physical Bitrix Disk copy paths');
await evaluate(`(() => {
  const doc = document.querySelector('iframe').contentDocument;
  doc.getElementById('document-storage-copies')?.scrollIntoView({ block: 'center' });
})()`);
await screenshot('document-storage-copies-1440x1000.png', 1440, 1000);
await screenshot('document-storage-copies-1280x900.png', 1280, 900);
const storageCopiesEvidence = await evaluate(`(() => {
  const doc = document.querySelector('iframe').contentDocument;
  const toggle = [...doc.querySelectorAll('button')].find(button => button.innerText.includes('Хранение на Bitrix24 Диске'));
  const block = doc.getElementById('document-storage-copies');
  const text = block?.innerText || '';
  return toggle?.getAttribute('aria-expanded') === 'true'
    && toggle.innerText.includes('2 пути')
    && text.includes('Сделка #1234 · Поставка оборудования')
    && text.includes('Сделка #5678 · Монтаж и пусконаладка')
    && text.includes('contract-equipment-v3.pdf · v3')
    && block.scrollWidth <= block.clientWidth + 1;
})()`);
await evaluate(`(() => {
  const doc = document.querySelector('iframe').contentDocument;
  [...doc.querySelectorAll('button')].find(button => button.innerText.includes('Хранение на Bitrix24 Диске'))?.click();
})()`);
await evaluate(`(() => {
  const doc = document.querySelector('iframe').contentDocument;
  [...doc.querySelectorAll('button')].find(button => button.innerText.includes('Дополнительные сведения'))?.click();
})()`);
await waitFor(`(() => {
  const doc = document.querySelector('iframe').contentDocument;
  const button = [...doc.querySelectorAll('button')].find(item => item.innerText.includes('Дополнительные сведения'));
  return button?.getAttribute('aria-expanded') === 'true' && doc.body.innerText.includes('Поставка линии розлива');
})()`, 'accessible additional details disclosure');
await evaluate(`(() => {
  const doc = document.querySelector('iframe').contentDocument;
  [...doc.querySelectorAll('button')].find(button => button.innerText.includes('Дополнительные сведения'))?.click();
  [...doc.querySelectorAll('button')].find(button => button.innerText.includes('Привязки Bitrix24'))?.click();
})()`);
await waitFor(`document.querySelector('iframe').contentDocument.body.innerText.includes('Проверить договор')`, 'accessible linked entities disclosure');
const accordionEvidence = await evaluate(`(() => {
  const doc = document.querySelector('iframe').contentDocument;
  const links = [...doc.querySelectorAll('button')].find(button => button.innerText.includes('Привязки Bitrix24'));
  return links?.getAttribute('aria-expanded') === 'true'
    && doc.body.innerText.includes('Проверить договор');
})()`);
const drawerScrollBeforeHistory = await evaluate(`(() => {
  const doc = document.querySelector('iframe').contentDocument;
  const panel = [...doc.querySelectorAll('div')].find(item => {
    const style = doc.defaultView.getComputedStyle(item);
    return style.overflowY === 'auto' && item.clientHeight > 300;
  });
  if (!panel) return -1;
  panel.scrollTop = Math.min(120, panel.scrollHeight - panel.clientHeight);
  return panel.scrollTop;
})()`);
await evaluate(`(() => {
  const doc = document.querySelector('iframe').contentDocument;
  [...doc.querySelectorAll('button')].find(button => button.innerText.includes('История версий и изменений'))?.click();
})()`);
await waitFor(`!!document.querySelector('iframe').contentDocument.querySelector('[aria-labelledby="document-history-title"]')`, 'separate document history dialog');
await screenshot('document-history-1440x1000.png', 1440, 1000);
await screenshot('document-history-1280x900.png', 1280, 900);
const historyDialogEvidence = await evaluate(`(() => {
  const doc = document.querySelector('iframe').contentDocument;
  const dialog = doc.querySelector('[aria-labelledby="document-history-title"]');
  const text = dialog?.innerText.toLowerCase() || '';
  return text.includes('версии файлов · 3')
    && text.includes('contract-equipment-v1.pdf')
    && text.includes('журнал изменений · 4')
    && text.includes('документ создан')
    && text.includes('получатели: #2, #7')
    && text.includes('черновик → на согласовании')
    && dialog.scrollWidth <= dialog.clientWidth + 1;
})()`);
await evaluate(`document.querySelector('iframe').contentDocument.querySelector('button[aria-label="Закрыть историю"]')?.click()`);
await waitFor(`!document.querySelector('iframe').contentDocument.querySelector('[aria-labelledby="document-history-title"]')`, 'history dialog close');
const drawerPositionPreserved = await evaluate(`(() => {
  const doc = document.querySelector('iframe').contentDocument;
  const panel = [...doc.querySelectorAll('div')].find(item => {
    const style = doc.defaultView.getComputedStyle(item);
    return style.overflowY === 'auto' && item.clientHeight > 300;
  });
  return !!panel && Math.abs(panel.scrollTop - ${JSON.stringify(drawerScrollBeforeHistory)}) <= 1;
})()`);

await clickIframeButton('✕');
await setPlacement('CRM_DEAL_DETAIL_TAB', 1234);
await waitFor(`document.querySelector('iframe').contentDocument.body.innerText.includes('#1234 · Поставка оборудования')`, 'deal context');
await waitFor(`document.querySelector('iframe').contentDocument.body.innerText.toLocaleUpperCase('ru').includes('СУММА ДОКУМЕНТОВ СДЕЛКИ · 4')`, 'deal financial summary');
await screenshot('deal-context-1440x1000.png', 1440, 1000);
await screenshot('deal-financial-rub-1280x900.png', 1280, 900);
const dealFinancialRubEvidence = await evaluate(`(() => {
  const doc = document.querySelector('iframe').contentDocument;
  const summary = doc.querySelector('[aria-labelledby="deal-financial-summary-title"]');
  const text = (summary?.innerText || '').replace(/\\s+/g, ' ');
  return text.includes('15 000,00 RUB')
    && text.includes('Счёт в долларах США')
    && text.includes('Инвойс в евро')
    && text.includes('Документ без суммы')
    && text.includes('Нет суммы → 0')
    && text.includes('03.04.2026');
})()`);
await evaluate(`(() => {
  const doc = document.querySelector('iframe').contentDocument;
  const select = [...doc.querySelectorAll('select')].find(item => item.querySelector('option[value="USD"]'));
  const setter = Object.getOwnPropertyDescriptor(select.ownerDocument.defaultView.HTMLSelectElement.prototype, 'value').set;
  setter.call(select, 'USD');
  select.dispatchEvent(new select.ownerDocument.defaultView.Event('change', { bubbles: true }));
})()`);
await waitFor(`document.querySelector('iframe').contentDocument.body.innerText.includes('166,67 USD')`, 'deal financial target currency change');
await screenshot('deal-financial-usd-1440x1000.png', 1440, 1000);
const dealFinancialUsdEvidence = await evaluate(`(() => {
  const doc = document.querySelector('iframe').contentDocument;
  const summary = doc.querySelector('[aria-labelledby="deal-financial-summary-title"]');
  return summary?.innerText.includes('166,67 USD')
    && summary?.innerText.includes('1 EUR = 1,1111 USD')
    && summary?.querySelector('select')?.value === 'USD';
})()`);
await waitFor(`document.querySelector('iframe').contentDocument.body.innerText.includes('АВТОИМПОРТ СЧЕТОВ И КОММЕРЧЕСКИХ ПРЕДЛОЖЕНИЙ ИЗ BITRIX24')`, 'deal Bitrix import block');
const dealBitrixImportEvidence = await evaluate(`(() => {
  const doc = document.querySelector('iframe').contentDocument;
  const block = doc.querySelector('[aria-labelledby="deal-bitrix-import-title"]');
  if (!block) return false;
  block.scrollIntoView({ block: 'center' });
  const text = (block.innerText || '').replace(/\s+/g, ' ');
  return text.includes('Счёт Bitrix24')
    && text.includes('ID 8842')
    && text.includes('Коммерческое предложение Bitrix24')
    && text.includes('ID 491')
    && text.includes('Синхронизировать')
    && block.scrollWidth <= block.clientWidth + 1;
})()`);
await screenshot('deal-bitrix-import-1440x1000.png', 1440, 1000);
await screenshot('deal-bitrix-import-1280x900.png', 1280, 900);
await clickIframeButton('Синхронизировать');
await waitFor(`document.querySelector('iframe').contentDocument.body.innerText.includes('дублей 0')`, 'deal Bitrix import synchronization result');
const dealBitrixImportSyncEvidence = await evaluate(`(() => {
  const block = document.querySelector('iframe').contentDocument.querySelector('[aria-labelledby="deal-bitrix-import-title"]');
  const text = (block?.innerText || '').replace(/\s+/g, ' ');
  return text.includes('создано 0') && text.includes('обновлено 1') && text.includes('без изменений 1') && text.includes('дублей 0');
})()`);
await setPlacement('CRM_COMPANY_DETAIL_TAB', 77);
await waitFor(`document.querySelector('iframe').contentDocument.body.innerText.includes('ООО «Ромашка»')`, 'company context');
await screenshot('company-context-1440x1000.png', 1440, 1000);
await setPlacement('LEFT_MENU', 0);
await clickIframeButton('Помощь');
await waitFor(`!!document.querySelector('iframe').contentDocument.querySelector('[aria-labelledby="help-training-title"]')`, 'six help materials');
const helpMaterialsEvidence = await evaluate(`(() => {
  const doc = document.querySelector('iframe').contentDocument;
  const dialog = doc.querySelector('[aria-labelledby="help-training-title"]');
  const text = dialog?.innerText || '';
  const articleCount = (text.match(/Статья/g) || []).length;
  const videoCount = (text.match(/Видео/g) || []).length;
  return {
    total: articleCount + videoCount === 6,
    articles: articleCount === 4,
    videos: videoCount === 2,
  };
})()`);
await screenshot('help-six-materials-1440x1000.png', 1440, 1000);
await clickIframeButton('✕');
await clickIframeButton('Администрирование');
await waitFor(`document.querySelector('iframe').contentDocument.body.innerText.includes('Администрирование реестра')`, 'administration');
await screenshot('administration-1440x1000.png', 1440, 1000);
await clickIframeButton('Обучение');
await waitFor(`document.querySelector('iframe').contentDocument.body.textContent.includes('Пользовательская инструкция') && document.querySelector('iframe').contentDocument.body.textContent.includes('Административная инструкция')`, 'two future training guides');
await screenshot('administration-training-1440x1000.png', 1440, 1000);
await screenshot('administration-training-1280x900.png', 1280, 900);
const trainingEvidence = await evaluate(`(() => {
  const body = document.querySelector('iframe').contentDocument.body;
  const sourceText = body.textContent;
  const renderedText = body.innerText;
  return {
    userGuide: sourceText.includes('Пользовательская инструкция') && sourceText.includes('одиночная и массовая загрузка'),
    adminGuide: sourceText.includes('Административная инструкция') && sourceText.includes('роли и права доступа'),
    futureStatus: (renderedText.match(/Будет выпущена после стабилизации интерфейса/g) || []).length === 2,
  };
})()`);
await clickIframeButton('Роли и доступ');
await waitFor(`document.querySelector('iframe').contentDocument.body.innerText.includes('Назначение подразделений')`, 'role assignments');
await screenshot('administration-roles-1440x1000.png', 1440, 1000);
await screenshot('administration-roles-1280x900.png', 1280, 900);
await clickIframeText('Менеджер продаж');
await waitFor(`document.querySelector('iframe').contentDocument.body.innerText.includes('Права по типам документов')`, 'role by document type matrix');
await screenshot('administration-role-matrix-1440x1000.png', 1440, 1000);
await screenshot('administration-role-matrix-1280x900.png', 1280, 900);
const roleEvidence = await evaluate(`(() => {
  const text = document.querySelector('iframe').contentDocument.body.innerText;
  return {
    departmentMapping: text.includes('Назначение подразделений'),
    typePermissionMatrix: text.includes('Права по типам документов'),
  };
})()`);

await clickIframeButton('✕');
await clickIframeButton('Типы документов');
await waitFor(`document.querySelector('iframe').contentDocument.body.innerText.includes('Договор поставщика')`, 'document type administration');
await clickIframeText('Договор');
await waitFor(`document.querySelector('iframe').contentDocument.body.innerText.includes('Формат номера')`, 'type numbering editor');
const multiSectionTypeEvidence = await evaluate(`(() => {
  const doc = document.querySelector('iframe').contentDocument;
  const input = doc.querySelector('input[placeholder="Договор аренды"]');
  const grid = input?.closest('div[style*="display: grid"]');
  const sectionButtons = grid?.children[0]
    ? [...grid.children[0].querySelectorAll('button')]
    : [];
  const supplier = sectionButtons.find(button => button.innerText.includes('Поставщик'));
  supplier?.click();
  return sectionButtons.length === 6 && !!supplier;
})()`);
await waitFor(`(() => {
  const doc = document.querySelector('iframe').contentDocument;
  const input = doc.querySelector('input[placeholder="Договор аренды"]');
  const grid = input?.closest('div[style*="display: grid"]');
  const sectionButtons = grid?.children[0] ? [...grid.children[0].querySelectorAll('button')] : [];
  return sectionButtons.filter(button => button.innerText.includes('✓')).length === 2;
})()`, 'multiple document type sections');
await clickIframeButton('＋ Поле');
const blankFieldTypeEditable = await evaluate(`(() => {
  const doc = document.querySelector('iframe').contentDocument;
  const inputs = [...doc.querySelectorAll('input[placeholder="Название поля"]')];
  return !inputs[inputs.length - 1]?.parentElement?.querySelector('select')?.disabled;
})()`);
await evaluate(`(() => {
  const doc = document.querySelector('iframe').contentDocument;
  const inputs = [...doc.querySelectorAll('input[placeholder="Название поля"]')];
  const input = inputs[inputs.length - 1];
  if (!input) return false;
  const setter = Object.getOwnPropertyDescriptor(input.ownerDocument.defaultView.HTMLInputElement.prototype, 'value').set;
  setter.call(input, 'Предмет договора');
  input.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`);
await waitFor(`(() => {
  const doc = document.querySelector('iframe').contentDocument;
  const inputs = [...doc.querySelectorAll('input[placeholder="Название поля"]')];
  return !!inputs[inputs.length - 1]?.parentElement?.querySelector('select:disabled');
})()`, 'field library type lock');
const libraryLock = await evaluate(`(() => {
  const doc = document.querySelector('iframe').contentDocument;
  const inputs = [...doc.querySelectorAll('input[placeholder="Название поля"]')];
  return !!inputs[inputs.length - 1]?.parentElement?.querySelector('select:disabled');
})()`);
await screenshot('administration-type-numbering-1440x1000.png', 1440, 1000);
await screenshot('administration-type-numbering-1280x900.png', 1280, 900);
await clickIframeButton('✕');
await clickIframeButton('Полный реестр');
await clickIframeButton('Создать документ');
await clickLastIframeButtonExact('Клиентские');
await clickLastIframeButtonExact('Договор');
await clickIframeButton('Далее');
await waitFor(`document.querySelector('iframe').contentDocument.body.innerText.includes('Оставьте пустым для автоматической нумерации')`, 'wizard numbering hint');
await waitFor(`document.querySelector('iframe').contentDocument.body.innerText.includes('Подписанная копия')`, 'wizard file field');
await screenshot('wizard-dynamic-file-numbering-1440x1000.png', 1440, 1000);
await screenshot('wizard-dynamic-file-numbering-1280x900.png', 1280, 900);
const stage2WizardEvidence = await evaluate(`(() => {
  const text = document.querySelector('iframe').contentDocument.body.innerText;
  return text.includes('Подписанная копия')
    && text.includes('Оставьте пустым для автоматической нумерации');
})()`);

await clickIframeButton('✕');
await clickIframeButton('Создать документ');
await clickLastIframeButtonExact('Внутренние');
await clickLastIframeButtonExact('Служебная записка');
await clickIframeButton('Далее');
await waitFor(`document.querySelector('iframe').contentDocument.body.innerText.includes('Поиск в CRM')`, 'wizard CRM company selector');
await screenshot('wizard-crm-company-context-1440x1000.png', 1440, 1000);
await screenshot('wizard-crm-company-context-1280x900.png', 1280, 900);
const crmSelectorEvidence = await evaluate(`(() => {
  const text = document.querySelector('iframe').contentDocument.body.innerText;
  return text.includes('Поиск в CRM')
    && text.includes('произвольный текст не используется')
    && text.includes('Содержимое можно добавить позже');
})()`);
await evaluate(`(() => {
  const doc = document.querySelector('iframe').contentDocument;
  const label = [...doc.querySelectorAll('label')].find(item => item.innerText.includes('Дата документа'));
  const input = label && label.querySelector('input[type="date"]');
  if (!input) return false;
  const setter = Object.getOwnPropertyDescriptor(input.ownerDocument.defaultView.HTMLInputElement.prototype, 'value').set;
  setter.call(input, '2026-08-04');
  input.dispatchEvent(new input.ownerDocument.defaultView.Event('input', { bubbles: true }));
  input.dispatchEvent(new input.ownerDocument.defaultView.Event('change', { bubbles: true }));
  return true;
})()`);
await waitFor(`(() => {
  const doc = document.querySelector('iframe').contentDocument;
  const label = [...doc.querySelectorAll('label')].find(item => item.innerText.includes('Дата документа'));
  return label?.querySelector('input[type="date"]')?.value === '2026-08-04';
})()`, 'wizard document date');
await clickIframeButton('Далее');
await waitFor(`document.querySelector('iframe').contentDocument.body.innerText.toLowerCase().includes('существующие задачи bitrix24')`, 'wizard existing task selector');
await screenshot('wizard-task-link-1440x1000.png', 1440, 1000);
await screenshot('wizard-task-link-1280x900.png', 1280, 900);
const existingTaskSelectorEvidence = await evaluate(`document.querySelector('iframe').contentDocument.body.innerText.includes('Новая задача не создаётся')`);

await clickIframeButton('✕');
await clickIframeButton('Полный реестр');
const dragPrepared = await evaluate(`(() => {
  const doc = document.querySelector('iframe').contentDocument;
  const view = doc.defaultView;
  const zone = doc.querySelector('[data-registry-drop-zone="true"][data-section-code="supplier"]');
  if (!zone) return false;
  const transfer = new view.DataTransfer();
  transfer.items.add(new view.File(['first'], 'Очень длинное название договора поставщика с приложениями и спецификациями номер один.pdf', { type: 'application/pdf' }));
  transfer.items.add(new view.File(['second'], 'Счет поставщика второй файл.xlsx', { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
  view.__stage4BulkTransfer = transfer;
  zone.dispatchEvent(new view.DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: transfer }));
  return true;
})()`);
if (!dragPrepared) throw new Error('Supplier registry drop zone was not found.');
await waitFor(`document.querySelector('iframe').contentDocument.body.innerText.includes('Отпустите файлы')`, 'section drop target highlight');
await screenshot('bulk-section-drop-active-1440x1000.png', 1440, 1000);
await screenshot('bulk-section-drop-active-1280x900.png', 1280, 900);
const dropHighlightEvidence = await evaluate(`(() => {
  const doc = document.querySelector('iframe').contentDocument;
  const zone = doc.querySelector('[data-registry-drop-zone="true"][data-section-code="supplier"]');
  const style = doc.defaultView.getComputedStyle(zone);
  return zone.innerText.includes('Отпустите файлы')
    && style.borderTopStyle !== 'none'
    && style.borderTopColor !== 'rgba(0, 0, 0, 0)';
})()`);
await evaluate(`(() => {
  const doc = document.querySelector('iframe').contentDocument;
  const view = doc.defaultView;
  const zone = doc.querySelector('[data-registry-drop-zone="true"][data-section-code="supplier"]');
  zone.dispatchEvent(new view.DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: view.__stage4BulkTransfer }));
})()`);
await waitFor(`(() => {
  const doc = document.querySelector('iframe').contentDocument;
  return doc.body.innerText.includes('Массовая загрузка документов')
    && doc.querySelectorAll('button[aria-label="Удалить файл из массовой загрузки"]').length === 2;
})()`, 'two bulk upload rows');
await screenshot('bulk-upload-two-files-1440x1000.png', 1440, 1000);
await screenshot('bulk-upload-two-files-1280x900.png', 1280, 900);
const bulkLayoutEvidence = await evaluate(`(() => {
  const doc = document.querySelector('iframe').contentDocument;
  const dialog = doc.querySelector('[aria-labelledby="bulk-upload-title"]');
  const firstSection = dialog.querySelector('select');
  const longTitle = [...dialog.querySelectorAll('input')].find(input => input.value.includes('Очень длинное название'));
  const companyButtons = [...dialog.querySelectorAll('button[title="Найти компанию в Bitrix24"]')];
  return {
    twoRows: dialog.querySelectorAll('button[aria-label="Удалить файл из массовой загрузки"]').length === 2,
    sectionPrefilled: firstSection?.value === 'supplier',
    longNameContained: !!longTitle && longTitle.scrollWidth >= longTitle.clientWidth && dialog.scrollWidth <= dialog.clientWidth + 1,
    crmCompanySelector: companyButtons.length >= 3,
    accessibleHelp: !!dialog.querySelector('button[aria-label="Справка по массовой загрузке"]'),
    commonAndRowDealSelectors: dialog.querySelectorAll('button[title="Выбрать одну или несколько сделок Bitrix24"]').length === 3,
    commonAndRowTaskSelectors: (dialog.innerText.match(/Существующая задача/g) || []).length === 3,
    commonAndRowStatusSelectors: (dialog.innerText.match(/Статус документа/g) || []).length === 3,
  };
})()`);
const bulkNumberPendingEvidence = await evaluate(`(() => {
  const doc = document.querySelector('iframe').contentDocument;
  const modes = [...doc.querySelectorAll('[data-bulk-number-mode="pending"]')];
  return modes.length === 2 && modes.every(item => item.innerText.includes('Сначала выберите тип'));
})()`);
await evaluate(`(() => {
  const doc = document.querySelector('iframe').contentDocument;
  const remove = doc.querySelector('button[aria-label="Удалить файл из массовой загрузки"]');
  const row = remove?.parentElement?.parentElement;
  const selects = row ? [...row.querySelectorAll('select')] : [];
  if (!selects[0]) return;
  selects[0].value = 'client';
  selects[0].dispatchEvent(new Event('change', { bubbles: true }));
})()`);
await waitFor(`(() => {
  const doc = document.querySelector('iframe').contentDocument;
  const remove = doc.querySelector('button[aria-label="Удалить файл из массовой загрузки"]');
  const row = remove?.parentElement?.parentElement;
  const type = row?.querySelectorAll('select')[1];
  return !!type && [...type.options].some(option => option.value === 'Договор');
})()`, 'bulk numbering type options');
await evaluate(`(() => {
  const doc = document.querySelector('iframe').contentDocument;
  const remove = doc.querySelector('button[aria-label="Удалить файл из массовой загрузки"]');
  const row = remove?.parentElement?.parentElement;
  const type = row?.querySelectorAll('select')[1];
  if (!type) return;
  type.value = 'Договор';
  type.dispatchEvent(new Event('change', { bubbles: true }));
})()`);
await waitFor(`document.querySelector('iframe').contentDocument.querySelector('[data-bulk-number-mode="auto"]')?.innerText.includes('Будет присвоен автоматически')`, 'bulk automatic numbering');
const bulkAutomaticNumberEvidence = await evaluate(`(() => {
  const doc = document.querySelector('iframe').contentDocument;
  const mode = doc.querySelector('[data-bulk-number-mode="auto"]');
  return !!mode
    && mode.innerText.includes('{TYPE}-{YYYY}-{SEQ:4}')
    && !!mode.querySelector('button[aria-label="Ввести номер вручную"]');
})()`);
const bulkInitialStatusEvidence = await evaluate(`(() => {
  const doc = document.querySelector('iframe').contentDocument;
  const remove = doc.querySelector('button[aria-label="Удалить файл из массовой загрузки"]');
  const row = remove?.parentElement?.parentElement;
  const status = [...(row?.querySelectorAll('select') || [])]
    .find(select => [...select.options].some(option => option.value === 'on_review'));
  return !!status
    && status.value === 'draft'
    && [...status.options].some(option => option.textContent.includes('На согласовании'));
})()`);
await screenshot('bulk-upload-automatic-number-1440x1000.png', 1440, 1000);
await evaluate(`document.querySelector('iframe').contentDocument.querySelector('[data-bulk-number-mode="auto"] button[aria-label="Ввести номер вручную"]')?.click()`);
await waitFor(`!!document.querySelector('iframe').contentDocument.querySelector('[data-bulk-number-mode="manual"] input[aria-label="Номер документа вручную"]')`, 'bulk manual numbering switch');
const bulkManualNumberEvidence = await evaluate(`(() => {
  const doc = document.querySelector('iframe').contentDocument;
  const mode = doc.querySelector('[data-bulk-number-mode="manual"]');
  return !!mode
    && mode.innerText.includes('Номер · вручную')
    && !!mode.querySelector('button[aria-label="Использовать автоматический номер"]');
})()`);
await screenshot('bulk-upload-manual-number-1280x900.png', 1280, 900);
await evaluate(`(() => {
  const doc = document.querySelector('iframe').contentDocument;
  doc.querySelector('button[aria-label="Справка по массовой загрузке"]')?.click();
})()`);
await waitFor(`document.querySelector('iframe').contentDocument.querySelector('[role="tooltip"]')?.innerText.includes('Раздел и тип обязательны')`, 'bulk upload help tooltip');
const helpEvidence = await evaluate(`(() => {
  const doc = document.querySelector('iframe').contentDocument;
  const button = doc.querySelector('button[aria-label="Справка по массовой загрузке"]');
  return button?.getAttribute('aria-expanded') === 'true'
    && !!doc.querySelector('[role="tooltip"]');
})()`);
await evaluate(`(() => {
  const doc = document.querySelector('iframe').contentDocument;
  const view = doc.defaultView;
  const zone = doc.getElementById('bulk-drop-zone-v2');
  const transfer = new view.DataTransfer();
  transfer.items.add(new view.File(['third'], 'Третий файл для подсветки зоны.docx', { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }));
  view.__stage4ModalTransfer = transfer;
  zone.dispatchEvent(new view.DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: transfer }));
})()`);
await waitFor(`document.querySelector('iframe').contentDocument.getElementById('bulk-drop-zone-v2')?.innerText.includes('Отпустите файлы для загрузки')`, 'bulk modal drop target highlight');
const modalDropEvidence = await evaluate(`(() => {
  const doc = document.querySelector('iframe').contentDocument;
  const zone = doc.getElementById('bulk-drop-zone-v2');
  const style = doc.defaultView.getComputedStyle(zone);
  return zone.innerText.includes('Отпустите файлы для загрузки')
    && style.backgroundColor !== 'rgba(0, 0, 0, 0)'
    && style.borderTopWidth === '2px';
})()`);
await screenshot('bulk-upload-modal-drop-active-1440x1000.png', 1440, 1000);
await evaluate(`(() => {
  const doc = document.querySelector('iframe').contentDocument;
  const view = doc.defaultView;
  const zone = doc.getElementById('bulk-drop-zone-v2');
  zone.dispatchEvent(new view.DragEvent('dragleave', { bubbles: true, cancelable: true, dataTransfer: view.__stage4ModalTransfer }));
  const removeButtons = [...doc.querySelectorAll('button[aria-label="Удалить файл из массовой загрузки"]')];
  removeButtons[0]?.click();
})()`);
await waitFor(`document.querySelector('iframe').contentDocument.querySelectorAll('button[aria-label="Удалить файл из массовой загрузки"]').length === 1`, 'single bulk row removal');
const removalEvidence = await evaluate(`(() => {
  const doc = document.querySelector('iframe').contentDocument;
  const dialog = doc.querySelector('[aria-labelledby="bulk-upload-title"]');
  return dialog.innerText.includes('Счет поставщика второй файл.xlsx')
    && !dialog.innerText.includes('Очень длинное название договора поставщика');
})()`);
await clickIframeButton('Загрузить документы');
await waitFor(`document.querySelector('iframe').contentDocument.body.innerText.includes('Исправьте поля, отмеченные в строках')`, 'bulk row validation error');
await screenshot('bulk-upload-row-error-1440x1000.png', 1440, 1000);
await screenshot('bulk-upload-row-error-1280x900.png', 1280, 900);
const rowErrorEvidence = await evaluate(`(() => {
  const doc = document.querySelector('iframe').contentDocument;
  const dialog = doc.querySelector('[aria-labelledby="bulk-upload-title"]');
  return dialog.innerText.includes('Выберите тип документа.')
    && dialog.innerText.includes('Повторить строку')
    && dialog.scrollWidth <= dialog.clientWidth + 1;
})()`);

const evidence = await evaluate(`(() => {
  const doc = document.querySelector('iframe').contentDocument;
  return {
    loaded: ${JSON.stringify(registryEvidence.loaded)},
    documentCount: ${JSON.stringify(registryEvidence.documentCount)},
    noRuntimeError: !document.getElementById('__bundler_err') && !doc.getElementById('__bundler_err'),
    helpSixMaterials: ${JSON.stringify(helpMaterialsEvidence.total && helpMaterialsEvidence.articles && helpMaterialsEvidence.videos)},
    userTrainingGuide: ${JSON.stringify(trainingEvidence.userGuide)},
    adminTrainingGuide: ${JSON.stringify(trainingEvidence.adminGuide)},
    trainingGuidesMarkedFuture: ${JSON.stringify(trainingEvidence.futureStatus)},
    departmentMapping: ${JSON.stringify(roleEvidence.departmentMapping)},
    typePermissionMatrix: ${JSON.stringify(roleEvidence.typePermissionMatrix)},
    multiSectionDocumentType: ${JSON.stringify(multiSectionTypeEvidence)},
    fieldLibraryTypeLock: ${JSON.stringify(libraryLock)},
    blankFieldTypeEditable: ${JSON.stringify(blankFieldTypeEditable)},
    numberingAndFileWizard: ${JSON.stringify(stage2WizardEvidence)},
    crmCompanySelector: ${JSON.stringify(crmSelectorEvidence)},
    existingTaskSelector: ${JSON.stringify(existingTaskSelectorEvidence)},
    bulkSectionDropTarget: ${JSON.stringify(dropHighlightEvidence)},
    bulkTwoRows: ${JSON.stringify(bulkLayoutEvidence.twoRows)},
    bulkSectionPrefilled: ${JSON.stringify(bulkLayoutEvidence.sectionPrefilled)},
    bulkLongNameContained: ${JSON.stringify(bulkLayoutEvidence.longNameContained)},
    bulkCrmCompanySelector: ${JSON.stringify(bulkLayoutEvidence.crmCompanySelector)},
    bulkCommonAndRowDealSelectors: ${JSON.stringify(bulkLayoutEvidence.commonAndRowDealSelectors)},
    bulkCommonAndRowTaskSelectors: ${JSON.stringify(bulkLayoutEvidence.commonAndRowTaskSelectors)},
    bulkCommonAndRowStatusSelectors: ${JSON.stringify(bulkLayoutEvidence.commonAndRowStatusSelectors)},
    bulkAccessibleHelp: ${JSON.stringify(bulkLayoutEvidence.accessibleHelp && helpEvidence)},
    bulkNumberPendingUntilType: ${JSON.stringify(bulkNumberPendingEvidence)},
    bulkAutomaticNumbering: ${JSON.stringify(bulkAutomaticNumberEvidence)},
    bulkInitialStatusOptions: ${JSON.stringify(bulkInitialStatusEvidence)},
    bulkManualNumberingSwitch: ${JSON.stringify(bulkManualNumberEvidence)},
    bulkModalDropTarget: ${JSON.stringify(modalDropEvidence)},
    bulkSingleRowRemoval: ${JSON.stringify(removalEvidence)},
    bulkRowErrorAndRetry: ${JSON.stringify(rowErrorEvidence)},
    drawerCompanyLink: ${JSON.stringify(compactDrawerEvidence.companyLink)},
    drawerPrimaryContentVisible: ${JSON.stringify(compactDrawerEvidence.primaryContentVisible)},
    drawerPreviousVersionsHidden: ${JSON.stringify(compactDrawerEvidence.previousVersionsHidden)},
    drawerSecondaryCollapsed: ${JSON.stringify(compactDrawerEvidence.secondaryCollapsed)},
    drawerDealStorageCopies: ${JSON.stringify(storageCopiesEvidence)},
    drawerAccessibleAccordions: ${JSON.stringify(accordionEvidence)},
    drawerSeparateHistoryButton: ${JSON.stringify(compactDrawerEvidence.separateHistory)},
    drawerHistoryDialog: ${JSON.stringify(historyDialogEvidence)},
    drawerPositionPreserved: ${JSON.stringify(drawerPositionPreserved)},
    contractSearchRelations: ${JSON.stringify(relationSearchEvidence)},
    addendumParentBacklink: ${JSON.stringify(addendumBacklinkEvidence)},
    documentRelationEditor: ${JSON.stringify(relationEditorEvidence)},
    dealFinancialRubBreakdown: ${JSON.stringify(dealFinancialRubEvidence)},
    dealFinancialCurrencySwitch: ${JSON.stringify(dealFinancialUsdEvidence)},
    dealBitrixImportCards: ${JSON.stringify(dealBitrixImportEvidence)},
    dealBitrixImportSyncResult: ${JSON.stringify(dealBitrixImportSyncEvidence)},
  };
})()`);

await writeFile(
  path.join(evidenceDirectory, 'result.json'),
  `${JSON.stringify({ ...evidence, generatedAt: new Date().toISOString() }, null, 2)}\n`,
  'utf8',
);

await command('Emulation.clearDeviceMetricsOverride');
await command('Fetch.disable');
socket.close();

if (!Object.values(evidence).every(Boolean)) {
  console.error(JSON.stringify(evidence, null, 2));
  process.exitCode = 1;
} else {
  console.log(JSON.stringify(evidence, null, 2));
}
