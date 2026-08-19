/**
 * Halation 局部光晕与 HDR 安全合成原语。
 * 零依赖，纯函数。
 *
 * 语义：
 *  - k = centerAttenuation（默认 0.9）：从扩散结果减去高光中心，保留边缘光晕、防中心过曝；
 *  - Global Diffusion 由 pipeline 作为独立红层宽扩散实现；本模块不生成白色 glare/bloom；
 *  - G = background gate（extract 产出）：暗背景允许 halo、亮背景抑制（防整图红雾 A1）；
 *  - α = strength/100 × ADDITIVE_SCALE（=2.0，D-7）；additive：O′ = O + α·(Halo⊙G)；
 *    screen：O′ = O + (1−O)·α·(Halo⊙G)。
 */

import { ADDITIVE_SCALE } from './params.js';

/**
 * Halo = max(D − centerAttenuation·W, 0)（逐通道）。
 * 1.1 变更：衰减对象从 0..1 掩码 S 改为辐射度加权场 W（= S·(Y/threshold)）——
 * 中心衰减与光晕强度同源缩放，强高光的中心保留比例与旧行为一致（k 仍表示移除比例）。
 * @param {Float32Array} dRgb 已扩散+redshift 的 RGB（w*h*3）
 * @param {Float32Array} w 辐射度加权高光场 W（w*h，可 >1）
 * @param {number} width
 * @param {number} height
 * @param {{centerAttenuation:number}} params
 * @returns {Float32Array} Halo RGB（w*h*3）
 */
export function computeHalo(dRgb, w, width, height, params) {
  const n = width * height;
  const k = params.centerAttenuation;
  const out = new Float32Array(n * 3);
  for (let i = 0, p = 0; i < n; i++, p += 3) {
    const sub = k * w[i];
    out[p] = dRgb[p] - sub > 0 ? dRgb[p] - sub : 0;
    out[p + 1] = dRgb[p + 1] - sub > 0 ? dRgb[p + 1] - sub : 0;
    out[p + 2] = dRgb[p + 2] - sub > 0 ? dRgb[p + 2] - sub : 0;
  }
  return out;
}

/** 计算 α = strength/100 × ADDITIVE_SCALE。
 * @param {{strength:number}} params
 * @returns {number}
 */
export function alphaFor(params) {
  return (params.strength / 100) * ADDITIVE_SCALE;
}

/**
 * 混合：O′ = O + blend(α·Halo⊙G)（additive 或 screen）。
 * 4.2 变更：支持传入 out 缓冲就地写入（调用方可将已无用途的 halo 缓冲复用为输出，
 * 省一个 3n 全分辨率分配）；gate 可为 null（光晕已预门控时跳过 ⊙G）。
 * @param {Float32Array} input 原始线性 RGB（w*h*3，只读）
 * @param {Float32Array} halo Halo+glare RGB（w*h*3，只读）
 * @param {Float32Array|null} gate background gate（w*h；null 表示无门控）
 * @param {number} width
 * @param {number} height
 * @param {{strength:number,blendMode:string}} params
 * @param {Float32Array} [out] 输出缓冲（可选；缺省新建；可与 halo 别名，不可与 input 别名）
 * @returns {Float32Array} 输出线性 RGB（w*h*3）
 */
export function blend(input, halo, gate, width, height, params, out) {
  const n = width * height;
  const alpha = alphaFor(params);
  const screen = params.blendMode === 'screen';
  const dst = out ?? new Float32Array(n * 3);
  if (screen) {
    for (let i = 0, p = 0; i < n; i++, p += 3) {
      const a = alpha * (gate ? gate[i] : 1);
      dst[p] = input[p] + screenGain(input[p]) * Math.max(0, halo[p]) * a;
      dst[p + 1] = input[p + 1] + screenGain(input[p + 1]) * Math.max(0, halo[p + 1]) * a;
      dst[p + 2] = input[p + 2] + screenGain(input[p + 2]) * Math.max(0, halo[p + 2]) * a;
    }
  } else {
    for (let i = 0, p = 0; i < n; i++, p += 3) {
      const a = alpha * (gate ? gate[i] : 1);
      dst[p] = input[p] + halo[p] * a;
      dst[p + 1] = input[p + 1] + halo[p + 1] * a;
      dst[p + 2] = input[p + 2] + halo[p + 2] * a;
    }
  }
  return dst;
}

/**
 * HDR 安全 screen 增益：0..1 仍使用传统 (1-base)，HDR >1 保留原能量并继续
 * 以递减增益叠加，绝不因 (1-base)<0 而反向变暗。
 * @param {number} base
 * @returns {number}
 */
export function screenGain(base) {
  if (base <= 0) return 1;
  if (base < 1) return 1 - base;
  return 1 / Math.max(1, base);
}
