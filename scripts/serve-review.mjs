import { createServer } from 'node:http';
import { readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDirectory, '..');
const indexPath = path.join(root, 'index.html');
const portArgument = process.argv.find((value, index) => process.argv[index - 1] === '--port');
const port = Number(portArgument || process.env.TERMECH_REVIEW_PORT || 4174);
const dataPath = process.env.TERMECH_REVIEW_DATA
  || '/private/tmp/termech-client-review-comments.json';
const temporaryDataPath = `${dataPath}.next`;

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(body);
}

async function readComments() {
  try {
    const payload = JSON.parse(await readFile(dataPath, 'utf8'));
    return Array.isArray(payload.comments) ? payload.comments : [];
  } catch (error) {
    if (error && error.code === 'ENOENT') return [];
    throw error;
  }
}

async function writeComments(comments) {
  const payload = JSON.stringify({
    version: 1,
    comments,
    updatedAt: new Date().toISOString(),
  });
  await writeFile(temporaryDataPath, payload, 'utf8');
  await rename(temporaryDataPath, dataPath);
}

async function readRequestBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 512 * 1024) throw new Error('PAYLOAD_TOO_LARGE');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url || '/', `http://${request.headers.host || '127.0.0.1'}`);
  try {
    if (url.pathname === '/api/comments' && request.method === 'GET') {
      sendJson(response, 200, {
        version: 1,
        comments: await readComments(),
        updatedAt: new Date().toISOString(),
      });
      return;
    }

    if (url.pathname === '/api/comments' && request.method === 'PUT') {
      const payload = JSON.parse(await readRequestBody(request));
      if (!payload || !Array.isArray(payload.comments)) {
        sendJson(response, 400, { error: 'Поле comments должно быть массивом.' });
        return;
      }
      const current = await readComments();
      const mergedById = new Map(current.map(comment => [comment.id, comment]));
      payload.comments.forEach(comment => {
        if (comment && typeof comment.id === 'string') mergedById.set(comment.id, comment);
      });
      const comments = Array.from(mergedById.values());
      await writeComments(comments);
      sendJson(response, 200, {
        version: 1,
        comments,
        updatedAt: new Date().toISOString(),
      });
      return;
    }

    if ((url.pathname === '/' || url.pathname === '/index.html') && request.method === 'GET') {
      const html = await readFile(indexPath);
      response.writeHead(200, {
        'Cache-Control': 'no-store',
        'Content-Length': html.length,
        'Content-Type': 'text/html; charset=utf-8',
        'X-Content-Type-Options': 'nosniff',
      });
      response.end(html);
      return;
    }

    if (url.pathname === '/health' && request.method === 'GET') {
      sendJson(response, 200, { status: 'ok' });
      return;
    }

    sendJson(response, 404, { error: 'Не найдено.' });
  } catch (error) {
    if (error && error.message === 'PAYLOAD_TOO_LARGE') {
      sendJson(response, 413, { error: 'Слишком большой запрос.' });
      return;
    }
    sendJson(response, 500, { error: 'Не удалось обработать запрос.' });
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Client review server: http://127.0.0.1:${port}`);
  console.log(`Shared comments: ${dataPath}`);
});
