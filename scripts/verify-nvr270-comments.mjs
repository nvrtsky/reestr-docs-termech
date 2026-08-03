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
  const result = await command('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'Evaluation failed');
  return result.result.value;
}

async function waitFor(expression, label, timeout = 15_000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    try {
      if (await evaluate(expression)) return;
    } catch {
      // A reload can replace the execution context between two polling calls.
    }
    await new Promise(resolve => setTimeout(resolve, 160));
  }
  throw new Error(`Timeout: ${label}`);
}

async function clickButton(text) {
  const found = await evaluate(`(() => {
    const target = [...document.querySelectorAll('button')].find(button => {
      const rect = button.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && button.innerText.includes(${JSON.stringify(text)});
    });
    if (!target) return false;
    target.click();
    return true;
  })()`);
  if (!found) throw new Error(`Button not found: ${text}`);
  await new Promise(resolve => setTimeout(resolve, 220));
}

async function setTextarea(selector, value) {
  const changed = await evaluate(`(() => {
    const textarea = document.querySelector(${JSON.stringify(selector)});
    if (!textarea) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(textarea, ${JSON.stringify(value)});
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  if (!changed) throw new Error(`Textarea not found: ${selector}`);
  await new Promise(resolve => setTimeout(resolve, 180));
}

async function setInput(selector, value) {
  const changed = await evaluate(`(() => {
    const input = document.querySelector(${JSON.stringify(selector)});
    if (!input) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  if (!changed) throw new Error(`Input not found: ${selector}`);
  await new Promise(resolve => setTimeout(resolve, 180));
}

async function screenshot(path) {
  const result = await command('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: false,
    fromSurface: true,
  });
  await writeFile(path, Buffer.from(result.data, 'base64'));
}

await command('Runtime.enable');
await command('Page.enable');
await command('Emulation.setDeviceMetricsOverride', {
  width: 1440,
  height: 1000,
  deviceScaleFactor: 1,
  mobile: false,
});
await command('Page.reload', { ignoreCache: true });
await waitFor(
  `document.querySelector('#dc-root .sc-host') &&
   !document.body.innerText.includes('{{ totalCount }}') &&
   document.body.innerText.includes('Договор поставки оборудования')`,
  'prototype render',
);
await evaluate(`localStorage.removeItem('termech-tz-comments-v2')`);
await command('Page.reload', { ignoreCache: true });
await waitFor(`document.body.innerText.includes('Договор поставки оборудования')`, 'prototype reload');
await evaluate(`document.getElementById('__bundler_err')?.remove()`);

await clickButton('Техническое задание');
await waitFor(`document.body.innerText.includes('Что вошло в единое ТЗ v2.1')`, 'specification tab');

const selected = await evaluate(`(() => {
  const phrase = 'решения в одном месте';
  const root = document.querySelector('#tz-v2-overview');
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node;
  while (walker.nextNode()) {
    const candidate = walker.currentNode;
    const index = candidate.nodeValue.indexOf(phrase);
    if (index >= 0) {
      node = candidate;
      const range = document.createRange();
      range.setStart(node, index);
      range.setEnd(node, index + phrase.length);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      const rect = range.getBoundingClientRect();
      node.parentElement.dispatchEvent(new MouseEvent('mouseup', {
        bubbles: true,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2,
      }));
      return true;
    }
  }
  return false;
})()`);
if (!selected) throw new Error('Target text was not selected');
await waitFor(`!!document.querySelector('.tz-selection-action')`, 'selection comment action');

await clickButton('Комментировать');
await waitFor(`!!document.querySelector('.tz-comment-compose')`, 'comment composer');
await setInput('.tz-comment-author-field', 'Проверка Codex');
await setTextarea('.tz-comment-compose .tz-comment-textarea', 'Уточнить, кто согласует итоговую редакцию перед запуском.');
await clickButton('Добавить комментарий');
await waitFor(
  `document.body.innerText.includes('Уточнить, кто согласует итоговую редакцию перед запуском.') &&
   JSON.parse(localStorage.getItem('termech-tz-comments-v2') || '[]')
     .some(comment => comment.body === 'Уточнить, кто согласует итоговую редакцию перед запуском.')`,
  'saved comment thread',
);
await waitFor(`document.body.innerText.includes('Общий журнал')`, 'shared comment saved');

const evidence = {};
evidence.commentGuideVisible = await evaluate(`(() => {
  const guide = document.querySelector('.tz-comment-guide');
  return !!guide &&
    guide.innerText.includes('Как оставить комментарий') &&
    guide.innerText.includes('Ваше имя') === false &&
    guide.innerText.includes('видят все участники');
})()`);
evidence.anchorHighlight = await evaluate(`
  CSS.highlights.has('tz-comment-highlight-active') &&
  CSS.highlights.get('tz-comment-highlight-active').size === 1
`);
evidence.threadCreated = await evaluate(`(() => {
  const text = document.querySelector('.tz-comments-panel')?.innerText || '';
  return text.includes('решения в одном месте') &&
    text.includes('Уточнить, кто согласует итоговую редакцию перед запуском.') &&
    text.includes('Открытые · 1');
})()`);

await clickButton('Ответить');
await waitFor(`!!document.querySelector('.tz-comment-reply-box')`, 'reply editor');
await setTextarea('.tz-comment-reply-box .tz-comment-textarea', 'Согласование выполняет Заказчик после проверки HTML-версии.');
await clickButton('Отправить');
await waitFor(
  `document.body.innerText.includes('Согласование выполняет Заказчик после проверки HTML-версии.')`,
  'saved reply',
);
await waitFor(`document.body.innerText.includes('Общий журнал')`, 'shared reply saved');
evidence.replyCreated = await evaluate(`
  JSON.parse(localStorage.getItem('termech-tz-comments-v2') || '[]')[0].replies.length === 1
`);

await evaluate(`localStorage.removeItem('termech-tz-comments-v2')`);
await command('Page.reload', { ignoreCache: true });
await waitFor(`document.body.innerText.includes('Договор поставки оборудования')`, 'reload for shared persistence');
await clickButton('Техническое задание');
await clickButton('Комментарии');
await waitFor(
  `document.body.innerText.includes('Уточнить, кто согласует итоговую редакцию перед запуском.') &&
   document.body.innerText.includes('Согласование выполняет Заказчик после проверки HTML-версии.')`,
  'shared discussion after local storage reset',
);
evidence.sharedPersistenceWorks = true;
evidence.authorVisible = await evaluate(`
  document.querySelector('.tz-comments-panel')?.innerText.includes('Проверка Codex') === true
`);

await clickButton('Закрыть обсуждение');
await waitFor(`document.body.innerText.includes('Открытые · 0')`, 'resolved thread');
await waitFor(`document.body.innerText.includes('Общий журнал')`, 'shared resolve saved');
await clickButton('Закрытые');
await waitFor(
  `document.body.innerText.includes('Закрыто') &&
   document.body.innerText.includes('Уточнить, кто согласует итоговую редакцию перед запуском.')`,
  'resolved tab',
);
evidence.resolveWorks = await evaluate(`
  JSON.parse(localStorage.getItem('termech-tz-comments-v2') || '[]')[0].resolved === true
`);

await clickButton('Восстановить');
await waitFor(`document.body.innerText.includes('Открытые · 1')`, 'reopened thread');
evidence.reopenWorks = await evaluate(`
  JSON.parse(localStorage.getItem('termech-tz-comments-v2') || '[]')[0].resolved === false
`);

await clickButton('×');
await waitFor(`!document.querySelector('.tz-comments-panel')`, 'closed comments panel');
const highlightClicked = await evaluate(`(() => {
  const phrase = 'решения в одном месте';
  const root = document.querySelector('#tz-v2-overview');
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode;
    const index = node.nodeValue.indexOf(phrase);
    if (index < 0) continue;
    const range = document.createRange();
    range.setStart(node, index);
    range.setEnd(node, index + phrase.length);
    const rect = range.getBoundingClientRect();
    node.parentElement.dispatchEvent(new MouseEvent('click', {
      bubbles: true,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
    }));
    return true;
  }
  return false;
})()`);
if (!highlightClicked) throw new Error('Highlighted text was not clicked');
await waitFor(`!!document.querySelector('.tz-comments-panel')`, 'open thread from highlight');
evidence.highlightClickWorks = true;
await new Promise(resolve => setTimeout(resolve, 260));
await screenshot('/private/tmp/nvr270-tz-comments-desktop.png');

await clickButton('×');
await waitFor(`!document.querySelector('.tz-comments-panel')`, 'close comments before prototype return test');
const openedFromChange = await evaluate(`(() => {
  const card = document.querySelector('#tz-change-05');
  const button = card && card.querySelector('.tz-open-screen');
  if (!button) return false;
  card.scrollIntoView({ block: 'start' });
  button.click();
  return true;
})()`);
if (!openedFromChange) throw new Error('Change 05 prototype button not found');
await waitFor(`!!document.querySelector('.prototype-back-to-tz')`, 'prototype back button');
evidence.prototypeBackButtonVisible = true;
evidence.prototypeBackButtonInSidebar = await evaluate(`(() => {
  const button = document.querySelector('.prototype-back-to-tz');
  const sidebar = button && button.closest('.side-rail');
  if (!button || !sidebar) return false;
  const buttonRect = button.getBoundingClientRect();
  const sidebarRect = sidebar.getBoundingClientRect();
  return buttonRect.left >= sidebarRect.left &&
    buttonRect.right <= sidebarRect.right &&
    buttonRect.bottom <= sidebarRect.bottom;
})()`);
await clickButton('Вернуться к карточке ТЗ');
await waitFor(`!!document.querySelector('#tz-change-05') && !document.querySelector('.prototype-back-to-tz')`, 'return to specification');
evidence.returnToSameChange = await evaluate(`(() => {
  const card = document.querySelector('#tz-change-05');
  const rect = card && card.getBoundingClientRect();
  return !!rect && rect.top >= 45 && rect.top < 180;
})()`);
await clickButton('Комментарии');
await waitFor(`!!document.querySelector('.tz-comments-panel')`, 'reopen comments after return test');

await command('Emulation.setDeviceMetricsOverride', {
  width: 390,
  height: 844,
  deviceScaleFactor: 1,
  mobile: true,
});
await new Promise(resolve => setTimeout(resolve, 300));
evidence.phoneKeepsDesktopCanvas = await evaluate(`(() => {
  const panel = document.querySelector('.tz-comments-panel');
  if (!panel) return false;
  const rect = panel.getBoundingClientRect();
  return Math.round(rect.width) === 370 &&
    Math.round(rect.top) === 58 &&
    document.documentElement.scrollWidth >= 1120 &&
    !document.querySelector('.mobile-registry');
})()`);
await screenshot('/private/tmp/nvr270-tz-comments-phone-desktop.png');

evidence.noRuntimeError = await evaluate(`!document.getElementById('__bundler_err')`);
evidence.allPassed = Object.values(evidence).every(value => value === true);

console.log(JSON.stringify(evidence, null, 2));
await evaluate(`localStorage.removeItem('termech-tz-comments-v2')`);
await evaluate(`localStorage.removeItem('termech-tz-comment-author-v2')`);
await command('Emulation.clearDeviceMetricsOverride');
await command('Page.reload', { ignoreCache: true });
socket.close();
if (!evidence.allPassed) process.exitCode = 1;
