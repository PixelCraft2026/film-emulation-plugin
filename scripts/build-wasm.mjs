/** Build the Rust low-level ABI modules and copy both release artifacts into assets/. */
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const manifest = join(root, 'native', 'film_core', 'Cargo.toml');
const cargoHome = process.env.USERPROFILE ? join(process.env.USERPROFILE, '.cargo', 'bin') : '';
const cargo = cargoHome && existsSync(join(cargoHome, 'cargo.exe')) ? join(cargoHome, 'cargo.exe') : 'cargo';
const source = join(root, 'native', 'film_core', 'target', 'wasm32-unknown-unknown', 'release', 'film_core.wasm');
const assets = join(root, 'assets');
mkdirSync(assets, { recursive: true });

function build(args, env, destination) {
  const result = spawnSync(cargo, args, {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, ...env },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
  if (!existsSync(source)) throw new Error(`WASM build did not produce ${source}`);
  const target = join(assets, destination);
  copyFileSync(source, target);
  console.log(`wasm: ${target}`);
}

build(['build', '--manifest-path', manifest, '--target', 'wasm32-unknown-unknown', '--release'], {}, 'film_core.wasm');
// SIMD remains an independent opt-in artifact. Runtime qualification can
// reject it without affecting the scalar module or minimum Photoshop version.
build(
  ['build', '--manifest-path', manifest, '--target', 'wasm32-unknown-unknown', '--release', '--features', 'simd'],
  { RUSTFLAGS: `${process.env.RUSTFLAGS ?? ''} -C target-feature=+simd128` },
  'film_core_simd.wasm',
);
