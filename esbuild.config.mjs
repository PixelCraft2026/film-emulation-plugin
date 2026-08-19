import esbuild from 'esbuild';
import { copyFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('.', import.meta.url));

/** UXP panel bundle: self-contained IIFE, browser-ish platform (UXP provides DOM globals). */
const options = {
  absWorkingDir: ROOT,
  entryPoints: ['./src/main.jsx'],
  bundle: true,
  outfile: './dist/main.js',
  format: 'iife',
  platform: 'browser',
  target: 'es2020',
  jsx: 'transform',
  sourcemap: true,
  logLevel: 'info',
  // UXP runtime modules — never bundled.
  external: ['photoshop', 'uxp'],
};

await esbuild.build(options);
const wasm = join(ROOT, 'assets', 'film_core.wasm');
if (existsSync(wasm)) copyFileSync(wasm, join(ROOT, 'dist', 'film_core.wasm'));
console.log('build: dist/main.js written');
