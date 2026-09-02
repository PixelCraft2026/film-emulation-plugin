import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PUBLIC_PACKAGE_ENTRIES,
  assertPublicBundleText,
  assertPublicPackageEntries,
} from '../../scripts/public-package-policy.mjs';

test('public beta package is one scalar-only bundle without migration UI', () => {
  assert.deepEqual(PUBLIC_PACKAGE_ENTRIES, [
    'manifest.json',
    'index.html',
    'dist/main.js',
    'dist/main.js.map',
    'dist/film_core.wasm',
  ]);
  assert.equal(PUBLIC_PACKAGE_ENTRIES.some((entry) => /simd|migration/i.test(entry)), false);
  assert.doesNotThrow(() => assertPublicPackageEntries(PUBLIC_PACKAGE_ENTRIES));
});

test('public beta bundle policy requires Windows label and rejects retired identities', () => {
  const valid = [
    'Film Emulation V1.7 Public Beta 1', 'Windows test build',
    'Film Resolution', 'Randomize grain', 'Apply memory', 'Language',
  ].join(' ');
  assert.doesNotThrow(() => assertPublicBundleText(valid));
  assert.throws(() => assertPublicBundleText(`${valid} film_core_simd.wasm`), /unsafe marker/);
  assert.throws(() => assertPublicBundleText(`${valid} com.cheukwing.filmhalation`), /unsafe marker/);
});
