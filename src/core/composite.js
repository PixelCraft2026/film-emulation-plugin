/**
 * 合成 — Halo = max(D − k·S, 0) + Secondary Glare，O′ = O + α·(Halo⊙G)（PRD §5.2）。
 * 零依赖，纯函数。
 *
 * 语义：
 *  - k = centerAttenuation（默认 0.9）：从扩散结果减去高光中心，保留边缘光晕、防中心过曝；
 *  - Secondary Glare：g = globalDiffusion（默认 0.15）对小 σ 扩散（σ_g 固定 4）的 S 加权，
 *    作为白光叠加到 Halo（中心附近额外的眩光层）；
 *  - G = background gate（extract 产出）：暗背景允许 halo、亮背景抑制（防整图红雾 A1）；
 *  - α = strength/100 × ADDITIVE_SCALE（=2.0，D-7）；additive：O′ = O + α·(Halo⊙G)；
 *    screen：O′ = O + (1−O)·α·(Halo⊙G)。
 */

import { ADDITIVE_SCALE } from './params.js';

/** Secondary Glare 固定扩散 σ（像素）；Phase 2 视觉调参可定稿。 */
export const GLARE_SIGMA = 4;

/**
 * Halo = max(D − centerAttenuation·S, 0)（逐通道）。
 * @param {Float32Array} dRgb 已扩散+redshift 的 RGB（w*h*3）
 * @param {Float32Array} s 高光 mask（w*h）
 * @param {number} width
 * @param {number} height
 * @param {{centerAttenuation:number}} params
 * @returns {Float32Array} Halo RGB（w*h*3）
 */
export function computeHalo(dRgb, s, width, height, params) {
  const n = width * height;
  const k = params.centerAttenuation;
  const out = new Float32Array(n * 3);
  for (let i = 0, p = 0; i < n; i++, p += 3) {
    const sub = k * s[i];
    out[p] = dRgb[p] - sub > 0 ? dRgb[p] - sub : 0;
    out[p + 1] = dRgb[p + 1] - sub > 0 ? dRgb[p + 1] - sub : 0;
    out[p + 2] = dRgb[p + 2] - sub > 0 ? dRgb[p + 2] - sub : 0;
  }
  return out;
}

/**
 * Secondary Glare：g·blur(S, σ_g)（单通道，白光层）。
 * @param {Float32Array} s 高光 mask（w*h）
 * @param {number} width
 * @param {number} height
 * @param {(src:Float32Array,dst:Float32Array,temp:Float32Array,w:number,h:number,sigma:number)=>void} blurFn
 *   扩散实现（quality 用 blurExp、fast 用 iirBlur 的适配层包装，统一此签名）
 * @param {Float32Array} temp 扩散工作缓冲（w*h）
 * @param {{globalDiffusion:number}} params
 * @returns {Float32Array} glare（w*h，已乘 g）
 */
export function computeSecondaryGlare(s, width, height, blurFn, temp, params) {
  const n = width * height;
  const glare = new Float32Array(n);
  blurFn(s, glare, temp, width, height, GLARE_SIGMA);
  const g = params.globalDiffusion;
  for (let i = 0; i < n; i++) glare[i] *= g;
  return glare;
}

/** 白光 glare 叠加到 Halo RGB（就地修改 halo）。
 * @param {Float32Array} haloRgb
 * @param {Float32Array} glare
 * @param {number} width
 * @param {number} height
 * @returns {Float32Array}
 */
export function addGlare(haloRgb, glare, width, height) {
  const n = width * height;
  for (let i = 0, p = 0; i < n; i++, p += 3) {
    const v = glare[i];
    haloRgb[p] += v;
    haloRgb[p + 1] += v;
    haloRgb[p + 2] += v;
  }
  return haloRgb;
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
 * @param {Float32Array} input 原始线性 RGB（w*h*3，只读）
 * @param {Float32Array} halo Halo+glare RGB（w*h*3，只读）
 * @param {Float32Array} gate background gate（w*h）
 * @param {number} width
 * @param {number} height
 * @param {{strength:number,blendMode:string}} params
 * @returns {Float32Array} 输出线性 RGB（w*h*3）
 */
export function blend(input, halo, gate, width, height, params) {
  const n = width * height;
  const alpha = alphaFor(params);
  const screen = params.blendMode === 'screen';
  const out = new Float32Array(n * 3);
  if (screen) {
    for (let i = 0, p = 0; i < n; i++, p += 3) {
      const a = alpha * gate[i];
      out[p] = input[p] + (1 - input[p]) * halo[p] * a;
      out[p + 1] = input[p + 1] + (1 - input[p + 1]) * halo[p + 1] * a;
      out[p + 2] = input[p + 2] + (1 - input[p + 2]) * halo[p + 2] * a;
    }
  } else {
    for (let i = 0, p = 0; i < n; i++, p += 3) {
      const a = alpha * gate[i];
      out[p] = input[p] + halo[p] * a;
      out[p + 1] = input[p + 1] + halo[p + 1] * a;
      out[p + 2] = input[p + 2] + halo[p + 2] * a;
    }
  }
  return out;
}
