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
 * @property {number} smoothness 三瓣 PSF 的尺寸/权重偏置 0..1
 * @property {number} backgroundThreshold Background Gating 背景阈值（单位同 threshold）
 * @property {number} sourceImpact 光源超阈值曝光的非线性响应 0..1（指数 1..2.5）
 * @property {number} amplify 乳剂返回光能增益 0..4；与最终 strength/Impact 分离
 * @property {number} sourceExpansion 强光种子向较低亮度邻域扩张 0..1
 * @property {number} redTail 红层 PSF 肩部/长尾权重增强 0..1
 * @property {number} blueCompensation 冷背景对红晕可见性的补偿 0..1
 * @property {number} colorDensity 亮度安全的红橙色度覆盖 0..1
 * @property {number} sourceInteriorProtection 光源内部保护 0..1；1 仅保留 PSF 越过源体边界的局部光晕
 * @property {number} hotSourceThreshold 强光源重建高光坐标门槛 0..4
 * @property {number} hotCoreStrength 强光源紧实核芯增强 0..1
 * @property {number} globalSourceThreshold Global Diffusion 的独立重建高光坐标门槛 0..4
 * @property {number} spectralSensitivity 光源色相对红/绿感光层响应的影响 0..1
 * @property {number} redLayerThresholdBias 主阈值源场倾向 0..1；0=现有曝光场，1=深红层曝光×发光体置信度
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

/**
 * The visible Threshold control has an explicit "no emitters" endpoint.
 * Values below the endpoint retain the continuous SDR/HDR exposure model;
 * the right-most value is intentionally semantic rather than another finite
 * scene-light threshold, because 32-bit documents have no fixed upper bound.
 */
export const HALATION_THRESHOLD_OFF_ENDPOINT = Object.freeze({
  linear: 1,
  stops: 4,
});

/** Top-of-control shoulder: ordinary values below it keep their legacy meaning. */
export const HALATION_THRESHOLD_HDR_SHOULDER = Object.freeze({
  linear: 0.9,
  stops: 3,
});

// Must remain finite after Float32 command-buffer encoding. The exact endpoint
// bypasses Halation via strength=0, so this is only an ABI-safe placeholder.
const HALATION_THRESHOLD_FINITE_CEILING = 1e30;

/**
 * Return true when the user-visible Threshold control is at its off endpoint.
 * @param {number} v
 * @param {'linear'|'stops'|string|undefined} units
 */
export function isHalationThresholdDisabled(v, units) {
  const endpoint = units === 'stops'
    ? HALATION_THRESHOLD_OFF_ENDPOINT.stops
    : HALATION_THRESHOLD_OFF_ENDPOINT.linear;
  return Number.isFinite(v) && v >= endpoint;
}

/**
 * Convert the user-facing Halation Threshold to its physical linear-light
 * value. The upper control shoulder expands continuously toward the unbounded
 * 32-bit HDR domain, avoiding the old 1.000=off / 0.999=all-HDR discontinuity.
 *
 * Below 0.9 linear or +3 stops this is exactly the legacy conversion, so all
 * built-in presets and ordinary SDR tuning retain their numerical meaning.
 * @param {number} v
 * @param {'linear'|'stops'|string|undefined} units
 * @returns {number}
 */
