// 极简静态服务器，无第三方运行时依赖。
// 路由：
//   GET /healthz        健康响应 JSON
//   GET /               页面
//   GET /assets/*       构建产物
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { existsSync } from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const DIST = path.join(ROOT, 'dist');
const WEB = path.join(ROOT, 'src/web');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

async function serveFile(res, filePath) {
  try {
    const body = await readFile(filePath);
    const ext = path.extname(filePath);
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
  }
}

export function createServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        status: 'ok',
        service: 'deep-sea-checkpoint-replay',
        time: new Date().toISOString(),
      }));
      return;
    }
    if (req.method !== 'GET') {
      res.writeHead(405).end('Method Not Allowed');
      return;
    }
    if (url.pathname === '/') {
      const distHtml = path.join(DIST, 'index.html');
      return serveFile(res, existsSync(distHtml) ? distHtml : path.join(WEB, 'index.html'));
    }
    if (url.pathname.startsWith('/assets/')) {
      const name = path.basename(url.pathname);
      const distFile = path.join(DIST, name);
      if (existsSync(distFile)) return serveFile(res, distFile);
      // 未构建时的开发兜底
      if (name === 'styles.css') return serveFile(res, path.join(WEB, 'styles.css'));
      if (name === 'app.js' || name === 'worker.js') {
        res.writeHead(200, { 'Content-Type': MIME['.js'] });
        return res.end(await readFile(path.join(WEB, name === 'app.js' ? 'app.js' : 'worker.js')));
      }
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
  });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const port = Number(process.env.PORT || 8080);
  const host = process.env.HOST || '0.0.0.0';
  createServer().listen(port, host, () => {
    console.log(`[web] listening on http://${host}:${port}`);
  });
}
