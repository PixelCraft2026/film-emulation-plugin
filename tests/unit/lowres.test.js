/**
 * 3.1 低分辨率扩散测试：scale 选择、DC 保持、与全分辨率卷积的数值一致性。
 * 运行：node --test tests/unit/lowres.test.js（沙箱内：node tests/unit/lowres.test.js）
 *
 * 注意：参考实现必须与 diffuseStep 完全同构（含 redshift 增益）——
 * plane = blur(field)·redshift[c]，逐通道比较。
 * 真实输入是稀疏的（W = S·Y/threshold，背景被 S 掩码清零），
 * 本测试用 extractStep 产出的真实 W 场标定误差。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  processHalation,
  createHalationParams,
  diffuseStep,
  extractStep,
  lowResScale,
  LOWRES_MAX_SCALE,
  PSF_LOBES,
  vvGauss,
} from '../../src/core/index.js';
import { gaussianBlurSep } from '../../src/core/diffuse/conv.js';
import { boxBlur3, boxRadiusForSigma } from '../../src/core/diffuse/box.js';

test('lowResScale: Fast/Quality 共用双瓣多尺度，只改变保守阈值', () => {
  const q = (sigma) => createHalationParams({ diffusionMode: 'quality', sigma });
  const f = (sigma) => createHalationParams({ diffusionMode: 'fast', sigma });
  assert.equal(lowResScale(f(48), 48), 8, 'fast 宽尾 scale 8');
  assert.equal(lowResScale(q(7), 7), 2, '默认宽尾 scale 2，核芯仍全分辨率');
  assert.equal(lowResScale(q(17), 17), 4, 'quality 保持低分辨率 σ≥4');
  assert.equal(lowResScale(q(18), 18), 4, '比例限定为 1/2/4/8');
  assert.equal(lowResScale(q(48), 48), 8, '大 σ 封顶 scale 8');
  assert.equal(lowResScale(q(200), 200), LOWRES_MAX_SCALE, '封顶 LOWRES_MAX_SCALE');
});

test('low-res diffuse: 常数场 DC 保持（降采样+卷积+上采样精确）', () => {
  const W = 64;
  const H = 64;
  const n = W * H;
  const field = new Float32Array(n).fill(0.7);
  const P = createHalationParams({ diffusionMode: 'quality', sigma: 48 });
  const { plane } = diffuseStep(field, W, H, P);
  // plane 分区：R = 0.7·rs[0], G = 0.7·rs[1], B = 0.7·rs[2]
  // 容差 5e-3：vvGauss 的 pad 瞬态残留规格（#1；有限卷积时代为 1e-6）
  const rs = P.redshift;
  for (let c = 0; c < 3; c++) {
    const base = plane.subarray(c * n, (c + 1) * n);
    for (let i = 0; i < n; i += 997) {
      assert.ok(Math.abs(base[i] - 0.7 * rs[c]) < 5e-3, `channel ${c} DC (got ${base[i]})`);
    }
  }
});

/** 确定性测试图像（线性域，暗背景 + 高光点）→ 真实 W 场（稀疏）。 */
function makeSparseField(W, H) {
  const n = W * H;
  const rgb = new Float32Array(n * 3);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const p = (y * W + x) * 3;
      const base = 0.02 + (0.06 * (((x * 7 + y * 13) % 11) / 11));
      rgb[p] = base;
      rgb[p + 1] = base * 0.9;
      rgb[p + 2] = base * 0.8;
    }
  }
  for (const [x, y, r, g, b] of [[64, 64, 2.0, 1.2, 0.9], [100, 20, 1.0, 0.6, 0.4], [20, 100, 0.9, 0.5, 0.3], [40, 80, 1.6, 1.4, 1.0]]) {
    const p = (y * W + x) * 3;
    rgb[p] = r;
    rgb[p + 1] = g;
    rgb[p + 2] = b;
  }
  const P = createHalationParams({ strength: 100, diffusionMode: 'quality', sigma: 48 });
  return extractStep({ width: W, height: H, rgb }, P).W;
}

