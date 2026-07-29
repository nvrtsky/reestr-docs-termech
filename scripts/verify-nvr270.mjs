import { writeFile } from 'node:fs/promises';

const pages = await fetch('http://127.0.0.1:9223/json/list').then(response => response.json());
const page = pages.find(item => item.type === 'page' && item.url.includes('127.0.0.1:4173'));
if (!page) throw new Error('Prototype page on 127.0.0.1:4173 not found');

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
    if (await evaluate(expression)) return;
    await new Promise(resolve => setTimeout(resolve, 180));
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
  await new Promise(resolve => setTimeout(resolve, 260));
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
await evaluate(`document.getElementById('__bundler_err')?.remove()`);

await clickButton('Техническое задание');
await waitFor(
  `document.body.innerText.includes('Что вошло в обновлённое ТЗ') &&
   document.body.innerText.includes('18 изменений, которые нужно проверить') &&
   document.body.innerText.includes('ТЗ · v2.0')`,
  'embedded specification v2',
);

const evidence = {};
evidence.versionAndDate = await evaluate(`(() => {
  const text = document.body.innerText;
  return text.includes('ТЗ · v2.0') &&
    text.includes('29.07.2026') &&
    text.includes('17.07.2026') &&
    text.includes('Договор №19082 от 27.04.2026');
})()`);
evidence.sourceCompleteness = await evaluate(`(() => {
  const text = document.body.innerText;
  return text.includes('полной транскрипции встречи 17.07.2026') &&
    text.includes('Красные замечания') &&
    text.includes('Оранжевый список') &&
    text.includes('Прямые уточнения');
})()`);
evidence.legend = await evaluate(`(() => {
  const text = document.querySelector('#tz-v2-overview')?.innerText || '';
  return text.includes('[v2] новое или изменённое') &&
    text.includes('[отложено] следующая фаза') &&
    text.includes('[оценка] до разработки');
})()`);
evidence.summaryComplete = await evaluate(`document.querySelectorAll('#tz-v2-overview .tz-summary-card').length === 4`);
evidence.sourcesComplete = await evaluate(`document.querySelectorAll('#tz-v2-overview .tz-source-card').length === 5`);
evidence.changesComplete = await evaluate(`document.querySelectorAll('#tz-v2-changes .tz-change-card').length === 18`);
evidence.conflictsComplete = await evaluate(`document.querySelectorAll('#tz-v2-conflicts .tz-compare-card').length === 7`);
evidence.meetingComplete = await evaluate(`
  document.querySelectorAll('#tz-v2-meeting .tz-decision-panel:first-child .tz-decision-row').length === 10 &&
  document.querySelectorAll('#tz-v2-meeting .tz-decision-panel:last-child .tz-decision-row').length === 8
`);
evidence.traceRowsComplete = await evaluate(`document.querySelectorAll('#tz-v2-trace .tz-trace-row:not(.tz-trace-head)').length === 16`);
evidence.evidenceScreensComplete = await evaluate(`document.querySelectorAll('#tz-v2-trace .tz-evidence-card').length === 4`);
evidence.traceability = await evaluate(`(() => {
  const text = document.querySelector('#tz-v2-trace')?.innerText || '';
  const required = [
    'Массовая загрузка с полями каждой строки',
    'Непубличная внутренняя ссылка',
    'Файл ИЛИ ссылка; обязательность по типу',
    'Связь документа с задачей',
    'Все версии и мягкое удаление',
    'Снятие доступа после закрытия сделок',
    'Договор и зависимые документы',
    'Только Bitrix24 и десктопная версия на телефоне',
    'Итог сделки и курс ЦБ',
    'Все счета и КП из Bitrix24',
    'Копия в папке каждой сделки',
  ];
  return required.every(item => text.includes(item));
})()`);
evidence.changeDetail = await evaluate(`(() => {
  const text = (document.querySelector('#tz-v2-changes')?.innerText || '').toLocaleUpperCase('ru');
  return text.includes('БЫЛО / ПРОБЛЕМА') &&
    text.includes('ПРИНЯТО В V2.0') &&
    text.includes('ПРОВЕРКА') &&
    text.includes('МАССОВАЯ ЗАГРУЗКА');
})()`);
evidence.noContradictions = await evaluate(`(() => {
  const text = document.body.innerText;
  return !text.includes('30.06.2026') &&
    !text.includes('Публичная ссылка на документ') &&
    !text.includes('Требуется файл для всех типов') &&
    !text.includes('Одна физическая копия для нескольких сделок') &&
    !text.includes('Отдельное обязательное поле «Юридическое лицо»') &&
    !text.includes('Мобильный Chrome и два пути входа') &&
    !text.includes('32–56 часов') &&
    !text.includes('Мобильный просмотр 390 px');
})()`);
evidence.deviceScope = await evaluate(`(() => {
  const text = document.querySelector('#tz-device-scope')?.innerText || '';
  return text.includes('мобильной версии не будет') &&
    text.includes('десктопный интерфейс') &&
    text.includes('только через действующую учётную запись Bitrix24') &&
    text.includes('OTP и SSO не входят в объём');
})()`);

