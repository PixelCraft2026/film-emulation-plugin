/**
 * V-5：threshold vs spill 提取 A/B 对照（PRD §5.2 / TDD R-5）。
 * 渲染 v1-night 样张：threshold（A）/ spill mix=0.9（中间态）/ spill mix=1（B），
 * 输出三张 PNG + A/B 差异图 + S mask 统计，写 v5-report.json。
 * 用法：node scripts/verify-v5.mjs
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { processHalation, createHalationParams, extractHighlights, TRCS } from '../src/core/index.js';

const OUT = fileURLToPath(new URL('../tests/visual/output', import.meta.url));
const SAMPLES = fileURLToPath(new URL('../tests/visual/samples', import.meta.url));
mkdirSync(OUT, { recursive: true });

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
const report = { width, height };

// S mask 统计（提取差异本身）
const masks = {
  threshold: extractHighlights(input, params, { extraction: 'threshold' }),
  spill09: extractHighlights(input, params, { extraction: 'spill', spillMix: 0.9 }),
  spill: extractHighlights(input, params, { extraction: 'spill', spillMix: 1 }),
};
const maskStats = (name) => {
  const S = masks[name].S;
  let nonZero = 0;
  let sum = 0;
  for (let i = 0; i < S.length; i++) {
    if (S[i] > 0) nonZero++;
    sum += S[i];
  }
  return { nonZeroPixels: nonZero, ratio: nonZero / S.length, mean: sum / S.length };
};
report.maskStats = {
  threshold: maskStats('threshold'),
  spill09: maskStats('spill09'),
  spill: maskStats('spill'),
};
// threshold vs spill mask 差异
{
  const a = masks.threshold.S;
  const b = masks.spill.S;
  let maxDiff = 0;
  let changed = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i] - b[i]);
    if (d > 0.01) changed++;
    if (d > maxDiff) maxDiff = d;
  }
  report.maskDiff = { maxDiff, changedPixels: changed, ratio: changed / a.length };
}
console.log('V-5 S mask stats:');
console.log(`  threshold: ${JSON.stringify(report.maskStats.threshold)}`);
console.log(`  spill(0.9): ${JSON.stringify(report.maskStats.spill09)}`);
console.log(`  spill(1.0): ${JSON.stringify(report.maskStats.spill)}`);
console.log(`  threshold vs spill mask diff: ${JSON.stringify(report.maskDiff)}`);

// 渲染三种
const renders = {
  threshold: processHalation(input, params, { extraction: 'threshold' }),
  spill09: processHalation(input, params, { extraction: 'spill', spillMix: 0.9 }),
  spill: processHalation(input, params, { extraction: 'spill', spillMix: 1 }),
};
for (const [name, out] of Object.entries(renders)) {
  writeFileSync(join(OUT, `v1-night-${name}.png`), PNG.sync.write(toPng(out)));
  console.log(`render: v1-night-${name}.png`);
}

// A/B 差异图（threshold vs spill，放大 20x）
{
  const a = toPng(renders.threshold);
  const b = toPng(renders.spill);
  const diff = new PNG({ width, height });
  let maxDiff = 0;
  for (let i = 0; i < width * height; i++) {
    const d = Math.abs(a.data[i * 4] - b.data[i * 4]) + Math.abs(a.data[i * 4 + 1] - b.data[i * 4 + 1]) + Math.abs(a.data[i * 4 + 2] - b.data[i * 4 + 2]);
    if (d > maxDiff) maxDiff = d;
    const v = Math.min(255, Math.round(d * 20));
    diff.data[i * 4] = v;
    diff.data[i * 4 + 1] = 0;
    diff.data[i * 4 + 2] = v;
    diff.data[i * 4 + 3] = 255;
  }
  writeFileSync(join(OUT, 'v1-night-threshold-vs-spill-diff20x.png'), PNG.sync.write(diff));
  report.renderMaxDiff = maxDiff;
  console.log(`A/B render max diff = ${maxDiff} (8-bit), diff ×20 written`);
}

writeFileSync(join(OUT, 'v5-report.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
console.log(`report: ${join(OUT, 'v5-report.json')}`);
