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

test('T7 redshift: channel gains (1.0, 0.05, 0.02) applied after diffusion', () => {
  const n = 4;
  const dr = new Float32Array(n).fill(1);
  const dg = new Float32Array(n).fill(1);
  const db = new Float32Array(n).fill(1);
  const out = applyRedShift(dr, dg, db, 2, 2, createHalationParams({}));
  assert.ok(Math.abs(out[0] - 1.0) < 1e-9);
  assert.ok(Math.abs(out[1] - 0.05) < 1e-9);
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

test('T9 radiance weighting (1.1): halo intensity scales with highlight brightness', () => {
  // 同场景仅改变高光亮度（都高于 soft-threshold 饱和点，S=1）：
  // W = S·Y/threshold → 光晕强度应 ∝ Y（2× 亮度 → 2× 光晕）。
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
  assert.ok(Math.abs(ratio - 2.0) < 0.1, `halo ∝ brightness (ratio=${ratio.toFixed(3)}, expected ≈2)`);
});

test('T10 extract: W = S·Y/threshold (radiance-weighted field)', () => {
  const rgb = new Float32Array(3);
  rgb[0] = 1.0;
  rgb[1] = 1.0;
  rgb[2] = 1.0;
  const { W, S } = extractHighlights({ width: 1, height: 1, rgb }, createHalationParams({ threshold: 0.7 }));
  assert.equal(S[0], 1, 'S=1 for Y=1');
  assert.ok(Math.abs(W[0] - 1 / 0.7) < 1e-6, `W = Y/threshold = 1/0.7 (got ${W[0]})`);
  // threshold=0 防御：不除零
  const { W: W0 } = extractHighlights({ width: 1, height: 1, rgb }, createHalationParams({ threshold: 0 }));
  assert.ok(Number.isFinite(W0[0]) && W0[0] === 1, 'W = S·Y when threshold=0');
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
  // 双瓣高斯核各向同性：等半径处光晕应一致（±5%）。
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
    assert.ok(ratio > 0.8 && ratio < 1.2, `${mode} 各向同性（axis/diag=${ratio.toFixed(3)}，旧 exp 核 ~1.6）`);
    // 相同欧氏距离的严格对比：r=5 主轴 vs r=5 对角线上最近点（3,4）：√(9+16)=5
    const diag5 = at(3, 4);
    const r5 = axis / diag5;
    assert.ok(r5 > 0.95 && r5 < 1.05, `${mode} r=5 严格各向同性（axis/diag5=${r5.toFixed(3)}）`);
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
  assert.ok(spill.W[0] > 1.9, `spill W 使用 max RGB (${spill.W[0]})`);
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

test('T-extra: computeHalo = max(D − centerAttenuation·S, 0)', () => {
  const d = new Float32Array(N * 3).fill(1);
  const s = new Float32Array(N).fill(0.5);
  const halo = computeHalo(d, s, W, H, createHalationParams({}));
  assert.ok(Math.abs(halo[0] - 0.55) < 1e-5, 'D − k·S');
});
