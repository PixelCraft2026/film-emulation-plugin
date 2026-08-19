/**
 * #7 canonical space：primaries 转换矩阵测试。
 * 运行：node --test tests/unit/primaries.test.js（沙箱内：node tests/unit/primaries.test.js）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SPACE_TO_SRGB, SRGB_TO_SPACE, applyMatrix3 } from '../../src/core/index.js';
import { primariesMatrices } from '../../src/io/colorPipeline.js';

function applyRowMajor(m, v) {
  return [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]];
}

test('primaries: sRGB 恒等；白点保持（各空间 [1,1,1] → sRGB ≈ [1,1,1]）', () => {
  for (const key of ['sRGB', 'DisplayP3', 'AdobeRGB', 'ProPhoto', 'Rec2020']) {
    const m = SPACE_TO_SRGB[key];
    if (key === 'sRGB') {
      assert.deepEqual(Array.from(m), [1, 0, 0, 0, 1, 0, 0, 0, 1]);
    } else {
      const w = applyRowMajor(m, [1, 1, 1]);
      for (let i = 0; i < 3; i++) {
        // ProPhoto 经 Bradford D50→D65，白点误差 ~0.3%；其余 <0.1%
        assert.ok(Math.abs(w[i] - 1) < (key === 'ProPhoto' ? 0.005 : 0.001), `${key} 白点 ${w[i]}`);
      }
    }
  }
});

test('primaries: toSRGB ∘ fromSRGB ≈ identity（roundtrip 精度 1e-4）', () => {
  for (const key of ['DisplayP3', 'AdobeRGB', 'ProPhoto', 'Rec2020']) {
    const to = SPACE_TO_SRGB[key];
    const from = SRGB_TO_SPACE[key];
    for (const v of [[0.3, 0.5, 0.7], [1, 0.2, 0], [0, 0, 1], [1.5, 0.8, 2.0]]) {
      const rt = applyRowMajor(from, applyRowMajor(to, v));
      for (let i = 0; i < 3; i++) {
        assert.ok(Math.abs(rt[i] - v[i]) < 1e-4, `${key} roundtrip ${v} → ${rt}`);
      }
    }
  }
});

test('primaries: known wide-gamut values map outside sRGB without premature clamping', () => {
  const r2020 = applyRowMajor(SPACE_TO_SRGB.Rec2020, [1, 0, 0]);
  assert.ok(Math.abs(r2020[0] - 1.660491) < 1e-4, `Rec2020 R → sRGB R ${r2020[0]}`);
  assert.ok(Math.abs(r2020[1] + 0.124550) < 1e-4, `Rec2020 R → sRGB G ${r2020[1]}`);
  const pG = applyRowMajor(SPACE_TO_SRGB.ProPhoto, [0, 1, 0]);
  assert.ok(pG[0] < 0 && pG[2] < 0, `ProPhoto G → sRGB out of gamut ${pG}`);
});

test('primaries: applyMatrix3 就地正确性（交错 RGB 逐像素）', () => {
  const rgb = new Float32Array([1, 0, 0, 0, 1, 0]);
  applyMatrix3(rgb, SPACE_TO_SRGB.Rec2020);
  // 像素0 = (1,0,0) → R' = m0；像素1 = (0,1,0) → G' = m4（交错：像素 i 通道 c 在 i*3+c）
  assert.ok(Math.abs(rgb[0] - 1.660491) < 1e-5, `pixel0 R ${rgb[0]}`);
  assert.ok(Math.abs(rgb[4] - 1.1328999) < 1e-5, `pixel1 G ${rgb[4]}`);
});

test('primariesMatrices: sRGB → null/null（无需转换），其余 → 矩阵', () => {
  assert.deepEqual(primariesMatrices('sRGB'), { toSRGB: null, fromSRGB: null });
  assert.deepEqual(primariesMatrices(null), { toSRGB: null, fromSRGB: null });
  const p = primariesMatrices('Rec2020');
  assert.ok(p.toSRGB && p.fromSRGB, 'Rec2020 有转换矩阵');
});
