/**
 * 指数扩散 — fast 模式：双向一阶 IIR（递归滤波）+ 5σ 镜像扩展边界。
 * 零依赖，作用于单通道 Float32Array（长度 width*height）。
 *
 * 数学（与 conv.js 同一 exp 核 exp(-|d|/σ) 的另一实现）：
 *  前向  f[i] = x[i] + a·f[i-1]，后向 g[i] = x[i] + a·g[i+1]，a = exp(-1/σ)
 *  y[i] = (f[i] + g[i] - x[i]) · (1-a)/(1+a)
 *  DC 增益恒为 1（C=(1-a)/(1+a) 使脉冲响应和归一化）。
 * 边界：图像先向四周镜像扩展 pad=ceil(5σ) 像素，在扩展域上递归，再裁回——
 *  避免边缘处无界递归的能量流失（TDD R-4）。
 * 性能：O(N)，与 σ 无关（两遍扫描），适用于大图预览。
 */

/** 循环镜像索引（对 n≥2；n=1 时恒 0）。
 * @param {number} i
 * @param {number} n
 * @returns {number}
 */
export function mirrorIndex(i, n) {
  if (n <= 1) return 0;
  const period = 2 * (n - 1);
  let m = i % period;
  if (m < 0) m += period;
  return m < n ? m : period - m;
}

/**
 * 双向一阶 IIR 指数模糊（镜像扩展 + 行 pass + 列 pass + 裁回）。
 * @param {Float32Array} src 输入（width*height）
 * @param {Float32Array} dst 输出（width*height）
 * @param {number} width
 * @param {number} height
 * @param {number} sigma 扩散 σ（像素）
 * @param {number} [pad=ceil(5*sigma)] 镜像扩展半宽
 */
export function iirBlur(src, dst, width, height, sigma, pad = Math.ceil(5 * sigma)) {
  const pw = width + 2 * pad;
  const ph = height + 2 * pad;
  const A = new Float32Array(pw * ph);
  const B = new Float32Array(pw * ph);

  // 镜像填充（扩展域）
  for (let y = 0; y < ph; y++) {
    const sy = mirrorIndex(y - pad, height);
    const rowA = y * pw;
    const rowS = sy * width;
    for (let x = 0; x < pw; x++) {
      A[rowA + x] = src[rowS + mirrorIndex(x - pad, width)];
    }
  }

  const a = Math.exp(-1 / sigma);
  const c = (1 - a) / (1 + a);

  // 行 pass：A -> B
  for (let y = 0; y < ph; y++) {
    const row = y * pw;
    let f = 0;
    for (let x = 0; x < pw; x++) {
      f = A[row + x] + a * f;
      B[row + x] = f;
    }
    let g = 0;
    for (let x = pw - 1; x >= 0; x--) {
      g = A[row + x] + a * g;
      B[row + x] = (B[row + x] + g - A[row + x]) * c;
    }
  }

  // 列 pass：B -> A
  for (let x = 0; x < pw; x++) {
    let f = 0;
    for (let y = 0; y < ph; y++) {
      const idx = y * pw + x;
      f = B[idx] + a * f;
      A[idx] = f;
    }
    let g = 0;
    for (let y = ph - 1; y >= 0; y--) {
      const idx = y * pw + x;
      g = B[idx] + a * g;
      A[idx] = (A[idx] + g - B[idx]) * c;
    }
  }

  // 裁回
  for (let y = 0; y < height; y++) {
    const rowD = y * width;
    const rowA = (y + pad) * pw + pad;
    for (let x = 0; x < width; x++) {
      dst[rowD + x] = A[rowA + x];
    }
  }
}
