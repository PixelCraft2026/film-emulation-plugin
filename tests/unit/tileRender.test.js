/**
 * tileRender 分块一致性测试：processTiledWithTrc（显示编码进/出、带内 TRC）vs 整图
 * decode→算法→encode 基准的数值对比；以及小图走整图路径的逐位一致性。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  processHalation,
  createHalationParams,
  createHalationPreset,
  createBloomParams,
  createDefringeParams,
  createDefaultEffectGraph,
  createFilmRenderPlan,
  createHighlightProtectionParams,
  getTRC,
} from '../../src/core/index.js';
import { processTiledWithTrc, processTiledFilmWithTrc } from '../../src/io/tileRender.js';
import { estimateHighMemoryBytes, streamGeometry } from '../../src/io/streamGeometry.js';
import { decodeToLinear, encodeFromLinear, resolveDocumentTRC } from '../../src/io/colorPipeline.js';

const TRC = getTRC('sRGB');

test('automatic memory preflight selects High for common files and Balanced for unsafe full images', () => {
  const params = createHalationParams({ sigma: 7 });
  const common = streamGeometry(3492, 2328, params, { componentSize: 16, memoryMode: 'auto' });
  assert.equal(common.memoryMode, 'high');
  assert.equal(common.bands.length, 1);
  assert.equal(common.overlap, 0);
  const largeUnknown = streamGeometry(6000, 4000, params, { componentSize: 32, memoryMode: 'auto' });
  assert.equal(largeUnknown.memoryMode, 'balanced');
  assert.ok(largeUnknown.bands.length > 1);
  const high16GB = streamGeometry(6000, 4000, params, { componentSize: 16, deviceMemoryGB: 16, memoryMode: 'auto' });
  assert.equal(high16GB.memoryMode, 'high');
  const enum16GB = streamGeometry(6000, 4000, params, { componentSize: 'bitDepth16', deviceMemoryGB: 16, memoryMode: 'auto' });
  assert.equal(enum16GB.memoryMode, 'high');
  assert.equal(high16GB.estimatedBytes, estimateHighMemoryBytes(6000, 4000, 16));
  const forcedBalanced = streamGeometry(3492, 2328, params, { memoryMode: 'balanced' });
  assert.equal(forcedBalanced.memoryMode, 'balanced');
});

/** 显示编码输入（0..1，含 1.0 高光点）。 */
function buildDisplayInput(w, h) {
  const rgb = new Float32Array(w * h * 3);
  for (let i = 0; i < w * h; i++) {
    const v = ((i * 2654435761) >>> 8) / 0xffffff;
    rgb[i * 3] = v;
    rgb[i * 3 + 1] = v * 0.8;
    rgb[i * 3 + 2] = v * 0.6;
  }
  const emitters = [
    [Math.floor(w * 0.25), Math.floor(h * 0.2)],
    [Math.floor(w * 0.75), Math.floor(h * 0.125)],
    [Math.floor(w * 0.18), Math.floor(h * 0.75)],
  ];
  for (const [x, y] of emitters) {
    const p = (y * w + x) * 3;
    rgb[p] = 1.0;
    rgb[p + 1] = 1.0;
    rgb[p + 2] = 1.0;
  }
  return { width: w, height: h, rgb };
}

/** 整图基准：显示编码 → decode → processHalation → encode。 */
function fullReference(input, params) {
  const linear = decodeToLinear(input.rgb, TRC);
  const out = processHalation({ width: input.width, height: input.height, rgb: linear }, params);
  return encodeFromLinear(out.rgb, TRC);
}

function l2AndMax(a, b) {
  let l2 = 0;
  let maxDiff = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    l2 += d * d;
    if (Math.abs(d) > maxDiff) maxDiff = Math.abs(d);
  }
  return { l2: Math.sqrt(l2 / a.length), maxDiff };
}

test('processTiledWithTrc matches full-image render (quality, tiled branch)', () => {
  const input = buildDisplayInput(128, 192);
  const params = createHalationParams({ strength: 100, diffusionMode: 'quality' });
  const full = fullReference(input, params);
  // tileThreshold=10000 强制走分块分支（24576px > 10000）。
  const tiled = processTiledWithTrc(input, params, TRC, { bandHeight: 64, overlapPx: 40, tileThreshold: 10000 });
  assert.equal(tiled.width, input.width);
  assert.equal(tiled.height, input.height);
  const { l2, maxDiff } = l2AndMax(full, tiled.rgb);
  console.log(`INFO tileWithTrc quality L2=${l2.toExponential(2)} maxDiff=${maxDiff.toExponential(2)}`);
  // #1 后 quality 用 van Vliet 递归高斯：带内列递归瞬态（~0.3% 于 valid 区边缘）
  // 使分块结果与整图有 ~2e-6 量级差异（视觉无感）；容差与 fast 分支一致（1e-5）
  assert.ok(l2 < 1e-5, `tile≈full L2=${l2.toExponential(2)}`);
});

