import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  createHalationParams,
  getWasmBackendStatus,
  installWasmModule,
  processHalation,
  resetWasmBackend,
  tryWasmBoxBlur,
} from '../../src/core/index.js';
import { boxBlur3 } from '../../src/core/diffuse/box.js';

const wasmPath = fileURLToPath(new URL('../../assets/film_core.wasm', import.meta.url));

test('WASM three-box blur matches the JavaScript fallback', async (t) => {
  if (!existsSync(wasmPath)) {
    t.skip('assets/film_core.wasm not built; run npm run build:wasm');
    return;
  }
  const bytes = readFileSync(wasmPath);
  const status = await installWasmModule(bytes);
  assert.equal(status.available, true, status.error || 'WASM available');
  assert.equal(getWasmBackendStatus().version, 0x010500);
  const width = 73;
  const height = 41;
  const n = width * height;
  const source = new Float32Array(n);
  for (let i = 0; i < n; i++) source[i] = ((i * 2654435761) >>> 8) / 0xffffff;
  const js = new Float32Array(n);
  boxBlur3(source, js, new Float32Array(n), new Float32Array(n), width, height, 7.25);
  const wasm = new Float32Array(n);
  assert.equal(tryWasmBoxBlur(source, wasm, width, height, 7.25), true);
  let rms = 0;
  let max = 0;
  for (let i = 0; i < n; i++) {
    const delta = wasm[i] - js[i];
    rms += delta * delta;
    max = Math.max(max, Math.abs(delta));
  }
  rms = Math.sqrt(rms / n);
  assert.ok(rms <= 2e-6, `RMS=${rms}`);
  assert.ok(max <= 1e-5, `max=${max}`);
  resetWasmBackend();
  assert.equal(getWasmBackendStatus().backend, 'js');
});

test('WASM complete Fast pipeline matches the compact JavaScript fallback', async (t) => {
  if (!existsSync(wasmPath)) {
    t.skip('assets/film_core.wasm not built; run npm run build:wasm');
    return;
  }
  const width = 89;
  const height = 57;
  const n = width * height;
  const rgb = new Float32Array(n * 3);
  const alpha = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const p = i * 3;
    const noise = ((i * 2654435761) >>> 9) / 0x7fffff;
    rgb[p] = noise * 1.8;
    rgb[p + 1] = noise * 1.1 + (i % 17 === 0 ? 1.25 : 0);
    rgb[p + 2] = noise * 0.65 + (i % 29 === 0 ? 1.75 : 0);
    alpha[i] = (i % 23) / 22;
  }
  const input = { width, height, rgb, alpha };
  const variants = [
    createHalationParams({ strength: 67, sigma: 11.25, diffusionMode: 'fast' }),
    createHalationParams({
      strength: 91,
      sigma: 18.5,
      diffusionMode: 'fast',
      extraction: 'spill',
      spillMix: 0.72,
      blendMode: 'screen',
      sourceSoftness: 0,
      backgroundSoftness: 0,
    }),
  ];
  for (const params of variants) {
    resetWasmBackend();
    const js = processHalation(input, params, { compact: true });
    const status = await installWasmModule(readFileSync(wasmPath));
    assert.equal(status.available, true, status.error || 'WASM available');
    const wasm = processHalation(input, params, { compact: true });
    assert.equal(wasm.stats.backend, 'wasm');
    assert.deepEqual(wasm.alpha, alpha, 'alpha is byte-identical');
    let rms = 0;
    let max = 0;
    for (let i = 0; i < js.rgb.length; i++) {
      const delta = wasm.rgb[i] - js.rgb[i];
      rms += delta * delta;
      max = Math.max(max, Math.abs(delta));
    }
    rms = Math.sqrt(rms / js.rgb.length);
    assert.ok(rms <= 1e-4, `RMS=${rms}`);
    assert.ok(max <= 1e-3, `max=${max}`);
  }
  resetWasmBackend();
});

test('invalid WASM fails closed to JavaScript', async () => {
  resetWasmBackend();
  const status = await installWasmModule(new Uint8Array([0, 1, 2, 3]));
  assert.equal(status.available, false);
  assert.equal(status.backend, 'js');
});
