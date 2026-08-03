import { writeFile } from 'node:fs/promises';

const appUrl = process.env.TERMECH_APP_URL || 'http://127.0.0.1:4173/';
const pages = await fetch('http://127.0.0.1:9223/json/list').then(response => response.json());
const page = pages.find(item => item.type === 'page');
if (!page) throw new Error('Chrome page not found');

const socket = new WebSocket(page.webSocketDebuggerUrl);
const pending = new Map();
let nextId = 1;
socket.addEventListener('message', event => {
  const message = JSON.parse(event.data);
  if (message.method === 'Fetch.requestPaused') {
    void fulfillMockRequest(message.params);
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

const typePermissions = { view: true, create: true, edit: true, transition: true, archive: true, export: true, finance: true };
const permissions = {
  create: true, editOwn: true, editAny: true, transitionOwn: true, transitionAny: true,
  softDelete: true, restore: true, export: true, administer: false,
  byType: { supplier_contract: typePermissions, client_contract: typePermissions },
};
const sections = [
  { code: 'client', name: 'Клиентские', color: '#6366f1', sortOrder: 10, isActive: true },
  { code: 'supplier', name: 'Поставщик', color: '#0d9488', sortOrder: 20, isActive: true },
];
const types = [
  { code: 'client_contract', sectionCode: 'client', sectionName: 'Клиентские', name: 'Договор', lifecycleCode: 'simple', contentRequirement: 'required', fields: [], sortOrder: 10, isActive: true },
  { code: 'supplier_contract', sectionCode: 'supplier', sectionName: 'Поставщик', name: 'Договор поставщика', lifecycleCode: 'simple', contentRequirement: 'required', fields: [{ key: 'supplier_reference', label: 'Номер договора поставщика', dataType: 'text', options: [], isRequired: true, sortOrder: 10 }], sortOrder: 10, isActive: true },
];
const lifecycle = {
  code: 'simple', name: 'Простой', isActive: true,
  config: {
    initialStatus: 'draft',
    states: [{ code: 'draft', label: 'Черновик', color: '#71717a' }, { code: 'active', label: 'Активен', color: '#15803d', terminal: true }],
    transitions: [{ from: 'draft', to: 'active', roles: ['sales'] }],
  },
};
const salesPolicy = {
  roleCode: 'sales', roleName: 'Менеджер продаж', visibleSectionCodes: ['client', 'supplier'], visibleTypeCodes: null,
  hiddenFields: [], permissions, hideMoney: false, isActive: true,
};

function mockPayload(url) {
  const parsed = new URL(url);
  const path = parsed.pathname;
  if (path.endsWith('/me/policy')) return { ...salesPolicy, roleCode: 'admin', roleName: 'Администратор', userId: 1, permissions: { ...permissions, administer: true } };
  if (path.endsWith('/admin/sections')) return { items: sections };
  if (path.endsWith('/admin/types')) return { items: types };
  if (path.endsWith('/admin/lifecycles')) return { items: [lifecycle] };
  if (path.endsWith('/admin/role-policies')) return { items: [salesPolicy] };
  if (path.endsWith('/admin/user-roles')) return { users: [{ id: 1, name: 'Администратор', isBitrixAdmin: true }], items: [] };
  if (path.endsWith('/sections')) return { items: sections.map(section => ({ ...section, types: types.filter(type => type.sectionCode === section.code) })) };
  if (path.endsWith('/lifecycles')) return { items: [lifecycle] };
  if (path.endsWith('/users')) return { items: [{ id: 1, name: 'Администратор' }] };
  if (path.endsWith('/saved-views')) return { items: [] };
  if (path.endsWith('/documents/options')) return { scopeTotal: 0, archiveTotal: 0, sections: {}, views: { all: 0, mine: 0, work: 0, draft: 0 }, responsibles: [{ id: 1, name: 'Администратор' }] };
  if (path.endsWith('/documents')) return { items: [], meta: { total: 0, limit: 50, offset: 0 } };
  return {};
}

async function fulfillMockRequest(params) {
  const payload = mockPayload(params.request.url);
  await command('Fetch.fulfillRequest', {
    requestId: params.requestId,
    responseCode: 200,
    responseHeaders: [{ name: 'content-type', value: 'application/json; charset=utf-8' }],
    body: Buffer.from(JSON.stringify(payload)).toString('base64'),
  });
}

async function evaluate(expression) {
  const result = await command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'Evaluation failed');
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
    await new Promise(resolve => setTimeout(resolve, 170));
  }
  throw new Error(`Timeout: ${label}`);
}

async function screenshot(path) {
  const result = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, fromSurface: true });
  await writeFile(path, Buffer.from(result.data, 'base64'));
}