test('processTiledWithTrc matches full-image render (fast, tiled branch)', () => {
  const input = buildDisplayInput(128, 192);
  const params = createHalationParams({ strength: 100, diffusionMode: 'fast' });
  const full = fullReference(input, params);
  const tiled = processTiledWithTrc(input, params, TRC, { bandHeight: 64, overlapPx: 40, tileThreshold: 10000 });
  const { l2 } = l2AndMax(full, tiled.rgb);
  console.log(`INFO tileWithTrc fast L2=${l2.toExponential(2)}`);
  // 行带边缘与整图在有限 overlap 外只有低量级数值差异；容差 1e-5。
  assert.ok(l2 < 1e-5, `tile≈full fast L2=${l2.toExponential(2)}`);
});

test('processTiledWithTrc small image goes full-image path (bit-identical)', () => {
  const input = buildDisplayInput(64, 48);
  const params = createHalationParams({ strength: 60 });
  const full = fullReference(input, params);
  const tiled = processTiledWithTrc(input, params, TRC); // 默认小图整图路径
  const { maxDiff } = l2AndMax(full, tiled.rgb);
  assert.ok(maxDiff < 1e-6, `small image maxDiff=${maxDiff.toExponential(2)}`);
});

test('profileTimings reports color and algorithm stages without changing output', () => {
  const input = buildDisplayInput(64, 48);
  const params = createHalationPreset('standard');
  const plain = processTiledWithTrc(input, params, TRC);
  const profiled = processTiledWithTrc(input, params, TRC, { profileTimings: true });
  assert.deepEqual(profiled.rgb, plain.rgb);
  for (const key of ['decodeMs', 'extractMs', 'diffuseMs', 'haloMs', 'blendMs', 'encodeMs']) {
    assert.ok(Number.isFinite(profiled.timings[key]) && profiled.timings[key] >= 0, `${key} is recorded`);
  }
});

test('linear Imaging API input is encoded to the nonlinear document TRC without darkening', () => {
  const width = 4;
  const height = 4;
  const rgb = new Float32Array(width * height * 3).fill(0.18);
  const inputTrc = resolveDocumentTRC({ colorProfileName: 'Rec. 2020 (Linear RGB Profile)' });
  const outputTrc = resolveDocumentTRC({ colorProfileName: 'Rec. 2020' });
  const params = createHalationParams({ strength: 0 });
  const result = processTiledWithTrc({ width, height, rgb }, params, inputTrc, { outputTrc });
  const expected = Math.pow(0.18, 1 / 2.4);
  for (const value of result.rgb) {
    assert.ok(Math.abs(value - expected) < 1e-6, `linear 0.18 should encode to ${expected}, got ${value}`);
  }
});

test('zero-strength Rec.2020 profile roundtrip preserves the source values', () => {
  const input = buildDisplayInput(32, 24);
  const rec2020 = resolveDocumentTRC({ colorProfileName: 'Rec. 2020' });
  const params = createHalationParams({ strength: 0 });
  const result = processTiledWithTrc(input, params, rec2020, { outputTrc: rec2020 });
  const { maxDiff } = l2AndMax(input.rgb, result.rgb);
  assert.ok(maxDiff < 2e-6, `Rec.2020 no-effect roundtrip maxDiff=${maxDiff.toExponential(2)}`);
});

test('default overlap covers sigmaRatio>1 (3.2): tiled matches full with large channel σ', () => {
  // σ=12, sigmaRatio=[2,1.5,1] → 红色通道基础 σ=24，并继续计入红尾 lobe 支持。
  // 旧默认 overlap=ceil(5·12)=60 不足（红尾截断 ~8%）；当前完整支持得到 176px。
  const input = buildDisplayInput(96, 400); // 默认 overlap=176、bandHeight=352，仍覆盖两带接缝。
  const params = createHalationParams({ strength: 100, diffusionMode: 'quality', sigma: 12, sigmaRatio: [2, 1.5, 1] });
  const full = fullReference(input, params);
  const tiled = processTiledWithTrc(input, params, TRC, { tileThreshold: 10000 });
  assert.equal(tiled.width, input.width);
  assert.equal(tiled.height, input.height);
  const { l2 } = l2AndMax(full, tiled.rgb);
  console.log(`INFO defaultOverlap sigmaRatio L2=${l2.toExponential(2)}`);
  assert.ok(l2 < 1e-6, `tile≈full with σ·maxRatio overlap L2=${l2.toExponential(2)}`);
});

