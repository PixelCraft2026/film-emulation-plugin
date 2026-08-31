import esbuild from 'esbuild';
import { copyFileSync, existsSync, rmSync } from 'node:fs';
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
// Keep SIMD in assets for Node QA only. A real Photoshop 27.1 / UXP 9.0.2
// A/B run proved that merely loading the current SIMD artifact can terminate
// the host process, so standard UXP bundles must be scalar-only.
rmSync(join(ROOT, 'dist', 'film_core_simd.wasm'), { force: true });
console.log('build: dist/main.js written');
