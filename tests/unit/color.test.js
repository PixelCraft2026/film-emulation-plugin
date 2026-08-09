/**
 * 色彩/TRC 测试 C1–C4（TDD R-2 / C1-C4）。
 * 运行：node --test tests/unit
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TRCS, getTRC, processHalation, createHalationParams } from '../../src/core/index.js';

test('C1 HDR>1: TRC decode passes values >1 (no clamp), pipeline preserves HDR', () => {
  // decode 不 clamp（HDR 语义保留）
  assert.ok(TRCS.sRGB.decode(1.5) > 1, 'sRGB decode(1.5) > 1');
  assert.ok(TRCS.AdobeRGB.decode(1.5) > 1, 'AdobeRGB decode(1.5) > 1');
  assert.ok(TRCS.ProPhoto.decode(1.5) > 1, 'ProPhoto decode(1.5) > 1');
  // pipeline：HDR 输入不被 clamp
  const rgb = new Float32Array(3);
  rgb[0] = 3.0;
  rgb[1] = 1.5;
  rgb[2] = 2.0;
  const out = processHalation({ width: 1, height: 1, rgb }, createHalationParams({ strength: 50 }));
  assert.ok(out.rgb[0] >= 3.0, 'pipeline R≥3 preserved');
});

test('C2 negative: linear TRC passes negatives through; display encodes clamp to [0,1]', () => {
  assert.equal(TRCS.linear.decode(-0.25), -0.25, 'linear decode negative passthrough');
  assert.equal(TRCS.linear.encode(-0.25), -0.25, 'linear encode negative passthrough');
  // 显示编码 encode 必须 clamp 到 [0,1]（显示域无负值）
  assert.equal(TRCS.sRGB.encode(-0.5), 0, 'sRGB encode clamps negative');
  assert.equal(TRCS.sRGB.encode(1.5), 1, 'sRGB encode clamps >1');
});

test('C3 profile roundtrip: decode(encode(v)) ≈ v for all TRCs over [0,1]', () => {
  for (const name of Object.keys(TRCS)) {
    const { decode, encode } = TRCS[name];
    for (let i = 0; i <= 200; i++) {
      const v = i / 200;
      const back = decode(encode(v));
      assert.ok(Math.abs(back - v) < 1e-9, `${name} roundtrip at v=${v}: ${back}`);
    }
  }
});

test('C4 32-bit ≠ linear: TRC is applied explicitly, never assumed 32=linear', () => {
  // 关键语义：core 不假设任何位深与 TRC 绑定；32-bit 文档若带 TRC 必须显式 decode。
  // 此处验证 getTRC 显式选择与 sRGB/AdobeRGB/ProPhoto 在 0..1 内均非恒等。
  const mid = 0.5;
  assert.notEqual(TRCS.sRGB.decode(mid), mid, 'sRGB decode(0.5) ≠ 0.5');
  assert.notEqual(TRCS.AdobeRGB.decode(mid), mid, 'AdobeRGB decode(0.5) ≠ 0.5');
  assert.notEqual(TRCS.ProPhoto.decode(mid), mid, 'ProPhoto decode(0.5) ≠ 0.5');
  // 显式取用：getTRC('linear') 才恒等
  assert.equal(getTRC('linear').decode(mid), mid, 'linear decode(0.5) = 0.5');
  // 未知名称抛错
  assert.throws(() => getTRC('Nope'), TypeError);
});
