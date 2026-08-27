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
      pluginName: 'Film Halation',
      entrypointId: 'filmHalationPanel',
      panelLabel: 'Film Halation Migration',
      htmlTitle: 'Film Halation Migration',
      featureLevel: 'v1.5-bridge',
    }
  : {
      pluginId: 'com.cheukwing.filmemulation',
      migrationRole: 'import',
      version: currentManifest.version,
      fileName: 'FilmEmulation.ccx',
      pluginName: 'Film Emulation',
      entrypointId: 'filmEmulationPanel',
      panelLabel: 'Film Emulation',
      htmlTitle: 'Film Emulation',
      featureLevel: 'current',
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
    FILM_FEATURE_LEVEL: definition.featureLevel,
  },
});

const bundleText = readFileSync(join(OUT_DIR, 'main.js'), 'utf8');
if (!bundleText.includes(definition.featureLevel)) {
  throw new Error(`Bundle feature gate missing for ${definition.featureLevel}`);
}
const v16UiMarkers = ['Film Resolution', 'Randomize grain', 'GRN / 70'];
if (variant === 'bridge' && v16UiMarkers.some((marker) => bundleText.includes(marker))) {
  throw new Error('Migration bridge bundle exposes V1.6 UI text');
}
if (variant === 'current' && !v16UiMarkers.every((marker) => bundleText.includes(marker))) {
  throw new Error('Current bundle is missing V1.6 UI');
}

const stage = join(OUT_DIR, `ccx-stage-${variant}`);
rmSync(stage, { recursive: true, force: true });
mkdirSync(join(stage, 'dist'), { recursive: true });
const manifest = {
  ...currentManifest,
  id: definition.pluginId,
  name: definition.pluginName,
  version: definition.version,
  entrypoints: currentManifest.entrypoints.map((entry) => ({
    ...entry,
    id: definition.entrypointId,
    label: { ...entry.label, default: definition.panelLabel },
  })),
};
writeFileSync(join(stage, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
const indexHtml = readFileSync(join(ROOT, 'index.html'), 'utf8')
  .replace(/<title>[^<]*<\/title>/, `<title>${definition.htmlTitle}</title>`);
writeFileSync(join(stage, 'index.html'), indexHtml);
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
