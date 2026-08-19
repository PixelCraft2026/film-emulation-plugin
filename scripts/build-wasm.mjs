/** Build the Rust low-level ABI module and copy the release artifact into assets/. */
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const manifest = join(root, 'native', 'film_core', 'Cargo.toml');
const cargoHome = process.env.USERPROFILE ? join(process.env.USERPROFILE, '.cargo', 'bin') : '';
const cargo = cargoHome && existsSync(join(cargoHome, 'cargo.exe')) ? join(cargoHome, 'cargo.exe') : 'cargo';
const result = spawnSync(cargo, ['build', '--manifest-path', manifest, '--target', 'wasm32-unknown-unknown', '--release'], {
  cwd: root,
  stdio: 'inherit',
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

const source = join(root, 'native', 'film_core', 'target', 'wasm32-unknown-unknown', 'release', 'film_core.wasm');
const assets = join(root, 'assets');
const target = join(assets, 'film_core.wasm');
mkdirSync(assets, { recursive: true });
copyFileSync(source, target);
console.log(`wasm: ${target}`);
