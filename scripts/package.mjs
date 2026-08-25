/**
 * Package one UXP identity from the shared source tree.
 *
 *   node scripts/package.mjs current  -> V1.6 new-ID importer
 *   node scripts/package.mjs bridge   -> V1.5.2 old-ID exporter
 */
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT_DIR = join(ROOT, 'dist');
const variant = process.argv[2] || 'current';
if (!['current', 'bridge'].includes(variant)) throw new Error(`Unknown package variant: ${variant}`);

const currentManifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));
const definition = variant === 'bridge'
  ? {
      pluginId: 'com.cheukwing.filmhalation',
      migrationRole: 'export',
      version: '1.5.2',
      fileName: 'FilmHalation-MigrationBridge.ccx',
      panelLabel: 'Film Halation Migration',
    }
  : {
      pluginId: 'com.cheukwing.filmemulation',
      migrationRole: 'import',
      version: currentManifest.version,
      fileName: 'FilmEmulation.ccx',
      panelLabel: 'Film Halation',
    };

if (process.env.FILM_SKIP_WASM_BUILD !== '1') {
  execFileSync(process.execPath, [join(ROOT, 'scripts', 'build-wasm.mjs')], { cwd: ROOT, stdio: 'inherit' });
}
execFileSync(process.execPath, [join(ROOT, 'esbuild.config.mjs')], {
  cwd: ROOT,
  stdio: 'inherit',
  env: {
    ...process.env,
    FILM_PLUGIN_ID: definition.pluginId,
    FILM_MIGRATION_ROLE: definition.migrationRole,
  },
});

const stage = join(OUT_DIR, `ccx-stage-${variant}`);
rmSync(stage, { recursive: true, force: true });
mkdirSync(join(stage, 'dist'), { recursive: true });
const manifest = {
  ...currentManifest,
  id: definition.pluginId,
  version: definition.version,
  entrypoints: currentManifest.entrypoints.map((entry) => ({
    ...entry,
    label: { ...entry.label, default: definition.panelLabel },
  })),
};
writeFileSync(join(stage, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
copyFileSync(join(ROOT, 'index.html'), join(stage, 'index.html'));
for (const fileName of ['main.js', 'main.js.map', 'film_core.wasm']) {
  copyFileSync(join(OUT_DIR, fileName), join(stage, 'dist', fileName));
}

const ccx = join(OUT_DIR, definition.fileName);
const zip = join(OUT_DIR, `${definition.fileName}.zip`);
rmSync(ccx, { force: true });
rmSync(zip, { force: true });
execFileSync('powershell', [
  '-NoProfile',
  '-Command',
  `Compress-Archive -Path '${join(stage, '*')}' -DestinationPath '${zip}' -Force`,
], { stdio: 'inherit' });
renameSync(zip, ccx);
rmSync(stage, { recursive: true, force: true });
console.log(`package (${variant}): ${ccx} (${existsSync(ccx) ? 'OK' : 'FAILED'})`);
