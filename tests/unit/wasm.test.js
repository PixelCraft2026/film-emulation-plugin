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
  tryWasmVvGaussianBlur,
  tryWasmMaxFilter,
  tryWasmHashField,
  tryWasmHashBlurField,
  tryWasmBeginGrainAccum,
  tryWasmHashBlurFieldIntoGrain,
  tryWasmGrainScaleIntoAccum,
  tryWasmFinishGrainAccum,
  tryWasmApplyGrain,
  tryWasmApplyResidentGrain,
  maxFilterSeparable,
  gaussianApprox,
  fnv1aUtf8,
  createV16ResidentBackend,
  createV17ResidentBackend,
  createFilmExecutor,
  createFilmRenderPlan,
  createDefaultEffectGraph,
  createFilmResolutionParams,
  createGrainParams,
  createDefringeParams,
  createBloomParams,
  createHighlightProtectionParams,
  createLumaMask,
  createHalationPreset,
  processFilm,
  createGraphCommandBuffer,
} from '../../src/core/index.js';
import { boxBlur3 } from '../../src/core/diffuse/box.js';
import { gaussianBlurSep } from '../../src/core/diffuse/conv.js';

const wasmPath = fileURLToPath(new URL('../../assets/film_core.wasm', import.meta.url));

test('V1.6 resident workspace reserves one reusable band capacity and reports copies', async (t) => {
  if (!existsSync(wasmPath)) {
    t.skip('assets/film_core.wasm not built; run npm run build:wasm');
    return;
  }
  await installWasmModule(readFileSync(wasmPath));
  const resident = createV16ResidentBackend({ planHash: 'test-plan' });
  assert.ok(resident);
  const first = resident.reserve(64, 32, 8);
  const second = resident.reserve(32, 32, 8);
  assert.equal(resident.abiVersion, 0x010600);
  assert.equal(first.workspaceBytes, second.workspaceBytes);
  assert.ok(second.workspaceBytes >= 64 * 32 * 8 * 4);
  assert.equal(resident.stats().copyCount, 0);
  resident.dispose();
});

test('WASM resident Grain accumulation matches the coordinate crop reference', async (t) => {
  if (!existsSync(wasmPath)) {
    t.skip('assets/film_core.wasm not built; run npm run build:wasm');
    return;
  }
  await installWasmModule(readFileSync(wasmPath));
  const width = 7;
  const height = 5;
  const fieldWidth = width + 4;
  const fieldHeight = height + 4;
  const pad = 2;
  const seed = 0x12345678;
  const nodeHash = fnv1aUtf8('grain-main');
  const coefficient = 0.37;
  assert.equal(tryWasmBeginGrainAccum(width, height), true);
  assert.equal(tryWasmHashBlurFieldIntoGrain(width, height, fieldWidth, fieldHeight, pad, 1, 3, coefficient, seed, nodeHash, -11, 19, 0, 0, 0, 'quality'), true);
  const actual = [new Float32Array(width * height), new Float32Array(width * height), new Float32Array(width * height)];
  assert.equal(tryWasmFinishGrainAccum(actual), true);
  const field = new Float32Array(fieldWidth * fieldHeight);
  assert.equal(tryWasmHashBlurField(field, fieldWidth, fieldHeight, seed, nodeHash, -11, 19, 0, 0, 0, 'quality'), true);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const expected = field[(y + pad) * fieldWidth + x + pad] * coefficient;
      const index = y * width + x;
      for (const channel of actual) assert.ok(Math.abs(channel[index] - expected) <= 1e-6, `${x},${y}`);
    }
  }
});

