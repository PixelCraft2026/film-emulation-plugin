/**
 * HalationParams — 参数契约、默认值与校验（PRD §4.2 / TDD §5）。
 * 纯函数、零依赖。
 *
 * @typedef {Object} HalationParams
 * @property {number} strength 强度 0..100；α = strength/100 × ADDITIVE_SCALE
 * @property {number} sigma 扩散半径 σ（像素），>0
 * @property {number} threshold 高光 soft-threshold 阈值 0..1
 * @property {number} thresholdSoftness smoothstep 软化宽度 0..1
 * @property {number} backgroundThreshold Background Gating 背景阈值 0..1
 * @property {number[]} redshift 红色偏移增益 [r,g,b]
 * @property {number[]} sigmaRatio 每通道扩散 σ 比例 [r,g,b]
 * @property {number} globalDiffusion Secondary Glare 强度 ≥0
 * @property {number} centerAttenuation 中心衰减 0..1
 * @property {'additive'|'screen'} blendMode 混合模式
 * @property {'quality'|'fast'} diffusionMode 扩散实现
 */

/** blendMode 合法值。 */
export const BLEND_MODES = Object.freeze(['additive', 'screen']);

/** diffusionMode 合法值。 */
export const DIFFUSION_MODES = Object.freeze(['quality', 'fast']);

/** V1 默认参数（PRD §4.2 / TDD 默认值表）。 */
export const DEFAULT_PARAMS = Object.freeze({
  /** 强度 0..100；α = strength/100 × ADDITIVE_SCALE */
  strength: 0,
  /** 扩散半径 σ（像素） */
  sigma: 7.0,
  /** 高光提取 soft-threshold 阈值 0..1 */
  threshold: 0.7,
  /** smoothstep 软化宽度 0..1 */
  thresholdSoftness: 0.1,
  /** Background Gating 背景阈值 0..1 */
  backgroundThreshold: 0.8,
  /** 红色偏移增益 [r, g, b]，基准 (1.0, 0.05, 0.02) */
  redshift: [1.0, 0.05, 0.02],
  /** 每通道扩散 σ 比例 [r, g, b]，基准 (1.0, 0.85, 0.7) */
  sigmaRatio: [1.0, 0.85, 0.7],
  /** Secondary Glare 全局扩散强度 */
  globalDiffusion: 0.15,
  /** Center Attenuation 中心衰减（spill 保留系数） */
  centerAttenuation: 0.9,
  /** 混合模式 */
  blendMode: 'additive',
  /** 扩散实现：quality=有限卷积 / fast=双向一阶 IIR。
   *  默认 fast（A3 决策 2026-08-10：24MP quality 12.8s > 5s 目标，fast 3.4s 达标；
   *  quality 保留为可选高精度模式，UI 提示更慢）。 */
  diffusionMode: 'fast',
});

/**
 * 内部常量（D-7）：α = strength/100 × ADDITIVE_SCALE。
 * AlcedoStudio halation 的 amount=strength/100×2.0 参考基线。
 */
export const ADDITIVE_SCALE = 2.0;

/** 逐通道扩散核的截断系数：quality 半径 = ceil(sigmaRatio × sigma × TRUNC_QUALITY)。 */
export const TRUNC_QUALITY = 3;
/** fast 模式的镜像扩展半宽系数（IIR 边界条件）。 */
export const TRUNC_FAST = 5;

/**
 * @param {unknown} v
 * @returns {boolean}
 */
const isFiniteNumber = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * 校验参数；非法时抛 TypeError。返回参数本身（便于链式使用）。
 * @param {HalationParams} params
 * @returns {HalationParams}
 */
export function validateParams(params) {
  const errors = [];
  if (!isFiniteNumber(params.strength) || params.strength < 0 || params.strength > 100) {
    errors.push(`strength must be a number in [0, 100], got ${params.strength}`);
  }
  if (!isFiniteNumber(params.sigma) || params.sigma <= 0) {
    errors.push(`sigma must be a positive number, got ${params.sigma}`);
  }
  if (!isFiniteNumber(params.threshold) || params.threshold < 0 || params.threshold > 1) {
    errors.push(`threshold must be a number in [0, 1], got ${params.threshold}`);
  }
  if (!isFiniteNumber(params.thresholdSoftness) || params.thresholdSoftness < 0 || params.thresholdSoftness > 1) {
    errors.push(`thresholdSoftness must be a number in [0, 1], got ${params.thresholdSoftness}`);
  }
  if (!isFiniteNumber(params.backgroundThreshold) || params.backgroundThreshold < 0 || params.backgroundThreshold > 1) {
    errors.push(`backgroundThreshold must be a number in [0, 1], got ${params.backgroundThreshold}`);
  }
  if (!isFiniteNumber(params.globalDiffusion) || params.globalDiffusion < 0) {
    errors.push(`globalDiffusion must be a non-negative number, got ${params.globalDiffusion}`);
  }
  if (!isFiniteNumber(params.centerAttenuation) || params.centerAttenuation < 0 || params.centerAttenuation > 1) {
    errors.push(`centerAttenuation must be a number in [0, 1], got ${params.centerAttenuation}`);
  }
  for (const key of /** @type {const} */ (['redshift', 'sigmaRatio'])) {
    const arr = params[key];
    if (!Array.isArray(arr) || arr.length !== 3 || !arr.every(isFiniteNumber)) {
      errors.push(`${key} must be an array of 3 finite numbers, got ${JSON.stringify(arr)}`);
    }
  }
  if (!BLEND_MODES.includes(params.blendMode)) {
    errors.push(`blendMode must be one of ${BLEND_MODES.join('|')}, got ${params.blendMode}`);
  }
  if (!DIFFUSION_MODES.includes(params.diffusionMode)) {
    errors.push(`diffusionMode must be one of ${DIFFUSION_MODES.join('|')}, got ${params.diffusionMode}`);
  }
  if (errors.length > 0) {
    throw new TypeError(`Invalid HalationParams: ${errors.join('; ')}`);
  }
  return params;
}

/**
 * 创建一份参数对象：默认值 + overrides 合并，数组字段深拷贝，并校验。
 * @param {Partial<HalationParams>} [overrides]
 * @returns {HalationParams}
 */
export function createHalationParams(overrides = {}) {
  const src = overrides ?? {};
  const params = /** @type {HalationParams} */ ({ ...DEFAULT_PARAMS, ...src });
  params.redshift = Array.isArray(src.redshift) ? [...src.redshift] : [...DEFAULT_PARAMS.redshift];
  params.sigmaRatio = Array.isArray(src.sigmaRatio) ? [...src.sigmaRatio] : [...DEFAULT_PARAMS.sigmaRatio];
  return validateParams(params);
}
