/**
 * 一键构建"静态直连版"并同步到仓库根目录的 docs/（GitHub Pages 分支部署用）。
 *
 * 为什么要这个脚本：docs/ 是**构建产物**，改了代码不重新构建，线上就一直是旧版。
 * 手抄命令容易漏掉 PAGES_BASE / VITE_STATIC_DEMO 这两个环境变量，所以固化在这里。
 *
 * 用法（在 apps/writing-style-lab 目录下）：
 *   npm run build:pages
 *
 * 发布方式：GitHub Pages → Deploy from a branch → main / docs
 */
import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const distDir = resolve(appDir, 'dist/web');
const docsDir = resolve(appDir, '../../docs');

// 必须在 import vite 之前设好：vite.config.ts 读的是 process.env。
process.env.PAGES_BASE = process.env.PAGES_BASE ?? '/novel-writing-skill/';
process.env.VITE_STATIC_DEMO = '1';

console.log(`[build:pages] PAGES_BASE=${process.env.PAGES_BASE}  VITE_STATIC_DEMO=1`);

const { build } = await import('vite');
await build({ configFile: resolve(appDir, 'vite.config.ts'), root: appDir });

if (!existsSync(resolve(distDir, 'index.html'))) {
  console.error('[build:pages] 构建产物里没有 index.html，中止');
  process.exit(1);
}

await rm(docsDir, { recursive: true, force: true });
await mkdir(docsDir, { recursive: true });
await cp(distDir, docsDir, { recursive: true });
// .nojekyll：别让 Pages 走 Jekyll 处理（虽然我们的目录名不带下划线，防患于未然）
await writeFile(resolve(docsDir, '.nojekyll'), '');

console.log(`[build:pages] 已同步到 ${docsDir}`);
console.log('[build:pages] 下一步：git add docs && git commit && git push（Pages 会自动重建）');
