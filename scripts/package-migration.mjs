/** Build the old-ID bridge and new-ID plugin; leave dist/main.js as the importer. */
import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
execFileSync(process.execPath, [join(ROOT, 'scripts', 'build-wasm.mjs')], { cwd: ROOT, stdio: 'inherit' });
const env = { ...process.env, FILM_SKIP_WASM_BUILD: '1' };
execFileSync(process.execPath, [join(ROOT, 'scripts', 'package.mjs'), 'bridge'], { cwd: ROOT, stdio: 'inherit', env });
execFileSync(process.execPath, [join(ROOT, 'scripts', 'package.mjs'), 'current'], { cwd: ROOT, stdio: 'inherit', env });
rmSync(join(ROOT, 'dist', 'FilmHalation.ccx'), { force: true });
console.log('migration packages: bridge + current ready');