test('WASM fused four-field Grain scale is sample-identical to individual accumulation', async (t) => {
  if (!existsSync(wasmPath)) {
    t.skip('assets/film_core.wasm not built; run npm run build:wasm');
    return;
  }
  await installWasmModule(readFileSync(wasmPath));
  const width = 19;
  const height = 13;
  const scale = 2;
  const pad = 4;
  const fieldWidth = Math.ceil(width / scale) + 2 * pad;
  const fieldHeight = Math.ceil(height / scale) + 2 * pad;
  const seed = 0x12345678;
  const nodeHash = fnv1aUtf8('grain-main');
  const shared = 0.37;
  const independent = 0.19;
  const originX = -8.5;
  const originY = 11.25;
  const fieldPreviewScale = 0.5;
  const sigma = 1.7;
  const reference = [new Float32Array(width * height), new Float32Array(width * height), new Float32Array(width * height)];
  assert.equal(tryWasmBeginGrainAccum(width, height), true);
  assert.equal(tryWasmHashBlurFieldIntoGrain(width, height, fieldWidth, fieldHeight, pad, scale, 3, shared, seed, nodeHash, originX, originY, 2, 0, sigma, 'quality', fieldPreviewScale), true);
  for (let channel = 0; channel < 3; channel++) {
    assert.equal(tryWasmHashBlurFieldIntoGrain(width, height, fieldWidth, fieldHeight, pad, scale, channel, independent, seed, nodeHash, originX, originY, 2, channel + 1, sigma, 'quality', fieldPreviewScale), true);
  }
  assert.equal(tryWasmFinishGrainAccum(reference), true);
  const fused = [new Float32Array(width * height), new Float32Array(width * height), new Float32Array(width * height)];
  assert.equal(tryWasmBeginGrainAccum(width, height), true);
  assert.equal(tryWasmGrainScaleIntoAccum(width, height, fieldWidth, fieldHeight, pad, scale, shared, independent, seed, nodeHash, originX, originY, 2, sigma, 'quality', fieldPreviewScale), true);
  assert.equal(tryWasmFinishGrainAccum(fused), true);
  for (let channel = 0; channel < 3; channel++) assert.deepEqual(fused[channel], reference[channel]);
});

test('WASM resident planar Grain composite is sample-identical to the established composite', async (t) => {
  if (!existsSync(wasmPath)) {
    t.skip('assets/film_core.wasm not built; run npm run build:wasm');
    return;
  }
  await installWasmModule(readFileSync(wasmPath));
  const width = 23;
  const height = 17;
  const pixels = width * height;
  const fieldWidth = width + 6;
  const fieldHeight = height + 6;
  const rgb = new Float32Array(pixels * 3);
  const alpha = new Float32Array(pixels);
  for (let i = 0; i < pixels; i++) {
    rgb[i * 3] = 0.015 + (i % 29) * 0.09;
    rgb[i * 3 + 1] = 0.025 + (i % 19) * 0.07;
    rgb[i * 3 + 2] = 0.01 + (i % 13) * 0.11;
    alpha[i] = (i % 9) / 8;
  }
  assert.equal(tryWasmBeginGrainAccum(width, height), true);
  assert.equal(tryWasmGrainScaleIntoAccum(
    width,
    height,
    fieldWidth,
    fieldHeight,
    3,
    1,
    0.41,
    0.17,
    0x12345678,
    fnv1aUtf8('grain-main'),
    -13,
    7,
    1,
    1.85,
    'quality',
  ), true);
  const noise = [new Float32Array(pixels), new Float32Array(pixels), new Float32Array(pixels)];
  assert.equal(tryWasmFinishGrainAccum(noise), true);
  const expected = new Float32Array(rgb.length);
  const actual = new Float32Array(rgb.length);
  assert.equal(tryWasmApplyGrain(rgb, noise, alpha, expected, 1.2, 800, 'negative'), true);
  assert.equal(tryWasmApplyResidentGrain(rgb, alpha, actual, 1.2, 800, 'negative'), true);
  assert.deepEqual(actual, expected);
});

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

