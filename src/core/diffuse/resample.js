/**
 * 降采样 / 上采样 — quality 模式低分辨率扩散支撑（3.1 优化）。
 * 零依赖，纯函数，作用于单通道 Float32Array。
 *
 * 原理：halo 是扩散产物（低频场），可在低分辨率下计算再上采样。
 * 误差上界：指数核频响 1/(1+(σω)²) 在降采样 Nyquist 频率 f=0.5/scale 处衰减
 * ≥ 1/(1+(πσ/scale)²)；scale ≤ σ/8 时 <0.2%——远小于 5σ 截断误差。
 * 收益：卷积计算量按 1/scale² 缩减（σ=50 时 ≈36×）。
 *
 * 网格对齐（分块一致性关键）：格子按「整数 scale」划分——
 * cell j 覆盖 [j·scale, (j+1)·scale)（末格可能偏短），配合调用方保证
 * 带起点与带高都是 scale 的整数倍（见 tileRender），带内格子与整图格子
 * 逐格重合 → 分块低分辨率扩散与整图低分辨率扩散数值一致（L2~1e-9）。
 * 上采样映射固定为 fy = (y+0.5)/scale − 0.5（与低分辨率格心对齐，
 * 不随带/整图高度变化），进一步保证分块/整图一致性。
 *
 * 不变量：常数场 → 常数场（box 平均 + 归一化双线性，DC 精确）。
 */

/**
 * box 平均降采样（单通道，整数 scale 格子）。
 * @param {Float32Array} src w*h
 * @param {number} w
 * @param {number} h
 * @param {number} scale 整数降采样比例（≥1）
 * @returns {{data:Float32Array,dw:number,dh:number}} 低分辨率数据与尺寸
 */
export function boxDownsample(src, w, h, scale) {
  const dw = Math.max(1, Math.ceil(w / scale));
  const dh = Math.max(1, Math.ceil(h / scale));
  const out = new Float32Array(dw * dh);
  for (let j = 0; j < dh; j++) {
    const y0 = j * scale;
    const y1 = Math.min(h, (j + 1) * scale);
    for (let i = 0; i < dw; i++) {
      const x0 = i * scale;
      const x1 = Math.min(w, (i + 1) * scale);
      let acc = 0;
      let count = 0;
      for (let yy = y0; yy < y1; yy++) {
        const row = yy * w;
        for (let xx = x0; xx < x1; xx++) {
          acc += src[row + xx];
          count++;
        }
      }
      out[j * dw + i] = acc / count;
    }
  }
  return { data: out, dw, dh };
}

/**
 * 双线性上采样（单通道，边界 clamp 到边缘像素）。
 * 源坐标固定映射 fy = (y+0.5)/scale − 0.5（低分辨率格心在 (j+0.5)·scale，
 * 输出像素中心在 y+0.5 —— 与格子对齐，分块/整图一致）。
 * 可传入 dst 缓冲（长度必须 = dw*dh）以避免大图重复分配。
 * @param {Float32Array} src sw*sh
 * @param {number} sw
 * @param {number} sh
 * @param {number} dw
 * @param {number} dh
 * @param {number} scale 整数降采样比例（与 boxDownsample 相同）
 * @param {Float32Array} [dst] 输出缓冲（可选）
 * @returns {Float32Array} dw*dh
 */
export function bilinearUpsample(src, sw, sh, dw, dh, scale, dst) {
  const out = dst ?? new Float32Array(dw * dh);
  const inv = 1 / scale;
  for (let y = 0; y < dh; y++) {
    const fy = (y + 0.5) * inv - 0.5;
    const y0 = fy < 0 ? 0 : fy >= sh - 1 ? sh - 1 : Math.floor(fy);
    const y1 = Math.min(sh - 1, y0 + 1);
    const ty = fy - y0;
    const row0 = y0 * sw;
    const row1 = y1 * sw;
    for (let x = 0; x < dw; x++) {
      const fx = (x + 0.5) * inv - 0.5;
      const x0 = fx < 0 ? 0 : fx >= sw - 1 ? sw - 1 : Math.floor(fx);
      const x1 = Math.min(sw - 1, x0 + 1);
      const tx = fx - x0;
      const v00 = src[row0 + x0];
      const v01 = src[row0 + x1];
      const v10 = src[row1 + x0];
      const v11 = src[row1 + x1];
      const top = v00 + (v01 - v00) * tx;
      const bot = v10 + (v11 - v10) * tx;
      out[y * dw + x] = top + (bot - top) * ty;
    }
  }
  return out;
}
