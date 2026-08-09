/**
 * 算法管线 — processHalation 与分步执行（PRD §5.2 V1 链路）。
 * 零依赖，纯函数。
 *
 * 链路：提取(Y/M/S/G) → 逐通道扩散(σ×sigmaRatio, quality=conv/fast=IIR) →
 *       red shift(redshift 增益) → Halo=max(D−k·S,0) → Secondary Glare(白光叠加) →
 *       blend(O + α·(Halo⊙G), additive/screen)。
 *
 * 分步（Phase 6 增量重算）：extractStep / diffuseStep / haloStep / blendStep，
 * 调用方可缓存中间量（S、扩散 plane、halo），参数局部变更时只重算受影响步骤。
 *
 * 内存（V-3 ≤3 份 3n 全分辨率缓冲）：plane(3n 平面扩散) + D(3n 交错 halo) + out(3n)，
 * 与 S/G/temp(n) 合计 ≈ 3 份 3n。
 *
 * 不变式（TDD）：不修改输入 rgb；strength=0 恒等（T1）；HDR >1 保留（T3）。
 */

import { validateParams } from './params.js';
import { extractHighlights } from './extract.js';
import { blurExp } from './diffuse/conv.js';
import { iirBlur } from './diffuse/iir.js';
import { channelSigmas } from './redshift.js';
import { computeSecondaryGlare, addGlare, blend } from './composite.js';

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
 * 步骤 1：提取 S/G（Y/M 为中间）。
 * @param {{width:number,height:number,rgb:Float32Array}} input
 * @param {import('./params.js').DEFAULT_PARAMS} params
 * @param {{extraction?:string,spillMix?:number}} [options]
 * @returns {{S:Float32Array,G:Float32Array,Y:Float32Array,M:Float32Array}}
 */
export function extractStep(input, params, options = {}) {
  return extractHighlights(input, params, options);
}

/**
 * 步骤 2：逐通道扩散 + red shift（输出平面 3n：R/G/B 分区，已乘 redshift，未减 S）。
 * @param {Float32Array} s S mask（w*h）
 * @param {number} width
 * @param {number} height
 * @param {import('./params.js').DEFAULT_PARAMS} params
 * @returns {{plane:Float32Array,temp:Float32Array,blurFn:(src:Float32Array,dst:Float32Array,temp:Float32Array,w:number,h:number,sigma:number)=>void}}
 */
export function diffuseStep(s, width, height, params) {
  const n = width * height;
  const blurFn = makeBlurFn(params);
  const [sr, sg, sb] = channelSigmas(params);
  const rs = params.redshift;
  const plane = new Float32Array(n * 3);
  const temp = new Float32Array(n);
  const rView = plane.subarray(0, n);
  const gView = plane.subarray(n, 2 * n);
  const bView = plane.subarray(2 * n, 3 * n);
  blurFn(s, rView, temp, width, height, sr);
  blurFn(s, gView, temp, width, height, sg);
  blurFn(s, bView, temp, width, height, sb);
  // 就地 red shift（平面区）
  for (let i = 0; i < n; i++) {
    rView[i] *= rs[0];
    gView[i] *= rs[1];
    bView[i] *= rs[2];
  }
  return { plane, temp, blurFn };
}

/**
 * 步骤 3：Halo = max(D−k·S,0) + Secondary Glare（交错输出）。
 * @param {Float32Array} s S mask
 * @param {Float32Array} plane 步骤 2 输出（平面，已 red shift）
 * @param {number} width
 * @param {number} height
 * @param {import('./params.js').DEFAULT_PARAMS} params
 * @param {(src:Float32Array,dst:Float32Array,temp:Float32Array,w:number,h:number,sigma:number)=>void} blurFn
 * @param {Float32Array} temp 扩散工作缓冲（复用）
 * @returns {Float32Array} D（3n 交错 halo）
 */
export function haloStep(s, plane, width, height, params, blurFn, temp) {
  const n = width * height;
  const k = params.centerAttenuation;
  const D = new Float32Array(n * 3);
  const rView = plane.subarray(0, n);
  const gView = plane.subarray(n, 2 * n);
  const bView = plane.subarray(2 * n, 3 * n);
  for (let i = 0; i < n; i++) {
    const sub = k * s[i];
    const r = rView[i] - sub;
    const g = gView[i] - sub;
    const b = bView[i] - sub;
    const p = i * 3;
    D[p] = r > 0 ? r : 0;
    D[p + 1] = g > 0 ? g : 0;
    D[p + 2] = b > 0 ? b : 0;
  }
  const glare = computeSecondaryGlare(s, width, height, blurFn, temp, params);
  addGlare(D, glare, width, height);
  return D;
}

/**
 * 步骤 4：blend（O + α·(Halo⊙G)）。
 * @param {{rgb:Float32Array}} input
 * @param {Float32Array} halo 步骤 3 输出
 * @param {Float32Array} g G mask
 * @param {number} width
 * @param {number} height
 * @param {import('./params.js').DEFAULT_PARAMS} params
 * @returns {Float32Array} out（3n）
 */
export function blendStep(input, halo, g, width, height, params) {
  return blend(input.rgb, halo, g, width, height, params);
}

/**
 * 完整处理（组装四步）。
 * @param {{width:number,height:number,rgb:Float32Array}} input 线性 RGB ImageBuffer
 * @param {import('./params.js').DEFAULT_PARAMS} params HalationParams
 * @param {{extraction?:string,spillMix?:number}} [options]
 * @returns {{width:number,height:number,rgb:Float32Array,S:Float32Array,G:Float32Array,halo:Float32Array}}
 */
export function processHalation(input, params, options = {}) {
  validateParams(params);
  const { width, height } = input;
  const { S, G } = extractStep(input, params, options);
  const { plane, temp, blurFn } = diffuseStep(S, width, height, params);
  const halo = haloStep(S, plane, width, height, params, blurFn, temp);
  const rgb = blendStep(input, halo, G, width, height, params);
  return { width, height, rgb, S, G, halo };
}
