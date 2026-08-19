/**
 * 打包脚本：esbuild 产物 + manifest + index.html → .ccx（UXP 安装包，zip 格式）。
 * 用法：npm run package（= node scripts/package.mjs）
 * 输出：dist/FilmHalation.ccx
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT_DIR = join(ROOT, 'dist');
const CCX = join(OUT_DIR, 'FilmHalation.ccx');
const STAGE = join(OUT_DIR, 'ccx-stage');

// 1) build（确保最新 bundle；直接用 node 跑 esbuild 配置，避免 .cmd spawn 问题）
execFileSync('node', [join(ROOT, 'scripts', 'build-wasm.mjs')], { cwd: ROOT, stdio: 'inherit' });
execFileSync('node', [join(ROOT, 'esbuild.config.mjs')], { cwd: ROOT, stdio: 'inherit' });

// 2) 组装 stage：manifest.json + index.html + dist/main.js
rmSync(STAGE, { recursive: true, force: true });
mkdirSync(join(STAGE, 'dist'), { recursive: true });
const copy = (src, dst) => execFileSync('cmd', ['/c', 'copy', '/Y', src, dst], { stdio: 'inherit' });
copy(join(ROOT, 'manifest.json'), STAGE);
copy(join(ROOT, 'index.html'), STAGE);
copy(join(OUT_DIR, 'main.js'), join(STAGE, 'dist'));
copy(join(OUT_DIR, 'main.js.map'), join(STAGE, 'dist'));
copy(join(OUT_DIR, 'film_core.wasm'), join(STAGE, 'dist'));

// 3) 压缩为 zip，再重命名 .ccx（Compress-Archive 只接受 .zip 扩展名）
rmSync(CCX, { force: true });
const ZIP = join(OUT_DIR, 'FilmHalation.zip');
rmSync(ZIP, { force: true });
execFileSync('powershell', [
  '-NoProfile', '-Command',
  `Compress-Archive -Path '${join(STAGE, '*')}' -DestinationPath '${ZIP}' -Force`,
], { stdio: 'inherit' });
execFileSync('cmd', ['/c', 'ren', ZIP, 'FilmHalation.ccx'], { stdio: 'inherit' });
rmSync(STAGE, { recursive: true, force: true });
console.log(`package: ${CCX} (${existsSync(CCX) ? 'OK' : 'FAILED'})`);