test('WASM van Vliet-Young Quality blur matches the JavaScript reference', async (t) => {
  if (!existsSync(wasmPath)) {
    t.skip('assets/film_core.wasm not built; run npm run build:wasm');
    return;
  }
  const status = await installWasmModule(readFileSync(wasmPath));
  assert.equal(status.available, true, status.error || 'WASM available');
  const width = 83;
  const height = 47;
  const n = width * height;
  const source = new Float32Array(n);
  for (let i = 0; i < n; i++) source[i] = (((i * 2246822519) >>> 5) / 0x7fffffff) * 1.8 - 0.2;
  const expected = new Float32Array(n);
  const actual = new Float32Array(n);
  const { vvGauss } = await import('../../src/core/diffuse/vv.js');
  vvGauss(source, expected, new Float32Array(n), new Float32Array(n), width, height, 7.25);
  assert.equal(tryWasmVvGaussianBlur(source, actual, width, height, 7.25), true);
  let rms = 0;
  let max = 0;
  for (let i = 0; i < n; i++) {
    const delta = actual[i] - expected[i];
    rms += delta * delta;
    max = Math.max(max, Math.abs(delta));
  }
  rms = Math.sqrt(rms / n);
  assert.ok(rms <= 2e-6, `RMS=${rms}`);
  assert.ok(max <= 1e-5, `max=${max}`);
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

test('resident command ABI executes Resolution → Grain with one frame upload/download', async (t) => {
  if (!existsSync(wasmPath)) {
    t.skip('assets/film_core.wasm not built; run npm run build:wasm');
    return;
  }
  const width = 83;
  const height = 57;
  const pixels = width * height;
  const rgb = new Float32Array(pixels * 3);
  const alpha = new Float32Array(pixels);
  for (let i = 0; i < pixels; i += 1) {
    rgb[i * 3] = 0.02 + (i % 31) * 0.07;
    rgb[i * 3 + 1] = 0.03 + (i % 19) * 0.05;
    rgb[i * 3 + 2] = 0.01 + (i % 23) * 0.06;
    alpha[i] = (i % 11) / 10;
  }
  const graph = createDefaultEffectGraph(createHalationParams({ strength: 0 }), 0x9e3779b9).map((node) => {
    if (node.type === 'filmResolution') return { ...node, enabled: true, params: createFilmResolutionParams({ amount: 1.2, response: 1.3, toeLoss: 0.4, shoulderLoss: 0.25 }) };
    if (node.type === 'grain') return { ...node, enabled: true, params: createGrainParams({ amount: 1.1, size: 1.1, roughness: 0.7, chroma: 0.3, mode: 'analogue', seed: 0x9e3779b9 }) };
    return node;
  });
  const document = { format: { gauge: '35mm', iso: 800 }, graph };
  const context = { fullWidth: 2400, fullHeight: 1600, previewScale: 1, quality: 'quality', format: document.format };
  const input = { width, height, rgb, alpha };
  resetWasmBackend();
  const expected = processFilm(input, document, { ...context, backend: 'js' });
  const status = await installWasmModule(readFileSync(wasmPath));
  assert.equal(status.available, true, status.error || 'WASM available');
  const plan = createFilmRenderPlan({ width, height, graph, format: document.format, fullWidth: context.fullWidth, fullHeight: context.fullHeight, quality: 'quality', memoryMode: 'high' });
  const resident = createV17ResidentBackend(plan);
  assert.ok(resident?.supportsPlan(plan));
  const executor = createFilmExecutor(plan, { backend: 'wasm-resident', residentBackend: resident });
  const actual = await executor.renderAsync(input, document, { ...context, intent: 'preview', yieldIntervalMs: 1 });
  let squaredError = 0;
  let max = 0;
  for (let i = 0; i < actual.rgb.length; i += 1) {
    const delta = actual.rgb[i] - expected.rgb[i];
    squaredError += delta * delta;
    max = Math.max(max, Math.abs(delta));
  }
  const rms = Math.sqrt(squaredError / actual.rgb.length);
  assert.equal(actual.stats.backend, 'wasm-resident');
  assert.equal(actual.alpha, alpha);
  assert.ok(rms <= 1e-4, `resident Resolution+Grain RMS=${rms}`);
  assert.ok(max <= 1e-3, `resident Resolution+Grain max=${max}`);
  const metrics = resident.stats();
  assert.equal(metrics.uploadBytes, rgb.byteLength + alpha.byteLength);
  assert.equal(metrics.downloadBytes, rgb.byteLength);
  assert.equal(metrics.steps, plan.enabled.length);
  executor.dispose();
  resetWasmBackend();
});

test('resident scalar executes the complete V1.7 graph including masks and Bloom transient', async (t) => {
  if (!existsSync(wasmPath)) {
    t.skip('assets/film_core.wasm not built; run npm run build:wasm');
    return;
  }
  const width = 61;
  const height = 43;
  const pixels = width * height;
  const rgb = new Float32Array(pixels * 3);
  const alpha = new Float32Array(pixels);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = y * width + x;
      const p = i * 3;
      const lamp = Math.hypot(x - 31, y - 20) < 5 ? 2.5 : 0;
      rgb[p] = 0.03 + x / width * 0.35 + lamp;
      rgb[p + 1] = 0.04 + y / height * 0.25 + lamp * 0.92;
      rgb[p + 2] = 0.05 + ((x * 13 + y * 7) % 29) / 120 + lamp * 0.75;
      alpha[i] = i % 17 === 0 ? 0 : 1;
    }
  }
  const activeMask = createLumaMask({ mode: 'luma', lowEV: -4, highEV: 5, softnessEV: 1, invert: false });
  const graph = createDefaultEffectGraph(createHalationParams({
    strength: 38, sigma: 3.2, sigmaUnits: 'pixels', threshold: 0.45,
    diffusionMode: 'fast', sourceExpansion: 0.25, sourceInteriorProtection: 0.55,
    spectralSensitivity: 0.7, colorDensity: 0.2, globalDiffusion: 0.01,
  }), 0x13579bdf).map((node) => {
    if (node.type === 'defringe') return { ...node, enabled: true, params: createDefringeParams({ amount: 0.55, radiusPx: 1.2 }), mask: activeMask };
    if (node.type === 'bloom') return { ...node, enabled: true, params: createBloomParams({ radius: 0.22, amplify: 0.4 }), mask: activeMask };
    if (node.type === 'highlightProtection') return { ...node, enabled: true, params: createHighlightProtectionParams({ amount: 0.45 }), mask: activeMask };
    if (node.type === 'filmResolution') return { ...node, enabled: true, params: createFilmResolutionParams({ amount: 0.6 }), mask: activeMask };
    if (node.type === 'grain') return { ...node, enabled: true, params: createGrainParams({ amount: 0.4, mode: 'analogue', seed: 0x13579bdf }), mask: activeMask };
    return { ...node, enabled: true, mask: createLumaMask({ ...activeMask, invert: true }) };
  });
  const document = { format: { gauge: '35mm', iso: 400 }, graph };
  const context = { fullWidth: 800, fullHeight: 600, previewScale: 1, quality: 'fast', format: document.format };
  const input = { width, height, rgb, alpha };
  resetWasmBackend();
  const expected = processFilm(input, document, { ...context, backend: 'js' });
  const status = await installWasmModule(readFileSync(wasmPath));
  assert.equal(status.available, true, status.error || 'WASM available');
  const plan = createFilmRenderPlan({ width, height, graph, format: document.format, fullWidth: context.fullWidth, fullHeight: context.fullHeight, quality: context.quality, memoryMode: 'high' });
  const resident = createV17ResidentBackend(plan);
  assert.ok(resident?.supportsPlan(plan));
  const executor = createFilmExecutor(plan, { backend: 'wasm-resident', residentBackend: resident });
  const actual = executor.render(input, document, context);
  let squared = 0;
  let max = 0;
  for (let i = 0; i < actual.rgb.length; i += 1) {
    const delta = actual.rgb[i] - expected.rgb[i];
    squared += delta * delta;
    max = Math.max(max, Math.abs(delta));
  }
  const rms = Math.sqrt(squared / actual.rgb.length);
  assert.equal(actual.stats.backend, 'wasm-resident');
  assert.equal(actual.alpha, alpha);
  assert.ok(rms <= 1e-4, `complete resident RMS=${rms}, max=${max}`);
  assert.ok(max <= 1e-3, `complete resident max=${max}, RMS=${rms}`);
  const metrics = resident.stats();
  assert.equal(metrics.uploadBytes, rgb.byteLength + alpha.byteLength);
  assert.equal(metrics.downloadBytes, rgb.byteLength);
  executor.dispose();
  resetWasmBackend();
});

