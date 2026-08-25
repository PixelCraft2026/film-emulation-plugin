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
 *  - gaussianBlurSep / boxBlur3                                (diffuse/*)
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
  EXTRACTION_MODES,
  THRESHOLD_UNITS,
  SIGMA_UNITS,
  MIDDLE_GRAY,
  thresholdLinear,
  sigmaPxFor,
  resolveSigmaParams,
  createHalationPreset,
  HALATION_PRESET_LABELS,
} from './params.js';
export { TRCS, getTRC } from './color/trc.js';
export { SPACE_TO_SRGB, SRGB_TO_SPACE, applyMatrix3 } from './color/primaries.js';
export { gaussianKernel1D, blurRowConv, blurColConv, gaussianBlurSep } from './diffuse/conv.js';
export { boxRadiusForSigma, boxBlurOnce, boxBlur3 } from './diffuse/box.js';
export { vvCoef, vvGauss } from './diffuse/vv.js';
export { boxDownsample, bilinearUpsample } from './diffuse/resample.js';
export {
  smoothstep,
  extractHighlights,
  sourceResponseFor,
  compressedHighlightResponseFor,
  reconstructedSourceExposureFor,
  maxFilterSeparable,
  WASM_MAX_FILTER_PIXEL_LIMIT,
  SOURCE_RESPONSE_LIMIT,
  SOURCE_CLASS_SOFTNESS,
  SOURCE_CLASS_SOFTNESS_EV,
  BACKGROUND_LONG_WAVE_R,
  BACKGROUND_LONG_WAVE_G,
  RED_LAYER_EXPOSURE_R,
  RED_LAYER_EXPOSURE_G,
  RED_LAYER_EXPOSURE_B,
  spectralHueResponse,
  RED_LAYER_HUE_RESPONSE,
  GREEN_LAYER_HUE_RESPONSE,
  BLUE_LAYER_HUE_RESPONSE,
} from './extract.js';
export { channelSigmas, applyRedShift } from './redshift.js';
export { computeHalo, alphaFor, blend, screenGain } from './composite.js';
export { makeBlurFn, processHalation, extractStep, diffuseStep, haloStep, blendStep, lowResScale, lobeScale, psfLobesFor, LOWRES_MIN_SIGMA, LOWRES_MAX_SCALE, PSF_LOBES, LOCAL_GATE_RELIEF_GAIN } from './pipeline.js';
export { ENGINE_VERSION, EFFECT_ORDER, processFilm } from './film.js';
export { installWasmModule, tryWasmBoxBlur, tryWasmMaxFilter, tryWasmHalation, getWasmBackendStatus, resetWasmBackend } from './wasmBackend.js';
export { blueNoise, BLUE_NOISE_SIZE } from './dither.js';
