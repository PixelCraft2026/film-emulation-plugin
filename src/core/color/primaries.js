/**
 * primaries 转换 — canonical space（#7）：算法统一在线性 sRGB primaries 执行。
 * 零依赖，纯函数。
 *
 * 背景：光晕算法（luma 提取 / redshift 增益 / 混合）的语义依赖 primaries——
 * 在 Display P3/AdobeRGB/ProPhoto/Rec.2020 下，同一 redshift 增益 [1.0, 0.05, 0.02] 产生
 * 不同色相的光晕。统一到线性 sRGB 后，"胶片红"跨工作空间一致。
 *
 * 矩阵：RGB(space) → XYZ(白点) → [Bradford D50→D65] → RGB(sRGB)，
 * 由标准 primaries 坐标与白点数值推导（roundtrip 精度 1e-6；ProPhoto
 * 使用 Bradford D50→D65 chromatic adaptation）。
 * 不 clamp：超 sRGB 色域值（如 ProPhoto 饱和绿 → 负 R）在线性运算中保留，
 * 回写时经逆矩阵转回文档空间（与"保留文件色彩意图"一致）。
 *
 * 布局：行主序 9 元素（m[0..2] = R 行，m[3..5] = G 行，m[6..8] = B 行）。
 */

/** 各基色空间 → 线性 sRGB（输入输出均为线性 RGB）。sRGB 恒等。
 *  普通数组（Float64 精度）；数值由 primaries/white point 推导。 */
export const SPACE_TO_SRGB = Object.freeze({
  sRGB: Object.freeze([1, 0, 0, 0, 1, 0, 0, 0, 1]),
  DisplayP3: Object.freeze([1.22494018, -0.22494018, 0, -0.04205695, 1.04205695, 0, -0.01963755, -0.07863605, 1.0982736]),
  AdobeRGB: Object.freeze([1.398355744, -0.398355744, 0, 0, 1, 0, 0, -0.0429289893, 1.0429289893]),
  ProPhoto: Object.freeze([2.0343675435, -0.7276344742, -0.3067330693, -0.2288267982, 1.2317533962, -0.002926598, -0.0085584243, -0.1532682035, 1.1618266279]),
  Rec2020: Object.freeze([1.6604910021, -0.5876411388, -0.0728498633, -0.1245504745, 1.1328998971, -0.0083494226, -0.0181507634, -0.100578898, 1.1187296614]),
});

/** 线性 sRGB → 各基色空间（SPACE_TO_SRGB 的逆；roundtrip 精度 1e-6）。 */
export const SRGB_TO_SPACE = Object.freeze({
  sRGB: Object.freeze([1, 0, 0, 0, 1, 0, 0, 0, 1]),
  DisplayP3: Object.freeze([0.82246197, 0.17753803, 0, 0.0331942, 0.9668058, 0, 0.01708263, 0.07239744, 0.91051993]),
  AdobeRGB: Object.freeze([0.7151256069, 0.2848743931, 0, 0, 1, 0, 0, 0.0411619485, 0.9588380515]),
  ProPhoto: Object.freeze([0.529280406, 0.3301529857, 0.1405666083, 0.098366222, 0.8734639545, 0.0281698235, 0.0168753409, 0.1176594143, 0.8654652448]),
  Rec2020: Object.freeze([0.6274038959, 0.3292830384, 0.0433130657, 0.0690972894, 0.9195403951, 0.0113623156, 0.0163914389, 0.0880133079, 0.8955952532]),
});

/** 就地 3×3 矩阵（行主序 9 元素）应用：交错 RGB 逐像素。
 * @param {Float32Array} rgb
 * @param {readonly number[]} m
 */
export function applyMatrix3(rgb, m) {
  const m0 = m[0];
  const m1 = m[1];
  const m2 = m[2];
  const m3 = m[3];
  const m4 = m[4];
  const m5 = m[5];
  const m6 = m[6];
  const m7 = m[7];
  const m8 = m[8];
  for (let i = 0; i < rgb.length; i += 3) {
    const r = rgb[i];
    const g = rgb[i + 1];
    const b = rgb[i + 2];
    rgb[i] = m0 * r + m1 * g + m2 * b;
    rgb[i + 1] = m3 * r + m4 * g + m5 * b;
    rgb[i + 2] = m6 * r + m7 * g + m8 * b;
  }
  return rgb;
}
