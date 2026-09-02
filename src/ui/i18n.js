// @ts-nocheck
/**
 * Runtime UI localization. Language is a global plugin preference and is
 * deliberately kept outside the document/schema state.
 */

export const UI_LOCALES = Object.freeze(['en', 'zh-CN']);
export const DEFAULT_UI_LOCALE = 'en';

export function normalizeUiLocale(value, fallback = DEFAULT_UI_LOCALE) {
  const locale = String(value || '').trim().toLowerCase().replace(/_/g, '-');
  if (locale === 'zh' || locale.startsWith('zh-')) return 'zh-CN';
  if (locale === 'en' || locale.startsWith('en-')) return 'en';
  return UI_LOCALES.includes(fallback) ? fallback : (fallback === '' ? '' : DEFAULT_UI_LOCALE);
}

export function detectUiLocale(candidates = [], fallback = DEFAULT_UI_LOCALE) {
  for (const candidate of candidates) {
    const raw = String(candidate || '').trim();
    if (!raw) continue;
    const normalized = normalizeUiLocale(raw, '');
    if (normalized) return normalized;
  }
  return normalizeUiLocale(fallback);
}

const EN = Object.freeze({
  title: 'Film Emulation', basic: 'Basic', preset: 'Preset', advanced: 'Advanced',
  strength: 'Strength', sigma: 'Sigma', threshold: 'Threshold',
  redLayerThresholdBias: 'Red-Layer Threshold Bias', thresholdSoftness: 'Softness',
  sourceSoftness: 'Source Softness', backgroundSoftness: 'Background Softness',
  smoothness: 'PSF Smoothness', backgroundThreshold: 'Background Threshold',
  sourceImpact: 'Source Impact', amplify: 'Halation Amplify',
  sourceExpansion: 'Strong Source Expansion', redTail: 'Red Tail',
  blueCompensation: 'Blue Compensation', colorDensity: 'Halation Color Density',
  sourceInteriorProtection: 'Source Interior Protection', hotSourceThreshold: 'Strong Source Level',
  hotCoreStrength: 'Strong Core', globalSourceThreshold: 'Global Source Level',
  spectralSensitivity: 'Hue Response', redshiftR: 'Red Shift R', redshiftG: 'Red Shift G',
  redshiftB: 'Red Shift B', sigmaRatioR: 'Sigma Ratio R', sigmaRatioG: 'Sigma Ratio G',
  sigmaRatioB: 'Sigma Ratio B', globalDiffusion: 'Global Red Diffusion',
  centerAttenuation: 'Center Attenuation', blendMode: 'Blend Mode', diffusionMode: 'Diffusion',
  extraction: 'Highlight Extraction', extractionLuma: 'luma (Y)',
  extractionSpill: 'spill (max RGB)', spillMix: 'Spill Mix', rolloff: 'Highlight Rolloff',
  sigmaUnits: 'Sigma Units', sigmaUnitsPixels: 'pixels', sigmaUnitsDiagonal: '% of diagonal',
  thresholdUnits: 'Threshold Units', unitsLinear: 'linear', unitsStops: 'stops (EV)',
  apply: 'Apply', rebind: 'Rebind Source', preview: 'Preview', previewStage: 'INSPECTION PREVIEW',
  language: 'Language', languageEnglish: 'English', languageChinese: '中文',
  windowsTestBuild: 'Windows test build',
  toggleOn: 'On', toggleOff: 'Off',
  enableEffectAria: (label) => `Enable ${label}`,
  enableEffectTitle: (label) => `${label}: enable or disable`,
  statusReady: 'Ready.',
  statusReadyForPreview: 'Ready. Select a pixel layer and adjust a slider.',
  statusNoDocument: 'No active document.',
  statusDocumentChanged: 'Document changed. Loading Film Emulation state…',
  statusLoaded: 'Loaded Film Emulation state. Preparing preview…',
  statusRendering: 'Rendering…',
  statusApplied: (ms) => `Rendered to a verified Film Emulation copy (${ms}ms). Source preserved.`,
  statusPreviewed: (ms) => `Panel preview (${ms}ms).`,
  statusPreviewedDetailed: (total, read, render) => `Panel preview ${total}ms (read ${read}ms, render ${render}ms).`,
  statusPreviewRefining: 'Source loaded. Refining film effects…',
  statusRebound: 'Source rebound. Apply will create a new verified effect copy.',
  statusFailed: (msg) => `Failed: ${msg}`,
  statusProfileNote: (note) => note,
  storedSettingsFailed: 'Stored settings could not be loaded.',
  selectOriginalSource: 'Select the original pixel layer, not a Film Emulation effect copy.',
  previewHint: 'Fit shows the whole image. At 100%, drag the synchronized Source / Preview view to inspect native pixels. Apply never writes the source layer.',
  modeQuality: 'quality', modeFast: 'fast', blendAdditive: 'additive', blendScreen: 'screen',
  runtimeInfo: (releaseName, backend) => `${releaseName} · ${backend}`,
  backendLoading: 'compute: loading', backendWasm: 'compute: scalar WASM',
  backendJs: 'compute: JavaScript fallback',
});

