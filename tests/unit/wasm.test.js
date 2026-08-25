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
  tryWasmGaussianBlur,
  tryWasmMaxFilter,
  tryWasmHashField,
  tryWasmHashBlurField,
  tryWasmApplyGrain,
  maxFilterSeparable,
  gaussianApprox,
  fnv1aUtf8,
} from '../../src/core/index.js';
import { boxBlur3 } from '../../src/core/diffuse/box.js';
import { gaussianBlurSep } from '../../src/core/diffuse/conv.js';

const wasmPath = fileURLToPath(new URL('../../assets/film_core.wasm', import.meta.url));

test('WASM three-box blur matches the JavaScript fallback', async (t) => {
  if (!existsSync(wasmPath)) {
    t.skip('assets/film_core.wasm not built; run npm run build:wasm');
    return;
  }
  const bytes = readFileSync(wasmPath);
  const status = await installWasmModule(bytes);
  assert.equal(status.available, true, status.error || 'WASM available');
  assert.equal(getWasmBackendStatus().version, 0x010600);
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

test('WASM coordinate hash field matches the JS reference, including negative origins', async (t) => {
  if (!existsSync(wasmPath)) {
    t.skip('assets/film_core.wasm not built; run npm run build:wasm');
    return;
  }
  const status = await installWasmModule(readFileSync(wasmPath));
  assert.equal(status.available, true, status.error || 'WASM available');
  const width = 17;
  const height = 9;
  const nodeHash = fnv1aUtf8('grain-main');
  const wasm = new Float32Array(width * height);
  assert.equal(tryWasmHashField(wasm, width, height, 0x12345678, nodeHash, -11, -7, 2, 1), true);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const expected = gaussianApprox(0x12345678, nodeHash, -11 + x, -7 + y, 2, 1);
    assert.ok(Math.abs(wasm[y * width + x] - expected) <= 1e-6, `${x},${y}`);
  }
  resetWasmBackend();
});

test('WASM Gaussian and fused Grain hash-blur paths match JavaScript', async (t) => {
  if (!existsSync(wasmPath)) {
    t.skip('assets/film_core.wasm not built; run npm run build:wasm');
    return;
  }
  const status = await installWasmModule(readFileSync(wasmPath));
  assert.equal(status.available, true, status.error || 'WASM available');
  const width = 31;
  const height = 19;
  const n = width * height;
  const source = new Float32Array(n);
  for (let i = 0; i < n; i++) source[i] = ((i * 2654435761) >>> 8) / 0xffffff;
  const gaussianJs = new Float32Array(n);
  gaussianBlurSep(source, gaussianJs, new Float32Array(n), new Float32Array(n), width, height, 2.25);
  const gaussianWasm = new Float32Array(n);
  assert.equal(tryWasmGaussianBlur(source, gaussianWasm, width, height, 2.25), true);

  const nodeHash = fnv1aUtf8('grain-main');
  const hash = new Float32Array(n);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    hash[y * width + x] = gaussianApprox(0x12345678, nodeHash, -5 + x, -3 + y, 1, 2);
  }
  const fusedJs = new Float32Array(n);
  boxBlur3(hash, fusedJs, new Float32Array(n), new Float32Array(n), width, height, 3.5);
  const fusedWasm = new Float32Array(n);
  assert.equal(tryWasmHashBlurField(fusedWasm, width, height, 0x12345678, nodeHash, -5, -3, 1, 2, 3.5, 'fast'), true);

  for (const [actual, expected, label] of [[gaussianWasm, gaussianJs, 'gaussian'], [fusedWasm, fusedJs, 'fused']]) {
    let rms = 0;
    for (let i = 0; i < n; i++) rms += (actual[i] - expected[i]) ** 2;
    rms = Math.sqrt(rms / n);
    assert.ok(rms <= 1e-5, `${label} RMS=${rms}`);
  }
  resetWasmBackend();
});

test('WASM Grain composite matches the bounded JavaScript log-density model', async (t) => {
  if (!existsSync(wasmPath)) {
    t.skip('assets/film_core.wasm not built; run npm run build:wasm');
    return;
  }
  const status = await installWasmModule(readFileSync(wasmPath));
  assert.equal(status.available, true, status.error || 'WASM available');
  const pixels = 257;
  const rgb = new Float32Array(pixels * 3);
  const alpha = new Float32Array(pixels);
  const noise = [new Float32Array(pixels), new Float32Array(pixels), new Float32Array(pixels)];
  for (let i = 0; i < pixels; i++) {
    rgb[i * 3] = 0.02 + (i % 31) * 0.08;
    rgb[i * 3 + 1] = 0.04 + (i % 17) * 0.06;
    rgb[i * 3 + 2] = 0.01 + (i % 23) * 0.05;
    alpha[i] = (i % 11) / 10;
    for (let channel = 0; channel < 3; channel++) noise[channel][i] = ((i * (channel + 3)) % 29 - 14) / 4;
  }
  const expected = new Float32Array(rgb.length);
  const amount = 1.3;
  const iso = 800;
  for (let i = 0; i < pixels; i++) {
    const p = i * 3;
    const luminance = Math.max(1e-6, 0.2126 * rgb[p] + 0.7152 * rgb[p + 1] + 0.0722 * rgb[p + 2]);
    const x = Math.log2(luminance / 0.18);
    const envelope = 0.42 + 0.58 * Math.exp(-0.5 * ((x + 0.5) / 2) ** 2);
    const sigmaD = 0.085 * amount * Math.sqrt(iso / 250) * envelope;
    const variance = (Math.LN2 * sigmaD) ** 2;
    for (let channel = 0; channel < 3; channel++) {
      const gain = Math.exp(Math.max(-20, Math.min(20, Math.LN2 * sigmaD * noise[channel][i] - 0.5 * variance)));
      expected[p + channel] = rgb[p + channel] + alpha[i] * (rgb[p + channel] * gain - rgb[p + channel]);
    }
  }
  const actual = new Float32Array(rgb.length);
  assert.equal(tryWasmApplyGrain(rgb, noise, alpha, actual, amount, iso, 'negative'), true);
  let rms = 0;
  for (let i = 0; i < actual.length; i++) rms += (actual[i] - expected[i]) ** 2;
  rms = Math.sqrt(rms / actual.length);
  assert.ok(rms <= 1e-5, `RMS=${rms}`);
  resetWasmBackend();
});

test('WASM source-expansion max filter matches the alias-safe JavaScript fallback', async (t) => {
  if (!existsSync(wasmPath)) {
    t.skip('assets/film_core.wasm not built; run npm run build:wasm');
    return;
  }
  const status = await installWasmModule(readFileSync(wasmPath));
  assert.equal(status.available, true, status.error || 'WASM available');
  const width = 97;
  const height = 61;
  const n = width * height;
  const source = new Float32Array(n);
  for (let i = 0; i < n; i++) source[i] = ((i * 2246822519) >>> 7) / 0x1ffffff;
  const js = maxFilterSeparable(source, width, height, 9);
  const wasm = new Float32Array(n);
  assert.equal(tryWasmMaxFilter(source, wasm, width, height, 9), true);
  assert.deepEqual(wasm, js);
  resetWasmBackend();
});

test('WASM blur-backed Fast pipeline matches the pure JavaScript fallback', async (t) => {
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