test('low-res diffuse ≈ 全分辨率卷积（真实稀疏 W 场，σ=48, scale=6）', () => {
  const W = 128;
  const H = 128;
  const n = W * H;
  const field = makeSparseField(W, H);
  const P = createHalationParams({ strength: 100, diffusionMode: 'quality', sigma: 48 });
  const { plane } = diffuseStep(field, W, H, P);
  // 全分辨率参考：双瓣高斯逐通道 + 同构 redshift 增益（与 diffuseStep 完全同构）
  const ref = new Float32Array(n * 3);
  const tempA = new Float32Array(n);
  const tempB = new Float32Array(n);
  const rs = P.redshift;
  const sigmas = [48, 48 * 0.85, 48 * 0.7];
  const [core, tail] = PSF_LOBES;
  for (let c = 0; c < 3; c++) {
    const dst = ref.subarray(c * n, (c + 1) * n);
    const sig = sigmas[c];
    gaussianBlurSep(field, dst, tempA, tempB, W, H, sig * core.sigmaRatio);
    gaussianBlurSep(field, tempB, tempA, tempB, W, H, sig * tail.sigmaRatio);
    for (let i = 0; i < n; i++) dst[i] = dst[i] * core.weight + tempB[i] * tail.weight;
    for (let i = 0; i < n; i++) dst[i] *= rs[c];
  }
  let l2 = 0;
  let mx = 0;
  for (let i = 0; i < plane.length; i++) {
    const d = plane[i] - ref[i];
    l2 += d * d;
    if (Math.abs(d) > mx) mx = Math.abs(d);
  }
  l2 = Math.sqrt(l2 / plane.length);
  console.log(`INFO lowres σ=48 L2=${l2.toExponential(2)} max=${mx.toExponential(2)}`);
  // 实测 L2≈3e-6（同实现对比）；#1 后 quality 用 vvGauss（近似误差 ~1e-4）→ 容差 2e-3
  assert.ok(l2 < 2e-3, `lowres L2=${l2.toExponential(2)}`);
  assert.ok(mx < 5e-3, `lowres max=${mx.toExponential(2)}`);
});

test('vvGauss ≈ gaussianBlurSep（#1 递归高斯精度；DC 保持）', () => {
  const W = 128;
  const H = 128;
  const n = W * H;
  const src = new Float32Array(n);
  const a = new Float32Array(n);
  const b = new Float32Array(n);
  const c = new Float32Array(n);
  const ref = new Float32Array(n);
  // DC：常量场（pad=5σ 后瞬态残留 <0.5%）
  src.fill(0.7);
  vvGauss(src, a, b, c, W, H, 7);
  let mx = 0;
  for (const v of a) mx = Math.max(mx, Math.abs(v - 0.7));
  assert.ok(mx < 5e-3, `DC 误差 ${mx.toExponential(2)}`);
  // 脉冲响应 vs 精确高斯卷积（中心 + 边界）
  for (const [px, py] of [[64, 64], [0, 0], [127, 64]]) {
    src.fill(0);
    src[py * W + px] = 1;
    vvGauss(src, a, b, c, W, H, 7);
    gaussianBlurSep(src, ref, b, c, W, H, 7);
    let l2 = 0;
    for (let i = 0; i < n; i++) {
      const d = a[i] - ref[i];
      l2 += d * d;
    }
    l2 = Math.sqrt(l2 / n);
    console.log(`INFO vvGauss 脉冲@(${px},${py}) L2=${l2.toExponential(2)}`);
    // 中心脉冲 L2~1.7e-5；边界（镜像 vs clamp 语义差异）~8e-3 量级
    assert.ok(l2 < (px === 64 && py === 64 ? 1e-3 : 2e-2), `vvGauss 脉冲 L2=${l2.toExponential(2)}`);
  }
});

