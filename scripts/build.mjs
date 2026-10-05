// 页面构建：用 esbuild 打包主线程与 Worker 两个入口到 dist/，
// 并拷贝 index.html / styles.css。
import { build } from 'esbuild';
import { copyFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');

async function main() {
  await rm(DIST, { recursive: true, force: true });
  await mkdir(DIST, { recursive: true });

  await build({
    entryPoints: {
      app: path.join(ROOT, 'src/web/app.js'),
      worker: path.join(ROOT, 'src/web/worker.js'),
    },
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: ['es2020'],
    outdir: DIST,
    logLevel: 'info',
  });

  await copyFile(path.join(ROOT, 'src/web/index.html'), path.join(DIST, 'index.html'));
  await copyFile(path.join(ROOT, 'src/web/styles.css'), path.join(DIST, 'styles.css'));
  console.log('[build] dist/ ready');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
