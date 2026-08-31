import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BUNDLED_SIMD_POLICY,
  loadBundledWasm,
} from '../../src/io/wasmRuntime.js';

test('UXP bundled WASM startup reads and installs scalar only', async () => {
  const scalarBytes = new Uint8Array([0, 97, 115, 109]);
  const requested = [];
  const storage = {
    formats: { binary: 'binary' },
    localFileSystem: {
      async getPluginFolder() {
        return {
          async getEntry(name) {
            requested.push(name);
            assert.equal(name, 'dist');
            return {
              async getEntry(fileName) {
                requested.push(fileName);
                assert.notEqual(fileName, 'film_core_simd.wasm', 'UXP must never touch the SIMD artifact');
                assert.equal(fileName, 'film_core.wasm');
                return {
                  async read({ format }) {
                    assert.equal(format, 'binary');
                    return scalarBytes;
                  },
                };
              },
            };
          },
        };
      },
    },
  };
  let installArguments = null;
  const status = await loadBundledWasm({
    storage,
    async install(...args) {
      installArguments = args;
      return { available: true, backend: 'wasm-resident-scalar' };
    },
  });

  assert.deepEqual(requested, ['dist', 'film_core.wasm']);
  assert.equal(installArguments.length, 1, 'SIMD bytes are not passed to the backend installer');
  assert.equal(installArguments[0], scalarBytes);
  assert.equal(status.available, true);
  assert.equal(status.backend, 'wasm-resident-scalar');
  assert.equal(status.simdPolicy, BUNDLED_SIMD_POLICY);
});
