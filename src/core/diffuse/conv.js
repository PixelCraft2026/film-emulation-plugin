/**
 * 高斯扩散 — quality 模式：分离式有限卷积（高斯核）+ 重归一化 + clamp 边界。
 * 零依赖，作用于单通道 Float32Array（长度 width*height）。
 *
 * V1.2 核体系重构（菱形修复 + 双瓣 PSF）：单指数可分离核 exp(-|x|/σ)·exp(-|y|/σ)
 * 是曼哈顿距离衰减（等值线为菱形）——各向异性伪影。高斯核可分离且各向同性
 * （exp(-(x²+y²)/2σ²) = exp(-x²/2σ²)·exp(-y²/2σ²)），双瓣高斯叠加提供
 * 「窄核芯 + 宽尾」的胶片 PSF 形状（瓣参数见 pipeline.js 的 PSF_LOBES）。
 *
 * 数学：一维高斯核 w(d) = exp(-d²/(2σ²))，截断半径 radius=ceil(3σ)
 * （3σ 截断处权重 e^-4.5 ≈ 1.1%），截断后重归一化保持直流增益 1。
 * 2D 扩散 = 水平 1D 卷积 + 垂直 1D 卷积（分离式）。
 * 边界：越界像素 clamp 到边缘像素值（不引入外部能量）。
 */

/** 生成重归一化后的一维高斯核。
 * @param {number} sigma
 * @param {number} radius
 * @returns {Float32Array}
 */
export function gaussianKernel1D(sigma, radius) {
  const size = radius * 2 + 1;
  const kernel = new Float32Array(size);
  const inv2s2 = 1 / (2 * sigma * sigma);
  let sum = 0;
  for (let i = 0; i < size; i++) {
    const d = i - radius;
    const w = Math.exp(-d * d * inv2s2);
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

/**
 * 分离式高斯模糊：src → (水平) → tempA → (垂直) → dst。
 * 签名与 boxBlur3 统一（多瓣扩散的 lobeFn 接口）：tempB 为占位参数（忽略）。
 * src/tempA/dst 必须互不别名且长度 = width*height（src 与 dst 别名合法）。
 * @param {Float32Array} src
 * @param {Float32Array} dst
 * @param {Float32Array} tempA 工作缓冲（长度同 src）
 * @param {Float32Array} tempB 占位（统一 lobeFn 签名，未使用）
 * @param {number} width
 * @param {number} height
 * @param {number} sigma 高斯 σ（像素）
 * @param {number} [radius=ceil(3*sigma)] 截断半径
 */
export function gaussianBlurSep(src, dst, tempA, tempB, width, height, sigma, radius = Math.ceil(3 * sigma)) {
  const kernel = gaussianKernel1D(sigma, radius);
  blurRowConv(src, tempA, width, height, kernel, radius);
  blurColConv(tempA, dst, width, height, kernel, radius);
}
