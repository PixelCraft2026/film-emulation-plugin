/**
 * Package the single public Film Emulation identity.
 * The pre-public old-ID migration bridge is intentionally not distributed.
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
import {
  PUBLIC_DIST_FILES,
  PUBLIC_PACKAGE_ENTRIES,
  assertPublicBundleText,
  assertPublicPackageEntries,
} from './public-package-policy.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT_DIR = join(ROOT, 'dist');
const currentManifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));
const definition = {
  pluginId: 'com.cheukwing.filmemulation',
  version: currentManifest.version,
  fileName: 'FilmEmulation.ccx',
  pluginName: 'Film Emulation',
  entrypointId: 'filmEmulationPanel',
  panelLabel: 'Film Emulation',
  htmlTitle: 'Film Emulation',
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
  },
});

const bundleText = readFileSync(join(OUT_DIR, 'main.js'), 'utf8');
assertPublicBundleText(bundleText);

const stage = join(OUT_DIR, 'ccx-stage-public-beta');
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
copyFileSync(join(ROOT, 'LICENSE'), join(stage, 'LICENSE'));
const indexHtml = readFileSync(join(ROOT, 'index.html'), 'utf8')
  .replace(/<title>[^<]*<\/title>/, `<title>${definition.htmlTitle}</title>`);
writeFileSync(join(stage, 'index.html'), indexHtml);
for (const fileName of PUBLIC_DIST_FILES) {
  copyFileSync(join(OUT_DIR, fileName), join(stage, 'dist', fileName));
}
assertPublicPackageEntries(PUBLIC_PACKAGE_ENTRIES);

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
console.log(`package (public beta): ${ccx} (${existsSync(ccx) ? 'OK' : 'FAILED'})`);
