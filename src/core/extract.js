/**
 * 高光提取 — Y / M / S / G / W（PRD §5.2 / TDD §5）。
 * 零依赖，纯函数。输入为线性 RGB ImageBuffer，输出 mask（0..1）与辐射度加权场 W。
 *
 * 语义（以 PRD 为准）：
 *  - Y：线性亮度（默认 Rec.709 系数；options.luma 可覆盖——2.1：Rec2020/ProPhoto
 *    工作空间用各自 primaries 的亮度权重），驱动 soft-threshold 提取与 background gating；
 *  - M：max(R,G,B)，用于 spill 提取变体（V-5 A/B 对照，默认不用）；
 *  - S：高光 mask = smoothstep(threshold±softness/2, Y)——默认提取方式；
 *  - G：background gate = 1 - smoothstep(backgroundThreshold-softness, backgroundThreshold, clamp(Y,0,1))，
 *       暗背景（Y 低）≈1 允许 halo，亮背景（Y 高）→0 抑制，防整图红雾（A1）；
 *  - W：辐射度加权高光场 = S·(Y/threshold)（1.1 优化）——光晕强度 ∝ 超出阈值的光亮度，
 *       而非恒定的 0..1 掩码；Y=threshold 处 W=1（与旧掩码行为连续），更亮的高光按比例
 *       增强光晕，HDR（Y>1）时 W>1 保留物理强度；threshold≤0 时退化为 S·Y。
 */

/** smoothstep 插值（edge0<edge1；x 越界 clamp）。
 * @param {number} edge0
 * @param {number} edge1
 * @param {number} x
 * @returns {number}
 */
export function smoothstep(edge0, edge1, x) {
  // 精确阈值（softness=0）是合法模式。避免 0/0 产生 NaN，并采用右连续阶跃。
  if (edge0 === edge1) return x >= edge1 ? 1 : 0;
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/** 亮度系数（Rec.709 线性）。 */
export const LUMA_R = 0.2126;
export const LUMA_G = 0.7152;
export const LUMA_B = 0.0722;

/** 中灰基准（#3 stops 换算）。 */
const MIDDLE_GRAY = 0.18;

/**
 * 提取 Y/M/S/G/W。
 * @param {{width:number,height:number,rgb:Float32Array,alpha?:Float32Array}} input 线性 RGB（长度 w*h*3）
 * @param {{threshold:number,thresholdSoftness:number,sourceSoftness?:number,backgroundSoftness?:number,backgroundThreshold:number,thresholdUnits?:string}} params
 * @param {{extraction?:string,spillMix?:number,luma?:[number,number,number],compact?:boolean}} [options]
 *   extraction: 'threshold'（默认，基于 Y）| 'spill'（基于 M，AlcedoStudio 参考）
 *   spillMix: 0..1 中间态混合权重（extraction='spill' 时生效；0=纯 threshold，1=纯 spill）
 *   luma: 亮度权重 [r,g,b]（默认 Rec.709；Rec2020/ProPhoto 工作空间由 io 层传入 2.1）
 * @returns {{Y:Float32Array,M:Float32Array|null,S:Float32Array|null,G:Float32Array,W:Float32Array|null,sourceR:Float32Array,sourceG:Float32Array,sourceB:Float32Array}}
 */
export function extractHighlights(input, params, options = {}) {
  const { width: w, height: h, rgb } = input;
  const n = w * h;
  const Y = new Float32Array(n);
  const M = options.compact ? null : new Float32Array(n);
  const S = options.compact ? null : new Float32Array(n);
  const G = new Float32Array(n);
  const W = options.compact ? null : new Float32Array(n);
  const sourceR = new Float32Array(n);
  const sourceG = new Float32Array(n);
  const sourceB = new Float32Array(n);

  const luma = options.luma ?? [LUMA_R, LUMA_G, LUMA_B];
  const spillMix = options.extraction === 'spill' ? (options.spillMix ?? 1) : 0;
  // #3：thresholdUnits='stops' 时阈值按中灰基准曝光档位换算（跨位深/工作空间语义统一）
  const T = params.thresholdUnits === 'stops' ? MIDDLE_GRAY * Math.pow(2, params.threshold) : params.threshold;
  const BT = params.thresholdUnits === 'stops' ? MIDDLE_GRAY * Math.pow(2, params.backgroundThreshold) : params.backgroundThreshold;
  const sourceSoftness = params.sourceSoftness ?? params.thresholdSoftness;
  const backgroundSoftness = params.backgroundSoftness ?? params.thresholdSoftness;
  const t0 = T - sourceSoftness / 2;
  const t1 = T + sourceSoftness / 2;
  const g0 = BT - backgroundSoftness;
  const g1 = BT;
  // 辐射度加权系数：W = S·Y/threshold（threshold=0 时退化为 S·Y，避免除零）
  const invT = T > 0 ? 1 / T : 1;

  for (let i = 0, p = 0; i < n; i++, p += 3) {
    const r = rgb[p];
    const g = rgb[p + 1];
    const b = rgb[p + 2];
    const a = input.alpha ? Math.min(1, Math.max(0, input.alpha[i])) : 1;
    const y = luma[0] * r + luma[1] * g + luma[2] * b;
    const m = r > g ? (r > b ? r : b) : g > b ? g : b;
    Y[i] = y;
    if (M) M[i] = m;
    const sThreshold = smoothstep(t0, t1, y);
    const sSpill = smoothstep(t0, t1, m);
    const s = spillMix === 0 ? sThreshold : sThreshold * (1 - spillMix) + sSpill * spillMix;
    // 完全透明像素不产生光晕；半透明像素按覆盖率贡献光能。
    const maskedSource = s * a;
    if (S) S[i] = maskedSource;
    G[i] = 1 - smoothstep(g0, g1, y < 0 ? 0 : y > 1 ? 1 : y);
    // spill 必须使用已经选择/混合后的 S 和辐射度，而不是旧的 sThreshold。
    const selectedRadiance = y * (1 - spillMix) + m * spillMix;
    if (W) W[i] = maskedSource * Math.max(0, selectedRadiance * invT);

    // 分层感光源：红层接受红/绿为主的反射光，蓝色贡献被严格限制；
    // 绿层随曝光非线性增强，形成靠近光源的橙色核芯和更远的红色尾部。
    const pr = Math.max(0, r);
    const pg = Math.max(0, g);
    const pb = Math.max(0, b);
    const exposure = Math.max(0, selectedRadiance * invT);
    const greenShoulder = 0.35 + 0.65 * smoothstep(0.75, 2.5, exposure);
    sourceR[i] = maskedSource * Math.max(0, (0.82 * pr + 0.16 * pg + 0.02 * pb) * invT);
    sourceG[i] = maskedSource * Math.max(0, (0.08 * pr + 0.74 * pg + 0.03 * pb) * invT) * greenShoulder;
    sourceB[i] = maskedSource * Math.max(0, (0.01 * pr + 0.03 * pg + 0.06 * pb) * invT);
  }
  return { Y, M, S, G, W, sourceR, sourceG, sourceB };
}
