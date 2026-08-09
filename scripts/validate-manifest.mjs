/**
 * Minimal manifest.json structural validation for UXP.
 * Checks required fields and PS host entry; exits non-zero on failure.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const manifestPath = fileURLToPath(new URL('../manifest.json', import.meta.url));
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

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

console.log('manifest.json validation OK (id=%s, minVersion=%s)', manifest.id, psHost.minVersion);
