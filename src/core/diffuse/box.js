/**
 * 盒式模糊 ×3 — fast 模式的高斯近似（各向同性、O(N) 与 σ 无关）。
 * 零依赖，作用于单通道 Float32Array（长度 width*height）。
 *
 * 原理：n 次独立 box blur 的核收敛到高斯（B 样条）；3 次宽 w 的 box 方差
 * σ² = 3·(w²−1)/12 ≈ w²/4 → w ≈ 2σ。由 σ 反解半径 r：σ² = r²+r → r = √(σ²+¼)−½。
 * 误差：B 样条³ 与高斯的形状偏差 <1%（σ≥2 时）；尾部略重（更接近胶片散射尾）。
 *
 * 边界：clamp 到边缘像素（与 conv.js 一致）。
 * 性能：前缀和滑动窗口 O(N)（每像素 ~4 次运算），与 σ 无关。
 */

/** 由 σ 计算 3×box 的整数半径（σ² = r²+r 反解；σ 过小时 r=0 → 恒等）。 @param {number} sigma */
export function boxRadiusForSigma(sigma) {
  if (sigma <= 0.5) return 0;
  return Math.max(1, Math.round(Math.sqrt(sigma * sigma + 0.25) - 0.5));
}

/**
 * 单次盒式模糊：行 pass（src→temp）+ 列 pass（temp→dst）。
 * src/temp/dst 互不别名；temp 长度 = width*height。
 * @param {Float32Array} src
 * @param {Float32Array} temp
 * @param {Float32Array} dst
 * @param {number} width
 * @param {number} height
 * @param {number} radius 盒半径（≥1）
 */
export function boxBlurOnce(src, temp, dst, width, height, radius) {
  const w = width;
  const h = height;
  const denom = 2 * radius + 1;
  // 行 pass：src → temp。滑动窗口 + clamp 边界（越界像素取边缘像素值）：
  // 窗口 [x−r, x+r]，初始化含左侧 r 个虚拟像素（clamp 到 src[0]）。
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let acc = radius * src[row];
    const kEnd = Math.min(radius, w - 1);
    for (let k = 0; k <= kEnd; k++) acc += src[row + k];
    for (let x = 0; x < w; x++) {
      temp[row + x] = acc / denom;
      const outK = x - radius;
      const innK = x + radius + 1;
      acc -= src[row + (outK < 0 ? 0 : outK >= w ? w - 1 : outK)];
      acc += src[row + (innK < 0 ? 0 : innK >= w ? w - 1 : innK)];
    }
  }
  // 列 pass：temp → dst（同 clamp 语义）
  for (let x = 0; x < w; x++) {
    let acc = radius * temp[x];
    const kEnd = Math.min(radius, h - 1);
    for (let k = 0; k <= kEnd; k++) acc += temp[k * w + x];
    for (let y = 0; y < h; y++) {
      dst[y * w + x] = acc / denom;
      const outK = y - radius;
      const innK = y + radius + 1;
      acc -= temp[(outK < 0 ? 0 : outK >= h ? h - 1 : outK) * w + x];
      acc += temp[(innK < 0 ? 0 : innK >= h ? h - 1 : innK) * w + x];
    }
  }
}

/**
 * 3×盒式模糊 ≈ 高斯模糊（fast 模式；乒乓轮转，无内部分配）。
 * 轮转：src→(tempA)→dst → dst→(tempA)→tempB → tempB→(tempA)→dst。
 * 结果写入 dst；src 不被修改。
 * @param {Float32Array} src
 * @param {Float32Array} dst
 * @param {Float32Array} tempA 工作缓冲（长度同 src）
 * @param {Float32Array} tempB 工作缓冲（长度同 src）
 * @param {number} width
 * @param {number} height
 * @param {number} sigma 目标高斯 σ（像素）
 */
export function boxBlur3(src, dst, tempA, tempB, width, height, sigma) {
  const r = boxRadiusForSigma(sigma);
  if (r === 0) {
    dst.set(src);
    return;
  }
  boxBlurOnce(src, tempA, dst, width, height, r);
  boxBlurOnce(dst, tempA, tempB, width, height, r);
  boxBlurOnce(tempB, tempA, dst, width, height, r);
}