await command('Runtime.enable');
await command('Page.enable');
await command('Fetch.enable', { patterns: [{ urlPattern: '*api/v1/registry/*' }] });
await command('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
await command('Page.navigate', { url: appUrl });
await waitFor(`location.href.startsWith(${JSON.stringify(appUrl)})`, 'working app navigation');
await waitFor(`!!document.querySelector('iframe')?.contentDocument?.body`, 'working app iframe');
await waitFor(`(() => { const d = document.querySelector('iframe')?.contentDocument; return d && d.body.innerText.includes('Массовая загрузка'); })()`, 'working app');

const evidence = {};
evidence.appLoaded = await evaluate(`(() => { const d = document.querySelector('iframe').contentDocument; return d.body.innerText.includes('Реестр документов') && !d.getElementById('__bundler_err'); })()`);

evidence.sectionDrop = await evaluate(`(() => {
  const d = document.querySelector('iframe').contentDocument;
  const target = d.querySelector('[data-registry-drop-zone="true"][data-section-code="supplier"]') || d.querySelector('[data-registry-drop-zone="true"]');
  if (!target) return false;
  const transfer = new DataTransfer();
  transfer.items.add(new File(['one'], 'working-one.pdf', { type: 'application/pdf' }));
  transfer.items.add(new File(['two'], 'working-two.pdf', { type: 'application/pdf' }));
  window.__workingTransfer = transfer;
  target.dispatchEvent(new DragEvent('dragenter', { bubbles: true, dataTransfer: transfer }));
  return true;
})()`);
await waitFor(`(() => { const d = document.querySelector('iframe').contentDocument; const z = d.querySelector('[data-registry-drop-zone="true"][data-section-code="supplier"]') || d.querySelector('[data-registry-drop-zone="true"]'); return z && z.innerText.includes('Отпустите'); })()`, 'working drop highlight');
evidence.dropHighlight = true;
await evaluate(`(() => { const d = document.querySelector('iframe').contentDocument; const z = d.querySelector('[data-registry-drop-zone="true"][data-section-code="supplier"]') || d.querySelector('[data-registry-drop-zone="true"]'); z.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: window.__workingTransfer })); })()`);
await waitFor(`(() => { const d = document.querySelector('iframe').contentDocument; return d.querySelectorAll('button[title="Удалить файл из списка"]').length === 2; })()`, 'working bulk rows');

evidence.prefilledSection = await evaluate(`(() => {
  const d = document.querySelector('iframe').contentDocument;
  const rows = [...d.querySelectorAll('button[title="Удалить файл из списка"]')].map(button => button.parentElement && button.parentElement.parentElement).filter(Boolean);
  return rows.length === 2 && rows.every(row => [...row.querySelectorAll('select')].some(select => select.value === 'supplier'));
})()`);
evidence.dynamicTypeFields = await evaluate(`(() => {
  const d = document.querySelector('iframe').contentDocument;
  const row = d.querySelector('button[title="Удалить файл из списка"]')?.parentElement?.parentElement;
  const type = row && [...row.querySelectorAll('select')].find(select => [...select.options].some(option => option.text === 'Договор поставщика'));
  if (!type) return false;
  type.value = 'Договор поставщика';
  type.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
})()`);
await waitFor(`(() => { const d = document.querySelector('iframe').contentDocument; return d.body.innerText.includes('Номер договора поставщика *'); })()`, 'working bulk dynamic type fields');
evidence.noFieldOverlap = await evaluate(`(() => {
  const d = document.querySelector('iframe').contentDocument;
  const button = d.querySelector('button[title="Удалить файл из списка"]');
  const row = button && button.parentElement && button.parentElement.parentElement;
  const grid = row && [...row.children].find(child => getComputedStyle(child).display === 'grid');
  if (!grid) return false;
  const fields = [...grid.children].map(item => item.getBoundingClientRect());
  return fields.every((a, index) => fields.slice(index + 1).every(b =>
    Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) === 0 ||
    Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)) === 0
  ));
})()`);
evidence.helpIcon = await evaluate(`(() => { const d = document.querySelector('iframe').contentDocument; const b = d.querySelector('button[aria-label="Справка по массовой загрузке"]'); return !!b && b.innerText.trim() === '?'; })()`);
evidence.companySelector = await evaluate(`(() => { const d = document.querySelector('iframe').contentDocument; return d.querySelectorAll('button[title="Найти компанию в Bitrix24"]').length >= 3; })()`);
evidence.singleRowDelete = await evaluate(`(() => { const d = document.querySelector('iframe').contentDocument; const b = d.querySelector('button[title="Удалить файл из списка"]'); b?.click(); return !!b; })()`);
await waitFor(`document.querySelector('iframe').contentDocument.querySelectorAll('button[title="Удалить файл из списка"]').length === 1`, 'working single row deletion');
await screenshot('/private/tmp/termech-v21-working-bulk.png');

await evaluate(`(() => { const d = document.querySelector('iframe').contentDocument; d.querySelector('button[aria-label="Закрыть массовую загрузку"]')?.click(); const admin = [...d.querySelectorAll('button')].find(button => button.innerText.includes('Администрирование')); admin?.click(); })()`);
await waitFor(`(() => { const d = document.querySelector('iframe').contentDocument; return d.body.innerText.includes('Администрирование реестра'); })()`, 'working administration');
await evaluate(`(() => { const d = document.querySelector('iframe').contentDocument; [...d.querySelectorAll('button')].find(button => button.innerText.includes('Роли и доступ'))?.click(); })()`);
await waitFor(`(() => { const d = document.querySelector('iframe').contentDocument; return d.body.innerText.includes('Настройте для каждой роли') && d.body.innerText.includes('Менеджер продаж'); })()`, 'working role policies');
evidence.roleTypeMatrix = await evaluate(`(() => {
  const d = document.querySelector('iframe').contentDocument;
  const card = [...d.querySelectorAll('div')].find(item => item.style.cursor === 'pointer' && item.innerText.includes('Менеджер продаж') && item.innerText.includes('суммы видны') && item.innerText.length < 400);
  card?.click();
  return !!card;
})()`);
await waitFor(`(() => { const d = document.querySelector('iframe').contentDocument; return d.body.innerText.includes('Права по типам документов') && d.body.innerText.includes('Просмотр') && d.body.innerText.includes('Финансы'); })()`, 'working type permission matrix');
await screenshot('/private/tmp/termech-v21-working-role-policy.png');

evidence.noRuntimeError = await evaluate(`(() => { const d = document.querySelector('iframe').contentDocument; return !document.getElementById('__bundler_err') && !d.getElementById('__bundler_err'); })()`);
evidence.allPassed = Object.values(evidence).every(value => value === true);
console.log(JSON.stringify(evidence, null, 2));
await command('Emulation.clearDeviceMetricsOverride');
await command('Fetch.disable');
socket.close();
if (!evidence.allPassed) process.exitCode = 1;