await evaluate(`document.querySelector('#tz-top')?.scrollIntoView({ block: 'start' })`);
await new Promise(resolve => setTimeout(resolve, 250));
await screenshot('/private/tmp/nvr270-html-tz-overview.png');

await clickButton('Все изменения');
await new Promise(resolve => setTimeout(resolve, 550));
evidence.jumpNavigationWorks = await evaluate(`Math.abs(document.querySelector('#tz-v2-changes').getBoundingClientRect().top - document.querySelector('.tz-jump-nav').getBoundingClientRect().bottom) < 90`);
await screenshot('/private/tmp/nvr270-html-tz-changes.png');

await clickButton('Было → стало');
await new Promise(resolve => setTimeout(resolve, 550));
await screenshot('/private/tmp/nvr270-html-tz-conflicts.png');

await evaluate(`(() => {
  const card = [...document.querySelectorAll('#tz-v2-changes .tz-change-card')]
    .find(item => item.innerText.includes('Мобильная версия не входит в текущий объём'));
  if (card) card.scrollIntoView({ block: 'center' });
})()`);
await new Promise(resolve => setTimeout(resolve, 300));
await screenshot('/private/tmp/nvr270-html-tz-device-scope.png');

await command('Emulation.setDeviceMetricsOverride', {
  width: 390,
  height: 844,
  deviceScaleFactor: 1,
  mobile: true,
});
await evaluate(`document.querySelector('#tz-v2-changes')?.scrollIntoView({ block: 'start' })`);
await new Promise(resolve => setTimeout(resolve, 300));
evidence.phoneDesktopLayout = await evaluate(`(() => {
  const body = document.querySelector('#tz-v2-changes .tz-change-body');
  const columns = body ? getComputedStyle(body).gridTemplateColumns.split(' ').filter(Boolean).length : 0;
  return columns === 2 &&
    document.documentElement.scrollWidth >= 1120 &&
    !document.querySelector('.mobile-registry');
})()`);
await screenshot('/private/tmp/nvr270-html-tz-desktop-on-phone.png');

await command('Emulation.setDeviceMetricsOverride', {
  width: 1440,
  height: 1000,
  deviceScaleFactor: 1,
  mobile: false,
});
await evaluate(`document.querySelector('#tz-v2-trace')?.scrollIntoView({ block: 'start' })`);
await new Promise(resolve => setTimeout(resolve, 300));

await clickButton('Финансовый итог сделки');
await waitFor(
  `document.body.innerText.toLocaleUpperCase('ru').includes('СУММА ДОКУМЕНТОВ СДЕЛКИ') &&
   document.body.innerText.includes('Автоимпорт счетов и коммерческих предложений из Bitrix24')`,
  'traceability link to deal screen',
);
evidence.traceabilityLinkWorks = true;
evidence.noRuntimeError = await evaluate(`!document.getElementById('__bundler_err')`);
evidence.allPassed = Object.values(evidence).every(value => value === true);

console.log(JSON.stringify(evidence, null, 2));
await command('Emulation.clearDeviceMetricsOverride');
socket.close();
if (!evidence.allPassed) process.exitCode = 1;
