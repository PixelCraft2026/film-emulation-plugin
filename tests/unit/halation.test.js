/**
 * Halation 管线单元测试 T1–T8（PRD §5 / TDD §7）。
 * 运行：node --test tests/unit
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  processHalation,
  createHalationParams,
  extractStep,
  extractHighlights,
  applyRedShift,
  blend,
  alphaFor,
  computeHalo,
  thresholdLinear,
  sigmaPxFor,
  resolveSigmaParams,
  smoothstep,
  screenGain,
  compressedHighlightResponseFor,
  psfLobesFor,
  spectralHueResponse,
  createHalationPreset,
  HALATION_PRESET_LABELS,
  maxFilterSeparable,
} from '../../src/core/index.js';
import { makeGoldenInput } from './golden-input.js';

const W = 32;
const H = 32;
const N = W * H;

function makeImage(fillFn) {
  const rgb = new Float32Array(N * 3);
  fillFn?.(rgb);
  return { width: W, height: H, rgb };
}

function fnv1a(bytes) {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

test('T1 identity: strength=0 → output byte-identical to input, input not mutated', () => {
  const rgb = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) {
    rgb[i * 3] = (i * 7) % 1000 / 1000;
    rgb[i * 3 + 1] = (i * 13) % 1000 / 1000;
    rgb[i * 3 + 2] = (i * 17) % 1000 / 1000;
  }
  const snapshot = new Float32Array(rgb);
  const out = processHalation({ width: W, height: H, rgb }, createHalationParams({ strength: 0 }));
  assert.deepEqual(out.rgb, snapshot, 'identity output');
  assert.deepEqual(rgb, snapshot, 'input not mutated');
});

test('T2 zero input → zero output', () => {
  const out = processHalation(makeImage(), createHalationParams({ strength: 100 }));
  assert.ok(out.rgb.every((v) => v === 0), 'zero output');
});

test('T3 constant dark image → unchanged (no global red fog, A1 前置)', () => {
  const rgb = new Float32Array(N * 3).fill(0.3);
  const input = { width: W, height: H, rgb };
  const snapshot = new Float32Array(rgb);
  const out = processHalation(input, createHalationParams({ strength: 100 }));
  // S=0（亮度 0.3 < threshold 0.7）→ halo=0 → 输出=输入（与输入 Float32 快照逐位一致）
  assert.deepEqual(out.rgb, snapshot, 'dark constant unchanged');
});

test('T4 impulse: bright pixel produces red-dominant halo that decays with distance', () => {
  const input = makeImage();
  const cx = 16;
  const cy = 16;
  input.rgb[(cy * W + cx) * 3] = 2.0;
  input.rgb[(cy * W + cx) * 3 + 1] = 2.0;
  input.rgb[(cy * W + cx) * 3 + 2] = 2.0;
  const out = processHalation(input, createHalationParams({ strength: 100 }));

  // 距中心 3px 处应有红色晕：R 高于 B（redshift 1.0 vs 0.02，红晕存在）
  const near = (dy, dx) => {
    const y = cy + dy;
    const x = cx + dx;
    const p = (y * W + x) * 3;
    return { r: out.rgb[p], g: out.rgb[p + 1], b: out.rgb[p + 2] };
  };
  const a = near(3, 0);
  assert.ok(a.r > a.b, `halo is red-dominant (R=${a.r.toFixed(4)}, B=${a.b.toFixed(4)})`);
  // 衰减：距中心更远处红色更弱
  const b = near(6, 0);
  assert.ok(b.r < a.r, `halo decays (R@3px=${a.r.toFixed(4)} > R@6px=${b.r.toFixed(4)})`);
});

test('T5 golden: output hash matches committed golden (both diffusion modes)', () => {
  const goldenPath = fileURLToPath(new URL('../golden/halation-default.json', import.meta.url));
  if (!existsSync(goldenPath)) {
    test.skip(`golden file missing: ${goldenPath} — run scripts/generate-golden.mjs`);
    return;
  }
  const golden = JSON.parse(readFileSync(goldenPath, 'utf8'));
  const input = makeGoldenInput(golden.width, golden.height);
  assert.equal(fnv1a(new Uint8Array(input.rgb.buffer)), golden.inputHash, 'input hash matches golden');
  for (const mode of ['quality', 'fast']) {
    const out = processHalation(input, createHalationParams({ ...golden.params, diffusionMode: mode }));
    const outHash = fnv1a(new Uint8Array(out.rgb.buffer));
    assert.equal(outHash, golden.outputHash[mode], `golden output hash (${mode})`);
  }
});

test('T6 spill variant: extractHighlights M = max channel, Y = luma', () => {
  const rgb = new Float32Array(3);
  rgb[0] = 0.2;
  rgb[1] = 0.5;
  rgb[2] = 0.9;
  const { M, Y } = extractHighlights({ width: 1, height: 1, rgb }, createHalationParams({}));
  assert.ok(Math.abs(M[0] - 0.9) < 1e-5, 'M = max channel');
  const yExp = 0.2126 * 0.2 + 0.7152 * 0.5 + 0.0722 * 0.9;
  assert.ok(Math.abs(Y[0] - yExp) < 1e-5, 'Y = Rec.709 luma');
});

test('T7 redshift: configured channel gains are applied after diffusion', () => {
  const n = 4;
  const dr = new Float32Array(n).fill(1);
  const dg = new Float32Array(n).fill(1);
  const db = new Float32Array(n).fill(1);
  const out = applyRedShift(dr, dg, db, 2, 2, createHalationParams({ redshift: [1, 0.12, 0.02] }));
  assert.ok(Math.abs(out[0] - 1.0) < 1e-9);
  assert.ok(Math.abs(out[1] - 0.12) < 1e-6);
  assert.ok(Math.abs(out[2] - 0.02) < 1e-9);
});

test('T8 additive blend: O + α·(Halo⊙G), α = strength/100 × 2.0; screen variant', () => {
  const P = createHalationParams({ strength: 50 });
  assert.equal(alphaFor(P), 1.0);
  const input = new Float32Array(N * 3).fill(0.25);
  const halo = new Float32Array(N * 3).fill(0.5);
  const gate = new Float32Array(N).fill(1);
  const out = blend(input, halo, gate, W, H, P);
  assert.ok(Math.abs(out[0] - 0.75) < 1e-9, 'additive O + α·Halo');
  const P2 = createHalationParams({ strength: 50, blendMode: 'screen' });
  const out2 = blend(input, halo, gate, W, H, P2);
  assert.ok(Math.abs(out2[0] - (0.25 + 0.75 * 0.5)) < 1e-9, 'screen O + (1-O)·α·Halo');
});

test('T9 V1.5.1 exposure response: strong highlights grow super-linearly', () => {
  const run = (value) => {
    const input = makeImage();
    const cx = 16;
    const cy = 16;
    input.rgb[(cy * W + cx) * 3] = value;
    input.rgb[(cy * W + cx) * 3 + 1] = value;
    input.rgb[(cy * W + cx) * 3 + 2] = value;
    const out = processHalation(input, createHalationParams({ strength: 100 }));
    // 距中心 5px 处探针：背景暗（W≈0），halo ≈ plane(5px) ∝ W_pix
    const p = ((cy + 5) * W + cx) * 3;
    return out.rgb[p];
  };
  const a = run(0.8); // Y=0.8 > t1=0.75 → S=1
  const b = run(1.6); // 2× 亮度
  assert.ok(a > 0, `halo exists at Y=0.8 (a=${a.toFixed(4)})`);
  const ratio = b / a;
  assert.ok(ratio > 8, `strong-source halo grows super-linearly (ratio=${ratio.toFixed(3)})`);
});

test('T10 extract: W uses the bounded compressed-highlight response', () => {
  const rgb = new Float32Array(3);
  rgb[0] = 1.0;
  rgb[1] = 1.0;
  rgb[2] = 1.0;
  const { W, S } = extractHighlights({ width: 1, height: 1, rgb }, createHalationParams({ threshold: 0.7 }));
  assert.equal(S[0], 1, 'S=1 for Y=1');
  const expected = compressedHighlightResponseFor(1, 0.7, createHalationParams({}).sourceImpact);
  assert.ok(Math.abs(W[0] - expected) < 1e-6, `W = compressed response(Y,T) (got ${W[0]})`);
  // threshold=0 防御：不除零
  const { W: W0 } = extractHighlights({ width: 1, height: 1, rgb }, createHalationParams({ threshold: 0 }));
  assert.ok(Number.isFinite(W0[0]) && W0[0] > 0, 'threshold=0 uses a finite normalized response');
});

test('T11 new params (1.5/2.3): extraction/spillMix/rolloff validation + pipeline wiring', () => {
  // 校验：非法值抛错
  assert.throws(() => createHalationParams({ extraction: 'bogus' }), TypeError, 'invalid extraction');
  assert.throws(() => createHalationParams({ spillMix: 1.5 }), TypeError, 'spillMix out of range');
  assert.throws(() => createHalationParams({ rolloff: -0.1 }), TypeError, 'rolloff out of range');
  // 默认值
  const d = createHalationParams({});
  assert.equal(d.extraction, 'threshold');
  assert.equal(d.spillMix, 0.5);
  assert.equal(d.rolloff, 0);
  // 接线：extraction 作为参数可直接驱动管线（spill 提取对饱和色高光产生更高 S）
  const saturated = makeImage();
  const p = (2 * W + 2) * 3;
  saturated.rgb[p] = 0.9; // 纯红高光：Y 低（≈0.19），M 高（0.9）
  saturated.rgb[p + 1] = 0.0;
  saturated.rgb[p + 2] = 0.0;
  const base = createHalationParams({ strength: 100, threshold: 0.5 });
  const { S: Sthr } = extractStep({ width: W, height: H, rgb: saturated.rgb }, { ...base, extraction: 'threshold' });
  const { S: Sspill } = extractStep({ width: W, height: H, rgb: saturated.rgb }, { ...base, extraction: 'spill', spillMix: 1 });
  assert.ok(Sspill[p / 3] > Sthr[p / 3], `spill 提取对饱和红高光更强 (${Sthr[p / 3].toFixed(3)} vs ${Sspill[p / 3].toFixed(3)})`);
});

test('T12 luma override (2.1): options.luma changes Y/extraction', () => {
  // 纯红像素：Rec.709 Y=0.2126 vs Rec.2020 Y=0.2627 → 不同空间下 S/W 不同
  const rgb = new Float32Array(3);
  rgb[0] = 1.0;
  rgb[1] = 0.0;
  rgb[2] = 0.0;
  const params = createHalationParams({ threshold: 0.25 });
  const a = extractStep({ width: 1, height: 1, rgb }, params, { luma: [0.2126, 0.7152, 0.0722] });
  const b = extractStep({ width: 1, height: 1, rgb }, params, { luma: [0.2627, 0.678, 0.0593] });
  // Y 是 Float32Array：存储精度 ~1e-7 量级，容差取 1e-6
  assert.ok(Math.abs(a.Y[0] - 0.2126) < 1e-6, `Rec.709 luma (${a.Y[0]})`);
  assert.ok(Math.abs(b.Y[0] - 0.2627) < 1e-6, `Rec.2020 luma (${b.Y[0]})`);
  assert.ok(b.S[0] > a.S[0], 'Rec2020 下纯红更亮 → S 更大');
});

test('T13 isotropy (V1.2 菱形修复): point-source halo is circular — axis ≈ diagonal at equal radius', () => {
  // 旧单指数可分离核：K(x,y)=exp(-(|x|+|y|)/σ) 曼哈顿距离 → 菱形（主轴/对角 ≈1.6×）。
  // 三瓣高斯核各向同性：等半径处光晕应一致。
  for (const mode of ['fast', 'quality']) {
    const input = makeImage();
    const cx = 16;
    const cy = 16;
    const p = (cy * W + cx) * 3;
    input.rgb[p] = 10;
    input.rgb[p + 1] = 10;
    input.rgb[p + 2] = 10;
    const out = processHalation(input, createHalationParams({ strength: 100, sigma: 7, diffusionMode: mode }));
    const at = (dy, dx) => out.rgb[((cy + dy) * W + (cx + dx)) * 3];
    const axis = at(5, 0); // 欧氏距离 5
    const diag = at(4, 4); // 欧氏距离 √32 ≈ 5.66
    const diag2 = at(3, 3); // 欧氏距离 √18 ≈ 4.24
    const ratio = axis / diag;
    console.log(`INFO ${mode} axis(5,0)/diag(4,4) = ${ratio.toFixed(3)}`);
    // 两个采样点半径并不相同（5 vs √32），仅作宽松形状检查；严格等半径见下方 (3,4)。
    assert.ok(ratio > 0.7 && ratio < 1.5, `${mode} 近似半径形状（axis/diag=${ratio.toFixed(3)}）`);
    // 相同欧氏距离的严格对比：r=5 主轴 vs r=5 对角线上最近点（3,4）：√(9+16)=5
    const diag5 = at(3, 4);
    const r5 = axis / diag5;
    assert.ok(r5 > 0.93 && r5 < 1.07, `${mode} r=5 各向同性（axis/diag5=${r5.toFixed(3)}）`);
  }
});

test('T14 units (#3/#5): threshold stops 换算、σ 对角线单位、validate', () => {
  // stops 换算：中灰 0.18 基准
  assert.ok(Math.abs(thresholdLinear(0, 'stops') - 0.18) < 1e-9, '0 stops = 中灰 0.18');
  assert.ok(Math.abs(thresholdLinear(1, 'stops') - 0.36) < 1e-9, '+1 stop = 0.36');
  assert.ok(Math.abs(thresholdLinear(-1, 'stops') - 0.09) < 1e-9, '-1 stop = 0.09');
  assert.equal(thresholdLinear(0.7, 'linear'), 0.7, 'linear 直通');
  // σ 对角线单位：7‰ 对角线（3:2 图 6000×4000 → 对角线 7211px → σ≈50.5px）
  const d = createHalationParams({ sigma: 7, sigmaUnits: 'diagonal' });
  const px = sigmaPxFor(d, 6000, 4000);
  assert.ok(Math.abs(px - (7 / 1000) * Math.hypot(6000, 4000)) < 1e-6, `diagonal σ→px (${px})`);
  assert.equal(sigmaPxFor(createHalationParams({ sigma: 7 }), 6000, 4000), 7, 'pixels 直通');
  // resolveSigmaParams：幂等 + 不修改原参数
  const resolved = resolveSigmaParams(d, 6000, 4000);
  assert.equal(resolved.sigmaUnits, 'pixels', '解析后 units=pixels');
  assert.equal(resolved.sigma, px);
  assert.equal(d.sigmaUnits, 'diagonal', '原参数不变');
  const again = resolveSigmaParams(resolved, 6000, 4000);
  assert.equal(again.sigma, px, '幂等（不二次换算）');
  // validate：新字段
  assert.throws(() => createHalationParams({ thresholdUnits: 'bogus' }), TypeError);
  assert.throws(() => createHalationParams({ sigmaUnits: 'bogus' }), TypeError);
  assert.throws(() => createHalationParams({ sourceImpact: 1.1 }), TypeError);
  assert.throws(() => createHalationParams({ amplify: 4.1 }), TypeError);
  assert.throws(() => createHalationParams({ sourceExpansion: 1.1 }), TypeError);
  assert.throws(() => createHalationParams({ redTail: -0.1 }), TypeError);
  assert.throws(() => createHalationParams({ blueCompensation: 1.1 }), TypeError);
  assert.throws(() => createHalationParams({ colorDensity: -0.1 }), TypeError);
  assert.throws(() => createHalationParams({ hotSourceThreshold: -0.1 }), TypeError);
  assert.throws(() => createHalationParams({ hotCoreStrength: 1.1 }), TypeError);
  assert.throws(() => createHalationParams({ globalSourceThreshold: 4.1 }), TypeError);
  assert.throws(() => createHalationParams({ redLayerThresholdBias: 1.01 }), TypeError);
  assert.throws(() => createHalationParams({ redLayerThresholdBias: -0.01 }), TypeError);
  assert.throws(() => createHalationParams({ threshold: 9 }), TypeError, 'threshold > 8 拒绝');
  assert.doesNotThrow(() => createHalationParams({ threshold: 2.88 }), 'stops 换算值 >1 合法');
  assert.doesNotThrow(
    () => createHalationParams({ thresholdUnits: 'stops', threshold: -4, backgroundThreshold: -2 }),
    'stops 允许负曝光档',
  );
  // extract 行为：stops 0 档 ≈ 中灰阈值（Y=0.2 有提取）；linear 0.7 下 Y=0.2 无提取
  const rgb = new Float32Array(3).fill(0.2);
  const inStops = extractStep({ width: 1, height: 1, rgb }, createHalationParams({ threshold: 0, thresholdUnits: 'stops' }));
  const inLinear = extractStep({ width: 1, height: 1, rgb }, createHalationParams({ threshold: 0.7 }));
  assert.ok(inStops.S[0] > 0.7, `stops 0 档提取 Y=0.2 (S=${inStops.S[0].toFixed(3)})`);
  assert.equal(inLinear.S[0], 0, 'linear 0.7 不提取 Y=0.2');
});

test('T15 exact threshold and independent softness never produce NaN', () => {
  assert.equal(smoothstep(0.5, 0.5, 0.49), 0);
  assert.equal(smoothstep(0.5, 0.5, 0.5), 1);
  const rgb = new Float32Array(3).fill(0.7);
  const result = extractHighlights(
    { width: 1, height: 1, rgb },
    createHalationParams({ sourceSoftness: 0, backgroundSoftness: 0, threshold: 0.7 }),
  );
  assert.ok([...result.S, ...result.G, ...result.W].every(Number.isFinite));
});

test('T16 spill radiance follows selected S/M field', () => {
  const rgb = new Float32Array([1, 0, 0]);
  const threshold = extractHighlights(
    { width: 1, height: 1, rgb },
    createHalationParams({ threshold: 0.5, extraction: 'threshold' }),
    { extraction: 'threshold' },
  );
  const spill = extractHighlights(
    { width: 1, height: 1, rgb },
    createHalationParams({ threshold: 0.5, extraction: 'spill', spillMix: 1 }),
    { extraction: 'spill', spillMix: 1 },
  );
  assert.equal(threshold.W[0], 0, '纯红的 luma 未达到阈值');
  assert.ok(spill.W[0] > 0.9, `spill W 使用 max RGB 的曝光响应 (${spill.W[0]})`);
});

test('T16b red-layer threshold bias continuously blends complete source fields', () => {
  const common = {
    threshold: 0.6,
    sourceSoftness: 0.02,
    extraction: 'threshold',
    spillMix: 0,
    sourceImpact: 0,
    spectralSensitivity: 1,
    amplify: 1,
    sourceExpansion: 0,
  };
  const extract = (rgb, redLayerThresholdBias) => extractHighlights(
    { width: 1, height: 1, rgb: new Float32Array(rgb) },
    createHalationParams({ ...common, redLayerThresholdBias }),
  );
  const legacyRed = extract([0.8, 0, 0], 0);
  const mixedRed = extract([0.8, 0, 0], 0.5);
  const layerRed = extract([0.8, 0, 0], 1);
  assert.equal(legacyRed.sourceR[0], 0, 'human-luma legacy threshold rejects the same deep red emitter');
  assert.ok(layerRed.sourceR[0] > 0, 'red-layer exposure lets a strong deep red emitter cross the main threshold');
  assert.ok(
    mixedRed.sourceR[0] > legacyRed.sourceR[0] && mixedRed.sourceR[0] < layerRed.sourceR[0],
    'midpoint transitions smoothly between the two complete source fields',
  );
  assert.ok(
    Math.abs(mixedRed.sourceR[0] - (legacyRed.sourceR[0] + layerRed.sourceR[0]) * 0.5) < 1e-6,
    'midpoint is the exact arithmetic mean of the completed spectral source fields',
  );

  const legacyBlue = extract([0, 0, 1], 0);
  const layerBlue = extract([0, 0, 1], 1);
  assert.equal(legacyBlue.sourceR[0], 0);
  assert.equal(layerBlue.sourceR[0], 0, 'red-layer endpoint does not promote a saturated blue emitter');

  const legacyWhite = extract([0.8, 0.8, 0.8], 0);
  const layerWhite = extract([0.8, 0.8, 0.8], 1);
  assert.ok(Math.abs(layerWhite.sourceR[0] - legacyWhite.sourceR[0]) < 1e-6, 'neutral white keeps the legacy exposure scale');
});

test('T16c omitted red-layer bias is bit-identical to explicit brightness endpoint', () => {
  const input = makeImage((rgb) => {
    for (let i = 0; i < rgb.length; i++) rgb[i] = ((i * 2654435761) >>> 10) / 0x3fffff;
  });
  const implicit = processHalation(input, createHalationParams({ strength: 73, extraction: 'spill', spillMix: 0.55 }));
  const explicit = processHalation(input, createHalationParams({
    strength: 73,
    extraction: 'spill',
    spillMix: 0.55,
    redLayerThresholdBias: 0,
  }));
  assert.deepEqual(explicit.rgb, implicit.rgb);
});

test('T17 alpha is preserved and transparent RGB cannot emit a halo', () => {
  const input = makeImage();
  const alpha = new Float32Array(N).fill(1);
  const center = 16 * W + 16;
  input.rgb[center * 3] = 10;
  input.rgb[center * 3 + 1] = 10;
  input.rgb[center * 3 + 2] = 10;
  alpha[center] = 0;
  const out = processHalation({ ...input, alpha }, createHalationParams({ strength: 100 }));
  assert.deepEqual(out.alpha, alpha, 'alpha byte values are preserved');
  const probe = ((16 + 4) * W + 16) * 3;
  assert.equal(out.rgb[probe], 0, 'fully transparent bright RGB emits no halo');
});

test('T18 HDR-safe screen never darkens values above 1', () => {
  assert.ok(screenGain(2) > 0);
  const input = new Float32Array(N * 3).fill(2);
  const halo = new Float32Array(N * 3).fill(0.5);
  const out = blend(input, halo, null, W, H, createHalationParams({ strength: 50, blendMode: 'screen' }));
  assert.ok(out[0] > 2, `HDR screen remains additive (${out[0]})`);
});

test('T19 spectral source limits blue-to-red leakage', () => {
  const run = (channel) => {
    const input = makeImage();
    const p = (16 * W + 16) * 3;
    input.rgb[p + channel] = 4;
    const out = processHalation(input, createHalationParams({ strength: 100, extraction: 'spill', spillMix: 1 }));
    return out.rgb[((16 + 4) * W + 16) * 3];
  };
  const redSource = run(0);
  const blueSource = run(2);
  assert.ok(redSource > blueSource * 8, `red source ${redSource} dominates blue leakage ${blueSource}`);
});

test('T19b hue response distinguishes warm, green, cyan and blue emitters', () => {
  const params = createHalationParams({
    threshold: 0.2,
    sourceSoftness: 0,
    extraction: 'spill',
    spillMix: 1,
    spectralSensitivity: 1,
    hotSourceThreshold: 0,
  });
  const layer = (rgb) => extractHighlights(
    { width: 1, height: 1, rgb: new Float32Array(rgb) },
    params,
    { extraction: 'spill', spillMix: 1 },
  );
  const red = layer([1, 0, 0]);
  const yellow = layer([1, 1, 0]);
  const green = layer([0, 1, 0]);
  const cyan = layer([0, 1, 1]);
  const blue = layer([0, 0, 1]);
  assert.ok(red.sourceR[0] > green.sourceR[0] * 8, 'red emitter strongly reaches the deep red layer');
  assert.ok(yellow.sourceR[0] > green.sourceR[0] * 8, 'yellow emitter retains a strong red-layer response');
  assert.ok(green.sourceR[0] > cyan.sourceR[0] * 2, 'green is stronger than cyan');
  assert.ok(cyan.sourceR[0] > blue.sourceR[0] * 5, 'blue has the weakest long-wave response');
  assert.ok(yellow.sourceG[0] > red.sourceG[0] * 20, 'yellow excites the orange-core green layer more than red');
});

test('T19c hue response is continuous at red wrap and neutral light stays unclassified', () => {
  const a = spectralHueResponse(1, 0, 0.001);
  const b = spectralHueResponse(1, 0.001, 0);
  assert.ok(Math.abs(a.red - b.red) < 0.01, `red wrap remains continuous (${a.red} vs ${b.red})`);
  assert.deepEqual(spectralHueResponse(0.5, 0.5, 0.5), {
    hue: 0,
    saturation: 0,
    red: 1,
    green: 1,
    blue: 1,
  });
});

test('T19d Tungsten 800 preset is high-threshold, compact and hue-aware', () => {
  const p = createHalationPreset('tungsten-800');
  assert.equal(p.profile, 'tungsten-800');
  assert.equal(HALATION_PRESET_LABELS['tungsten-800'], 'Tungsten 800 No-Remjet');
  assert.equal(p.sigmaUnits, 'diagonal');
  assert.ok(p.strength >= 80, 'no-remjet preset uses a high final Impact');
  assert.ok(p.threshold >= 0.8, 'weak window lights are limited');
  assert.ok(p.hotCoreStrength >= 0.8, 'strong sources retain a solid core');
  assert.ok(p.smoothness <= 0.2, 'PSF remains compact');
  assert.ok(p.amplify >= 2, 'returned emulsion energy is amplified independently of Impact');
  assert.ok(p.sourceExpansion >= 0.8, 'strong seeds recruit their adjacent optical glow');
  assert.ok(p.redTail >= 0.75, 'deep red layer uses an enhanced tail');
  assert.ok(p.blueCompensation >= 0.8, 'cool-background compensation is enabled');
  assert.ok(p.colorDensity >= 0.6, 'density-inspired chroma composite is enabled');
  assert.ok(p.globalSourceThreshold < 1, 'clipped SDR white enters global red diffusion');
  assert.equal(p.spectralSensitivity, 1, 'Tungsten preset uses strict hue response');
  assert.throws(() => createHalationPreset('unknown'), /Unknown halation preset/);
});

test('T19d2 Neutral preset is a restrained physical profile below No-Remjet', () => {
  const neutral = createHalationPreset('standard');
  const noRemjet = createHalationPreset('tungsten-800');
  assert.equal(neutral.profile, 'standard');
  assert.equal(neutral.sigmaUnits, 'diagonal', 'neutral halo size scales with image dimensions');
  assert.ok(neutral.strength >= 55 && neutral.strength <= 70, 'neutral uses a restrained final impact');
  assert.ok(neutral.amplify >= 1.3 && neutral.amplify < 1.8, 'neutral adds moderate returned emulsion energy');
  assert.ok(neutral.sourceExpansion > 0 && neutral.sourceExpansion <= 0.2, 'neutral recruits only a narrow optical-glow neighbourhood');
  assert.ok(neutral.redTail > 0 && neutral.redTail <= 0.3, 'neutral keeps a short red tail');
  assert.equal(neutral.spectralSensitivity, 1, 'saturated blue/cyan leakage is strictly suppressed');
  assert.ok(neutral.globalDiffusion <= 0.01, 'dense city lights cannot accumulate into broad red fog');
  assert.ok(neutral.globalSourceThreshold > 1, 'ordinary clipped SDR windows do not feed global diffusion');
  assert.ok(neutral.colorDensity > 0 && neutral.colorDensity < noRemjet.colorDensity);
  assert.ok(neutral.amplify < noRemjet.amplify);
  assert.ok(neutral.sourceExpansion < noRemjet.sourceExpansion);
  assert.ok(neutral.redTail < noRemjet.redTail);

  const input = makeImage((rgb) => {
    const p = (16 * W + 16) * 3;
    rgb[p] = 1;
    rgb[p + 1] = 1;
    rgb[p + 2] = 1;
  });
  const legacy = processHalation(input, createHalationParams({ strength: 50, profile: 'standard' }));
  const medium = processHalation(input, neutral);
  let legacyAdded = 0;
  let mediumAdded = 0;
  for (let index = 0; index < input.rgb.length; index++) {
    if (index >= (16 * W + 16) * 3 && index < (16 * W + 16) * 3 + 3) continue;
    legacyAdded += Math.max(0, legacy.rgb[index] - input.rgb[index]);
    mediumAdded += Math.max(0, medium.rgb[index] - input.rgb[index]);
  }
  assert.ok(mediumAdded > legacyAdded * 0.2, 'neutral remains visibly active while protecting the source core');
  assert.ok(medium.rgb[(16 * W + 16) * 3] >= 1, 'compact white emitter remains a luminous core');
});

test('T19f strict hue response rejects high-energy blue/cyan leakage', () => {
  const p = createHalationPreset('tungsten-800');
  const layer = (rgb) => extractHighlights(
    { width: 1, height: 1, rgb: new Float32Array(rgb) },
    p,
    { extraction: p.extraction, spillMix: p.spillMix },
  );
  const white = layer([2, 2, 2]);
  const cyan = layer([0, 2, 2]);
  const blue = layer([0, 0, 2]);
  const total = (x) => x.sourceR[0] + x.sourceG[0] + x.sourceB[0];
  assert.ok(total(blue) < total(white) * 1e-4, `blue leakage is negligible (${total(blue)} vs ${total(white)})`);
  assert.ok(total(cyan) < total(white) * 0.01, `cyan leakage remains below 1% (${total(cyan)} vs ${total(white)})`);
});

test('T19f2 cool-white emitters remain active while saturated blue LEDs stay rejected', () => {
  const p = createHalationPreset('standard');
  const layer = (rgb, spectralSensitivity = p.spectralSensitivity) => extractHighlights(
    { width: 1, height: 1, rgb: new Float32Array(rgb) },
    { ...p, spectralSensitivity },
    { extraction: p.extraction, spillMix: p.spillMix },
  );
  const white = layer([1, 1, 1]);
  const coolWhite = layer([0.72, 0.84, 1]);
  const coolWhiteUnclassified = layer([0.72, 0.84, 1], 0);
  const saturatedBlue = layer([0.02, 0.10, 1]);
  assert.ok(
    coolWhite.sourceR[0] > coolWhiteUnclassified.sourceR[0] * 0.999,
    `slightly cool white is not attenuated by hue protection (${coolWhite.sourceR[0]} vs ${coolWhiteUnclassified.sourceR[0]})`,
  );
  assert.ok(
    saturatedBlue.sourceR[0] < white.sourceR[0] * 0.01,
    `saturated blue LED remains rejected (${saturatedBlue.sourceR[0]} vs ${white.sourceR[0]})`,
  );
});

test('T19g Tungsten preset reconstructs clipped SDR white as a strong source', () => {
  const p = createHalationPreset('tungsten-800');
  const exposure = (value) => extractHighlights(
    { width: 1, height: 1, rgb: new Float32Array([value, value, value]) },
    p,
    { extraction: p.extraction, spillMix: p.spillMix },
  ).U[0];
  const weak = exposure(0.85);
  const clippedWhite = exposure(1);
  const hdrTwo = exposure(2);
  assert.ok(weak < p.hotSourceThreshold - 0.2, `weak window remains below Strong Core (${weak})`);
  assert.equal(clippedWhite, 1, 'the compressed T..1 SDR highlight range maps to 0..1');
  assert.equal(hdrTwo, 2, 'HDR energy continues from white by exposure stops');
});

test('T19h white emitter crosses a blue-sky/optical-glow background without re-enabling blue emitters', () => {
  const width = 129;
  const height = 129;
  const cx = width >> 1;
  const cy = height >> 1;
  const params = createHalationParams({
    ...createHalationPreset('tungsten-800'),
    sigmaUnits: 'pixels',
    sigma: 8,
    strength: 100,
    globalDiffusion: 0,
  });

  const gateProbe = extractHighlights(
    {
      width: 2,
      height: 1,
      // 两个像素亮度接近；前者是高饱和蓝天，后者是中性灰。
      rgb: new Float32Array([0.10, 0.45, 0.80, 0.40, 0.40, 0.40]),
    },
    params,
  ).G;
  assert.ok(gateProbe[0] > gateProbe[1] + 0.5, `blue background keeps more red-layer headroom (${gateProbe[0]} vs ${gateProbe[1]})`);

  const whiteRgb = new Float32Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const d = Math.hypot(x - cx, y - cy);
      const opticalGlow = Math.exp(-(d * d) / (2 * 9 * 9)) * 0.75;
      const p = (y * width + x) * 3;
      whiteRgb[p] = 0.03 * (1 - opticalGlow) + opticalGlow;
      whiteRgb[p + 1] = 0.16 * (1 - opticalGlow) + opticalGlow;
      whiteRgb[p + 2] = 0.25 * (1 - opticalGlow) + opticalGlow;
      if (d < 2) whiteRgb[p] = whiteRgb[p + 1] = whiteRgb[p + 2] = 1;
    }
  }
  const whiteOut = processHalation({ width, height, rgb: whiteRgb }, params);
  const innerRing = (cy * width + cx + 4) * 3;
  const whiteRed = whiteOut.rgb[innerRing] - whiteRgb[innerRing];
  const whiteGreen = whiteOut.rgb[innerRing + 1] - whiteRgb[innerRing + 1];
  assert.ok(whiteOut.G[innerRing / 3] < 0.2, 'pre-existing bright optical glow still mostly closes the ordinary background gate');
  assert.ok(whiteRed > 0.01, `spectrally eligible strong source crosses the closed gate (${whiteRed})`);
  assert.ok(whiteRed > whiteGreen * 3, 'the restored halo remains red-dominant');

  const blueRgb = new Float32Array(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    blueRgb[i * 3] = 0.03;
    blueRgb[i * 3 + 1] = 0.16;
    blueRgb[i * 3 + 2] = 0.25;
  }
  const center = (cy * width + cx) * 3;
  blueRgb[center + 2] = 2;
  const blueOut = processHalation({ width, height, rgb: blueRgb }, params);
  const blueRing = (cy * width + cx + 4) * 3;
  const blueRed = blueOut.rgb[blueRing] - blueRgb[blueRing];
  assert.ok(blueRed < whiteRed * 1e-3, `strict source-side blue suppression is preserved (${blueRed} vs ${whiteRed})`);
});

test('T19i source expansion requires a spectrally eligible strong seed', () => {
  const width = 9;
  const center = width >> 1;
  const params = createHalationParams({
    ...createHalationPreset('tungsten-800'),
    sigmaUnits: 'pixels',
    sigma: 2,
    amplify: 1,
  });
  const field = (seed) => {
    const rgb = new Float32Array(width * 3);
    const neighbor = center + 2;
    rgb[neighbor * 3] = rgb[neighbor * 3 + 1] = rgb[neighbor * 3 + 2] = 0.65;
    if (seed) {
      rgb[center * 3] = seed[0];
      rgb[center * 3 + 1] = seed[1];
      rgb[center * 3 + 2] = seed[2];
    }
    return extractHighlights({ width, height: 1, rgb }, params);
  };
  const none = field(null);
  const white = field([1, 1, 1]);
  const blue = field([0, 0, 2]);
  const neighbor = center + 2;
  assert.equal(none.sourceR[neighbor], 0, 'a sub-threshold patch cannot expand itself');
  assert.ok(white.sourceR[neighbor] > 0.1, `white strong seed recruits adjacent glow (${white.sourceR[neighbor]})`);
  assert.ok(blue.sourceR[neighbor] < white.sourceR[neighbor] * 1e-3, 'pure blue seed cannot authorize red source growth');
});

test('T19i2 source expansion rechecks candidate hue and cannot recolor an adjacent saturated blue LED', () => {
  const width = 13;
  const center = width >> 1;
  const params = createHalationParams({
    ...createHalationPreset('standard'),
    sigmaUnits: 'pixels',
    sigma: 3,
    threshold: 0.72,
    sourceExpansion: 1,
    amplify: 1,
  });
  const rgb = new Float32Array(width * 3);
  rgb[center * 3] = rgb[center * 3 + 1] = rgb[center * 3 + 2] = 1;
  const neutralNeighbor = center - 2;
  rgb[neutralNeighbor * 3] = rgb[neutralNeighbor * 3 + 1] = rgb[neutralNeighbor * 3 + 2] = 0.7;
  const blueNeighbor = center + 2;
  rgb[blueNeighbor * 3] = 0.02;
  rgb[blueNeighbor * 3 + 1] = 0.10;
  rgb[blueNeighbor * 3 + 2] = 1;
  const out = extractHighlights({ width, height: 1, rgb }, params);
  assert.ok(out.sourceR[neutralNeighbor] > 0.05, 'nearby neutral optical glow remains authorized');
  assert.ok(
    out.sourceR[blueNeighbor] < out.sourceR[neutralNeighbor] * 0.01,
    `saturated blue candidate stays rejected (${out.sourceR[blueNeighbor]} vs ${out.sourceR[neutralNeighbor]})`,
  );
  assert.ok(out.K[blueNeighbor] < out.K[neutralNeighbor] * 0.01, 'blue candidate cannot reopen source-interior protection');
});

test('T19i3 Neutral protects a bright saturated blue target from nearby white-source halo', () => {
  const width = 97;
  const height = 65;
  const cy = height >> 1;
  const rgb = new Float32Array(width * height * 3).fill(0.015);
  const whiteX = 42;
  const blueX = 52;
  const white = (cy * width + whiteX) * 3;
  rgb[white] = rgb[white + 1] = rgb[white + 2] = 1;
  const blue = (cy * width + blueX) * 3;
  rgb[blue] = 0.02;
  rgb[blue + 1] = 0.10;
  rgb[blue + 2] = 1;
  const params = createHalationParams({
    ...createHalationPreset('standard'),
    sigmaUnits: 'pixels',
    sigma: 8,
    strength: 100,
    globalDiffusion: 0,
  });
  const protectedOut = processHalation({ width, height, rgb }, params);
  const unprotectedOut = processHalation({ width, height, rgb }, createHalationParams({
    ...params,
    sourceInteriorProtection: 0,
  }));
  const protectedRed = protectedOut.rgb[blue] - rgb[blue];
  const unprotectedRed = unprotectedOut.rgb[blue] - rgb[blue];
  assert.ok(protectedRed < unprotectedRed * 0.05, `blue emitter target stays blue (${protectedRed} vs ${unprotectedRed})`);
  const sky = (cy * width + blueX + 3) * 3;
  assert.ok(protectedOut.rgb[sky] > rgb[sky], 'nearby dark/blue background may still receive the white source halo');
});

test('T19j Amplify is pre-PSF energy, while redTail redistributes only the deep red layer', () => {
  const base = createHalationParams({ threshold: 0.2, sourceSoftness: 0, amplify: 1 });
  const boosted = createHalationParams({ ...base, amplify: 2 });
  const input = { width: 1, height: 1, rgb: new Float32Array([1, 1, 1]) };
  const a = extractHighlights(input, base);
  const b = extractHighlights(input, boosted);
  assert.ok(Math.abs(b.sourceR[0] / a.sourceR[0] - 2) < 1e-6, 'Amplify scales red source energy before diffusion');

  const neutral = psfLobesFor(createHalationParams({ smoothness: 0.14, redTail: 0 }), 'red');
  const noRemjet = psfLobesFor(createHalationParams({ smoothness: 0.14, redTail: 1 }), 'red');
  const sum = noRemjet.reduce((acc, lobe) => acc + lobe.weight, 0);
  assert.ok(Math.abs(sum - 1) < 1e-12, 'red-tail PSF remains DC-normalized');
  assert.ok(noRemjet[2].weight > neutral[2].weight, 'red tail receives more energy');
  assert.ok(noRemjet[2].sigmaRatio > neutral[2].sigmaRatio, 'red tail also spreads farther');
  assert.deepEqual(
    psfLobesFor(createHalationParams({ smoothness: 0.14, redTail: 1 }), 'green'),
    psfLobesFor(createHalationParams({ smoothness: 0.14, redTail: 0 }), 'green'),
    'green/orange core does not inherit the red-only tail boost',
  );
});

test('T19k density composite increases red chroma without reducing linear luminance', () => {
  const input = new Float32Array([0.2, 0.5, 0.7]);
  const halo = new Float32Array([0.18, 0.02, 0]);
  const additive = blend(input, halo, null, 1, 1, createHalationParams({ strength: 50, colorDensity: 0 }));
  const density = blend(input, halo, null, 1, 1, createHalationParams({
    strength: 50,
    colorDensity: 0.8,
    blueCompensation: 1,
  }));
  const luma = (rgb) => 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
  assert.ok(luma(density) >= luma(input) - 1e-7, 'density colorization preserves base luminance before positive halo energy');
  assert.ok(
    density[0] - Math.max(density[1], density[2]) > additive[0] - Math.max(additive[1], additive[2]) + 0.2,
    'cool white/blue glow becomes visibly red rather than merely brighter',
  );
});

test('T19l separable max filter is alias-safe and reaches the configured radius', () => {
  const src = new Float32Array(25);
  src[12] = 1;
  const out = maxFilterSeparable(src, 5, 5, 1, src);
  assert.equal(out[12], 1);
  assert.equal(out[6], 1, 'diagonal neighbor is included by the separable square support');
  assert.equal(out[2], 0, 'pixels beyond radius remain excluded');
});

test('T19m No-Remjet expansion does not turn dense sub-threshold windows into red fog', () => {
  const input = makeImage();
  for (let y = 2; y < H; y += 4) {
    for (let x = 2; x < W; x += 4) {
      const p = (y * W + x) * 3;
      input.rgb[p] = input.rgb[p + 1] = input.rgb[p + 2] = 0.85;
    }
  }
  const out = processHalation(input, createHalationParams({
    ...createHalationPreset('tungsten-800'),
    sigmaUnits: 'pixels',
    sigma: 4,
  }));
  assert.deepEqual(out.rgb, input.rgb, 'without a high-threshold seed, expansion/global/density paths remain inactive');
});

test('T19e Tungsten 800 preset keeps clipped SDR white visibly active', () => {
  const width = 129;
  const height = 129;
  const rgb = new Float32Array(width * height * 3);
  const center = ((height >> 1) * width + (width >> 1)) * 3;
  rgb[center] = 1;
  rgb[center + 1] = 1;
  rgb[center + 2] = 1;
  const params = resolveSigmaParams(createHalationPreset('tungsten-800'), 2048, 1365);
  const out = processHalation({ width, height, rgb }, params);
  let maxBackgroundDelta = 0;
  for (let p = 0; p < out.rgb.length; p += 3) {
    if (p === center) continue;
    maxBackgroundDelta = Math.max(maxBackgroundDelta, out.rgb[p] - rgb[p]);
  }
  assert.ok(maxBackgroundDelta > 0.001, `clipped white produces visible red halo (${maxBackgroundDelta})`);
});

test('T-extra: computeHalo = max(D − centerAttenuation·S, 0)', () => {
  const d = new Float32Array(N * 3).fill(1);
  const s = new Float32Array(N).fill(0.5);
  const halo = computeHalo(d, s, W, H, createHalationParams({ centerAttenuation: 0.9 }));
  assert.ok(Math.abs(halo[0] - 0.55) < 1e-5, 'D − k·S');
});

test('T20 V1.5.1 source limiter separates weak windows from strong emitters', () => {
  const params = createHalationParams({ threshold: 0.82, sourceSoftness: 0.02, sourceImpact: 0.65 });
  const field = (value) => {
    const rgb = new Float32Array([value, value, value]);
    return extractHighlights({ width: 1, height: 1, rgb }, params).W[0];
  };
  const weak = field(0.85);
  const strong = field(1.0);
  assert.ok(weak > 0, 'weak source remains continuous, not hard-clipped');
  assert.ok(strong > weak * 10, `strong/weak separation (${strong / weak}x)`);
});

test('T21 V1.5.1 strong-source core lowers center attenuation only for hot sources', () => {
  const run = (value, hotCoreStrength) => {
    const input = makeImage();
    const center = 16 * W + 16;
    input.rgb[center * 3] = value;
    input.rgb[center * 3 + 1] = value;
    input.rgb[center * 3 + 2] = value;
    return processHalation(input, createHalationParams({
      strength: 100,
      threshold: 0.82,
      sourceSoftness: 0.02,
      centerAttenuation: 0.9,
      hotCoreStrength,
      globalDiffusion: 0,
    })).halo[center * 3];
  };
  const weakOff = run(0.85, 0);
  const weakOn = run(0.85, 1);
  const hotOff = run(1.6, 0);
  const hotDefault = run(1.6, 0.75);
  const hotOn = run(1.6, 1);
  assert.ok(Math.abs(weakOn - weakOff) < 1e-6, 'weak source core is unchanged');
  assert.ok(hotDefault > hotOff, `default Strong Core keeps a dense core (${hotOff} -> ${hotDefault})`);
  assert.ok(hotOn > hotOff, `hot source keeps a denser core (${hotOff} -> ${hotOn})`);
});

test('T22 V1.5.1 global diffusion rejects a dense weak-window field', () => {
  const input = makeImage();
  for (let y = 2; y < H; y += 4) {
    for (let x = 2; x < W; x += 4) {
      const p = (y * W + x) * 3;
      input.rgb[p] = input.rgb[p + 1] = input.rgb[p + 2] = 0.85;
    }
  }
  const common = {
    strength: 100,
    threshold: 0.82,
    sourceSoftness: 0.02,
    globalSourceThreshold: 0.75,
  };
  const local = processHalation(input, createHalationParams({ ...common, globalDiffusion: 0 }));
  const global = processHalation(input, createHalationParams({ ...common, globalDiffusion: 1 }));
  let maxDelta = 0;
  for (let i = 0; i < local.rgb.length; i++) maxDelta = Math.max(maxDelta, Math.abs(global.rgb[i] - local.rgb[i]));
  assert.ok(maxDelta < 1e-7, `weak windows do not feed global red haze (max delta ${maxDelta})`);
});

test('T23 V1.5.1 PSF is normalized and core-dominant across smoothness range', () => {
  for (const smoothness of [0, 0.15, 1]) {
    const lobes = psfLobesFor(createHalationParams({ smoothness }));
    const sum = lobes.reduce((acc, lobe) => acc + lobe.weight, 0);
    assert.equal(lobes.length, 3);
    assert.ok(Math.abs(sum - 1) < 1e-12, `PSF energy normalized at ${smoothness}`);
    assert.ok(lobes[0].weight > lobes[2].weight, `core dominates tail at ${smoothness}`);
  }
});

test('T24 source interior protection moves local halation from a broad white source to its exterior edge', () => {
  const width = 128;
  const height = 96;
  const rgb = new Float32Array(width * height * 3).fill(0.05);
  for (let y = 24; y < 72; y++) {
    for (let x = 40; x < 88; x++) {
      const p = (y * width + x) * 3;
      rgb[p] = rgb[p + 1] = rgb[p + 2] = 1;
    }
  }
  const common = {
    strength: 100,
    sigma: 8,
    threshold: 0.65,
    sourceSoftness: 0.02,
    backgroundThreshold: 0.4,
    sourceExpansion: 0,
    globalDiffusion: 0,
    colorDensity: 0,
    hotSourceThreshold: 0.1,
    hotCoreStrength: 0.8,
    redshift: [1.08, 0.12, 0.015],
  };
  const legacy = processHalation({ width, height, rgb }, createHalationParams({
    ...common,
    sourceInteriorProtection: 0,
  }));
  const protectedResult = processHalation({ width, height, rgb }, createHalationParams({
    ...common,
    sourceInteriorProtection: 1,
  }));
  const center = (48 * width + 64) * 3;
  const outside = (48 * width + 38) * 3;
  assert.ok(legacy.halo[center] > 0.05, `legacy source interior remains colored (${legacy.halo[center]})`);
  assert.ok(protectedResult.halo[center] < 1e-5, `protected interior is neutral (${protectedResult.halo[center]})`);
  assert.ok(protectedResult.halo[outside] > 1e-4, `exterior edge keeps a red halo (${protectedResult.halo[outside]})`);
});

test('T25 protected compact emitter preserves its source body and keeps an exterior halo', () => {
  const width = 65;
  const height = 65;
  const rgb = new Float32Array(width * height * 3);
  const centerPixel = 32 * width + 32;
  rgb[centerPixel * 3] = rgb[centerPixel * 3 + 1] = rgb[centerPixel * 3 + 2] = 1;
  const out = processHalation({ width, height, rgb }, createHalationParams({
    strength: 100,
    sigma: 6,
    threshold: 0.65,
    sourceSoftness: 0.02,
    sourceInteriorProtection: 1,
    globalDiffusion: 0,
    colorDensity: 0,
    redshift: [1.08, 0.12, 0.015],
  }));
  assert.ok(out.halo[centerPixel * 3] < 1e-4, `compact emitter body stays neutral (${out.halo[centerPixel * 3]})`);
  const ring = (32 * width + 34) * 3;
  assert.ok(out.halo[ring] > 0, 'external PSF ring remains present');
  assert.ok(out.halo[ring] > out.halo[ring + 1] * 4, 'external halo remains red-dominant');
  assert.ok(out.rgb[centerPixel * 3] >= 1, 'the unchanged base image keeps the compact source luminous');
});

test('T25b a narrow highlight embedded in a broad bright surface is not misclassified as a lamp', () => {
  const width = 97;
  const height = 65;
  const rgb = new Float32Array(width * height * 3).fill(0.03);
  for (let y = 12; y < 53; y++) for (let x = 16; x < 81; x++) {
    const value = x >= 46 && x <= 50 ? 1 : 0.82;
    const p = (y * width + x) * 3;
    rgb[p] = rgb[p + 1] = rgb[p + 2] = value;
  }
  const out = processHalation({ width, height, rgb }, createHalationParams({
    ...createHalationPreset('standard'),
    sigmaUnits: 'pixels',
    sigma: 8,
    threshold: 0.65,
    strength: 100,
    globalDiffusion: 0,
  }));
  const embedded = (32 * width + 48) * 3;
  const exterior = (32 * width + 13) * 3;
  assert.ok(out.halo[embedded] < out.halo[exterior] * 0.5, 'embedded highlight stays protected while the exterior edge halates');
});

test('T25c expanded cool-white lamp glow keeps a monotonic visible core at maximum Neutral controls', () => {
  const width = 161;
  const height = 129;
  const cx = width >> 1;
  const cy = height >> 1;
  const rgb = new Float32Array(width * height * 3);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const d = Math.hypot(x - cx, y - cy);
    const glow = 0.04 + 0.72 * Math.exp(-(d * d) / (2 * 7 * 7));
    const p = (y * width + x) * 3;
    rgb[p] = glow * 0.82;
    rgb[p + 1] = glow * 0.91;
    rgb[p + 2] = glow;
    if (d <= 2) rgb[p] = rgb[p + 1] = rgb[p + 2] = 1;
  }
  const out = processHalation({ width, height, rgb }, createHalationParams({
    ...createHalationPreset('standard'),
    sigmaUnits: 'pixels',
    sigma: 50,
    strength: 100,
    threshold: 0,
    colorDensity: 0,
    globalDiffusion: 0,
  }));
  const outputRedAt = (dx) => out.rgb[(cy * width + cx + dx) * 3];
  const haloRedAt = (dx) => out.halo[(cy * width + cx + dx) * 3];
  assert.equal(haloRedAt(0), 0, 'the clipped source body is not recolored');
  assert.ok(haloRedAt(10) > 0 && haloRedAt(35) > 0, 'recruited glow and exterior halo remain active');
  assert.ok(
    outputRedAt(0) >= outputRedAt(4)
      && outputRedAt(4) >= outputRedAt(10)
      && outputRedAt(10) >= outputRedAt(20),
    'base optical glow plus exterior halation has no visible hollow brightness layer',
  );
});

test('T26 No-Remjet protection=0 is exact legacy branch while Neutral enables protected edges', () => {
  const noRemjet = createHalationPreset('tungsten-800');
  const neutral = createHalationPreset('standard');
  assert.equal(noRemjet.sourceInteriorProtection, 0);
  assert.equal(neutral.sourceInteriorProtection, 1);
  const input = makeImage((rgb) => {
    for (let i = 0; i < rgb.length; i++) rgb[i] = ((i * 1103515245) >>> 9) / 0x7fffff;
  });
  const explicitLegacy = processHalation(input, createHalationParams({ ...noRemjet, sourceInteriorProtection: 0 }));
  const presetLegacy = processHalation(input, noRemjet);
  assert.deepEqual(presetLegacy.rgb, explicitLegacy.rgb);
});

test('T27 source-body density gate suppresses internal texture staining without removing the exterior halo', () => {
  const width = 128;
  const height = 96;
  const rgb = new Float32Array(width * height * 3).fill(0.05);
  for (let y = 20; y < 76; y++) {
    for (let x = 32; x < 96; x++) {
      const p = (y * width + x) * 3;
      const value = x >= 62 && x < 66 ? 0.5 : 1;
      rgb[p] = rgb[p + 1] = rgb[p + 2] = value;
    }
  }
  const common = {
    strength: 100,
    sigma: 8,
    threshold: 0.65,
    sourceSoftness: 0.02,
    backgroundThreshold: 0.4,
    sourceExpansion: 0.2,
    globalDiffusion: 0,
    colorDensity: 0.7,
    hotSourceThreshold: 0.1,
    hotCoreStrength: 0.8,
    redshift: [1.08, 0.12, 0.015],
  };
  const legacy = processHalation({ width, height, rgb }, createHalationParams({ ...common, sourceInteriorProtection: 0 }));
  const protectedResult = processHalation({ width, height, rgb }, createHalationParams({ ...common, sourceInteriorProtection: 1 }));
  const stripe = (48 * width + 64) * 3;
  const edge = (48 * width + 29) * 3;
  const redExcess = (out, p) => (out.rgb[p] - rgb[p]) - Math.max(out.rgb[p + 1] - rgb[p + 1], out.rgb[p + 2] - rgb[p + 2]);
  assert.ok(redExcess(protectedResult, stripe) < redExcess(legacy, stripe) * 0.55, 'internal texture red stain is materially reduced');
  assert.ok(
    protectedResult.rgb[edge] - rgb[edge] > (legacy.rgb[edge] - rgb[edge]) * 0.7,
    'exterior halo keeps most of its visible energy',
  );
});