export function halationThresholdLinear(v, units) {
  if (isHalationThresholdDisabled(v, units)) return HALATION_THRESHOLD_FINITE_CEILING;
  if (units === 'stops') {
    const pivot = HALATION_THRESHOLD_HDR_SHOULDER.stops;
    const endpoint = HALATION_THRESHOLD_OFF_ENDPOINT.stops;
    const effectiveStops = v <= pivot
      ? v
      : pivot + ((v - pivot) * (endpoint - pivot)) / Math.max(1e-9, endpoint - v);
    return Math.min(HALATION_THRESHOLD_FINITE_CEILING, MIDDLE_GRAY * Math.pow(2, Math.min(120, effectiveStops)));
  }
  const pivot = HALATION_THRESHOLD_HDR_SHOULDER.linear;
  const endpoint = HALATION_THRESHOLD_OFF_ENDPOINT.linear;
  if (v <= pivot) return v;
  return Math.min(
    HALATION_THRESHOLD_FINITE_CEILING,
    pivot + ((v - pivot) * (endpoint - pivot)) / Math.max(1e-9, endpoint - v),
  );
}

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
  sourceSoftness: 0.05,
  /** 暗侧环境门控软化，与光源提取独立。 */
  backgroundSoftness: 0.08,
  /** 三瓣 PSF 平滑度；较低默认值保留扎实核芯，避免密集弱光源形成柔雾。 */
  smoothness: 0.15,
  /** Background Gating 背景阈值（单位同 threshold） */
  backgroundThreshold: 0.3,
  /** 超阈值曝光响应强度：0=近线性档位响应，1=2.5 次幂。 */
  sourceImpact: 0.65,
  /** 乳剂返回光能增益；1=兼容，0=关闭物理光能，最终 Strength 仍是效果 Impact。 */
  amplify: 1,
  /** 强光种子引导的低阈值源体扩张；0 保持 V1.5.1 单阈值行为。 */
  sourceExpansion: 0,
  /** 红层肩部/长尾权重增强；0 使用共享三瓣 PSF。 */
  redTail: 0,
  /** 冷色背景补偿；0 保持固定长波门控，1 最大程度恢复蓝天上的红晕。 */
  blueCompensation: 0,
  /** 红层曝光驱动的亮度安全色度覆盖；0 为纯 RGB 加法兼容路径。 */
  colorDensity: 0,
  /** 光源内部保护；0 保持旧版中心衰减，1 从扩散场减去同增益源场，只保留外缘残差。 */
  sourceInteriorProtection: 0,
  /** 强光源分类门槛：T..1 为 0..1，HDR 从 1 继续按曝光档延伸。 */
  hotSourceThreshold: 0.1,
  /** 强光源降低中心衰减的程度。 */
  hotCoreStrength: 0.75,
  /** Global Diffusion 只接受比主 Threshold 更高的强光源。 */
  globalSourceThreshold: 0.75,
  /** 0 保持 V1.5 兼容矩阵；1 使用完整的光源色相/饱和度响应。 */
  spectralSensitivity: 0,
  /** 主阈值源场倾向；0 逐值保持现有 Y/maxRGB 提取，1 完全使用深红层曝光源场。 */
  redLayerThresholdBias: 0,
  /** 阈值单位：linear（显示/场景参考线性值）| stops（中灰 0.18 基准曝光档位，#3） */
  thresholdUnits: 'linear',
  /** 红色偏移增益 [r, g, b]，基准 (1.0, 0.12, 0.02) */
  redshift: [1.0, 0.12, 0.02],
  /** 每通道扩散 σ 比例 [r, g, b]，基准 (1.0, 0.55, 0.35) */
  sigmaRatio: [1.0, 0.55, 0.35],
  /** Secondary Glare 全局扩散强度 */
  globalDiffusion: 0.03,
  /** Center Attenuation 中心衰减（spill 保留系数） */
  centerAttenuation: 0.4,
  /** 混合模式 */
  blendMode: 'additive',
  /** 扩散实现：quality=高精度高斯 / fast=三盒高斯近似；两者共享三瓣 PSF。 */
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

/** 面板内置物理预设。名称仅描述视觉方向，不代表官方胶片配置。 */
export const HALATION_PRESET_LABELS = Object.freeze({
  custom: 'Custom',
  standard: 'Neutral / Legacy',
  'tungsten-800': 'CineStill 800T',
});

