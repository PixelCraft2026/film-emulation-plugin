/**
 * 算法管线编排 — processHalation（PRD §5.2 V1 链路）。
 * 零依赖，纯函数。
 *
 * 链路：提取(Y/M/S/G) → 逐通道扩散(σ×sigmaRatio, quality=conv/fast=IIR) →
 *       red shift(redshift 增益) → Halo=max(D−k·S,0) → Secondary Glare(白光叠加) →
 *       blend(O + α·(Halo⊙G), additive/screen)。
 *
 * 不变式（TDD）：
 *  - 不修改输入 rgb（非破坏）；
 *  - strength=0 → 输出与输入逐字节一致（identity，T1）；
 *  - 32-bit HDR >1 值全程保留（不 clamp，T3/C1）。
 */

import { validateParams } from './params.js';
import { extractHighlights } from './extract.js';
import { blurExp } from './diffuse/conv.js';
import { iirBlur } from './diffuse/iir.js';
import { channelSigmas, applyRedShift } from './redshift.js';
import { computeHalo, computeSecondaryGlare, addGlare, blend } from './composite.js';

/**
 * 构造统一签名的扩散函数 (src,dst,temp,w,h,sigma)。
 * @param {import('./params.js').DEFAULT_PARAMS} params
 * @returns {(src:Float32Array,dst:Float32Array,temp:Float32Array,w:number,h:number,sigma:number)=>void}
 */
export function makeBlurFn(params) {
  if (params.diffusionMode === 'fast') {
    return (src, dst, _temp, w, h, sigma) => iirBlur(src, dst, w, h, sigma);
  }
  return (src, dst, temp, w, h, sigma) => blurExp(src, dst, temp, w, h, sigma);
}

/**
 * 处理单张图像。
 * @param {{width:number,height:number,rgb:Float32Array}} input 线性 RGB ImageBuffer
 * @param {import('./params.js').DEFAULT_PARAMS} params HalationParams
 * @param {{extraction?:string,spillMix?:number}} [options] 透传给 extractHighlights（V-5 对照用）
 * @returns {{width:number,height:number,rgb:Float32Array}}
 */
export function processHalation(input, params, options = {}) {
  validateParams(params);
  const { width: w, height: h, rgb } = input;
  const n = w * h;

  const { S, G } = extractHighlights(input, params, options);
  const blurFn = makeBlurFn(params);

  // 逐通道扩散（σ = sigma × sigmaRatio[c]）
  const [sr, sg, sb] = channelSigmas(params);
  const dr = new Float32Array(n);
  const dg = new Float32Array(n);
  const db = new Float32Array(n);
  const temp = new Float32Array(n);
  blurFn(S, dr, temp, w, h, sr);
  blurFn(S, dg, temp, w, h, sg);
  blurFn(S, db, temp, w, h, sb);

  // red shift + halo + secondary glare
  const dRgb = applyRedShift(dr, dg, db, w, h, params);
  const halo = computeHalo(dRgb, S, w, h, params);
  const glare = computeSecondaryGlare(S, w, h, blurFn, temp, params);
  addGlare(halo, glare, w, h);

  // 混合（不修改输入）
  const out = blend(rgb, halo, G, w, h, params);
  return { width: w, height: h, rgb: out };
}
