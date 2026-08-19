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

test('C2 negative: linear TRC passes negatives through; display encodes zero negatives and extend >1 (HDR not clipped)', () => {
  assert.equal(TRCS.linear.decode(-0.25), -0.25, 'linear decode negative passthrough');
  assert.equal(TRCS.linear.encode(-0.25), -0.25, 'linear encode negative passthrough');
  // 显示编码 encode：负值归零（非法输入）；>1 延拓（32-bit HDR 高光不裁剪，8/16-bit 由写回量化 clamp）
  assert.equal(TRCS.sRGB.encode(-0.5), 0, 'sRGB encode zeroes negative');
  assert.ok(TRCS.sRGB.encode(1.5) > 1, 'sRGB encode extends >1 (HDR)');
  assert.ok(TRCS.AdobeRGB.encode(1.5) > 1, 'AdobeRGB encode extends >1 (HDR)');
  assert.ok(TRCS.ProPhoto.encode(1.5) > 1, 'ProPhoto encode extends >1 (HDR)');
  // 往返：>1 区域 encode→decode 仍回到原值（幂函数可逆）
  assert.ok(Math.abs(TRCS.sRGB.decode(TRCS.sRGB.encode(1.5)) - 1.5) < 1e-9, 'sRGB HDR roundtrip');
  assert.ok(Math.abs(TRCS.AdobeRGB.decode(TRCS.AdobeRGB.encode(1.5)) - 1.5) < 1e-9, 'AdobeRGB HDR roundtrip');
  assert.ok(Math.abs(TRCS.ProPhoto.decode(TRCS.ProPhoto.encode(1.5)) - 1.5) < 1e-9, 'ProPhoto HDR roundtrip');
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

test('C5 Photoshop Rec.2020 ICC TRC: gamma 2.4 known values + roundtrip + HDR', () => {
  const trc = getTRC('Rec2020');
  const expected = Math.pow(0.5, 2.4);
  assert.ok(Math.abs(trc.decode(0.5) - expected) < 1e-12, 'Rec2020 decode(0.5)');
  // 往返精度（含 >1 延拓区）
  for (const v of [0.0, 0.01, 0.05, 0.2, 0.5, 0.8, 1.0, 1.5]) {
    const rt = trc.decode(trc.encode(v));
    assert.ok(Math.abs(rt - v) < 1e-9, `Rec2020 roundtrip(${v}) = ${rt}`);
  }
  // HDR 延拓不裁剪
  assert.ok(trc.decode(1.5) > 1, 'Rec2020 decode(1.5) > 1');
  assert.ok(trc.encode(1.5) > 1, 'Rec2020 encode(1.5) > 1');
});