test('resident Quality graph matches the Tungsten JS authority and preserves masked identity', async (t) => {
  if (!existsSync(wasmPath)) {
    t.skip('assets/film_core.wasm not built; run npm run build:wasm');
    return;
  }
  const width = 37;
  const height = 29;
  const pixels = width * height;
  const rgb = new Float32Array(pixels * 3);
  const alpha = new Float32Array(pixels);
  for (let i = 0; i < pixels; i += 1) {
    rgb[i * 3] = 0.04 + (i % 13) * 0.09;
    rgb[i * 3 + 1] = 0.03 + (i % 11) * 0.075;
    rgb[i * 3 + 2] = 0.02 + (i % 7) * 0.055;
    alpha[i] = i % 17 === 0 ? 0 : 1;
  }
  rgb[(14 * width + 18) * 3] = 3.5;
  rgb[(14 * width + 18) * 3 + 1] = 2.8;
  rgb[(14 * width + 18) * 3 + 2] = 2.1;
  const graph = createDefaultEffectGraph(createHalationPreset('tungsten-800'), 0x2468ace0).map((node) => {
    if (node.type === 'defringe') return { ...node, enabled: true, params: createDefringeParams({ amount: 0.4 }) };
    if (node.type === 'bloom') return { ...node, enabled: true, params: createBloomParams({ radius: 0.18, amplify: 0.25 }) };
    if (node.type === 'highlightProtection') return { ...node, enabled: true, params: createHighlightProtectionParams({ amount: 0.3 }) };
    if (node.type === 'filmResolution') return { ...node, enabled: true, params: createFilmResolutionParams({ amount: 0.45 }) };
    if (node.type === 'grain') return { ...node, enabled: true, params: createGrainParams({ amount: 0.25, mode: 'analogue', seed: 0x2468ace0 }) };
    return { ...node, enabled: true };
  });
  const document = { format: { gauge: '35mm', iso: 800 }, graph };
  const context = { fullWidth: 1200, fullHeight: 800, previewScale: 1, quality: 'quality', format: document.format };
  const input = { width, height, rgb, alpha };
  resetWasmBackend();
  const expected = processFilm(input, document, { ...context, backend: 'js' });
  await installWasmModule(readFileSync(wasmPath));
  const plan = createFilmRenderPlan({ width, height, graph, format: document.format, fullWidth: context.fullWidth, fullHeight: context.fullHeight, quality: 'quality', memoryMode: 'high' });
  const resident = createV17ResidentBackend(plan);
  const executor = createFilmExecutor(plan, { backend: 'wasm-resident', residentBackend: resident });
  const actual = await executor.renderAsync(input, document, { ...context, intent: 'preview', yieldIntervalMs: 1 });
  let squared = 0;
  let max = 0;
  for (let i = 0; i < actual.rgb.length; i += 1) {
    const delta = actual.rgb[i] - expected.rgb[i];
    squared += delta * delta;
    max = Math.max(max, Math.abs(delta));
  }
  const rms = Math.sqrt(squared / actual.rgb.length);
  assert.ok(rms <= 1e-4, `Quality resident RMS=${rms}, max=${max}`);
  assert.ok(max <= 1e-3, `Quality resident max=${max}, RMS=${rms}`);
  assert.equal(actual.alpha, alpha);
  executor.dispose();

  const zeroMask = createLumaMask({ mode: 'luma', lowEV: 10, highEV: 12, softnessEV: 0.5 });
  const maskedGraph = graph.map((node) => ({ ...node, mask: zeroMask }));
  const maskedDocument = { ...document, graph: maskedGraph };
  const maskedPlan = createFilmRenderPlan({ width, height, graph: maskedGraph, format: document.format, fullWidth: context.fullWidth, fullHeight: context.fullHeight, quality: 'quality', memoryMode: 'high' });
  const maskedResident = createV17ResidentBackend(maskedPlan);
  const maskedExecutor = createFilmExecutor(maskedPlan, { backend: 'wasm-resident', residentBackend: maskedResident });
  const identity = maskedExecutor.render(input, maskedDocument, context);
  assert.deepEqual(identity.rgb, rgb);
  assert.equal(identity.alpha, alpha);
  maskedExecutor.dispose();
  resetWasmBackend();
});

