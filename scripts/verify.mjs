// verify 编排：代码测试（屏障/恢复/错误边界）→ 页面构建 → HTTP 冒烟。
// 任一步失败即以非零退出码报告全部结果，供容器 verify 服务使用。
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { once } from 'node:events';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function run(name, args, { env } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: ROOT,
      env: { ...process.env, ...(env || {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; process.stdout.write(`[${name}] ${d}`); });
    child.stderr.on('data', (d) => { err += d; process.stderr.write(`[${name}] ${d}`); });
    child.on('close', (code) => resolve({ name, code, out, err }));
  });
}

async function httpSmoke(port) {
  // 直接以子进程启动正式服务器并发起真实 HTTP 请求
  const child = spawn(process.execPath, [path.join(ROOT, 'src/server/server.js')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => { log += d; process.stdout.write(`[http] ${d}`); });
  child.stderr.on('data', (d) => { log += d; process.stderr.write(`[http] ${d}`); });

  const deadline = Date.now() + 10000;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (res.status === 200) {
        const body = await res.json();
        const page = await fetch(`http://127.0.0.1:${port}/`);
        const js = await fetch(`http://127.0.0.1:${port}/assets/app.js`);
        child.kill('SIGTERM');
        await once(child, 'close').catch(() => {});
        if (body.status !== 'ok' || page.status !== 200 || js.status !== 200) {
          return { name: 'http-smoke', code: 1, err: `响应异常 healthz=${body.status} /=${page.status} app.js=${js.status}` };
        }
        return { name: 'http-smoke', code: 0 };
      }
      lastErr = new Error(`status ${res.status}`);
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  child.kill('SIGTERM');
  await once(child, 'close').catch(() => {});
  return { name: 'http-smoke', code: 1, err: String(lastErr) + '\n' + log };
}

async function main() {
  const results = [];

  results.push(await run('unit-tests', ['--test', 'test/aligner.test.js', 'test/replayer.test.js']));
  results.push(await run('build', [path.join(ROOT, 'scripts/build.mjs')]));
  results.push(await run('test-smoke', ['--test', 'test/http.smoke.test.js']));
  results.push(await httpSmoke(Number(process.env.SMOKE_PORT || 8099)));

  const failed = results.filter((r) => r.code !== 0);
  console.log('\n========== verify 汇总 ==========');
  for (const r of results) {
    console.log(`${r.code === 0 ? 'PASS' : 'FAIL'}  ${r.name} (exit ${r.code})${r.err ? ' — ' + r.err.split('\n')[0] : ''}`);
  }
  console.log('=================================');
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
