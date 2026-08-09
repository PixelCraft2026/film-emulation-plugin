/**
 * 指数扩散 — quality 模式：分离式有限卷积（exp 核）+ 重归一化 + clamp 边界。
 * 零依赖，作用于单通道 Float32Array（长度 width*height）。
 *
 * 数学（PRD §5.2 / AlcedoStudio halation 参考基线）：
 *  一维指数核 w(d) = exp(-|d|/σ)，截断半径 radius=ceil(3σ)（TDD 可调 5σ），
 *  截断后重归一化（除以权重和）以保持直流增益 1。
 *  2D 扩散 = 水平 1D 卷积 + 垂直 1D 卷积（分离式；一阶 IIR 的脉冲响应即该核，
 *  故 fast/quality 为同一数学核的不同实现 —— A6 一致性前提）。
 * 边界：越界像素 clamp 到边缘像素值（不引入外部能量）。
 */

/** 生成重归一化后的一维指数核。
 * @param {number} sigma
 * @param {number} radius
 * @returns {Float32Array}
 */
export function expKernel1D(sigma, radius) {
  const size = radius * 2 + 1;
  const kernel = new Float32Array(size);
  let sum = 0;
  for (let i = 0; i < size; i++) {
    const d = i - radius;
    const w = Math.exp(-Math.abs(d) / sigma);
    kernel[i] = w;
    sum += w;
  }
  const inv = 1 / sum;
  for (let i = 0; i < size; i++) kernel[i] *= inv;
  return kernel;
}

/** 水平 1D 卷积（src→dst，可 in-place 之外任意别名）。边界 clamp。
 * @param {Float32Array} src
 * @param {Float32Array} dst
 * @param {number} width
 * @param {number} height
 * @param {Float32Array} kernel
 * @param {number} radius
 */
export function blurRowConv(src, dst, width, height, kernel, radius) {
  for (let y = 0; y < height; y++) {
    const rowBase = y * width;
    for (let x = 0; x < width; x++) {
      let acc = 0;
      for (let k = -radius; k <= radius; k++) {
        const sx = x + k;
        const clamped = sx < 0 ? 0 : sx >= width ? width - 1 : sx;
        acc += src[rowBase + clamped] * kernel[k + radius];
      }
      dst[rowBase + x] = acc;
    }
  }
}

/** 垂直 1D 卷积（src→dst）。边界 clamp。
 * @param {Float32Array} src
 * @param {Float32Array} dst
 * @param {number} width
 * @param {number} height
 * @param {Float32Array} kernel
 * @param {number} radius
 */
export function blurColConv(src, dst, width, height, kernel, radius) {
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let acc = 0;
      for (let k = -radius; k <= radius; k++) {
        const sy = y + k;
        const clamped = sy < 0 ? 0 : sy >= height ? height - 1 : sy;
        acc += src[clamped * width + x] * kernel[k + radius];
      }
      dst[y * width + x] = acc;
    }
  }
}

import { TRUNC_QUALITY } from '../params.js';

/**
 * 分离式指数模糊：src → (水平) → temp → (垂直) → dst。
 * src/temp/dst 必须互不别名且长度 = width*height。
 * @param {Float32Array} src
 * @param {Float32Array} dst
 * @param {Float32Array} temp 工作缓冲（长度同 src）
 * @param {number} width
 * @param {number} height
 * @param {number} sigma 扩散 σ（像素）
 * @param {number} [radius=ceil(TRUNC_QUALITY*sigma)] 截断半径
 */
export function blurExp(src, dst, temp, width, height, sigma, radius = Math.ceil(TRUNC_QUALITY * sigma)) {
  const kernel = expKernel1D(sigma, radius);
  blurRowConv(src, temp, width, height, kernel, radius);
  blurColConv(temp, dst, width, height, kernel, radius);
}