const PRESET_OVERRIDES = Object.freeze({
  standard: Object.freeze({
    // 克制的通用 halation：只让最亮的中性/暖色光源形成短而清晰的外缘红晕。
    // 全局扩散近乎关闭，避免城市窗户阵列累积成红雾；光源本体与蓝色 LED 优先保色。
    strength: 68,
    sigma: 3.6,
    sigmaUnits: 'diagonal',
    threshold: 0.74,
    thresholdUnits: 'linear',
    sourceSoftness: 0.04,
    thresholdSoftness: 0.04,
    backgroundSoftness: 0.10,
    smoothness: 0.14,
    backgroundThreshold: 0.36,
    sourceImpact: 0.88,
    amplify: 1.65,
    sourceExpansion: 0.16,
    redTail: 0.28,
    blueCompensation: 0.35,
    colorDensity: 0.045,
    sourceInteriorProtection: 1.0,
    hotSourceThreshold: 0.42,
    hotCoreStrength: 0.62,
    globalSourceThreshold: 1.05,
    spectralSensitivity: 1.0,
    redLayerThresholdBias: 0,
    redshift: [1.08, 0.10, 0.01],
    sigmaRatio: [1.05, 0.50, 0.28],
    globalDiffusion: 0.008,
    centerAttenuation: 0.45,
    blendMode: 'additive',
    diffusionMode: 'fast',
    extraction: 'spill',
    spillMix: 0.55,
    rolloff: 0,
    profile: 'standard',
  }),
  'tungsten-800': Object.freeze({
    strength: 82,
    sigma: 5.2,
    sigmaUnits: 'diagonal',
    threshold: 0.86,
    thresholdUnits: 'linear',
    sourceSoftness: 0.03,
    thresholdSoftness: 0.03,
    backgroundSoftness: 0.24,
    smoothness: 0.14,
    backgroundThreshold: 0.48,
    sourceImpact: 1.0,
    amplify: 2.2,
    sourceExpansion: 0.85,
    redTail: 0.80,
    blueCompensation: 0.90,
    colorDensity: 0.68,
    // 保留 V1.5.1 当前 No-Remjet 强光核芯与浓郁红晕外观。
    sourceInteriorProtection: 0,
    hotSourceThreshold: 0.45,
    hotCoreStrength: 0.90,
    globalSourceThreshold: 0.78,
    spectralSensitivity: 1.0,
    redLayerThresholdBias: 0,
    redshift: [1.25, 0.12, 0.0],
    sigmaRatio: [1.15, 0.42, 0.18],
    globalDiffusion: 0.05,
    centerAttenuation: 0.35,
    blendMode: 'additive',
    diffusionMode: 'fast',
    extraction: 'spill',
    spillMix: 0.7,
    rolloff: 0,
    profile: 'tungsten-800',
  }),
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
  if (!isFiniteNumber(params.sourceImpact) || params.sourceImpact < 0 || params.sourceImpact > 1) {
    errors.push(`sourceImpact must be a number in [0, 1], got ${params.sourceImpact}`);
  }
  if (!isFiniteNumber(params.amplify) || params.amplify < 0 || params.amplify > 4) {
    errors.push(`amplify must be a number in [0, 4], got ${params.amplify}`);
  }
  for (const key of /** @type {const} */ (['sourceExpansion', 'redTail', 'blueCompensation', 'colorDensity', 'sourceInteriorProtection', 'redLayerThresholdBias'])) {
    const value = params[key];
    if (!isFiniteNumber(value) || value < 0 || value > 1) {
      errors.push(`${key} must be a number in [0, 1], got ${value}`);
    }
  }
  if (!isFiniteNumber(params.hotSourceThreshold) || params.hotSourceThreshold < 0 || params.hotSourceThreshold > 4) {
    errors.push(`hotSourceThreshold must be a number in [0, 4], got ${params.hotSourceThreshold}`);
  }
  if (!isFiniteNumber(params.hotCoreStrength) || params.hotCoreStrength < 0 || params.hotCoreStrength > 1) {
    errors.push(`hotCoreStrength must be a number in [0, 1], got ${params.hotCoreStrength}`);
  }
  if (!isFiniteNumber(params.globalSourceThreshold) || params.globalSourceThreshold < 0 || params.globalSourceThreshold > 4) {
    errors.push(`globalSourceThreshold must be a number in [0, 4], got ${params.globalSourceThreshold}`);
  }
  if (!isFiniteNumber(params.spectralSensitivity) || params.spectralSensitivity < 0 || params.spectralSensitivity > 1) {
    errors.push(`spectralSensitivity must be a number in [0, 1], got ${params.spectralSensitivity}`);
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
  const legacySrc = /** @type {Partial<HalationParams> & {sourceThresholdMode?:string}} */ (src);
  const params = /** @type {HalationParams} */ ({ ...DEFAULT_PARAMS, ...src });
  // V1.5.1 短期双模式字段迁移到连续滑块：legacy→0，red-layer→1。
  if (!Object.prototype.hasOwnProperty.call(src, 'redLayerThresholdBias')
    && Object.prototype.hasOwnProperty.call(src, 'sourceThresholdMode')) {
    params.redLayerThresholdBias = legacySrc.sourceThresholdMode === 'red-layer' ? 1 : 0;
  }
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
 * 构造一份独立的内置预设参数；custom 只用于标记用户修改，不可直接加载。
 * @param {'standard'|'tungsten-800'} id
 */
export function createHalationPreset(id = 'tungsten-800') {
  const preset = PRESET_OVERRIDES[/** @type {keyof typeof PRESET_OVERRIDES} */ (id)];
  if (!preset) throw new TypeError(`Unknown halation preset: ${String(id)}`);
  return createHalationParams(preset);
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