const ZH = Object.freeze({
  title: 'Film Emulation', basic: '基础', preset: '预设', advanced: '高级',
  strength: '强度', sigma: '半径 Sigma', threshold: '阈值',
  redLayerThresholdBias: '红色感光层阈值偏移', thresholdSoftness: '柔和度',
  sourceSoftness: '光源柔和度', backgroundSoftness: '背景柔和度',
  smoothness: 'PSF 平滑度', backgroundThreshold: '背景阈值', sourceImpact: '光源影响',
  amplify: '胶片光晕增益', sourceExpansion: '强光源扩张', redTail: '红色尾部',
  blueCompensation: '蓝色补偿', colorDensity: '胶片光晕色彩密度',
  sourceInteriorProtection: '光源内部保护', hotSourceThreshold: '强光源级别',
  hotCoreStrength: '强光核心', globalSourceThreshold: '全局光源级别',
  spectralSensitivity: '色相响应', redshiftR: '红移 R', redshiftG: '红移 G',
  redshiftB: '红移 B', sigmaRatioR: 'Sigma 比例 R', sigmaRatioG: 'Sigma 比例 G',
  sigmaRatioB: 'Sigma 比例 B', globalDiffusion: '全局红色扩散', centerAttenuation: '中心衰减',
  blendMode: '混合模式', diffusionMode: '扩散模式', extraction: '高光提取',
  extractionLuma: '亮度（Y）', extractionSpill: '溢出（RGB 最大值）', spillMix: '溢出混合',
  rolloff: '高光滚降', sigmaUnits: 'Sigma 单位', sigmaUnitsPixels: '像素',
  sigmaUnitsDiagonal: '对角线百分比', thresholdUnits: '阈值单位',
  unitsLinear: '线性', unitsStops: '档（EV）', apply: '应用', rebind: '重新绑定源图层',
  preview: '预览', previewStage: '检查预览', language: '界面语言',
  languageEnglish: 'English', languageChinese: '中文', windowsTestBuild: 'Windows 测试版', toggleOn: '开启', toggleOff: '关闭',
  enableEffectAria: (label) => `启用${label}`,
  enableEffectTitle: (label) => `${label}：启用或关闭`,
  statusReady: '就绪。', statusReadyForPreview: '就绪。请选择像素图层并调整参数。',
  statusNoDocument: '没有活动文档。', statusDocumentChanged: '文档已切换，正在载入 Film Emulation 状态…',
  statusLoaded: '已载入 Film Emulation 状态，正在准备预览…', statusRendering: '正在渲染…',
  statusApplied: (ms) => `已渲染到经验证的 Film Emulation 效果副本（${ms}ms），源图层保持不变。`,
  statusPreviewed: (ms) => `面板预览（${ms}ms）。`,
  statusPreviewedDetailed: (total, read, render) => `面板预览 ${total}ms（读取 ${read}ms，渲染 ${render}ms）。`,
  statusPreviewRefining: '源图像已载入，正在细化胶片效果…',
  statusRebound: '源图层已重新绑定；应用时会创建新的效果副本。',
  statusFailed: (msg) => `失败：${msg}`, statusProfileNote: (note) => note,
  storedSettingsFailed: '无法载入已保存的设置。',
  selectOriginalSource: '请选择原始像素图层，而不是 Film Emulation 效果副本。',
  previewHint: '“适合”显示完整图像；在 100% 下可拖动同步的源图/预览检查原生像素。应用不会写入源图层。',
  modeQuality: '质量', modeFast: '快速', blendAdditive: '相加', blendScreen: '滤色',
  runtimeInfo: (releaseName, backend) => `${releaseName} · ${backend}`,
  backendLoading: '计算后端：载入中', backendWasm: '计算后端：标量 WASM',
  backendJs: '计算后端：JavaScript 回退',
});

export function getStrings(locale = DEFAULT_UI_LOCALE) {
  return normalizeUiLocale(locale) === 'zh-CN' ? ZH : EN;
}

