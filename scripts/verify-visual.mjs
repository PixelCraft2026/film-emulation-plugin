/**
 * 视觉验证数值部分（Phase 2）：
 *  - V-6：四种 TRC 全域往返精度复核（C3 口径，批量采样）
 *  - V-4 数值：IIR(fast) vs conv(quality) 在 0..3σ 区域的 L2（A6 口径），
 *    并对比 quality 半径 3σ vs 5σ 的差异
 *  - V-4 视觉：渲染 v1-night 样张 quality/fast 两版 + 差异图（放大 20x）
 * 用法：node scripts/verify-visual.mjs
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { TRCS, processHalation, createHalationParams, blurExp, iirBlur } from '../src/core/index.js';

const OUT = fileURLToPath(new URL('../tests/visual/output', import.meta.url));
const SAMPLES = fileURLToPath(new URL('../tests/visual/samples', import.meta.url));
mkdirSync(OUT, { recursive: true });

const report = { v6: {}, v4: {} };

// ---- V-6 TRC roundtrip ----
for (const name of Object.keys(TRCS)) {
  const { decode, encode } = TRCS[name];
  let maxErr = 0;
  let at = 0;
  for (let i = 0; i <= 4000; i++) {
    const v = i / 4000;
    const err = Math.abs(decode(encode(v)) - v);
    if (err > maxErr) { maxErr = err; at = v; }
  }
  report.v6[name] = { maxErr, at };
  console.log(`V-6 ${name}: max roundtrip err = ${maxErr.toExponential(2)} at v=${at.toFixed(4)}`);
}

// ---- V-4 numeric: impulse response L2 within 0..3σ ----
{
  const W = 128;
  const H = 128;
  const N = W * H;
  const SIGMA = 7;
  const src = new Float32Array(N);
  const cx = 64;
  const cy = 64;
  src[cy * W + cx] = 1;
  const a = new Float32Array(N); // fast (IIR)
  const b = new Float32Array(N); // quality 3σ
  const c = new Float32Array(N); // quality 5σ
  const temp = new Float32Array(N);
  iirBlur(src, a, W, H, SIGMA);
  blurExp(src, b, temp, W, H, SIGMA, Math.ceil(3 * SIGMA));
  blurExp(src, c, temp, W, H, SIGMA, Math.ceil(5 * SIGMA));
  const limit = 3 * SIGMA;
  const l2 = (arr) => {
    let sum = 0;
    let n = 0;
    for (let y = cy - limit; y <= cy + limit; y++) {
      for (let x = cx - limit; x <= cx + limit; x++) {
        if (y < 0 || y >= H || x < 0 || x >= W) continue;
        if (Math.hypot(x - cx, y - cy) > limit) continue;
        sum += arr[y * W + x] * arr[y * W + x];
        n++;
      }
    }
    return Math.sqrt(sum / n);
  };
  const diff = (p, q) => {
    let sum = 0;
    let n = 0;
    for (let y = cy - limit; y <= cy + limit; y++) {
      for (let x = cx - limit; x <= cx + limit; x++) {
        if (y < 0 || y >= H || x < 0 || x >= W) continue;
        if (Math.hypot(x - cx, y - cy) > limit) continue;
        const d = p[y * W + x] - q[y * W + x];
        sum += d * d;
        n++;
      }
    }
    return Math.sqrt(sum / n);
  };
  report.v4 = {
    impulseL2_fast: l2(a),
    impulseL2_quality3: l2(b),
    impulseL2_quality5: l2(c),
    l2_fast_vs_quality3: diff(a, b),
    l2_fast_vs_quality5: diff(a, c),
  };
  console.log('V-4 numeric (0..3σ region):');
  console.log(`  fast impulse L2      = ${report.v4.impulseL2_fast.toExponential(2)}`);
  console.log(`  quality3 impulse L2  = ${report.v4.impulseL2_quality3.toExponential(2)}`);
  console.log(`  quality5 impulse L2  = ${report.v4.impulseL2_quality5.toExponential(2)}`);
  console.log(`  L2 fast vs quality3  = ${report.v4.l2_fast_vs_quality3.toExponential(2)}  (A6 口径 <1e-4: ${report.v4.l2_fast_vs_quality3 < 1e-4 ? 'PASS' : 'FAIL'})`);
  console.log(`  L2 fast vs quality5  = ${report.v4.l2_fast_vs_quality5.toExponential(2)}`);
}

// ---- V-4 visual: render v1-night in both modes + diff map ----
{
  const params = createHalationParams({ strength: 100 });
  const png = PNG.sync.read(readFileSync(join(SAMPLES, 'v1-night.png')));
  const { width, height, data } = png;
  const trc = TRCS.sRGB;
  const toLinear = () => {
    const rgb = new Float32Array(width * height * 3);
    for (let i = 0, p = 0; i < width * height; i++, p += 3) {
      rgb[p] = trc.decode(data[i * 4] / 255);
      rgb[p + 1] = trc.decode(data[i * 4 + 1] / 255);
      rgb[p + 2] = trc.decode(data[i * 4 + 2] / 255);
    }
    return { width, height, rgb };
  };
  const toPng = (out) => {
    const p = new PNG({ width, height });
    for (let i = 0, q = 0; i < width * height; i++, q += 3) {
      p.data[i * 4] = Math.round(Math.min(255, Math.max(0, trc.encode(out.rgb[q]) * 255)));
      p.data[i * 4 + 1] = Math.round(Math.min(255, Math.max(0, trc.encode(out.rgb[q + 1]) * 255)));
      p.data[i * 4 + 2] = Math.round(Math.min(255, Math.max(0, trc.encode(out.rgb[q + 2]) * 255)));
      p.data[i * 4 + 3] = 255;
    }
    return p;
  };
  const input = toLinear();
  const q = toPng(processHalation(input, createHalationParams({ ...params, diffusionMode: 'quality' })));
  const f = toPng(processHalation(input, createHalationParams({ ...params, diffusionMode: 'fast' })));
  writeFileSync(join(OUT, 'v1-night-quality.png'), PNG.sync.write(q));
  writeFileSync(join(OUT, 'v1-night-fast.png'), PNG.sync.write(f));

  // diff map（放大 20x 便于观察）
  const diff = new PNG({ width, height });
  let maxDiff = 0;
  for (let i = 0; i < width * height * 4; i++) {
    const d = Math.abs(q.data[i] - f.data[i]);
    if (d > maxDiff) maxDiff = d;
  }
  for (let i = 0; i < width * height; i++) {
    const d = Math.abs(q.data[i * 4] - f.data[i * 4]) + Math.abs(q.data[i * 4 + 1] - f.data[i * 4 + 1]) + Math.abs(q.data[i * 4 + 2] - f.data[i * 4 + 2]);
    const v = Math.min(255, Math.round(d * 20));
    diff.data[i * 4] = v;
    diff.data[i * 4 + 1] = 0;
    diff.data[i * 4 + 2] = v;
    diff.data[i * 4 + 3] = 255;
  }
  writeFileSync(join(OUT, 'v1-night-diff20x.png'), PNG.sync.write(diff));
  report.v4.visualMaxDiff = maxDiff;
  console.log(`V-4 visual: max per-channel diff = ${maxDiff} (8-bit), diff map ×20 written`);
}

const reportPath = join(OUT, 'v4-v6-report.json');
writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
console.log(`report: ${reportPath}`);