test('boxBlur3 ≈ gaussianBlurSep（fast 模式核近似；σ 整数半径量化 ±7%）', () => {
  const W = 64;
  const H = 64;
  const n = W * H;
  const field = new Float32Array(n);
  for (let i = 0; i < n; i++) field[i] = ((i * 2654435761) >>> 8) / 0xffffff;
  const a = new Float32Array(n);
  const b = new Float32Array(n);
  const c = new Float32Array(n);
  for (const sigma of [7, 12, 24]) {
    boxBlur3(field, a, b, c, W, H, sigma);
    gaussianBlurSep(field, b, c, a, W, H, sigma);
    let l2 = 0;
    let mx = 0;
    for (let i = 0; i < n; i++) {
      const d = a[i] - b[i];
      l2 += d * d;
      if (Math.abs(d) > mx) mx = Math.abs(d);
    }
    l2 = Math.sqrt(l2 / n);
    console.log(`INFO box≈gauss σ=${sigma} r=${boxRadiusForSigma(sigma)} L2=${l2.toExponential(2)} max=${mx.toExponential(2)}`);
    // σ_eff=sqrt(r²+r) 与目标 σ 偏差 ~±7%（r 整数量化）；容差按形状级放行
    assert.ok(l2 < 3e-2, `box≈gauss σ=${sigma} L2=${l2.toExponential(2)}`);
  }
});

test('A6 end-to-end: Fast/Quality 同 PSF，RMS≤1e-4 且 SSIM≥0.9995', () => {
  const W = 128;
  const H = 128;
  const n = W * H;
  const rgb = new Float32Array(n * 3);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const p = (y * W + x) * 3;
      const base = 0.02 + (0.06 * (((x * 7 + y * 13) % 11) / 11));
      rgb[p] = base;
      rgb[p + 1] = base * 0.9;
      rgb[p + 2] = base * 0.8;
    }
  }
  for (const [x, y, r, g, b] of [[64, 64, 2.0, 1.2, 0.9], [100, 20, 1.0, 0.6, 0.4], [20, 100, 0.9, 0.5, 0.3]]) {
    const p = (y * W + x) * 3;
    rgb[p] = r;
    rgb[p + 1] = g;
    rgb[p + 2] = b;
  }
  const input = { width: W, height: H, rgb };
  const common = { strength: 100, sigma: 48 };
  const q = processHalation(input, createHalationParams({ ...common, diffusionMode: 'quality' }));
  const f = processHalation(input, createHalationParams({ ...common, diffusionMode: 'fast' }));
  let l2 = 0;
  let mx = 0;
  for (let i = 0; i < q.rgb.length; i++) {
    const d = q.rgb[i] - f.rgb[i];
    l2 += d * d;
    if (Math.abs(d) > mx) mx = Math.abs(d);
  }
  l2 = Math.sqrt(l2 / q.rgb.length);
  let meanQ = 0;
  let meanF = 0;
  for (let i = 0; i < q.rgb.length; i++) {
    meanQ += q.rgb[i];
    meanF += f.rgb[i];
  }
  meanQ /= q.rgb.length;
  meanF /= f.rgb.length;
  let varianceQ = 0;
  let varianceF = 0;
  let covariance = 0;
  for (let i = 0; i < q.rgb.length; i++) {
    const aq = q.rgb[i] - meanQ;
    const af = f.rgb[i] - meanF;
    varianceQ += aq * aq;
    varianceF += af * af;
    covariance += aq * af;
  }
  varianceQ /= q.rgb.length - 1;
  varianceF /= q.rgb.length - 1;
  covariance /= q.rgb.length - 1;
  const c1 = 0.01 ** 2;
  const c2 = 0.03 ** 2;
  const ssim = ((2 * meanQ * meanF + c1) * (2 * covariance + c2)) /
    ((meanQ ** 2 + meanF ** 2 + c1) * (varianceQ + varianceF + c2));
  console.log(`INFO quality(lowres) vs fast σ=48 L2=${l2.toExponential(2)} max=${mx.toExponential(2)}`);
  assert.ok(l2 <= 1e-4, `quality-lowres vs fast RMS=${l2.toExponential(2)}`);
  assert.ok(ssim >= 0.9995, `quality-lowres vs fast SSIM=${ssim}`);
});
