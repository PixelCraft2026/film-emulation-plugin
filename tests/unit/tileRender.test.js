/**
 * tileRender 分块一致性测试：tile vs 整图渲染数值对比。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { processHalation, createHalationParams } from '../../src/core/index.js';
import { processTiled } from '../../src/io/tileRender.js';

function buildInput(w, h) {
  const rgb = new Float32Array(w * h * 3);
  for (let i = 0; i < w * h; i++) {
    const v = ((i * 2654435761) >>> 8) / 0xffffff;
    rgb[i * 3] = v;
    rgb[i * 3 + 1] = v * 0.7;
    rgb[i * 3 + 2] = v * 0.5;
  }
  // 高光点
  for (const [x, y] of [[40, 40], [120, 30], [30, 180]]) {
    const p = (y * w + x) * 3;
    rgb[p] = 2;
    rgb[p + 1] = 1.2;
    rgb[p + 2] = 0.8;
  }
  return { width: w, height: h, rgb };
}

test('tileRender matches full-image render (L2 < 1e-6, quality)', () => {
  const input = buildInput(200, 240);
  const params = createHalationParams({ strength: 100, diffusionMode: 'quality' });
  const full = processHalation(input, params);
  const tiled = processTiled(input, params, { bandHeight: 64, overlapPx: 40 });
  assert.equal(tiled.width, input.width);
  assert.equal(tiled.height, input.height);
  let l2 = 0;
  let maxDiff = 0;
  for (let i = 0; i < full.rgb.length; i++) {
    const d = full.rgb[i] - tiled.rgb[i];
    l2 += d * d;
    if (Math.abs(d) > maxDiff) maxDiff = Math.abs(d);
  }
  l2 = Math.sqrt(l2 / full.rgb.length);
  console.log(`INFO tile L2=${l2.toExponential(2)} maxDiff=${maxDiff.toExponential(2)}`);
  assert.ok(l2 < 1e-6, `tile≈full L2=${l2.toExponential(2)}`);
});

test('tileRender matches full-image render (fast mode)', () => {
  const input = buildInput(200, 240);
  const params = createHalationParams({ strength: 100, diffusionMode: 'fast' });
  const full = processHalation(input, params);
  const tiled = processTiled(input, params, { bandHeight: 64, overlapPx: 40 });
  let l2 = 0;
  for (let i = 0; i < full.rgb.length; i++) {
    const d = full.rgb[i] - tiled.rgb[i];
    l2 += d * d;
  }
  l2 = Math.sqrt(l2 / full.rgb.length);
  console.log(`INFO tile fast L2=${l2.toExponential(2)}`);
  // IIR 带边缘镜像与整图略有差异（overlap 内瞬态残余，~3e-6 量级）；容差 1e-5
  assert.ok(l2 < 1e-5, `tile≈full fast L2=${l2.toExponential(2)}`);
});
