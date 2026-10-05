import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/server/server.js';

let server;
let base;

before(async () => {
  await new Promise((resolve) => {
    server = createServer().listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  base = `http://127.0.0.1:${port}`;
});

after(() => server.close());

test('GET /healthz 返回 200 与 status ok', async () => {
  const res = await fetch(`${base}/healthz`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'ok');
});

test('GET / 返回页面 HTML', async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  const html = await res.text();
  assert.match(html, /检查点/);
});

test('GET /assets/app.js 返回 JS（构建产物或开发兜底）', async () => {
  const res = await fetch(`${base}/assets/app.js`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /javascript/);
});

test('未知路径 404', async () => {
  const res = await fetch(`${base}/nope`);
  assert.equal(res.status, 404);
});
