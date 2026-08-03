import { writeFile } from 'node:fs/promises';

const reviewUrl = process.env.TERMECH_REVIEW_URL || 'http://127.0.0.1:4173/index.html';
const reviewHost = new URL(reviewUrl).host;
const pages = await fetch('http://127.0.0.1:9223/json/list').then(response => response.json());
const page = pages.find(item => item.type === 'page' && item.url.includes(reviewHost));
if (!page) throw new Error(`Prototype page on ${reviewHost} not found`);

const socket = new WebSocket(page.webSocketDebuggerUrl);
const pending = new Map();
let nextId = 1;
socket.addEventListener('message', event => {
  const message = JSON.parse(event.data);
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
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'Evaluation failed');
  return result.result.value;
}

async function waitFor(expression, label, timeout = 12_000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    try {
      if (await evaluate(expression)) return;
    } catch {
      // Reload can briefly replace the execution context.
    }
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error(`Timeout: ${label}`);
}

async function screenshot(path) {
  const result = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, fromSurface: true });
  await writeFile(path, Buffer.from(result.data, 'base64'));
}

await command('Runtime.enable');
await command('Page.enable');
await command('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
await command('Page.reload', { ignoreCache: true });
await waitFor(`document.body.innerText.includes('Договор поставки оборудования')`, 'prototype render');
await evaluate(`document.getElementById('__bundler_err')?.remove()`);

const evidence = {};

evidence.sectionDrop = await evaluate(`(() => {
  const target = document.querySelector('[data-bulk-section="supplier"]');
  if (!target) return false;
  const transfer = new DataTransfer();
  transfer.items.add(new File(['one'], 'supplier-one.pdf', { type: 'application/pdf' }));
  transfer.items.add(new File(['two'], 'supplier-two.pdf', { type: 'application/pdf' }));
  window.__termechTestTransfer = transfer;
  target.dispatchEvent(new DragEvent('dragenter', { bubbles: true, dataTransfer: transfer }));
  return true;
})()`);
await waitFor(`getComputedStyle(document.querySelector('[data-bulk-section="supplier"]')).borderStyle === 'dashed'`, 'section drop highlight');
evidence.sectionDrop = evidence.sectionDrop && await evaluate(`(() => {
  const target = document.querySelector('[data-bulk-section="supplier"]');
  target.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: window.__termechTestTransfer }));
  return true;
})()`);
await waitFor(`document.body.innerText.includes('Массовая загрузка документов') && document.querySelectorAll('button[title="Удалить только этот файл"]').length === 2`, 'bulk rows from section drop');
evidence.prefilledSection = await evaluate(`(() => {
  const values = [...document.querySelectorAll('article select')].filter(select => [...select.options].some(option => option.text === 'Поставщик')).map(select => select.value);
  return values.filter(value => value === 'supplier').length === 2;
})()`);

evidence.dropHighlight = await evaluate(`(() => {
  const zone = document.querySelector('#bulk-drop-zone-v2');
  zone.dispatchEvent(new DragEvent('dragenter', { bubbles: true, dataTransfer: new DataTransfer() }));
  return true;
})()`);
await waitFor(`document.body.innerText.includes('Отпустите файлы для загрузки')`, 'modal drop highlight');
evidence.dropHighlight = evidence.dropHighlight && await evaluate(`getComputedStyle(document.querySelector('#bulk-drop-zone-v2')).borderStyle === 'solid'`);

evidence.noFieldOverlap = await evaluate(`(() => {
  const card = [...document.querySelectorAll('article')].find(item => item.querySelector('button[title="Удалить только этот файл"]'));
  if (!card) return false;
  const fields = [...card.querySelectorAll(':scope > div:nth-child(2) > label, :scope > div:nth-child(2) > div')]
    .map(item => item.getBoundingClientRect()).filter(rect => rect.width > 0 && rect.height > 0);
  return fields.every((a, index) => fields.slice(index + 1).every(b =>
    Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) === 0 ||
    Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)) === 0
  ));
})()`);

evidence.singleRowDelete = await evaluate(`(() => {
  const buttons = [...document.querySelectorAll('button[title="Удалить только этот файл"]')];
  if (buttons.length !== 2) return false;
  buttons[0].click();
  return true;
})()`);
await waitFor(`document.querySelectorAll('button[title="Удалить только этот файл"]').length === 1`, 'single row deletion');
evidence.singleRowDelete = evidence.singleRowDelete && true;
evidence.companySelector = await evaluate(`(() => {
  const card = [...document.querySelectorAll('article')].find(item => item.querySelector('button[title="Удалить только этот файл"]'));
  const select = card && [...card.querySelectorAll('select')].find(item => [...item.options].some(option => option.text.includes('ООО «Ромашка»')));
  return !!select && [...select.options].some(option => option.value === 'ООО «Ромашка»');
})()`);
evidence.helpIcon = await evaluate(`!![...document.querySelectorAll('button[aria-label]')].find(button => button.getAttribute('aria-label').includes('Подсказка по массовой загрузке') && button.innerText.trim() === '?')`);
await screenshot('/private/tmp/termech-v21-bulk-upload.png');

await command('Page.reload', { ignoreCache: true });
await waitFor(`document.body.innerText.includes('Договор поставки оборудования')`, 'prototype reload for document');
await evaluate(`(() => {
  const row = [...document.querySelectorAll('*')].find(item => item.children.length === 0 && item.textContent.trim() === 'Договор поставки оборудования');
  if (row) row.closest('[style*="cursor: pointer"]')?.click();
})()`);
await waitFor(`document.body.innerText.includes('Компания-контрагент · Bitrix24') && document.body.innerText.includes('Версии и история документа')`, 'document drawer');
evidence.counterpartyLink = await evaluate(`!!document.querySelector('a[href*="/crm/company/details/"]')`);
await evaluate(`([...document.querySelectorAll('button')].find(button => button.innerText.includes('Открыть историю')) || {}).click?.()`);
await waitFor(`!!document.querySelector('[role="dialog"][aria-label="История версий документа"]')`, 'history dialog');
evidence.separateHistory = true;
await screenshot('/private/tmp/termech-v21-document-history.png');

await command('Page.reload', { ignoreCache: true });
await waitFor(`document.body.innerText.includes('Договор поставки оборудования')`, 'prototype reload for roles');
evidence.roleTypeMatrix = await evaluate(`(() => {
  const role = [...document.querySelectorAll('select')].find(select => [...select.options].some(option => option.value === 'admin'));
  if (!role) return false;
  role.value = 'admin';
  role.dispatchEvent(new Event('change', { bubbles: true }));
  const adminButton = [...document.querySelectorAll('button')].find(button => button.innerText.includes('Администрирование'));
  adminButton?.click();
  return true;
})()`);
await waitFor(`document.body.innerText.includes('Разделы') && document.body.innerText.includes('Типы документов')`, 'administration');
await evaluate(`([...document.querySelectorAll('button')].find(button => button.innerText.includes('Политики ролей')) || {}).click?.()`);
await waitFor(`document.body.innerText.includes('Редактируемая роль') && document.body.innerText.includes('Сохранить политику')`, 'role type matrix');
evidence.roleTypeMatrix = evidence.roleTypeMatrix && await evaluate(`document.querySelectorAll('button[aria-label^="Просмотр:"]').length > 5`);
evidence.roleToggle = await evaluate(`(() => {
  const button = document.querySelector('button[aria-label^="Просмотр:"]');
  if (!button) return false;
  const before = button.innerText;
  button.click();
  return before.length > 0;
})()`);
await waitFor(`document.querySelector('button[aria-label^="Просмотр:"]')?.innerText === 'Запрещено'`, 'role permission toggle');
await screenshot('/private/tmp/termech-v21-role-policy.png');

evidence.noRuntimeError = await evaluate(`!document.getElementById('__bundler_err')`);
evidence.allPassed = Object.values(evidence).every(value => value === true);
console.log(JSON.stringify(evidence, null, 2));
await command('Emulation.clearDeviceMetricsOverride');
socket.close();
if (!evidence.allPassed) process.exitCode = 1;
