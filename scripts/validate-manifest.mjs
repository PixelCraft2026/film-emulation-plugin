/**
 * Minimal manifest.json structural validation for UXP.
 * Checks required fields and PS host entry; exits non-zero on failure.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const manifestPath = fileURLToPath(new URL('../manifest.json', import.meta.url));
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const packageJson = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'));

const required = ['id', 'name', 'version', 'main', 'host', 'manifestVersion', 'entrypoints'];
const missing = required.filter((key) => !(key in manifest));
if (missing.length > 0) {
  console.error(`manifest.json validation FAILED — missing: ${missing.join(', ')}`);
  process.exit(1);
}

const psHost = Array.isArray(manifest.host)
  ? manifest.host.find((entry) => entry.app === 'PS')
  : manifest.host;
if (!psHost || psHost.app !== 'PS') {
  console.error('manifest.json validation FAILED — no PS host entry');
  process.exit(1);
}

if (manifest.manifestVersion !== 4) {
  console.error(`manifest.json validation FAILED — manifestVersion must be 4, got ${manifest.manifestVersion}`);
  process.exit(1);
}

if (manifest.id !== 'com.cheukwing.filmemulation') {
  console.error(`manifest.json validation FAILED — expected new plugin id, got ${manifest.id}`);
  process.exit(1);
}
const panels = manifest.entrypoints.filter((entry) => entry.type === 'panel');
if (
  manifest.name !== 'Film Emulation'
  || panels.length !== 1
  || panels[0].id !== 'filmEmulationPanel'
  || panels[0].label?.default !== 'Film Emulation'
) {
  console.error('manifest.json validation FAILED — current plugin/panel identity must be Film Emulation / filmEmulationPanel');
  process.exit(1);
}
if (packageJson.name !== 'film-emulation' || packageJson.version !== manifest.version) {
  console.error('manifest/package identity mismatch');
  process.exit(1);
}
if (
  manifest.version !== '1.7.0'
  || !packageJson.description.includes('Film Emulation V1.7 Public Beta 1')
  || !packageJson.description.includes('Windows test build')
) {
  console.error('manifest/package release identity must be Film Emulation V1.7 Public Beta 1 / 1.7.0 / Windows test build');
  process.exit(1);
}
if (packageJson.scripts?.['package:migration'] || packageJson.scripts?.['package:migration-bridge']) {
  console.error('retired migration bridge scripts must not be exposed by the public beta package');
  process.exit(1);
}

console.log(
  'manifest.json validation OK (name=%s, id=%s, panel=%s, minVersion=%s)',
  manifest.name,
  manifest.id,
  panels[0].id,
  psHost.minVersion,
);