test('No-Remjet source expansion, red tail and density composite remain band-seam free', () => {
  const input = buildDisplayInput(96, 400); // 默认 overlap=88、bandHeight=256，覆盖两带接缝。
  const params = createHalationParams({
    ...createHalationPreset('tungsten-800'),
    sigmaUnits: 'pixels',
    sigma: 8,
  });
  const full = fullReference(input, params);
  const tiled = processTiledWithTrc(input, params, TRC, { tileThreshold: 10000 });
  const { l2, maxDiff } = l2AndMax(full, tiled.rgb);
  console.log(`INFO no-remjet banded L2=${l2.toExponential(2)} max=${maxDiff.toExponential(2)}`);
  assert.ok(l2 < 1e-5, `No-Remjet tile≈full L2=${l2.toExponential(2)}`);
});

test('banded low-res diffusion aligns with full-image low-res (3.1 相位对齐)', () => {
  // σ=48 → scale=8：quality 低分辨率路径在分块/整图下都应一致。
  // 当前三瓣红尾得到 overlap=344、bandHeight=688，H=720（8 的倍数）
  // → 带起点/带高均为 scale 整数倍，带内格子与整图格子逐格重合。
  const input = buildDisplayInput(96, 720);
  const params = createHalationParams({ strength: 100, diffusionMode: 'quality', sigma: 48 });
  const full = fullReference(input, params);
  const tiled = processTiledWithTrc(input, params, TRC, { tileThreshold: 10000 });
  const { l2, maxDiff } = l2AndMax(full, tiled.rgb);
  console.log(`INFO banded lowres σ=48 L2=${l2.toExponential(2)} max=${maxDiff.toExponential(2)}`);
  assert.ok(l2 < 1e-5, `banded lowres≈full L2=${l2.toExponential(2)}`);
});

test('#2 bottom edge: non-multiple height (H mod scale ≠ 0) keeps banded/full consistency', () => {
  // H=724 不是 scale=8 的倍数：末格偏短（[720,724)），相位对齐 + 末格公式
  // 保证带末格与整图末格覆盖相同全局行（#2 验证，V1.2 整数格设计已覆盖）。
  const input = buildDisplayInput(96, 724);
  const params = createHalationParams({ strength: 100, diffusionMode: 'quality', sigma: 48 });
  const full = fullReference(input, params);
  const tiled = processTiledWithTrc(input, params, TRC, { tileThreshold: 10000 });
  const { l2, maxDiff } = l2AndMax(full, tiled.rgb);
  console.log(`INFO bottom-edge H=724 L2=${l2.toExponential(2)} max=${maxDiff.toExponential(2)}`);
  // vvGauss 带内瞬态 ~2e-6；若末格相位错误会出现 ~1e-3 的底部条带误差
  assert.ok(l2 < 1e-5, `non-multiple height L2=${l2.toExponential(2)}`);
});

test('V1.7 Defringe → Bloom → HP is seam-free across 1/8 phase and a narrow bottom band', () => {
  const width = 73;
  const height = 277;
  const input = buildDisplayInput(width, height);
  input.alpha = new Float32Array(width * height).fill(1);
  for (let y = 0; y < height; y += 47) {
    const p = (y * width + ((y * 13) % width)) * 3;
    input.rgb[p] = input.rgb[p + 1] = input.rgb[p + 2] = 4;
  }
  const graph = createDefaultEffectGraph(createHalationParams({ strength: 0 }), 17).map((node) => {
    if (node.type === 'defringe') return { ...node, enabled: true, params: createDefringeParams({ amount: 0.9, radiusPx: 2 }) };
    if (node.type === 'bloom') return { ...node, enabled: true, params: createBloomParams({ thresholdEV: -1, radius: 1.2, amplify: 0.8, saveLights: 0.2 }) };
    if (node.type === 'highlightProtection') return { ...node, enabled: true, params: createHighlightProtectionParams({ amount: 0.7, thresholdEV: 1 }) };
    return node;
  });
  const document = { graph };
  const plan = createFilmRenderPlan({ width, height, fullWidth: width, fullHeight: height, graph, quality: 'quality', memoryMode: 'balanced' });
  assert.equal(plan.phasePeriod, 8);
  assert.equal(plan.overlap % 8, 0);
  const linear = getTRC('linear');
  const full = processTiledFilmWithTrc(input, document, linear, {
    tileThreshold: Number.MAX_SAFE_INTEGER,
    quality: 'quality',
    renderPlan: plan,
  });
  const banded = processTiledFilmWithTrc(input, document, linear, {
    tileThreshold: 1,
    bandHeight: 64,
    overlapPx: plan.overlap,
    quality: 'quality',
    renderPlan: plan,
  });
  const { l2, maxDiff } = l2AndMax(full.rgb, banded.rgb);
  console.log(`INFO V1.7 phase-8 banded L2=${l2.toExponential(2)} max=${maxDiff.toExponential(2)} overlap=${plan.overlap}`);
  assert.ok(l2 <= 1e-4, `V1.7 banded RMS=${l2.toExponential(2)}`);
  assert.ok(maxDiff <= 1e-3, `V1.7 banded max=${maxDiff.toExponential(2)}`);
  assert.deepEqual(banded.alpha, input.alpha);
});
