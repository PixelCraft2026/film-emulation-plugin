import esbuild from 'esbuild';
import { copyFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const pluginId = process.env.FILM_PLUGIN_ID || 'com.cheukwing.filmemulation';
const migrationRole = process.env.FILM_MIGRATION_ROLE || 'import';
const featureLevel = process.env.FILM_FEATURE_LEVEL || 'current';

/** UXP panel bundle: self-contained IIFE, browser-ish platform (UXP provides DOM globals). */
const options = {
  absWorkingDir: ROOT,
  entryPoints: [join(ROOT, 'src', 'main.jsx')],
  bundle: true,
  outfile: join(ROOT, 'dist', 'main.js'),
  format: 'iife',
  platform: 'browser',
  target: 'es2020',
  jsx: 'transform',
  sourcemap: true,
  minifySyntax: true,
  logLevel: 'info',
  // UXP runtime modules — never bundled.
  external: ['photoshop', 'uxp'],
  define: {
    __FILM_PLUGIN_ID__: JSON.stringify(pluginId),
    __FILM_MIGRATION_ROLE__: JSON.stringify(migrationRole),
    __FILM_FEATURE_LEVEL__: JSON.stringify(featureLevel),
  },
};

await esbuild.build(options);
const wasm = join(ROOT, 'assets', 'film_core.wasm');
if (existsSync(wasm)) copyFileSync(wasm, join(ROOT, 'dist', 'film_core.wasm'));
const wasmSimd = join(ROOT, 'assets', 'film_core_simd.wasm');
if (existsSync(wasmSimd)) copyFileSync(wasmSimd, join(ROOT, 'dist', 'film_core_simd.wasm'));
console.log('build: dist/main.js written');