test('resident Highlight Protection warns without Bloom and consumes the nearest of multiple Blooms', async (t) => {
  if (!existsSync(wasmPath)) {
    t.skip('assets/film_core.wasm not built; run npm run build:wasm');
    return;
  }
  const width = 23;
  const height = 17;
  const rgb = new Float32Array(width * height * 3).fill(0.18);
  rgb[(8 * width + 11) * 3] = 2.5;
  rgb[(8 * width + 11) * 3 + 1] = 2.0;
  rgb[(8 * width + 11) * 3 + 2] = 1.5;
  const alpha = new Float32Array(width * height).fill(1);
  const base = createDefaultEffectGraph(createHalationParams({ strength: 0 }), 9);
  const hpOnly = base.map((node) => ({ ...node, enabled: node.type === 'highlightProtection', params: node.type === 'highlightProtection' ? createHighlightProtectionParams({ amount: 1 }) : node.params }));
  await installWasmModule(readFileSync(wasmPath));
  const hpPlan = createFilmRenderPlan({ width, height, graph: hpOnly, quality: 'fast', memoryMode: 'high' });
  const hpResident = createV17ResidentBackend(hpPlan);
  const hpExecutor = createFilmExecutor(hpPlan, { backend: 'wasm-resident', residentBackend: hpResident });
  const missing = hpExecutor.render({ width, height, rgb, alpha }, { graph: hpOnly }, { quality: 'fast' });
  assert.deepEqual(missing.rgb, rgb);
  assert.ok(missing.stats.nodes[0].warnings.includes('missingBloomContribution'));
  hpExecutor.dispose();

  const firstBloom = { ...base.find((node) => node.type === 'bloom'), id: 'bloom-first', enabled: true, params: createBloomParams({ radius: 0.08, amplify: 0.2 }) };
  const secondBloom = { ...firstBloom, id: 'bloom-second', params: createBloomParams({ radius: 0.2, amplify: 0.45 }) };
  const hp = { ...base.find((node) => node.type === 'highlightProtection'), enabled: true, params: createHighlightProtectionParams({ amount: 0.7 }) };
  const multiple = base.flatMap((node) => {
    if (node.type === 'bloom') return [firstBloom, secondBloom];
    if (node.type === 'highlightProtection') return [hp];
    return [{ ...node, enabled: false }];
  });
  const document = { graph: multiple };
  const context = { fullWidth: width, fullHeight: height, quality: 'fast', previewScale: 1 };
  const expected = processFilm({ width, height, rgb, alpha }, document, { ...context, backend: 'js' });
  const plan = createFilmRenderPlan({ width, height, graph: multiple, quality: 'fast', memoryMode: 'high' });
  const resident = createV17ResidentBackend(plan);
  const executor = createFilmExecutor(plan, { backend: 'wasm-resident', residentBackend: resident });
  const actual = executor.render({ width, height, rgb, alpha }, document, context);
  let max = 0;
  for (let i = 0; i < actual.rgb.length; i += 1) max = Math.max(max, Math.abs(actual.rgb[i] - expected.rgb[i]));
  assert.ok(max <= 1e-3, `nearest Bloom max=${max}`);
  executor.dispose();
  resetWasmBackend();
});

