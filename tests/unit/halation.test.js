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
  extractHighlights,
  applyRedShift,
  blend,
  alphaFor,
  computeHalo,
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

test('T-extra: computeHalo = max(D − centerAttenuation·S, 0)', () => {
  const d = new Float32Array(N * 3).fill(1);
  const s = new Float32Array(N).fill(0.5);
  const halo = computeHalo(d, s, W, H, createHalationParams({}));
  assert.ok(Math.abs(halo[0] - 0.55) < 1e-5, 'D − k·S');
});
