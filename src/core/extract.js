/**
 * 高光提取 — Y / M / S / G（PRD §5.2 / TDD §5）。
 * 零依赖，纯函数。输入为线性 RGB ImageBuffer，输出 4 个单通道 mask（0..1）。
 *
 * 语义（以 PRD 为准）：
 *  - Y：线性亮度（Rec.709 系数），驱动 soft-threshold 提取与 background gating；
 *  - M：max(R,G,B)，用于 spill 提取变体（V-5 A/B 对照，默认不用）；
 *  - S：高光 mask = smoothstep(threshold±softness/2, Y)——默认提取方式；
 *  - G：background gate = 1 - smoothstep(backgroundThreshold-softness, backgroundThreshold, clamp(Y,0,1))，
 *       暗背景（Y 低）≈1 允许 halo，亮背景（Y 高）→0 抑制，防整图红雾（A1）。
 */

/** smoothstep 插值（edge0<edge1；x 越界 clamp）。
 * @param {number} edge0
 * @param {number} edge1
 * @param {number} x
 * @returns {number}
 */
export function smoothstep(edge0, edge1, x) {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/** 亮度系数（Rec.709 线性）。 */
export const LUMA_R = 0.2126;
export const LUMA_G = 0.7152;
export const LUMA_B = 0.0722;

/**
 * 提取 Y/M/S/G。
 * @param {{width:number,height:number,rgb:Float32Array}} input 线性 RGB（长度 w*h*3）
 * @param {{threshold:number,thresholdSoftness:number,backgroundThreshold:number}} params
 * @param {{extraction?:string,spillMix?:number}} [options]
 *   extraction: 'threshold'（默认，基于 Y）| 'spill'（基于 M，AlcedoStudio 参考）
 *   spillMix: 0..1 中间态混合权重（extraction='spill' 时生效；0=纯 threshold，1=纯 spill）
 * @returns {{Y:Float32Array,M:Float32Array,S:Float32Array,G:Float32Array}}
 */
export function extractHighlights(input, params, options = {}) {
  const { width: w, height: h, rgb } = input;
  const n = w * h;
  const Y = new Float32Array(n);
  const M = new Float32Array(n);
  const S = new Float32Array(n);
  const G = new Float32Array(n);

  const spillMix = options.extraction === 'spill' ? (options.spillMix ?? 1) : 0;
  const t0 = params.threshold - params.thresholdSoftness / 2;
  const t1 = params.threshold + params.thresholdSoftness / 2;
  const g0 = params.backgroundThreshold - params.thresholdSoftness;
  const g1 = params.backgroundThreshold;

  for (let i = 0, p = 0; i < n; i++, p += 3) {
    const r = rgb[p];
    const g = rgb[p + 1];
    const b = rgb[p + 2];
    const y = LUMA_R * r + LUMA_G * g + LUMA_B * b;
    const m = r > g ? (r > b ? r : b) : g > b ? g : b;
    Y[i] = y;
    M[i] = m;
    const sThreshold = smoothstep(t0, t1, y);
    const sSpill = smoothstep(t0, t1, m);
    S[i] = spillMix === 0 ? sThreshold : sThreshold * (1 - spillMix) + sSpill * spillMix;
    G[i] = 1 - smoothstep(g0, g1, y < 0 ? 0 : y > 1 ? 1 : y);
  }
  return { Y, M, S, G };
}
