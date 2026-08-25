/**
 * Halation 局部光晕与 HDR 安全合成原语。
 * 零依赖，纯函数。
 *
 * 语义：
 *  - k = centerAttenuation（默认 0.9）：从扩散结果减去高光中心，保留边缘光晕、防中心过曝；
 *  - Global Diffusion 由 pipeline 作为独立红层宽扩散实现；本模块不生成白色 glare/bloom；
 *  - G = 红层 background gate（extract 产出）：长波余量允许 halo、亮中性/暖色背景抑制红雾；
 *  - α = strength/100 × ADDITIVE_SCALE（=2.0，D-7）；additive：O′ = O + α·(Halo⊙G)；
 *    screen：O′ = O + (1−O)·α·(Halo⊙G)；
 *  - 可选 Color Density 仅改变红色超额能量的色度，并以中性补偿保证线性亮度不降低。
 */

import { ADDITIVE_SCALE } from './params.js';

/**
 * Halo = max(D − centerAttenuation·W, 0)（逐通道）。
 * 1.5.1：衰减对象为曝光相关源场 W（= S·compressedHighlightResponse(E,T)）——
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
 * @param {{strength:number,blendMode:string,colorDensity?:number,blueCompensation?:number}} params
 * @param {Float32Array} [out] 输出缓冲（可选；缺省新建；可与 halo 别名，不可与 input 别名）
 * @param {Float32Array|null} [densityGate] 可选源体内部色密度保护；只缩放 Color Density，不缩放正 halo 光能
 * @returns {Float32Array} 输出线性 RGB（w*h*3）
 */
export function blend(input, halo, gate, width, height, params, out, densityGate = null) {
  const n = width * height;
  const alpha = alphaFor(params);
  const screen = params.blendMode === 'screen';
  const density = Math.min(1, Math.max(0, Number(params.colorDensity ?? 0)));
  const blueCompensation = Math.min(1, Math.max(0, Number(params.blueCompensation ?? 0)));
  const dst = out ?? new Float32Array(n * 3);
  if (screen) {
    for (let i = 0, p = 0; i < n; i++, p += 3) {
      const a = alpha * (gate ? gate[i] : 1);
      const er = screenGain(input[p]) * Math.max(0, halo[p]) * a;
      const eg = screenGain(input[p + 1]) * Math.max(0, halo[p + 1]) * a;
      const eb = screenGain(input[p + 2]) * Math.max(0, halo[p + 2]) * a;
      writeDensityComposite(dst, p, input[p], input[p + 1], input[p + 2], er, eg, eb, density * (densityGate ? densityGate[i] : 1), blueCompensation);
    }
  } else {
    for (let i = 0, p = 0; i < n; i++, p += 3) {
      const a = alpha * (gate ? gate[i] : 1);
      const er = Math.max(0, halo[p]) * a;
      const eg = Math.max(0, halo[p + 1]) * a;
      const eb = Math.max(0, halo[p + 2]) * a;
      writeDensityComposite(dst, p, input[p], input[p + 1], input[p + 2], er, eg, eb, density * (densityGate ? densityGate[i] : 1), blueCompensation);
    }
  }
  return dst;
}

/**
 * Density-inspired 红橙色度合成。
 *
 * 先在相同 Rec.709 亮度下把 base 色度向 halo 的红橙层比例移动，再叠加正的
 * 扩散光能。因此不会造成感知亮度下降，也不会把 HDR screen 变成负增益；
 * 高亮保护让灯芯保持白色，色度主要落在 shoulder/tail。
 * @param {Float32Array} dst
 * @param {number} p
 * @param {number} r
 * @param {number} g
 * @param {number} b
 * @param {number} er
 * @param {number} eg
 * @param {number} eb
 * @param {number} density
 * @param {number} blueCompensation
 */
function writeDensityComposite(dst, p, r, g, b, er, eg, eb, density, blueCompensation) {
  if (density <= 0 || er <= 1e-12) {
    dst[p] = r + er;
    dst[p + 1] = g + eg;
    dst[p + 2] = b + eb;
    return;
  }
  const redExcess = Math.max(0, er - Math.max(eg, eb));
  if (redExcess <= 1e-12) {
    dst[p] = r + er;
    dst[p + 1] = g + eg;
    dst[p + 2] = b + eb;
    return;
  }

  const basePeak = Math.max(1e-8, Math.max(r, g, b));
  const coolness = Math.min(1, Math.max(0, (Math.max(g, b) - r) / basePeak));
  const energy = redExcess * (1 + 1.6 * blueCompensation * coolness);
  const baseY = Math.max(0, 0.2126 * r + 0.7152 * g + 0.0722 * b);
  const highlight = smoothUnit((baseY - 0.70) / 0.35);
  const mask = Math.min(0.78, density * (1 - Math.exp(-6 * energy)) * (1 - 0.86 * highlight));

  const greenRatio = Math.min(0.38, Math.max(0.12, eg / Math.max(er, 1e-8)));
  const blueRatio = Math.min(0.12, Math.max(0.035, eb / Math.max(er, 1e-8)));
  const targetLuma = 0.2126 + 0.7152 * greenRatio + 0.0722 * blueRatio;
  const targetR = Math.min(baseY / Math.max(1e-8, targetLuma), baseY * 2.4 + 0.05);
  const targetG = targetR * greenRatio;
  const targetB = targetR * blueRatio;
  let coloredR = r + (targetR - r) * mask;
  let coloredG = g + (targetG - g) * mask;
  let coloredB = b + (targetB - b) * mask;
  // targetR 的安全上限可能让目标色的亮度略低；用中性分量补回差额，
  // 保持色度增强而不制造暗环。
  const coloredY = 0.2126 * coloredR + 0.7152 * coloredG + 0.0722 * coloredB;
  const neutralLift = Math.max(0, baseY - coloredY);
  coloredR += neutralLift;
  coloredG += neutralLift;
  coloredB += neutralLift;
  dst[p] = coloredR + er;
  dst[p + 1] = coloredG + eg;
  dst[p + 2] = coloredB + eb;
}

/** @param {number} value */
function smoothUnit(value) {
  const t = Math.min(1, Math.max(0, value));
  return t * t * (3 - 2 * t);
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
