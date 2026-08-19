/**
 * tileRender 分块一致性测试：processTiledWithTrc（显示编码进/出、带内 TRC）vs 整图
 * decode→算法→encode 基准的数值对比；以及小图走整图路径的逐位一致性。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { processHalation, createHalationParams, getTRC } from '../../src/core/index.js';
import { processTiledWithTrc } from '../../src/io/tileRender.js';
import { decodeToLinear, encodeFromLinear, resolveDocumentTRC } from '../../src/io/colorPipeline.js';

const TRC = getTRC('sRGB');

/** 显示编码输入（0..1，含 1.0 高光点）。 */
function buildDisplayInput(w, h) {
  const rgb = new Float32Array(w * h * 3);
  for (let i = 0; i < w * h; i++) {
    const v = ((i * 2654435761) >>> 8) / 0xffffff;
    rgb[i * 3] = v;
    rgb[i * 3 + 1] = v * 0.8;
    rgb[i * 3 + 2] = v * 0.6;
  }
  for (const [x, y] of [[40, 40], [120, 30], [30, 180]]) {
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
  const input = buildDisplayInput(200, 240);
  const params = createHalationParams({ strength: 100, diffusionMode: 'quality' });
  const full = fullReference(input, params);
  // tileThreshold=10000 强制走分块分支（48000px > 10000）
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
  const input = buildDisplayInput(200, 240);
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
  // σ=12, sigmaRatio=[2,1.5,1] → 红色通道 σ=24，核支撑 5σ=120px。
  // 旧默认 overlap=ceil(5·12)=60 不足（红尾截断 ~8%）；新默认按 σ·maxRatio=120。
  const input = buildDisplayInput(160, 480); // 多带（bandHeight 默认 256）
  const params = createHalationParams({ strength: 100, diffusionMode: 'quality', sigma: 12, sigmaRatio: [2, 1.5, 1] });
  const full = fullReference(input, params);
  const tiled = processTiledWithTrc(input, params, TRC, { tileThreshold: 10000 });
  assert.equal(tiled.width, input.width);
  assert.equal(tiled.height, input.height);
  const { l2 } = l2AndMax(full, tiled.rgb);
  console.log(`INFO defaultOverlap sigmaRatio L2=${l2.toExponential(2)}`);
  assert.ok(l2 < 1e-6, `tile≈full with σ·maxRatio overlap L2=${l2.toExponential(2)}`);
});

test('banded low-res diffusion aligns with full-image low-res (3.1 相位对齐)', () => {
  // σ=48 → scale=8：quality 低分辨率路径在分块/整图下都应一致。
  // 默认 overlap=ceil(240/8)·8=240，bandHeight=ceil(480/8)·8=480，H=1000（8 的倍数）
  // → 带起点/带高均为 scale 整数倍，带内格子与整图格子逐格重合。
  const input = buildDisplayInput(160, 1000);
  const params = createHalationParams({ strength: 100, diffusionMode: 'quality', sigma: 48 });
  const full = fullReference(input, params);
  const tiled = processTiledWithTrc(input, params, TRC, { tileThreshold: 10000 });
  const { l2, maxDiff } = l2AndMax(full, tiled.rgb);
  console.log(`INFO banded lowres σ=48 L2=${l2.toExponential(2)} max=${maxDiff.toExponential(2)}`);
  assert.ok(l2 < 1e-5, `banded lowres≈full L2=${l2.toExponential(2)}`);
});

test('#2 bottom edge: non-multiple height (H mod scale ≠ 0) keeps banded/full consistency', () => {
  // H=1004 不是 scale=8 的倍数：末格偏短（[1000,1004)），相位对齐 + 末格公式
  // 保证带末格与整图末格覆盖相同全局行（#2 验证，V1.2 整数格设计已覆盖）。
  const input = buildDisplayInput(160, 1004);
  const params = createHalationParams({ strength: 100, diffusionMode: 'quality', sigma: 48 });
  const full = fullReference(input, params);
  const tiled = processTiledWithTrc(input, params, TRC, { tileThreshold: 10000 });
  const { l2, maxDiff } = l2AndMax(full, tiled.rgb);
  console.log(`INFO bottom-edge H=1004 L2=${l2.toExponential(2)} max=${maxDiff.toExponential(2)}`);
  // vvGauss 带内瞬态 ~2e-6；若末格相位错误会出现 ~1e-3 的底部条带误差
  assert.ok(l2 < 1e-5, `non-multiple height L2=${l2.toExponential(2)}`);
});
