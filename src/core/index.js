/**
 * Film Halation core — 唯一公共出口（zero-dependency 纯算法库）。
 *
 * 约束（TDD §3）：
 *  - 零 UXP / Photoshop / DOM 依赖，纯函数，Node 可直接运行与测试；
 *  - core/ 不感知宿主；io/ 是唯一接触宿主 API 的层；
 *  - 所有公共 API 只从这里导出。
 *
 * Public API (V1, 依实现进度逐次挂载)：
 *  - createHalationParams(overrides?) -> HalationParams        (params.js)
 *  - processHalation(input, params) -> { rgb, stats }          (pipeline.js)
 *  - decodeTRC / encodeTRC / trcNameForProfile                 (color/trc.js)
 *  - gaussianBlurConv / iirBlur                                 (diffuse/*)
 *  - extractHighlights / redShift / compositeHalo               (extract/redshift/composite)
 *
 * 像素约定（TDD §5）：ImageBuffer = { width: number, height: number, rgb: Float32Array }
 *  rgb 为线性 RGB（R,G,B 交错，长度 width*height*3，可含 >1 HDR 值），
 *  本库不负责 TRC——TRC 由调用方（io/colorPipeline 或 Node 测试 harness）负责。
 */

export {
  createHalationParams,
  validateParams,
  DEFAULT_PARAMS,
  ADDITIVE_SCALE,
  BLEND_MODES,
  DIFFUSION_MODES,
} from './params.js';
export { TRCS, getTRC } from './color/trc.js';
export { expKernel1D, blurRowConv, blurColConv, blurExp } from './diffuse/conv.js';
export { iirBlur, mirrorIndex } from './diffuse/iir.js';
export { smoothstep, extractHighlights } from './extract.js';
export { channelSigmas, applyRedShift } from './redshift.js';
export { GLARE_SIGMA, computeHalo, computeSecondaryGlare, addGlare, alphaFor, blend } from './composite.js';
export { makeBlurFn, processHalation, extractStep, diffuseStep, haloStep, blendStep } from './pipeline.js';