test('resident ABI rejects malformed plans, non-finite values, stale handles, and reports memory generations', async (t) => {
  if (!existsSync(wasmPath)) {
    t.skip('assets/film_core.wasm not built; run npm run build:wasm');
    return;
  }
  const { instance } = await WebAssembly.instantiate(readFileSync(wasmPath), {});
  const wasm = instance.exports;
  const width = 8;
  const height = 6;
  const graph = createDefaultEffectGraph(createHalationParams({ strength: 0 }), 7).map((node) => node.type === 'filmResolution'
    ? { ...node, enabled: true, params: createFilmResolutionParams({ amount: 0.7 }) }
    : node);
  const plan = createFilmRenderPlan({ width, height, graph, format: { gauge: '35mm', iso: 250 }, memoryMode: 'high' });
  const command = createGraphCommandBuffer(plan, { width, height, format: { gauge: '35mm', iso: 250 } });
  const handle = wasm.film_executor_create(0);
  const arenaFloats = width * (height + 4) * 32;
  const transientFloats = width * (height + 4) * 5;
  assert.equal(wasm.film_executor_reserve(handle, command.length, width, height, arenaFloats, transientFloats), 0);
  const firstGeneration = wasm.film_executor_memory_generation(handle);
  assert.equal(wasm.film_executor_reserve(handle, command.length, width, height, arenaFloats, transientFloats), 0);
  assert.equal(wasm.film_executor_memory_generation(handle), firstGeneration, 'same capacity keeps views valid');
  assert.equal(wasm.film_executor_reserve(handle, command.length + 128, width, height + 4, arenaFloats, transientFloats), 0);
  assert.ok(wasm.film_executor_memory_generation(handle) > firstGeneration, 'growth advances generation');

  const begin = (bytes) => {
    assert.equal(wasm.film_executor_reserve(handle, Math.max(command.length + 128, bytes.length), width, height + 4, arenaFloats, transientFloats), 0);
    new Uint8Array(wasm.memory.buffer, wasm.film_executor_command_ptr(handle), bytes.length).set(bytes);
    return wasm.film_executor_begin(handle, bytes.length);
  };
  assert.equal(begin(command), 0);
  assert.equal(wasm.film_executor_cursor(handle), 0);
  assert.equal(wasm.film_executor_current_frame(handle), 0);
  assert.equal(wasm.film_executor_reset(handle), 0);
  const badMagic = command.slice();
  badMagic[0] ^= 0xff;
  assert.equal(begin(badMagic), -2);
  const badAbi = command.slice();
  new DataView(badAbi.buffer).setUint32(8, 99, true);
  assert.equal(begin(badAbi), -1);
  const badOpcode = command.slice();
  new DataView(badOpcode.buffer).setUint16(80, 99, true);
  assert.equal(begin(badOpcode), -3);
  const overflow = command.slice();
  new DataView(overflow.buffer).setUint32(76, 0xffffffff, true);
  assert.equal(begin(overflow), -4);
  const badTransientSlot = command.slice();
  new DataView(badTransientSlot.buffer).setUint32(80 + 28, 0x10, true);
  assert.equal(begin(badTransientSlot), -2);
  const nonFinite = command.slice();
  const amountHash = [0x49, 0xce, 0x85, 0xf7, 1];
  let amountOffset = -1;
  for (let i = 0; i <= nonFinite.length - amountHash.length; i += 1) {
    if (amountHash.every((value, index) => nonFinite[i + index] === value)) { amountOffset = i + amountHash.length; break; }
  }
  assert.ok(amountOffset > 0);
  new DataView(nonFinite.buffer).setUint32(amountOffset, 0x7fc00000, true);
  assert.equal(begin(nonFinite), -5);

  assert.equal(begin(command), 0);
  const inputView = new Float32Array(wasm.memory.buffer, wasm.film_executor_input_rgb_ptr(handle), width * height * 3);
  inputView.fill(0.18);
  inputView[3] = Number.NaN;
  let code = 1;
  while (code === 1) code = wasm.film_executor_step(handle, 1);
  assert.equal(code, -6);
  wasm.film_executor_destroy(handle);
  assert.equal(wasm.film_executor_reserve(handle, command.length, width, height, arenaFloats, transientFloats), -7);
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