const ZH_UI_TEXT = Object.freeze({
  'Effects': '效果', 'Film effect domains': '胶片效果分类', 'Halation': '胶片光晕',
  'Defringe': '去色边', 'Bloom': '泛光', 'Resolution': '解析度', 'Grain': '颗粒',
  'Custom': '自定义', 'Neutral / Legacy': '中性 / 传统',
  'CineStill 800T': 'CineStill 800T',
  'Amount': '数量', 'Radius (px)': '半径（px）', 'Chroma threshold': '色度阈值',
  'Chroma softness': '色度柔和度', 'Edge sensitivity': '边缘灵敏度',
  'Threshold (EV)': '阈值（EV）', 'Softness (EV)': '柔和度（EV）',
  'Radius (% diagonal)': '半径（对角线百分比）', 'Amplify': '增益',
  'Saturation': '饱和度', 'Save lights': '保留高光', 'Highlight Protection': '高光保护',
  'Film stock': '胶片规格', 'Film format': '胶片格式', 'Film Resolution': '胶片解析度',
  'Film Grain': '胶片颗粒', 'Material': '材料', 'Negative': '负片',
  'Positive / print': '正片 / 印片', 'Resolution loss': '解析度损失',
  'MTF response': 'MTF 响应', 'Shadow loss': '暗部损失', 'Highlight loss': '高光损失',
  'Correlation': '相关模式', 'Analogue': '模拟', 'Fast': '快速', 'Size': '尺寸',
  'Roughness': '粗糙度', 'Chroma': '色度', 'Randomize grain': '随机化颗粒',
  'Effect area': '效果区域', 'Bloom output area': '泛光输出区域',
  'Protection area': '保护区域', 'Halation output area': '胶片光晕输出区域',
  'Apply to': '应用于', 'Entire image': '整张图像', 'Exposure range': '曝光范围',
  'Lower bound (EV)': '下限（EV）', 'Upper bound (EV)': '上限（EV）',
  'Edge softness (EV)': '边缘柔和度（EV）', 'Range': '范围',
  'Inside EV range': 'EV 范围内', 'Outside EV range': 'EV 范围外',
  'Fit': '适合', 'Preview scale': '预览缩放', 'Fit on screen': '适合窗口',
  'Inspect source pixels at 100%': '以 100% 检查源像素', 'SOURCE': '源图',
  'PREVIEW': '预览', 'Rendering': '正在渲染', 'Rendering film preview': '正在渲染胶片预览',
  'Drag to inspect · Arrow keys move 64 px': '拖动检查 · 方向键移动 64 px',
  'Apply memory': '应用内存模式', 'Auto (safe)': '自动（安全）',
  'High (16 GB+)': '高（16 GB+）', 'Balanced': '平衡', 'Language': '界面语言',
  'Highlight Protection uses the nearest Bloom contribution.': '高光保护使用最近的泛光贡献。',
  'Highlight Protection has no Bloom contribution. Enable Bloom to activate it.': '当前没有泛光贡献；请启用泛光以激活高光保护。',
  'Limits where this effect is mixed, using the node input exposure.': '根据节点输入曝光限制效果混合区域。',
  'Limits where Defringe correction is mixed, using the input exposure.': '根据输入曝光限制去色边校正的混合区域。',
  'Limits where diffused Bloom is added. Highlight source extraction is unchanged.': '限制扩散泛光的添加区域，不改变高光源提取。',
  'Limits where Highlight Protection modifies the nearest Bloom contribution.': '限制高光保护修改最近泛光贡献的区域。',
  'Limits where the Film Resolution result is mixed, using the input exposure.': '根据输入曝光限制胶片解析度结果的混合区域。',
  'Limits where the Film Grain result is mixed, using the input exposure.': '根据输入曝光限制胶片颗粒结果的混合区域。',
  'Limits where the rendered Halation is mixed. Source extraction settings are unchanged.': '限制胶片光晕渲染结果的混合区域，不改变光源提取设置。',
  'Film preview. In 100 percent mode, drag to inspect another area.': '胶片预览。在 100% 模式下拖动可检查其他区域。',
  'Original source preview': '原始源图预览', 'Rendered film preview': '渲染后的胶片预览',
  'High avoids repeated spatial halos when UXP cannot report memory. Use only on systems with at least 16 GB RAM.': '当 UXP 无法报告内存时，高模式可减少空间分段重复计算；仅建议在至少 16 GB 内存的系统使用。',
});

export function translateUiText(value, locale = DEFAULT_UI_LOCALE) {
  const text = String(value ?? '');
  if (normalizeUiLocale(locale) !== 'zh-CN') return text;
  return ZH_UI_TEXT[text] ?? text;
}

export const STRINGS = EN;
