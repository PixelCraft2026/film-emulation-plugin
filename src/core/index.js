/**
 * Film Emulation core — 唯一公共出口（zero-dependency 纯算法库）。
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
  HALATION_THRESHOLD_OFF_ENDPOINT,
  HALATION_THRESHOLD_HDR_SHOULDER,
  halationThresholdLinear,
  isHalationThresholdDisabled,
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
export { ENGINE_VERSION, FILM_GRAPH_VERSION, EFFECT_ORDER, processFilm, processFilmStages } from './film.js';
export {
  createFilmRenderPlan,
  createPhysicalLayout,
  stableStringify as stablePlanStringify,
  TRANSIENT_SLOTS,
  STAGE_OPCODES,
  RESIDENT_MIGRATION_ORDER,
  RESIDENT_LAYOUT_VERSION,
  RESIDENT_LAYOUT_ALIGNMENT_FLOATS,
} from './renderPlan.js';
export {
  COMMAND_MAGIC,
  COMMAND_BUFFER_VERSION,
  EXECUTOR_ABI_VERSION,
  COMMAND_HEADER_BYTES,
  NODE_COMMAND_BYTES,
  COMMAND_ERRORS,
  createGraphCommandBuffer,
  validateGraphCommandBuffer,
} from './commandBuffer.js';
export { BufferArena, allocateF32, acquireF32, releaseF32 } from './bufferArena.js';
export { createFilmExecutor } from './executor.js';
export {
  BACKEND_IDS,
  GPU_BACKEND_ABI,
  GPU_UNAVAILABLE_CODE,
  createBackendTransferStats,
  createBackendMemoryStats,
  normalizeBackendCapabilities,
  createUnavailableGpuBackend,
} from './backendContract.js';
export {
  installWasmModule,
  tryWasmBoxBlur,
  tryWasmGaussianBlur,
  tryWasmVvGaussianBlur,
  tryWasmMaxFilter,
  tryWasmHashField,
  tryWasmHashBlurField,
  tryWasmBeginGrainAccum,
  tryWasmHashBlurFieldIntoGrain,
  tryWasmGrainScaleIntoAccum,
  tryWasmFinishGrainAccum,
  tryWasmApplyGrain,
  tryWasmApplyResidentGrain,
  tryWasmHalation,
  createV16ResidentBackend,
  createV17ResidentBackend,
  getWasmBackendStatus,
  setWasmExecutionMode,
  getWasmExecutionMode,
  setWasmSimdQualification,
  resetWasmBackend,
} from './wasmBackend.js';
export { blueNoise, BLUE_NOISE_SIZE } from './dither.js';
export {
  FORMAT_PROFILES,
  DEFAULT_FILM_FORMAT,
  GAUGES,
  normalizeFilmFormat,
  resolveFilmFormat,
  pixelsPerMm,
  pixelsPerMicron,
  physicalMicronsToPixels,
} from './format.js';
export { fmix32, fnv1aUtf8, hash32, uniformFromHash, gaussianApprox, deriveSeed, SEED_GOLDEN_RATIO } from './seed.js';
export {
  FILM_RESOLUTION_DEFAULTS,
  createFilmResolutionParams,
  validateFilmResolutionParams,
  filmResolutionTarget,
  filmResolutionSupport,
  processFilmResolution,
  gaussianVarianceScale,
} from './resolution.js';
export {
  GRAIN_DEFAULTS,
  createGrainParams,
  validateGrainParams,
  processGrain,
  grainSupport,
} from './grain.js';
export {
  LUMA_MASK_DEFAULTS,
  maskSmoothstep,
  validateLumaMask,
  createLumaMask,
  lumaMaskValue,
  computeLumaMask,
  applyEffectMask,
  applyContributionMask,
} from './mask.js';
export {
  DEFRINGE_DEFAULTS,
  createDefringeParams,
  validateDefringeParams,
  processDefringe,
  defringeSupport,
} from './defringe.js';
export {
  BLOOM_DEFAULTS,
  BLOOM_LOBES,
  createBloomParams,
  validateBloomParams,
  processBloom,
  bloomRadiusPx,
  bloomSupport,
} from './bloom.js';
export {
  HIGHLIGHT_PROTECTION_DEFAULTS,
  createHighlightProtectionParams,
  validateHighlightProtectionParams,
  processHighlightProtection,
} from './highlightProtection.js';
export {
  FILM_EFFECT_REGISTRY,
  getEffectDefinition,
  validateEffectNode,
  normalizeEffectGraph,
  createDefaultEffectGraph,
  graphMinimumEngineVersion,
} from './effectRegistry.js';
