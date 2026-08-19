/**
 * HalationParams — 参数契约、默认值与校验（PRD §4.2 / TDD §5）。
 * 纯函数、零依赖。
 *
 * @typedef {Object} HalationParams
 * @property {number} strength 强度 0..100；α = strength/100 × ADDITIVE_SCALE
 * @property {number} sigma 扩散半径 σ（像素），>0
 * @property {number} threshold 高光 soft-threshold 阈值（linear 0..1；stops 模式为曝光档位）
 * @property {number} thresholdSoftness smoothstep 软化宽度 0..1
 * @property {number} sourceSoftness 光源提取边缘宽度 0..1
 * @property {number} backgroundSoftness 暗侧环境门控边缘宽度 0..1
 * @property {number} smoothness 双瓣 PSF 的尺寸/权重偏置 0..1
 * @property {number} backgroundThreshold Background Gating 背景阈值（单位同 threshold）
 * @property {'linear'|'stops'} thresholdUnits 阈值单位（#3：stops = 中灰 0.18 基准的曝光档位，
 *   跨位深/工作空间语义统一——32-bit HDR 文档阈值行为不再漂移）
 * @property {number[]} redshift 红色偏移增益 [r,g,b]
 * @property {number[]} sigmaRatio 每通道扩散 σ 比例 [r,g,b]
 * @property {'pixels'|'diagonal'} sigmaUnits σ 单位（#5：diagonal = 图像对角线千分比，
 *   同一参数在不同分辨率文档上光晕相对大小一致）
 * @property {number} globalDiffusion Secondary Glare 强度 ≥0
 * @property {number} centerAttenuation 中心衰减 0..1
 * @property {'additive'|'screen'} blendMode 混合模式
 * @property {'quality'|'fast'} diffusionMode 扩散实现
 * @property {'threshold'|'spill'} extraction 高光提取方式（threshold=亮度 Y / spill=max 通道 M）
 * @property {number} spillMix spill 混合权重 0..1（extraction='spill' 时生效；0=纯 Y，1=纯 M）
 * @property {number} rolloff 高光软拐点 0..1（8/16-bit 写回时 >1 值软滚降；0=硬裁剪）
 */

/** blendMode 合法值。 */
export const BLEND_MODES = Object.freeze(['additive', 'screen']);

/** diffusionMode 合法值。 */
export const DIFFUSION_MODES = Object.freeze(['quality', 'fast']);

/** extraction 合法值。 */
export const EXTRACTION_MODES = Object.freeze(['threshold', 'spill']);

/** thresholdUnits 合法值。 */
export const THRESHOLD_UNITS = Object.freeze(['linear', 'stops']);

/** sigmaUnits 合法值。 */
export const SIGMA_UNITS = Object.freeze(['pixels', 'diagonal']);

/** 中灰基准（stops 模式换算：#3）。 */
export const MIDDLE_GRAY = 0.18;

/** V1 默认参数（PRD §4.2 / TDD 默认值表）。 */
export const DEFAULT_PARAMS = Object.freeze({
  /** 强度 0..100；α = strength/100 × ADDITIVE_SCALE */
  strength: 0,
  /** 扩散半径 σ（像素；sigmaUnits='diagonal' 时为对角线千分比，#5） */
  sigma: 7.0,
  /** σ 单位：pixels（像素）| diagonal（图像对角线千分比，#5） */
  sigmaUnits: 'pixels',
  /** 高光提取 soft-threshold 阈值（linear 0..1；stops 模式为曝光档位，见 THRESHOLD_UNITS） */
  threshold: 0.7,
  /** smoothstep 软化宽度 0..1 */
  thresholdSoftness: 0.1,
  /** 光源提取软化；thresholdSoftness 仅作为 v1 兼容别名保留。 */
  sourceSoftness: 0.1,
  /** 暗侧环境门控软化，与光源提取独立。 */
  backgroundSoftness: 0.1,
  /** 双瓣 PSF 平滑度；2/3 恢复 V1.4 的 0.35σ/1.5σ/0.15 权威基线。 */
  smoothness: 2 / 3,
  /** Background Gating 背景阈值（单位同 threshold） */
  backgroundThreshold: 0.8,
  /** 阈值单位：linear（显示/场景参考线性值）| stops（中灰 0.18 基准曝光档位，#3） */
  thresholdUnits: 'linear',
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
  /** 扩散实现：quality=高精度高斯 / fast=三盒高斯近似；两者共享双瓣 PSF。 */
  diffusionMode: 'fast',
  /** 高光提取方式：threshold=基于亮度 Y（默认）/ spill=基于 max 通道 M（饱和色高光更强）。
   *  V1.1 从管线 options 提升为正式参数（可持久化、可 UI 调节）。 */
  extraction: 'threshold',
  /** spill 混合权重（extraction='spill' 时生效；0=纯 Y 提取，1=纯 M 提取）。 */
  spillMix: 0.5,
  /** 高光软拐点：8/16-bit 写回时对 >1 显示值软滚降（模拟胶片肩部）；0=硬裁剪。 */
  rolloff: 0,
  /** 预设骨架（PRD §4.3，V1 无 UI）：预留参数组合名称，未来 Film Stock Preset 库用。 */
  profile: 'standard',
});

/**
 * 内部常量（D-7）：α = strength/100 × ADDITIVE_SCALE。
 * AlcedoStudio halation 的 amount=strength/100×2.0 参考基线。
 */
