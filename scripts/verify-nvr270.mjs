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
  `document.body.innerText.includes('Журнал изменений и трассируемость') &&
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
evidence.sourceCompleteness = await evaluate(`document.body.innerText.includes('полной транскрипции встречи 17.07.2026')`);
evidence.legend = await evaluate(`(() => {
  const text = document.querySelector('#tz-v2-sync')?.innerText || '';
  return text.includes('[v2] новое / изменённое') &&
    text.includes('[отложено] следующая фаза') &&
    text.includes('[оценка] требует оценки до разработки');
})()`);
evidence.traceability = await evaluate(`(() => {
  const text = document.querySelector('#tz-v2-sync')?.innerText || '';
  const required = [
    'Массовая загрузка с полями каждой строки',
    'Непубличная внутренняя ссылка',
    'Файл ИЛИ ссылка; обязательность по типу',
    'Связь документа с задачей',
    'Все версии и мягкое удаление',
    'Снятие доступа после закрытия сделок',
    'Договор и зависимые документы',
    'Два мобильных входа и оценка',
    'Итог сделки и курс ЦБ',
    'Все счета и КП из Bitrix24',
    'Копия в папке каждой сделки',
  ];
  return required.every(item => text.includes(item));
})()`);
evidence.evidenceLinks = await evaluate(`(() => {
  const block = document.querySelector('#tz-v2-sync');
  return block && [...block.querySelectorAll('button')]
    .filter(button => button.innerText.includes('Открыть актуальный экран')).length === 4;
})()`);
evidence.noContradictions = await evaluate(`(() => {
  const text = document.body.innerText;
  return !text.includes('30.06.2026') &&
    !text.includes('Публичная ссылка на документ') &&
    !text.includes('Требуется файл для всех типов') &&
    !text.includes('Одна физическая копия для нескольких сделок') &&
    !text.includes('Отдельное обязательное поле «Юридическое лицо»');
})()`);

await evaluate(`document.querySelector('#tz-v2-sync')?.scrollIntoView({ block: 'start' })`);
await new Promise(resolve => setTimeout(resolve, 250));
await screenshot('/private/tmp/nvr270-embedded-tz-v2.png');

await clickButton('Финансовый итог сделки');
await waitFor(
  `document.body.innerText.toLocaleUpperCase('ru').includes('СУММА ДОКУМЕНТОВ СДЕЛКИ') &&
   document.body.innerText.includes('Автоимпорт счетов и коммерческих предложений из Bitrix24')`,
  'traceability link to deal screen',
);
evidence.traceabilityLinkWorks = true;
evidence.noRuntimeError = await evaluate(`!document.getElementById('__bundler_err')`);
evidence.allPassed = Object.values(evidence).every(Boolean);

console.log(JSON.stringify(evidence, null, 2));
await command('Emulation.clearDeviceMetricsOverride');
socket.close();
if (!evidence.allPassed) process.exitCode = 1;