export const ADDITIVE_SCALE = 2.0;

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
  const stops = params.thresholdUnits === 'stops';
  const thresholdMin = stops ? -8 : 0;
  const thresholdMax = 8;
  // stops 允许负曝光档；linear 仍要求非负。先按值校验，单位枚举在下方独立报告。
  if (!isFiniteNumber(params.threshold) || params.threshold < thresholdMin || params.threshold > thresholdMax) {
    errors.push(`threshold must be a number in [${thresholdMin}, ${thresholdMax}] for ${stops ? 'stops' : 'linear'} units, got ${params.threshold}`);
  }
  if (!isFiniteNumber(params.thresholdSoftness) || params.thresholdSoftness < 0 || params.thresholdSoftness > 1) {
    errors.push(`thresholdSoftness must be a number in [0, 1], got ${params.thresholdSoftness}`);
  }
  if (!isFiniteNumber(params.sourceSoftness) || params.sourceSoftness < 0 || params.sourceSoftness > 1) {
    errors.push(`sourceSoftness must be a number in [0, 1], got ${params.sourceSoftness}`);
  }
  if (!isFiniteNumber(params.backgroundSoftness) || params.backgroundSoftness < 0 || params.backgroundSoftness > 1) {
    errors.push(`backgroundSoftness must be a number in [0, 1], got ${params.backgroundSoftness}`);
  }
  if (!isFiniteNumber(params.smoothness) || params.smoothness < 0 || params.smoothness > 1) {
    errors.push(`smoothness must be a number in [0, 1], got ${params.smoothness}`);
  }
  if (!isFiniteNumber(params.backgroundThreshold) || params.backgroundThreshold < thresholdMin || params.backgroundThreshold > thresholdMax) {
    errors.push(`backgroundThreshold must be a number in [${thresholdMin}, ${thresholdMax}] for ${stops ? 'stops' : 'linear'} units, got ${params.backgroundThreshold}`);
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
  if (!EXTRACTION_MODES.includes(params.extraction)) {
    errors.push(`extraction must be one of ${EXTRACTION_MODES.join('|')}, got ${params.extraction}`);
  }
  if (!THRESHOLD_UNITS.includes(params.thresholdUnits)) {
    errors.push(`thresholdUnits must be one of ${THRESHOLD_UNITS.join('|')}, got ${params.thresholdUnits}`);
  }
  if (!SIGMA_UNITS.includes(params.sigmaUnits)) {
    errors.push(`sigmaUnits must be one of ${SIGMA_UNITS.join('|')}, got ${params.sigmaUnits}`);
  }
  if (!isFiniteNumber(params.spillMix) || params.spillMix < 0 || params.spillMix > 1) {
    errors.push(`spillMix must be a number in [0, 1], got ${params.spillMix}`);
  }
  if (!isFiniteNumber(params.rolloff) || params.rolloff < 0 || params.rolloff > 1) {
    errors.push(`rolloff must be a number in [0, 1], got ${params.rolloff}`);
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
  // v1 文档只有 thresholdSoftness。迁移时同时作为两个独立软化参数的初值；
  // 新文档若显式提供 source/backgroundSoftness，则各自保持独立。
  if (!Object.prototype.hasOwnProperty.call(src, 'sourceSoftness') && Object.prototype.hasOwnProperty.call(src, 'thresholdSoftness')) {
    params.sourceSoftness = /** @type {number} */ (src.thresholdSoftness);
  }
  if (!Object.prototype.hasOwnProperty.call(src, 'backgroundSoftness') && Object.prototype.hasOwnProperty.call(src, 'thresholdSoftness')) {
    params.backgroundSoftness = /** @type {number} */ (src.thresholdSoftness);
  }
  params.thresholdSoftness = params.sourceSoftness;
  params.redshift = Array.isArray(src.redshift) ? [...src.redshift] : [...DEFAULT_PARAMS.redshift];
  params.sigmaRatio = Array.isArray(src.sigmaRatio) ? [...src.sigmaRatio] : [...DEFAULT_PARAMS.sigmaRatio];
  return validateParams(params);
}

/**
 * 阈值单位换算（#3）：stops（中灰 0.18 基准曝光档位）→ 线性值。
 * @param {number} v 参数值（linear 时为线性值；stops 时为档位数）
 * @param {'linear'|'stops'} units
 * @returns {number} 线性阈值（0..8 域）
 */
export function thresholdLinear(v, units) {
  return units === 'stops' ? MIDDLE_GRAY * Math.pow(2, v) : v;
}

/**
 * σ 单位换算（#5）：返回像素 σ。
 * @param {import('./params.js').DEFAULT_PARAMS} params
 * @param {number} width 图像宽（像素）
 * @param {number} height 图像高（像素）
 * @returns {number} 像素 σ
 */
export function sigmaPxFor(params, width, height) {
  if (params.sigmaUnits === 'diagonal') {
    return (params.sigma / 1000) * Math.hypot(width, height);
  }
  return params.sigma;
}

/**
 * 幂等解析 σ 单位：返回 sigma 已换算为像素、sigmaUnits='pixels' 的参数副本
 * （重复调用不二次换算；调用方不得修改 UI 持有的原 params）。
 * @param {{sigmaUnits?:string,sigma:number}} params HalationParams
 * @param {number} width
 * @param {number} height
 * @returns {object} 渲染用参数（σ 像素值）
 */
export function resolveSigmaParams(params, width, height) {
  if (params.sigmaUnits !== 'diagonal') return params;
  return { ...params, sigma: sigmaPxFor(params, width, height), sigmaUnits: 'pixels' };
}
