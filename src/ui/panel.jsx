// @ts-nocheck
/**
 * ui/panel — Film Emulation 面板（Spectrum UXP，原生 DOM）。
 * 布局：效果领域导航 / 当前领域参数 / 大幅检查预览 / Apply + 状态行。
 * 控件变更 → handlers.onParamsChange()（main.jsx 负责 debounce 预览与状态刷新）。
 * 本文件只做视图与事件转发，不含算法与宿主逻辑。
 */
import { getStrings, translateUiText } from './i18n.js';
import {
  createSlider as createSliderControl,
  createSelect as createSelectControl,
  createEffectSwitch as createEffectSwitchControl,
} from './controls.js';
import {
  defaultPreviewModeForDomain,
  inspectionImageLayout,
  inspectionViewportForCss,
  normalizePreviewPixelRatio,
} from './previewMode.js';
import { replaceGraphNodeParams } from './graphState.js';
import {
  createHalationPreset,
  HALATION_PRESET_LABELS,
  createFilmResolutionParams,
  createGrainParams,
  createDefringeParams,
  createBloomParams,
  createHighlightProtectionParams,
  createLumaMask,
} from '../core/index.js';

function setDropdownValue(el, value) {
  if (!el) return;
  const items = Array.from((el.querySelector('sp-menu') || { children: [] }).children || []);
  const idx = items.findIndex((it) => it.value === value);
  el.selectedIndex = idx >= 0 ? idx : 0;
}

function setSliderRange(el, min, max, step, value) {
  if (!el) return;
  if (el.__filmSlider?.setRange) {
    el.__filmSlider.setRange(min, max, step, value);
    return;
  }
  el.min = min;
  el.max = max;
  el.step = step;
  if (value !== undefined) el.value = value;
}

function localizePanelTree(root, locale) {
  if (locale !== 'zh-CN') return;
  const elements = [root, ...Array.from(root.querySelectorAll?.('*') || [])];
  for (const element of elements) {
    if (!(element.children?.length > 0) && element.textContent) {
      element.textContent = translateUiText(element.textContent, locale);
    }
    for (const attribute of ['aria-label', 'title']) {
      const value = element.getAttribute?.(attribute);
      if (value) element.setAttribute(attribute, translateUiText(value, locale));
    }
  }
}

/**
 * @param {{
 *   params: object,                       // 当前 HalationParams
 *   graph?: Array<object>,                // V1.6 graph
 *   format?: object,                      // V1.6 physical format
 *   onParamsChange: (partial:object)=>void, // 参数变更（partial 合并）
 *   onGraphChange?: (graph:Array<object>,changedType:string)=>void,
 *   onFormatChange?: (partial:object)=>void,
 *   onRandomizeGrain?: ()=>void,
 *   onPreviewModeChange?: (mode:'fit'|'actual',domain:string)=>void,
 *   onPreviewPan?: (delta:{x:number,y:number})=>void,
 *   onPreviewViewportChange?: (viewport:{width:number,height:number})=>void,
 *   applyMemoryMode?: 'auto'|'high'|'balanced',
 *   onApplyMemoryModeChange?: (mode:'auto'|'high'|'balanced')=>void,
 *   onApply: ()=>void,                    // 触发 Apply
 *   onRebind: ()=>void,                   // 显式把当前像素层重新绑定为 source
 *   locale?: 'en'|'zh-CN',
 *   onLanguageChange?: (locale:'en'|'zh-CN')=>void,
 *   initialDomain?: 'halation'|'defringe'|'bloom'|'resolution'|'grain',
 *   initialPreviewMode?: 'fit'|'actual',
 *   initialPreviewPixelRatio?: number,
 *   releaseInfo?: {name?:string,backend?:string},
 * }} handlers
 * @returns {HTMLElement}
 */
export function createPanel(handlers) {
  const {
    params,
    graph = [],
    format = { gauge: '35mm', iso: 250 },
    onParamsChange,
    onGraphChange = () => {},
    onFormatChange = () => {},
    onRandomizeGrain = () => {},
    onPreviewModeChange = () => {},
    onPreviewPan = () => {},
    onPreviewViewportChange = () => {},
    applyMemoryMode = 'auto',
    onApplyMemoryModeChange = () => {},
    onApply,
    onRebind,
    locale = 'en',
    onLanguageChange = () => {},
    initialDomain = 'halation',
    initialPreviewMode,
    initialPreviewPixelRatio,
    releaseInfo = {},
  } = handlers;
  const STRINGS = getStrings(locale);
  const localize = (value) => translateUiText(value, locale);
  const createSlider = (options) => createSliderControl({ ...options, label: localize(options.label) });
  const createSelect = (options) => createSelectControl({
    ...options,
    label: localize(options.label),
    options: options.options.map((option) => ({ ...option, label: localize(option.label) })),
  });
  const createEffectSwitch = (options) => {
    const label = localize(options.label);
    return createEffectSwitchControl({
      ...options,
      label,
      onLabel: STRINGS.toggleOn,
      offLabel: STRINGS.toggleOff,
      ariaLabel: STRINGS.enableEffectAria(label),
      title: STRINGS.enableEffectTitle(label),
    });
  };
  let currentParams = { ...params, redshift: [...params.redshift], sigmaRatio: [...params.sigmaRatio] };
  let currentGraph = graph.map((node) => ({ ...node, params: { ...node.params }, mask: node.mask ? { ...node.mask } : createLumaMask() }));
  let currentFormat = { ...format };
  const maskRangeVisibility = {};
  const maskNodeIds = Object.freeze({
    halation: 'halation-main',
    defringe: 'defringe-main',
    bloom: 'bloom-main',
    highlightProtection: 'highlight-protection-main',
    filmResolution: 'film-resolution-main',
    grain: 'grain-main',
  });
  const maskParamFactories = {
    halation: () => ({ ...currentParams, redshift: [...currentParams.redshift], sigmaRatio: [...currentParams.sigmaRatio] }),
    defringe: createDefringeParams,
    bloom: createBloomParams,
    highlightProtection: createHighlightProtectionParams,
    filmResolution: createFilmResolutionParams,
    grain: createGrainParams,
  };
  const set = (partial) => {
    const explicitProfile = Object.prototype.hasOwnProperty.call(partial, 'profile');
    const effective = explicitProfile ? partial : { ...partial, profile: 'custom' };
    currentParams = { ...currentParams, ...effective };
    currentGraph = replaceGraphNodeParams(currentGraph, 'halation', currentParams);
    if (!explicitProfile) setDropdownValue(document.getElementById('profile'), 'custom');
    onParamsChange(effective);
  };
  const updateMaskNode = (type, partial) => {
    const existing = currentGraph.find((node) => node.type === type);
    if (existing) {
      currentGraph = currentGraph.map((node) => node.type === type
        ? { ...node, mask: createLumaMask({ ...(node.mask ?? {}), ...partial }) }
        : node);
    } else {
      const createParams = maskParamFactories[type];
      if (!createParams) throw new Error(`No mask defaults for effect type: ${type}`);
      currentGraph = [...currentGraph, {
        id: maskNodeIds[type] ?? `${type}-main`,
        type,
        enabled: false,
        params: createParams(),
        mask: createLumaMask(partial),
      }];
    }
    onGraphChange(currentGraph, `${type}:mask`);
  };
  const appendMaskControls = (type, targetPanel, options = {}) => {
    const node = currentGraph.find((item) => item.type === type);
    const mask = node?.mask ?? createLumaMask();
    const group = document.createElement('div');
    group.classList.add('fhal-mask-section');
    const heading = document.createElement('sp-heading');
    heading.textContent = options.title ?? 'Effect area';
    heading.classList.add('fhal-section-heading');
    const help = document.createElement('sp-body');
    help.classList.add('fhal-mask-help');
    help.textContent = options.description ?? 'Limits where this effect is mixed, using the node input exposure.';
    const rangeRows = [
      createSlider({ id: `${type}MaskLowEV`, label: 'Lower bound (EV)', value: mask.lowEV, min: -16, max: 16, step: 0.1, onInput: (value) => updateMaskNode(type, { lowEV: value }) }),
      createSlider({ id: `${type}MaskHighEV`, label: 'Upper bound (EV)', value: mask.highEV, min: -16, max: 16, step: 0.1, onInput: (value) => updateMaskNode(type, { highEV: value }) }),
      createSlider({ id: `${type}MaskSoftnessEV`, label: 'Edge softness (EV)', value: mask.softnessEV, min: 0.1, max: 4, step: 0.1, onInput: (value) => updateMaskNode(type, { softnessEV: value }) }),
      createSelect({ id: `${type}MaskInvert`, label: 'Range', value: mask.invert ? 'true' : 'false', options: [{ value: 'false', label: 'Inside EV range' }, { value: 'true', label: 'Outside EV range' }], onChange: (value) => updateMaskNode(type, { invert: value === 'true' }) }),
    ];
    const syncRangeVisibility = (mode) => {
      for (const row of rangeRows) row.style.display = mode === 'luma' ? 'flex' : 'none';
    };
    maskRangeVisibility[type] = syncRangeVisibility;
    const modeRow = createSelect({
      id: `${type}MaskMode`,
      label: 'Apply to',
      value: mask.mode,
      options: [{ value: 'none', label: 'Entire image' }, { value: 'luma', label: 'Exposure range' }],
      onChange: (value) => {
        updateMaskNode(type, { mode: value });
        syncRangeVisibility(value);
      },
    });
    group.append(heading, help, modeRow, ...rangeRows);
    targetPanel.append(group);
    syncRangeVisibility(mask.mode);
  };
  const createAdvancedDisclosure = (id) => {
    const disclosure = document.createElement('div');
    disclosure.classList.add('fhal-advanced-disclosure');
    const toggle = document.createElement('sp-button');
    toggle.id = `${id}Toggle`;
    toggle.variant = 'secondary';
    toggle.textContent = STRINGS.advanced;
    toggle.setAttribute('aria-expanded', 'false');
    const body = document.createElement('div');
    body.id = `${id}Body`;
    body.classList.add('fhal-advanced-body');
    body.style.display = 'none';
    toggle.setAttribute('aria-controls', body.id);
    toggle.addEventListener('click', () => {
      const expanded = toggle.getAttribute('aria-expanded') !== 'true';
      toggle.setAttribute('aria-expanded', String(expanded));
      body.style.display = expanded ? 'flex' : 'none';
    });
    disclosure.append(toggle, body);
    return { element: disclosure, body };
  };

  const panel = document.createElement('div');
  // 全局紧凑样式 + 滚动条视觉；body 限高（滚动只发生在 panel 内）
  const style = document.createElement('style');
  style.textContent = `
    html, body { height: 100%; margin: 0; padding: 0; overflow: hidden; background: #1d1e20; }
    ::-webkit-scrollbar { width: 8px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: rgba(128, 128, 128, 0.45); border-radius: 4px; }
    ::-webkit-scrollbar-thumb:hover { background: rgba(128, 128, 128, 0.65); }
    sp-heading { margin: 0 0 2px 0; font-family: "Adobe Clean", "Segoe UI", sans-serif; }
    sp-label { font-size: 11px; line-height: 1.2; margin: 0; }
    sp-body { margin: 0; }
    .fhal-workspace { flex: 1; min-height: 0; display: flex; flex-direction: row; }
    .fhal-domain-nav {
      flex: 0 0 112px; min-width: 112px; display: flex; flex-direction: column; gap: 3px;
      padding: 10px 7px; box-sizing: border-box; overflow-y: auto; background: #17181a;
      border-right: 1px solid rgba(255,255,255,.09);
    }
    .fhal-nav-kicker {
      padding: 2px 7px 8px; color: rgba(255,255,255,.48); font: 600 9px/1.2 Consolas, monospace;
      letter-spacing: .14em; text-transform: uppercase;
    }
    .fhal-domain-button {
      position: relative; display: flex; align-items: center; width: 100%; min-height: 40px; padding: 7px 8px 7px 12px;
      border: 0; border-left: 2px solid transparent; border-radius: 2px; box-sizing: border-box;
      color: rgba(255,255,255,.68); background: transparent; text-align: left;
      font: 600 13px/1.2 "Adobe Clean", "Segoe UI", sans-serif; white-space: nowrap; overflow: hidden;
      text-overflow: ellipsis; cursor: pointer;
    }
    .fhal-domain-button:hover { color: #fff; background: rgba(255,255,255,.055); }
    .fhal-domain-button:focus { outline: 1px solid #55a9d8; outline-offset: -1px; }
    .fhal-domain-button[aria-pressed="true"] { color: #fff; background: rgba(255,255,255,.085); }
     .fhal-domain-button[data-domain="halation"][aria-pressed="true"] { border-left-color: #e77f42; }
     .fhal-domain-button[data-domain="defringe"][aria-pressed="true"] { border-left-color: #d9b95d; }
     .fhal-domain-button[data-domain="bloom"][aria-pressed="true"] { border-left-color: #e2a6ee; }
    .fhal-domain-button[data-domain="resolution"][aria-pressed="true"] { border-left-color: #55a9d8; }
    .fhal-domain-button[data-domain="grain"][aria-pressed="true"] { border-left-color: #b7b1a5; }
    .fhal-advanced-disclosure { display: flex; flex-direction: column; gap: 7px; padding-top: 2px; }
    .fhal-advanced-disclosure > sp-button { align-self: stretch; }
    .fhal-advanced-body { flex-direction: column; gap: 8px; }
    .fhal-mask-section { display: flex; flex-direction: column; gap: 6px; padding-top: 2px; }
    .fhal-mask-help { color: rgba(255,255,255,.54); font-size: 11px; line-height: 1.35; }
    .fhal-controls {
      flex: 0 0 340px; min-width: 280px; max-width: 380px; overflow-y: auto;
      padding: 12px; box-sizing: border-box; background: #242528; border-right: 1px solid rgba(128,128,128,.28);
    }
    .fhal-controls > * { flex-shrink: 0; }
    .fhal-domain-panel { display: none; flex-direction: column; gap: 8px; }
    .fhal-domain-panel[data-active="true"] { display: flex; }
    .fhal-section-heading { padding-bottom: 6px; border-bottom: 1px solid rgba(255,255,255,.09); }
    .fhal-effect-heading {
      display: flex; align-items: center; justify-content: space-between; gap: 8px;
      min-height: 27px; padding-bottom: 6px; border-bottom: 1px solid rgba(255,255,255,.09);
    }
    .fhal-effect-heading sp-heading { flex: 1 1 auto; min-width: 0; padding-bottom: 0; border-bottom: 0; }
    .fhal-effect-toggle {
      display: inline-flex; align-items: center; gap: 6px; flex: 0 0 auto;
      min-width: 56px; height: 24px; padding: 2px 6px 2px 3px; border: 1px solid rgba(255,255,255,.20);
      border-radius: 12px; color: rgba(255,255,255,.60); background: #17181a; cursor: pointer;
      box-sizing: border-box; font: 600 10px/1 "Adobe Clean", "Segoe UI", sans-serif;
    }
    .fhal-effect-toggle:hover { border-color: rgba(255,255,255,.42); color: #fff; }
    .fhal-effect-toggle:focus { outline: 1px solid #55a9d8; outline-offset: 1px; }
    .fhal-toggle-track {
      position: relative; display: inline-block; flex: 0 0 17px; width: 17px; height: 17px;
      border-radius: 50%; background: #5b5d62; box-shadow: inset 0 0 0 1px rgba(0,0,0,.42);
    }
    .fhal-toggle-thumb { position: absolute; left: 2px; top: 2px; width: 13px; height: 13px; border-radius: 50%; background: #babcc0; }
    .fhal-toggle-state { min-width: 20px; text-align: center; }
    .fhal-effect-toggle[data-enabled="true"] { border-color: rgba(85,169,216,.72); color: #fff; background: #202a30; }
    .fhal-effect-toggle[data-enabled="true"] .fhal-toggle-track { background: #55a9d8; }
    .fhal-effect-toggle[data-enabled="true"] .fhal-toggle-thumb { left: 7px; background: #fff; }
    .fhal-physical-group { display: none; flex-direction: column; gap: 6px; margin-bottom: 4px; padding-bottom: 10px; border-bottom: 1px solid rgba(255,255,255,.09); }
    .fhal-physical-group[data-visible="true"] { display: flex; }
    .fhal-preview-stage {
      flex: 1 1 auto; min-width: 300px; min-height: 0; display: flex; flex-direction: column;
      padding: 12px; box-sizing: border-box; overflow: hidden; background: #1d1e20;
    }
    .fhal-preview-toolbar {
      flex: 0 0 auto; min-height: 31px; display: flex; align-items: center; justify-content: space-between;
      gap: 10px; margin-bottom: 7px;
    }
    .fhal-preview-title {
      color: rgba(255,255,255,.62); font: 600 10px/1.2 Consolas, monospace;
      letter-spacing: .10em; text-transform: uppercase; white-space: nowrap;
    }
    .fhal-preview-modes {
      display: inline-flex; align-items: center; padding: 2px; border-radius: 4px;
      background: #151619; border: 1px solid rgba(255,255,255,.12);
    }
    .fhal-preview-mode {
      min-width: 48px; height: 25px; padding: 0 10px; border: 0; border-radius: 3px;
      color: rgba(255,255,255,.60); background: transparent; cursor: pointer;
      font: 600 11px/1 "Adobe Clean", "Segoe UI", sans-serif;
    }
    .fhal-preview-mode:hover { color: #fff; background: rgba(255,255,255,.06); }
    .fhal-preview-mode:focus { outline: 1px solid #55a9d8; outline-offset: -1px; }
    .fhal-preview-mode[aria-pressed="true"] { color: #fff; background: #3a3c40; box-shadow: 0 1px 2px rgba(0,0,0,.35); }
    .fhal-preview-frame {
      position: relative; flex: 1; min-height: 220px; min-width: 0; display: flex; flex-direction: row;
      align-items: stretch; justify-content: stretch;
      overflow: hidden; background: #101113; border: 1px solid rgba(255,255,255,.10);
      box-shadow: inset 0 0 0 1px rgba(0,0,0,.42), 0 8px 28px rgba(0,0,0,.18);
    }
    .fhal-preview-frame[data-mode="actual"] { cursor: grab; }
    .fhal-preview-frame[data-dragging="true"] { cursor: grabbing; }
    .fhal-compare-pane {
      position: relative; flex: 1 1 100%; width: 100%; max-width: 100%; min-width: 0; min-height: 0;
      align-self: stretch;
      display: flex; align-items: center; justify-content: center; box-sizing: border-box;
      overflow: hidden; background-color: #0f1012;
      background-image: linear-gradient(45deg, #17181a 25%, transparent 25%), linear-gradient(-45deg, #17181a 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #17181a 75%), linear-gradient(-45deg, transparent 75%, #17181a 75%);
      background-size: 16px 16px; background-position: 0 0, 0 8px, 8px -8px, -8px 0;
    }
    .fhal-preview-frame[data-mode="actual"] .fhal-compare-pane + .fhal-compare-pane { border-left: 1px solid rgba(110,176,214,.62); }
    .fhal-compare-source { display: none; }
    .fhal-preview-frame[data-mode="actual"] .fhal-compare-pane {
      flex: 0 0 50%; width: 50%; max-width: 50%;
    }
    .fhal-preview-frame[data-mode="actual"] .fhal-compare-source { display: flex; }
    .fhal-preview-frame[data-mode="fit"],
    .fhal-preview-frame[data-mode="fit"] .fhal-compare-preview {
      background-color: #000; background-image: none;
    }
    .fhal-compare-image { display: block; flex: 0 0 auto; user-select: none; pointer-events: none; transform: translate(0,0); }
    .fhal-compare-preview[data-loading="true"] .fhal-compare-image { image-rendering: auto; }
    .fhal-preview-frame[data-mode="fit"] .fhal-compare-preview .fhal-compare-image { width: 100%; height: 100%; object-fit: contain; }
    .fhal-preview-frame[data-mode="actual"] .fhal-compare-image { width: auto; height: auto; max-width: none; max-height: none; object-fit: fill; }
    .fhal-compare-label {
      position: absolute; z-index: 2; left: 9px; bottom: 8px; padding: 3px 6px; border-radius: 2px;
      color: rgba(255,255,255,.82); background: rgba(12,13,15,.70); pointer-events: none;
      font: 600 9px/1 Consolas, monospace; letter-spacing: .12em;
    }
    .fhal-preview-frame[data-mode="fit"] .fhal-compare-label { display: none; }
    .fhal-preview-loading {
      position: absolute; z-index: 4; inset: 0; display: flex; flex-direction: column;
      align-items: center; justify-content: center; gap: 9px; pointer-events: none;
      color: rgba(255,255,255,.82); background: rgba(8,9,11,.16);
    }
    .fhal-preview-loading[hidden] { display: none; }
    .fhal-render-ring {
      width: 29px; height: 29px; box-sizing: border-box; border-radius: 50%;
      border: 3px solid rgba(255,255,255,.16); border-top-color: #55a9d8; border-right-color: #e77f42;
      box-shadow: 0 0 0 1px rgba(0,0,0,.28), inset 0 0 0 5px rgba(10,11,13,.34);
      contain: layout paint; backface-visibility: hidden; will-change: transform;
      transform: translateZ(0) rotate(0deg);
      animation: fhal-render-spin .72s linear infinite !important;
    }
    .fhal-preview-loading-text {
      padding: 3px 6px; border-radius: 2px; color: rgba(255,255,255,.82); background: rgba(12,13,15,.62);
      font: 600 9px/1 Consolas, monospace; letter-spacing: .13em; text-transform: uppercase;
    }
    @keyframes fhal-render-spin {
      from { transform: translateZ(0) rotate(0deg); }
      to { transform: translateZ(0) rotate(360deg); }
    }
    @media (prefers-reduced-motion: reduce) { .fhal-render-ring { animation: none; } }
    .fhal-pan-hint {
      display: none; position: absolute; z-index: 3; top: 9px; left: 50%; transform: translateX(-50%);
      padding: 4px 7px; border-radius: 3px; color: rgba(255,255,255,.68); background: rgba(12,13,15,.72);
      font: 9px/1.2 "Adobe Clean", "Segoe UI", sans-serif; pointer-events: none;
    }
    .fhal-preview-frame[data-mode="actual"]:hover .fhal-pan-hint { display: block; }
    .fhal-footer-settings {
      padding: 4px 6px; box-sizing: border-box; border: 1px solid rgba(255,255,255,.10);
      border-radius: 4px; background: #17181a;
    }
    .fhal-footer-setting {
      min-height: 27px; padding: 2px 4px; box-sizing: border-box;
      border: 1px solid rgba(255,255,255,.08); border-radius: 3px; background: rgba(255,255,255,.025);
    }
    @media (max-width: 760px) {
      .fhal-workspace { flex-direction: column; }
      .fhal-domain-nav {
        flex: 0 0 auto; min-width: 0; flex-direction: row; overflow-x: auto; overflow-y: hidden;
        padding: 6px; border-right: 0; border-bottom: 1px solid rgba(255,255,255,.09);
      }
      .fhal-nav-kicker { display: none; }
      .fhal-domain-button { min-width: 94px; min-height: 36px; border-left: 0; border-bottom: 2px solid transparent; }
       .fhal-domain-button[data-domain="halation"][aria-pressed="true"] { border-bottom-color: #e77f42; }
       .fhal-domain-button[data-domain="defringe"][aria-pressed="true"] { border-bottom-color: #d9b95d; }
       .fhal-domain-button[data-domain="bloom"][aria-pressed="true"] { border-bottom-color: #e2a6ee; }
      .fhal-domain-button[data-domain="resolution"][aria-pressed="true"] { border-bottom-color: #55a9d8; }
      .fhal-domain-button[data-domain="grain"][aria-pressed="true"] { border-bottom-color: #b7b1a5; }
      .fhal-controls {
        flex: 1 1 52%; width: 100%; min-width: 0; max-width: none;
        border-right: 0; border-bottom: 1px solid rgba(128,128,128,.28);
      }
      .fhal-preview-stage { flex: 1 1 48%; min-width: 0; min-height: 220px; }
      .fhal-preview-title { display: none; }
    }
    sp-heading, sp-label, sp-slider, sp-dropdown, sp-button, sp-body { flex-shrink: 0; }
  `;
  panel.append(style);

  // UXP 无 sp-panel 组件（退化为 div）——用普通 div 容器 + 基础样式。
  // 关键：absolute + inset 铺满视口（不依赖父级高度），内容超出时 panel 自身滚动。
  panel.style.position = 'absolute';
  panel.style.top = '0';
  panel.style.left = '0';
  panel.style.right = '0';
  panel.style.bottom = '0';
  panel.style.display = 'flex';
  panel.style.flexDirection = 'column';
  panel.style.boxSizing = 'border-box';

  // 领域导航、当前参数和预览是三个独立区域；窄面板下导航转为横向。
  const workspace = document.createElement('div');
  workspace.classList.add('fhal-workspace');
  const domainNav = document.createElement('div');
  domainNav.classList.add('fhal-domain-nav');
  domainNav.setAttribute('aria-label', 'Film effect domains');
  domainNav.setAttribute('role', 'tablist');
  const navKicker = document.createElement('div');
  navKicker.classList.add('fhal-nav-kicker');
  navKicker.textContent = 'Effects';
  domainNav.append(navKicker);
  const scrollArea = document.createElement('div');
  scrollArea.style.display = 'flex';
  scrollArea.style.flexDirection = 'column';
  scrollArea.style.gap = '8px';
  scrollArea.classList.add('fhal-controls');

  const halationPanel = document.createElement('div');
  halationPanel.classList.add('fhal-domain-panel');
  halationPanel.setAttribute('data-domain', 'halation');
  halationPanel.id = 'film-domain-halation';
  halationPanel.setAttribute('role', 'tabpanel');
  const defringePanel = document.createElement('div');
  defringePanel.classList.add('fhal-domain-panel');
  defringePanel.setAttribute('data-domain', 'defringe');
  defringePanel.id = 'film-domain-defringe';
  defringePanel.setAttribute('role', 'tabpanel');
  const bloomPanel = document.createElement('div');
  bloomPanel.classList.add('fhal-domain-panel');
  bloomPanel.setAttribute('data-domain', 'bloom');
  bloomPanel.id = 'film-domain-bloom';
  bloomPanel.setAttribute('role', 'tabpanel');
  const resolutionPanel = document.createElement('div');
  resolutionPanel.classList.add('fhal-domain-panel');
  resolutionPanel.setAttribute('data-domain', 'resolution');
  resolutionPanel.id = 'film-domain-resolution';
  resolutionPanel.setAttribute('role', 'tabpanel');
  const grainPanel = document.createElement('div');
  grainPanel.classList.add('fhal-domain-panel');
  grainPanel.setAttribute('data-domain', 'grain');
  grainPanel.id = 'film-domain-grain';
  grainPanel.setAttribute('role', 'tabpanel');
  const physicalGroup = document.createElement('div');
  physicalGroup.classList.add('fhal-physical-group');
  const domainPanels = { halation: halationPanel, defringe: defringePanel, bloom: bloomPanel, resolution: resolutionPanel, grain: grainPanel };
  const domainButtons = {};
  const graphToggles = {};
  const previewModesByDomain = { halation: 'fit', defringe: 'actual', bloom: 'fit', resolution: 'actual', grain: 'actual' };
  const initialPanelDomain = Object.prototype.hasOwnProperty.call(domainPanels, initialDomain) ? initialDomain : 'halation';
  if (initialPreviewMode === 'fit' || initialPreviewMode === 'actual') {
    previewModesByDomain[initialPanelDomain] = initialPreviewMode;
  }
  let activeDomain = initialPanelDomain;
  let previewDomainSync = () => {};
  const addDomainButton = (domain, label) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.classList.add('fhal-domain-button');
    button.setAttribute('data-domain', domain);
    button.setAttribute('aria-pressed', 'false');
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-controls', `film-domain-${domain}`);
    button.setAttribute('aria-label', label);
    button.title = label;
    button.textContent = label;
    button.addEventListener('click', () => showDomain(domain));
    domainButtons[domain] = button;
    domainNav.append(button);
  };
  const showDomain = (domain) => {
    activeDomain = domain;
    for (const [name, section] of Object.entries(domainPanels)) {
      section.setAttribute('data-active', String(name === domain));
      section.setAttribute('aria-hidden', String(name !== domain));
    }
    for (const [name, button] of Object.entries(domainButtons)) {
      button.setAttribute('aria-pressed', String(name === domain));
      button.setAttribute('aria-selected', String(name === domain));
    }
    physicalGroup.setAttribute('data-visible', String(domain === 'resolution' || domain === 'grain'));
    previewDomainSync(domain, previewModesByDomain[domain] ?? defaultPreviewModeForDomain(domain));
  };
  addDomainButton('halation', 'Halation');
  addDomainButton('defringe', 'Defringe');
  addDomainButton('bloom', 'Bloom');
  addDomainButton('resolution', 'Resolution');
  addDomainButton('grain', 'Grain');
  showDomain(initialPanelDomain);

  // ---- Basic ----
  const basicGroup = document.createElement('div');
  basicGroup.style.display = 'flex';
  basicGroup.style.flexDirection = 'column';
  basicGroup.style.gap = '6px';
  const basicHeading = document.createElement('sp-heading');
  basicHeading.textContent = STRINGS.basic;
  basicHeading.classList.add('fhal-section-heading');
  basicGroup.append(basicHeading);
  basicGroup.append(
    createSelect({
      id: 'profile',
      label: STRINGS.preset,
      value: params.profile,
      options: [
        { value: 'tungsten-800', label: HALATION_PRESET_LABELS['tungsten-800'] },
        { value: 'standard', label: HALATION_PRESET_LABELS.standard },
        { value: 'custom', label: HALATION_PRESET_LABELS.custom },
      ],
      onChange: (value) => {
        if (value === 'custom') {
          set({ profile: 'custom' });
          return;
        }
        const next = createHalationPreset(value);
        currentParams = { ...next, redshift: [...next.redshift], sigmaRatio: [...next.sigmaRatio] };
        currentGraph = replaceGraphNodeParams(currentGraph, 'halation', currentParams);
        panel.__handles?.updateParams(next);
        onParamsChange(next);
      },
    }),
    createSlider({
      id: 'strength',
      label: STRINGS.strength,
      value: params.strength,
      min: 0,
      max: 100,
      step: 1,
      onInput: (v) => set({ strength: v }),
    }),
    createSlider({ id: 'sigma', label: STRINGS.sigma, value: params.sigma, min: params.sigmaUnits === 'diagonal' ? 0.1 : 0.5, max: params.sigmaUnits === 'diagonal' ? 10 : 50, step: params.sigmaUnits === 'diagonal' ? 0.1 : 0.5, curve: 'fine-min', curveExponent: 2.2, fineStepScale: 0.1, onInput: (v) => set({ sigma: v }) }),
    createSlider({ id: 'threshold', label: STRINGS.threshold, value: params.threshold, min: params.thresholdUnits === 'stops' ? -4 : 0, max: params.thresholdUnits === 'stops' ? 4 : 1, step: params.thresholdUnits === 'stops' ? 0.1 : 0.01, curve: 'fine-max', curveExponent: 2.2, fineStepScale: 0.01, onInput: (v) => set({ threshold: v }) }),
  );

  {
    const resolution = currentGraph.find((node) => node.type === 'filmResolution')?.params ?? createFilmResolutionParams();
    const grain = currentGraph.find((node) => node.type === 'grain')?.params ?? createGrainParams();
    const defringe = currentGraph.find((node) => node.type === 'defringe')?.params ?? createDefringeParams();
    const bloom = currentGraph.find((node) => node.type === 'bloom')?.params ?? createBloomParams();
    const highlightProtection = currentGraph.find((node) => node.type === 'highlightProtection')?.params ?? createHighlightProtectionParams();
    const validators = {
      defringe: createDefringeParams,
      bloom: createBloomParams,
      highlightProtection: createHighlightProtectionParams,
      filmResolution: createFilmResolutionParams,
      grain: createGrainParams,
    };
    let bloomWarning = null;
    const refreshBloomWarning = () => {
      if (!bloomWarning) return;
      const bloomEnabled = currentGraph.find((node) => node.type === 'bloom')?.enabled === true;
      const hpEnabled = currentGraph.find((node) => node.type === 'highlightProtection')?.enabled === true;
      bloomWarning.textContent = localize(hpEnabled && !bloomEnabled
        ? 'Highlight Protection has no Bloom contribution. Enable Bloom to activate it.'
        : 'Highlight Protection uses the nearest Bloom contribution.');
    };
    const updateNode = (type, partial = {}, enabled) => {
      const existing = currentGraph.find((node) => node.type === type);
      const nextEnabled = enabled === undefined ? (existing?.enabled ?? false) : enabled === true;
      const validate = validators[type] ?? (() => ({ ...(existing?.params ?? {}), ...partial }));
      const params = validate({ ...(existing?.params ?? {}), ...partial });
      currentGraph = currentGraph.map((node) => node.type === type
        ? { ...node, enabled: nextEnabled, params }
        : node);
      if (!existing) currentGraph.push({
        id: ({
          defringe: 'defringe-main',
          bloom: 'bloom-main',
          highlightProtection: 'highlight-protection-main',
          filmResolution: 'film-resolution-main',
          grain: 'grain-main',
        })[type] ?? `${type}-main`,
        type,
        enabled: nextEnabled,
         params,
         mask: createLumaMask(),
       });
      onGraphChange(currentGraph, type);
      refreshBloomWarning();
    };
    const defringeNode = currentGraph.find((node) => node.type === 'defringe');
    const defringeHeading = document.createElement('sp-heading');
    defringeHeading.textContent = 'Defringe';
    const defringeSwitch = createEffectSwitch({ id: 'defringeEnabled', label: 'Defringe', enabled: defringeNode?.enabled === true, onChange: (enabled) => updateNode('defringe', {}, enabled) });
    graphToggles.defringe = defringeSwitch;
    const defringeHeadingRow = document.createElement('div');
    defringeHeadingRow.classList.add('fhal-effect-heading');
    defringeHeadingRow.append(defringeHeading, defringeSwitch.element);
    defringePanel.append(defringeHeadingRow,
      createSlider({ id: 'defringeAmount', label: 'Amount', value: defringe.amount, min: 0, max: 1, step: 0.01, onInput: (value) => updateNode('defringe', { amount: value }) }),
      createSlider({ id: 'defringeRadiusPx', label: 'Radius (px)', value: defringe.radiusPx, min: 0.5, max: 4, step: 0.1, onInput: (value) => updateNode('defringe', { radiusPx: value }) }),
      createSlider({ id: 'defringeThreshold', label: 'Chroma threshold', value: defringe.threshold, min: 0, max: 1, step: 0.01, onInput: (value) => updateNode('defringe', { threshold: value }) }),
      createSlider({ id: 'defringeSoftness', label: 'Chroma softness', value: defringe.softness, min: 0.01, max: 0.5, step: 0.01, onInput: (value) => updateNode('defringe', { softness: value }) }),
      createSlider({ id: 'defringeEdgeSensitivity', label: 'Edge sensitivity', value: defringe.edgeSensitivity, min: 0, max: 2, step: 0.01, onInput: (value) => updateNode('defringe', { edgeSensitivity: value }) }),
    );
    const defringeAdvanced = createAdvancedDisclosure('defringeAdvanced');
    appendMaskControls('defringe', defringeAdvanced.body, {
      title: 'Effect area',
      description: 'Limits where Defringe correction is mixed, using the input exposure.',
    });
    defringePanel.append(defringeAdvanced.element);

    const bloomNode = currentGraph.find((node) => node.type === 'bloom');
    const hpNode = currentGraph.find((node) => node.type === 'highlightProtection');
    const bloomHeading = document.createElement('sp-heading');
    bloomHeading.textContent = 'Bloom';
    const bloomSwitch = createEffectSwitch({ id: 'bloomEnabled', label: 'Bloom', enabled: bloomNode?.enabled === true, onChange: (enabled) => updateNode('bloom', {}, enabled) });
    graphToggles.bloom = bloomSwitch;
    const bloomHeadingRow = document.createElement('div');
    bloomHeadingRow.classList.add('fhal-effect-heading');
    bloomHeadingRow.append(bloomHeading, bloomSwitch.element);
    bloomWarning = document.createElement('sp-body');
    bloomWarning.id = 'highlight-protection-warning';
    bloomWarning.textContent = localize('Highlight Protection uses the nearest Bloom contribution.');
    bloomWarning.style.opacity = '0.62';
    bloomPanel.append(bloomHeadingRow,
      createSlider({ id: 'bloomThresholdEV', label: 'Threshold (EV)', value: bloom.thresholdEV, min: -2, max: 8, step: 0.1, onInput: (value) => updateNode('bloom', { thresholdEV: value }) }),
      createSlider({ id: 'bloomSoftnessEV', label: 'Softness (EV)', value: bloom.softnessEV, min: 0.1, max: 4, step: 0.1, onInput: (value) => updateNode('bloom', { softnessEV: value }) }),
      createSlider({ id: 'bloomRadius', label: 'Radius (% diagonal)', value: bloom.radius, min: 0.05, max: 5, step: 0.05, onInput: (value) => updateNode('bloom', { radius: value }) }),
      createSlider({ id: 'bloomAmplify', label: 'Amplify', value: bloom.amplify, min: 0, max: 4, step: 0.01, onInput: (value) => updateNode('bloom', { amplify: value }) }),
      createSlider({ id: 'bloomSaturation', label: 'Saturation', value: bloom.saturation, min: 0, max: 1.5, step: 0.01, onInput: (value) => updateNode('bloom', { saturation: value }) }),
      createSlider({ id: 'bloomSaveLights', label: 'Save lights', value: bloom.saveLights, min: 0, max: 1, step: 0.01, onInput: (value) => updateNode('bloom', { saveLights: value }) }),
    );
    const hpHeading = document.createElement('sp-heading');
    hpHeading.textContent = 'Highlight Protection';
    const hpSwitch = createEffectSwitch({ id: 'highlightProtectionEnabled', label: 'Highlight Protection', enabled: hpNode?.enabled === true, onChange: (enabled) => updateNode('highlightProtection', {}, enabled) });
    graphToggles.highlightProtection = hpSwitch;
    const hpHeadingRow = document.createElement('div');
    hpHeadingRow.classList.add('fhal-effect-heading');
    hpHeadingRow.append(hpHeading, hpSwitch.element);
    bloomPanel.append(hpHeadingRow,
      createSlider({ id: 'highlightProtectionAmount', label: 'Amount', value: highlightProtection.amount, min: 0, max: 1, step: 0.01, onInput: (value) => updateNode('highlightProtection', { amount: value }) }),
      createSlider({ id: 'highlightProtectionThresholdEV', label: 'Threshold (EV)', value: highlightProtection.thresholdEV, min: 0, max: 8, step: 0.1, onInput: (value) => updateNode('highlightProtection', { thresholdEV: value }) }),
      createSlider({ id: 'highlightProtectionSoftnessEV', label: 'Softness (EV)', value: highlightProtection.softnessEV, min: 0.1, max: 4, step: 0.1, onInput: (value) => updateNode('highlightProtection', { softnessEV: value }) }),
      bloomWarning,
    );
    refreshBloomWarning();
    const bloomAdvanced = createAdvancedDisclosure('bloomAdvanced');
    appendMaskControls('bloom', bloomAdvanced.body, {
      title: 'Bloom output area',
      description: 'Limits where diffused Bloom is added. Highlight source extraction is unchanged.',
    });
    appendMaskControls('highlightProtection', bloomAdvanced.body, {
      title: 'Protection area',
      description: 'Limits where Highlight Protection modifies the nearest Bloom contribution.',
    });
    bloomPanel.append(bloomAdvanced.element);
    const setNode = (type, partial) => updateNode(type, partial);
    const setNodeEnabled = (type, enabled) => updateNode(type, {}, enabled);

    const physicalHeading = document.createElement('sp-heading');
    physicalHeading.textContent = 'Film stock';
    physicalHeading.classList.add('fhal-section-heading');
    physicalGroup.append(physicalHeading, createSelect({
      id: 'filmGauge', label: 'Film format', value: currentFormat.gauge,
      options: [
        { value: '8mm', label: 'Super 8' },
        { value: '16mm', label: 'Super 16' },
        { value: '35mm', label: 'Super 35 4-perf' },
        { value: '65mm', label: '65mm 5-perf' },
      ],
      onChange: (value) => { currentFormat = { ...currentFormat, gauge: value }; onFormatChange({ gauge: value }); },
    }), createSlider({ id: 'filmIso', label: 'ISO', value: currentFormat.iso, min: 25, max: 3200, step: 1, onInput: (value) => { currentFormat = { ...currentFormat, iso: value }; onFormatChange({ iso: value }); } }));

    const resolutionNode = currentGraph.find((node) => node.type === 'filmResolution');
    const resolutionHeading = document.createElement('sp-heading');
    resolutionHeading.textContent = 'Film Resolution';
    const resolutionSwitch = createEffectSwitch({
      id: 'filmResolutionEnabled', label: 'Film Resolution', enabled: resolutionNode?.enabled === true,
      onChange: (enabled) => setNodeEnabled('filmResolution', enabled),
    });
    graphToggles.filmResolution = resolutionSwitch;
    const resolutionHeadingRow = document.createElement('div');
    resolutionHeadingRow.classList.add('fhal-effect-heading');
    resolutionHeadingRow.append(resolutionHeading, resolutionSwitch.element);
    resolutionPanel.append(
      resolutionHeadingRow,
      createSelect({
        id: 'filmResolutionProfile', label: 'Material', value: resolution.profile,
        options: [{ value: 'negative', label: 'Negative' }, { value: 'positive', label: 'Positive / print' }],
        onChange: (value) => setNode('filmResolution', { profile: value }),
      }),
      createSlider({ id: 'filmResolutionAmount', label: 'Resolution loss', value: resolution.amount, min: 0, max: 1.5, step: 0.01, onInput: (value) => setNode('filmResolution', { amount: value }) }),
      createSlider({ id: 'filmResolutionResponse', label: 'MTF response', value: resolution.response, min: 0.5, max: 2, step: 0.01, onInput: (value) => setNode('filmResolution', { response: value }) }),
      createSlider({ id: 'filmResolutionToeLoss', label: 'Shadow loss', value: resolution.toeLoss, min: 0, max: 1, step: 0.01, onInput: (value) => setNode('filmResolution', { toeLoss: value }) }),
      createSlider({ id: 'filmResolutionShoulderLoss', label: 'Highlight loss', value: resolution.shoulderLoss, min: 0, max: 1, step: 0.01, onInput: (value) => setNode('filmResolution', { shoulderLoss: value }) }),
    );
    const resolutionAdvanced = createAdvancedDisclosure('resolutionAdvanced');
    appendMaskControls('filmResolution', resolutionAdvanced.body, {
      title: 'Effect area',
      description: 'Limits where the Film Resolution result is mixed, using the input exposure.',
    });
    resolutionPanel.append(resolutionAdvanced.element);

    const grainNode = currentGraph.find((node) => node.type === 'grain');
    const grainHeading = document.createElement('sp-heading');
    grainHeading.textContent = 'Film Grain';
    const grainSwitch = createEffectSwitch({
      id: 'grainEnabled', label: 'Film Grain', enabled: grainNode?.enabled === true,
      onChange: (enabled) => setNodeEnabled('grain', enabled),
    });
    graphToggles.grain = grainSwitch;
    const grainHeadingRow = document.createElement('div');
    grainHeadingRow.classList.add('fhal-effect-heading');
    grainHeadingRow.append(grainHeading, grainSwitch.element);
    grainPanel.append(
      grainHeadingRow,
      createSelect({
        id: 'grainProfile', label: 'Material', value: grain.profile,
        options: [{ value: 'negative', label: 'Negative' }, { value: 'positive', label: 'Positive / print' }],
        onChange: (value) => setNode('grain', { profile: value }),
      }),
      createSelect({
        id: 'grainMode', label: 'Correlation', value: grain.mode,
        options: [{ value: 'analogue', label: 'Analogue' }, { value: 'fast', label: 'Fast' }],
        onChange: (value) => setNode('grain', { mode: value }),
      }),
      createSlider({ id: 'grainAmount', label: 'Amount', value: grain.amount, min: 0, max: 2, step: 0.01, onInput: (value) => setNode('grain', { amount: value }) }),
      createSlider({ id: 'grainSize', label: 'Size', value: grain.size, min: 0.5, max: 2, step: 0.01, onInput: (value) => setNode('grain', { size: value }) }),
      createSlider({ id: 'grainRoughness', label: 'Roughness', value: grain.roughness, min: 0, max: 1, step: 0.01, onInput: (value) => setNode('grain', { roughness: value }) }),
      createSlider({ id: 'grainChroma', label: 'Chroma', value: grain.chroma, min: 0, max: 1, step: 0.01, onInput: (value) => setNode('grain', { chroma: value }) }),
    );
    const randomize = document.createElement('sp-button');
    randomize.variant = 'secondary';
    randomize.textContent = 'Randomize grain';
    randomize.addEventListener('click', onRandomizeGrain);
    grainPanel.append(randomize);
    const grainAdvanced = createAdvancedDisclosure('grainAdvanced');
    appendMaskControls('grain', grainAdvanced.body, {
      title: 'Effect area',
      description: 'Limits where the Film Grain result is mixed, using the input exposure.',
    });
    grainPanel.append(grainAdvanced.element);
  }

  // ---- Advanced（折叠）----
  const halationAdvanced = createAdvancedDisclosure('halationAdvanced');
  const advBody = halationAdvanced.body;
  const advGroup = document.createElement('div');
  advGroup.style.display = 'flex';
  advGroup.style.flexDirection = 'column';
  advGroup.style.gap = '6px';
  advGroup.append(
    createSlider({ id: 'redLayerThresholdBias', label: STRINGS.redLayerThresholdBias, value: params.redLayerThresholdBias, min: 0, max: 1, step: 0.01, onInput: (v) => set({ redLayerThresholdBias: v }) }),
    createSlider({ id: 'sourceSoftness', label: STRINGS.sourceSoftness, value: params.sourceSoftness, min: 0, max: 1, step: 0.01, onInput: (v) => set({ sourceSoftness: v, thresholdSoftness: v }) }),
    createSlider({ id: 'backgroundSoftness', label: STRINGS.backgroundSoftness, value: params.backgroundSoftness, min: 0, max: 1, step: 0.01, onInput: (v) => set({ backgroundSoftness: v }) }),
    createSlider({ id: 'smoothness', label: STRINGS.smoothness, value: params.smoothness, min: 0, max: 1, step: 0.01, onInput: (v) => set({ smoothness: v }) }),
    createSlider({ id: 'backgroundThreshold', label: STRINGS.backgroundThreshold, value: params.backgroundThreshold, min: params.thresholdUnits === 'stops' ? -4 : 0, max: params.thresholdUnits === 'stops' ? 4 : 1, step: params.thresholdUnits === 'stops' ? 0.1 : 0.01, onInput: (v) => set({ backgroundThreshold: v }) }),
    createSlider({ id: 'sourceImpact', label: STRINGS.sourceImpact, value: params.sourceImpact, min: 0, max: 1, step: 0.01, onInput: (v) => set({ sourceImpact: v }) }),
    createSlider({ id: 'amplify', label: STRINGS.amplify, value: params.amplify, min: 0, max: 4, step: 0.05, onInput: (v) => set({ amplify: v }) }),
    createSlider({ id: 'sourceExpansion', label: STRINGS.sourceExpansion, value: params.sourceExpansion, min: 0, max: 1, step: 0.01, onInput: (v) => set({ sourceExpansion: v }) }),
    createSlider({ id: 'redTail', label: STRINGS.redTail, value: params.redTail, min: 0, max: 1, step: 0.01, onInput: (v) => set({ redTail: v }) }),
    createSlider({ id: 'blueCompensation', label: STRINGS.blueCompensation, value: params.blueCompensation, min: 0, max: 1, step: 0.01, onInput: (v) => set({ blueCompensation: v }) }),
    createSlider({ id: 'colorDensity', label: STRINGS.colorDensity, value: params.colorDensity, min: 0, max: 1, step: 0.01, onInput: (v) => set({ colorDensity: v }) }),
    createSlider({ id: 'sourceInteriorProtection', label: STRINGS.sourceInteriorProtection, value: params.sourceInteriorProtection, min: 0, max: 1, step: 0.01, onInput: (v) => set({ sourceInteriorProtection: v }) }),
    createSlider({ id: 'hotSourceThreshold', label: STRINGS.hotSourceThreshold, value: params.hotSourceThreshold, min: 0, max: 4, step: 0.05, onInput: (v) => set({ hotSourceThreshold: v }) }),
    createSlider({ id: 'hotCoreStrength', label: STRINGS.hotCoreStrength, value: params.hotCoreStrength, min: 0, max: 1, step: 0.01, onInput: (v) => set({ hotCoreStrength: v }) }),
    createSlider({ id: 'globalSourceThreshold', label: STRINGS.globalSourceThreshold, value: params.globalSourceThreshold, min: 0, max: 4, step: 0.05, onInput: (v) => set({ globalSourceThreshold: v }) }),
    createSlider({ id: 'spectralSensitivity', label: STRINGS.spectralSensitivity, value: params.spectralSensitivity, min: 0, max: 1, step: 0.01, onInput: (v) => set({ spectralSensitivity: v }) }),
    createSlider({ id: 'redshiftR', label: STRINGS.redshiftR, value: params.redshift[0], min: 0, max: 2, step: 0.01, onInput: (v) => set({ redshift: [v, currentParams.redshift[1], currentParams.redshift[2]] }) }),
    createSlider({ id: 'redshiftG', label: STRINGS.redshiftG, value: params.redshift[1], min: 0, max: 2, step: 0.01, onInput: (v) => set({ redshift: [currentParams.redshift[0], v, currentParams.redshift[2]] }) }),
    createSlider({ id: 'redshiftB', label: STRINGS.redshiftB, value: params.redshift[2], min: 0, max: 2, step: 0.01, onInput: (v) => set({ redshift: [currentParams.redshift[0], currentParams.redshift[1], v] }) }),
    createSlider({ id: 'sigmaRatioR', label: STRINGS.sigmaRatioR, value: params.sigmaRatio[0], min: 0.1, max: 2, step: 0.01, onInput: (v) => set({ sigmaRatio: [v, currentParams.sigmaRatio[1], currentParams.sigmaRatio[2]] }) }),
    createSlider({ id: 'sigmaRatioG', label: STRINGS.sigmaRatioG, value: params.sigmaRatio[1], min: 0.1, max: 2, step: 0.01, onInput: (v) => set({ sigmaRatio: [currentParams.sigmaRatio[0], v, currentParams.sigmaRatio[2]] }) }),
    createSlider({ id: 'sigmaRatioB', label: STRINGS.sigmaRatioB, value: params.sigmaRatio[2], min: 0.1, max: 2, step: 0.01, onInput: (v) => set({ sigmaRatio: [currentParams.sigmaRatio[0], currentParams.sigmaRatio[1], v] }) }),
    createSlider({ id: 'globalDiffusion', label: STRINGS.globalDiffusion, value: params.globalDiffusion, min: 0, max: 1, step: 0.01, onInput: (v) => set({ globalDiffusion: v }) }),
    createSlider({ id: 'centerAttenuation', label: STRINGS.centerAttenuation, value: params.centerAttenuation, min: 0, max: 1, step: 0.01, onInput: (v) => set({ centerAttenuation: v }) }),
    createSelect({
      id: 'blendMode',
      label: STRINGS.blendMode,
      value: params.blendMode,
      options: [
        { value: 'additive', label: STRINGS.blendAdditive },
        { value: 'screen', label: STRINGS.blendScreen },
      ],
      onChange: (v) => set({ blendMode: v }),
    }),
    createSelect({
      id: 'diffusionMode',
      label: STRINGS.diffusionMode,
      value: params.diffusionMode,
      options: [
        { value: 'quality', label: STRINGS.modeQuality },
        { value: 'fast', label: STRINGS.modeFast },
      ],
      onChange: (v) => set({ diffusionMode: v }),
    }),
    createSelect({
      id: 'extraction',
      label: STRINGS.extraction,
      value: params.extraction,
      options: [
        { value: 'threshold', label: STRINGS.extractionLuma },
        { value: 'spill', label: STRINGS.extractionSpill },
      ],
      onChange: (v) => set({ extraction: v }),
    }),
    createSlider({ id: 'spillMix', label: STRINGS.spillMix, value: params.spillMix, min: 0, max: 1, step: 0.05, onInput: (v) => set({ spillMix: v }) }),
    createSlider({ id: 'rolloff', label: STRINGS.rolloff, value: params.rolloff, min: 0, max: 1, step: 0.01, onInput: (v) => set({ rolloff: v }) }),
    // #5：σ 单位（pixels / 对角线千分比）——切换时同步滑块量程
    createSelect({
      id: 'sigmaUnits',
      label: STRINGS.sigmaUnits,
      value: params.sigmaUnits,
      options: [
        { value: 'pixels', label: STRINGS.sigmaUnitsPixels },
        { value: 'diagonal', label: STRINGS.sigmaUnitsDiagonal },
      ],
      onChange: (v) => {
        const slider = document.getElementById('sigma');
        setSliderRange(slider, v === 'diagonal' ? 0.1 : 0.5, v === 'diagonal' ? 10 : 50, v === 'diagonal' ? 0.1 : 0.5, currentParams.sigma);
        set({ sigmaUnits: v });
      },
    }),
    // #3：阈值单位（linear / stops）——切换时同步滑块量程（当前值不自动换算，由用户调整）
    createSelect({
      id: 'thresholdUnits',
      label: STRINGS.thresholdUnits,
      value: params.thresholdUnits,
      options: [
        { value: 'linear', label: STRINGS.unitsLinear },
        { value: 'stops', label: STRINGS.unitsStops },
      ],
      onChange: (v) => {
        for (const id of ['threshold', 'backgroundThreshold']) {
          const slider = document.getElementById(id);
          setSliderRange(slider, v === 'stops' ? -4 : 0, v === 'stops' ? 4 : 1, v === 'stops' ? 0.1 : 0.01, currentParams[id]);
        }
        set({ thresholdUnits: v });
      },
    }),
  );
  advBody.append(advGroup);
  appendMaskControls('halation', advBody, {
    title: 'Halation output area',
    description: 'Limits where the rendered Halation is mixed. Source extraction settings are unchanged.',
  });

  // ---- Preview 图 ----
  const img = document.createElement('img');
  img.id = 'preview-image';
  img.alt = 'Rendered film preview';
  img.draggable = false;
  img.classList.add('fhal-compare-image');
  const sourceImg = document.createElement('img');
  sourceImg.id = 'preview-source-image';
  sourceImg.alt = 'Original source preview';
  sourceImg.draggable = false;
  sourceImg.classList.add('fhal-compare-image');

  const previewStage = document.createElement('div');
  previewStage.classList.add('fhal-preview-stage');
  const previewToolbar = document.createElement('div');
  previewToolbar.classList.add('fhal-preview-toolbar');
  const previewLabel = document.createElement('div');
  previewLabel.classList.add('fhal-preview-title');
  previewLabel.textContent = STRINGS.previewStage;
  const previewModes = document.createElement('div');
  previewModes.classList.add('fhal-preview-modes');
  previewModes.setAttribute('role', 'group');
  previewModes.setAttribute('aria-label', 'Preview scale');
  const fitButton = document.createElement('button');
  fitButton.type = 'button';
  fitButton.classList.add('fhal-preview-mode');
  fitButton.textContent = 'Fit';
  fitButton.title = 'Fit on screen';
  const actualButton = document.createElement('button');
  actualButton.type = 'button';
  actualButton.classList.add('fhal-preview-mode');
  actualButton.textContent = '100%';
  actualButton.title = 'Inspect source pixels at 100%';
  previewModes.append(fitButton, actualButton);
  previewToolbar.append(previewLabel, previewModes);
  const previewFrame = document.createElement('div');
  previewFrame.classList.add('fhal-preview-frame');
  previewFrame.setAttribute('data-mode', 'fit');
  previewFrame.setAttribute('data-dragging', 'false');
  previewFrame.tabIndex = 0;
  previewFrame.setAttribute('aria-label', 'Film preview. In 100 percent mode, drag to inspect another area.');
  const sourcePane = document.createElement('div');
  sourcePane.classList.add('fhal-compare-pane', 'fhal-compare-source');
  const sourceLabel = document.createElement('span');
  sourceLabel.classList.add('fhal-compare-label');
  sourceLabel.textContent = 'SOURCE';
  sourcePane.append(sourceImg, sourceLabel);
  const previewPane = document.createElement('div');
  previewPane.classList.add('fhal-compare-pane', 'fhal-compare-preview');
  const renderedLabel = document.createElement('span');
  renderedLabel.classList.add('fhal-compare-label');
  renderedLabel.textContent = 'PREVIEW';
  const previewLoading = document.createElement('div');
  previewLoading.classList.add('fhal-preview-loading');
  previewLoading.hidden = true;
  previewLoading.setAttribute('role', 'status');
  previewLoading.setAttribute('aria-live', 'polite');
  previewLoading.setAttribute('aria-label', 'Rendering film preview');
  const renderRing = document.createElement('span');
  renderRing.classList.add('fhal-render-ring');
  renderRing.setAttribute('aria-hidden', 'true');
  const previewLoadingText = document.createElement('span');
  previewLoadingText.classList.add('fhal-preview-loading-text');
  previewLoadingText.textContent = 'Rendering';
  previewLoading.append(renderRing, previewLoadingText);
  previewPane.append(img, renderedLabel, previewLoading);
  const panHint = document.createElement('span');
  panHint.classList.add('fhal-pan-hint');
  panHint.textContent = 'Drag to inspect · Arrow keys move 64 px';
  previewFrame.append(sourcePane, previewPane, panHint);
  previewStage.append(previewToolbar, previewFrame);

  let currentPreviewMode = 'fit';
  let configuredPreviewPixelRatio = Number.isFinite(Number(initialPreviewPixelRatio)) && Number(initialPreviewPixelRatio) > 0
    ? normalizePreviewPixelRatio(initialPreviewPixelRatio)
    : null;
  const reportedPreviewPixelRatio = () => normalizePreviewPixelRatio(
    previewFrame.uxpContainer?.devicePixelRatio
      ?? globalThis.window?.devicePixelRatio
      ?? globalThis.devicePixelRatio
      ?? 1,
  );
  const previewPixelRatio = () => configuredPreviewPixelRatio ?? reportedPreviewPixelRatio();
  const previewViewport = () => {
    const target = currentPreviewMode === 'actual' ? previewPane : previewFrame;
    const cssWidth = Math.max(1, Number(target.clientWidth) || 512);
    const cssHeight = Math.max(1, Number(target.clientHeight) || 512);
    return currentPreviewMode === 'actual'
      ? inspectionViewportForCss(cssWidth, cssHeight, previewPixelRatio())
      : { width: Math.floor(cssWidth), height: Math.floor(cssHeight), pixelRatio: 1 };
  };
  const nativeImageSizes = new Map();
  const applyActualImageSize = (previewImage) => {
    if (currentPreviewMode !== 'actual') return;
    const stored = nativeImageSizes.get(previewImage);
    const pixelWidth = stored?.width ?? Number(previewImage.naturalWidth || 0);
    const pixelHeight = stored?.height ?? Number(previewImage.naturalHeight || 0);
    if (!(pixelWidth > 0 && pixelHeight > 0)) return;
    const layout = inspectionImageLayout(pixelWidth, pixelHeight, previewPixelRatio());
    previewImage.style.width = `${layout.width}px`;
    previewImage.style.height = `${layout.height}px`;
    previewImage.style.objectFit = layout.objectFit;
  };
  sourceImg.addEventListener('load', () => applyActualImageSize(sourceImg));
  img.addEventListener('load', () => applyActualImageSize(img));
  const resetPreviewPanVisual = () => {
    sourceImg.style.transform = 'translate(0px, 0px)';
    img.style.transform = 'translate(0px, 0px)';
    previewFrame.setAttribute('data-dragging', 'false');
  };
  const setPreviewLoading = (loading, options = {}) => {
    const active = loading === true;
    if (active && options.useSource !== false) {
      const source = sourceImg.getAttribute('src');
      if (source) {
        img.src = source;
        const sourceSize = nativeImageSizes.get(sourceImg);
        if (sourceSize) nativeImageSizes.set(img, { ...sourceSize });
        applyActualImageSize(img);
      }
    }
    previewPane.setAttribute('data-loading', String(active));
    previewPane.setAttribute('aria-busy', String(active));
    previewLoading.hidden = !active;
  };
  // Photoshop UXP releases differ in their support for compound selectors and
  // automatic flex sizing. Keep the mode-defining dimensions inline as a host
  // compatibility fallback so images can never escape into the controls area.
  const applyPreviewLayout = (mode) => {
    const actual = mode === 'actual';
    previewFrame.style.display = 'flex';
    previewFrame.style.flexDirection = 'row';
    previewFrame.style.overflow = 'hidden';
    previewFrame.style.backgroundColor = actual ? '#101113' : '#000000';
    for (const pane of [sourcePane, previewPane]) {
      pane.style.boxSizing = 'border-box';
      pane.style.minWidth = '0px';
      pane.style.minHeight = '0px';
      pane.style.overflow = 'hidden';
      pane.style.alignSelf = 'stretch';
      pane.style.flex = actual ? '0 0 50%' : '1 1 100%';
      pane.style.width = actual ? '50%' : '100%';
      pane.style.maxWidth = actual ? '50%' : '100%';
      pane.style.backgroundColor = actual ? '#0f1012' : '#000000';
      pane.style.backgroundImage = actual ? '' : 'none';
    }
    sourcePane.style.display = actual ? 'flex' : 'none';
    previewPane.style.display = 'flex';
    previewPane.style.borderLeft = actual ? '1px solid rgba(110,176,214,.62)' : '0px';
    for (const previewImage of [sourceImg, img]) {
      previewImage.style.display = 'block';
      previewImage.style.flex = '0 0 auto';
      previewImage.style.maxWidth = actual ? 'none' : '100%';
      previewImage.style.maxHeight = actual ? 'none' : '100%';
      previewImage.style.width = actual ? 'auto' : '100%';
      previewImage.style.height = actual ? 'auto' : '100%';
      previewImage.style.objectFit = actual ? 'fill' : 'contain';
      if (actual) applyActualImageSize(previewImage);
    }
  };
  const selectPreviewMode = (mode, notify = true) => {
    currentPreviewMode = mode === 'actual' ? 'actual' : 'fit';
    previewFrame.setAttribute('data-mode', currentPreviewMode);
    applyPreviewLayout(currentPreviewMode);
    fitButton.setAttribute('aria-pressed', String(currentPreviewMode === 'fit'));
    actualButton.setAttribute('aria-pressed', String(currentPreviewMode === 'actual'));
    resetPreviewPanVisual();
    if (notify) onPreviewModeChange(currentPreviewMode, activeDomain);
  };
  fitButton.addEventListener('click', () => {
    previewModesByDomain[activeDomain] = 'fit';
    selectPreviewMode('fit');
  });
  actualButton.addEventListener('click', () => {
    previewModesByDomain[activeDomain] = 'actual';
    selectPreviewMode('actual');
  });
  previewDomainSync = (domain, mode) => selectPreviewMode(mode, true);
  selectPreviewMode(previewModesByDomain[activeDomain], false);

  let dragStart = null;
  const updateDragVisual = (x, y) => {
    const transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
    sourceImg.style.transform = transform;
    img.style.transform = transform;
  };
  const finishDrag = (event) => {
    if (!dragStart) return;
    const dx = Number(event.clientX) - dragStart.x;
    const dy = Number(event.clientY) - dragStart.y;
    dragStart = null;
    previewFrame.setAttribute('data-dragging', 'false');
    document.removeEventListener('mousemove', moveDrag);
    document.removeEventListener('mouseup', finishDrag);
    const pixelRatio = previewPixelRatio();
    if (Math.abs(dx) >= 2 || Math.abs(dy) >= 2) onPreviewPan({ x: -Math.round(dx * pixelRatio), y: -Math.round(dy * pixelRatio) });
    else resetPreviewPanVisual();
  };
  const moveDrag = (event) => {
    if (!dragStart) return;
    updateDragVisual(Number(event.clientX) - dragStart.x, Number(event.clientY) - dragStart.y);
    event.preventDefault?.();
  };
  previewFrame.addEventListener('mousedown', (event) => {
    if (currentPreviewMode !== 'actual' || (Number.isFinite(event.button) && event.button !== 0)) return;
    dragStart = { x: Number(event.clientX), y: Number(event.clientY) };
    previewFrame.setAttribute('data-dragging', 'true');
    document.addEventListener('mousemove', moveDrag);
    document.addEventListener('mouseup', finishDrag);
    event.preventDefault?.();
  });
  previewFrame.addEventListener('keydown', (event) => {
    if (currentPreviewMode !== 'actual') return;
    const step = event.shiftKey ? 256 : 64;
    const deltas = {
      ArrowLeft: { x: -step, y: 0 },
      ArrowRight: { x: step, y: 0 },
      ArrowUp: { x: 0, y: -step },
      ArrowDown: { x: 0, y: step },
    };
    const delta = deltas[event.key];
    if (!delta) return;
    event.preventDefault?.();
    onPreviewPan(delta);
  });
  let resizeTimer = null;
  let previewResizeObserver = null;
  if (typeof ResizeObserver === 'function') {
    previewResizeObserver = new ResizeObserver(() => {
      if (currentPreviewMode !== 'actual') return;
      applyActualImageSize(sourceImg);
      applyActualImageSize(img);
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => onPreviewViewportChange(previewViewport()), 120);
    });
    previewResizeObserver.observe(previewPane);
  }

  // ---- 固定底栏：Apply + 状态行 + 提示（不随参数滚动，永不重叠）----
  const footer = document.createElement('div');
  footer.style.flexShrink = '0';
  footer.style.display = 'flex';
  footer.style.flexDirection = 'column';
  footer.style.gap = '4px';
  footer.style.padding = '8px 10px 10px';
  footer.style.boxSizing = 'border-box';
  footer.style.borderTop = '1px solid rgba(128, 128, 128, 0.25)';

  // ---- 按钮与状态 ----
  const actions = document.createElement('div');
  actions.style.display = 'flex';
  actions.style.gap = '8px';
  actions.style.flexWrap = 'wrap';
  const applyBtn = document.createElement('sp-button');
  applyBtn.textContent = STRINGS.apply;
  applyBtn.addEventListener('click', onApply);
  const rebindBtn = document.createElement('sp-button');
  rebindBtn.variant = 'secondary';
  rebindBtn.textContent = STRINGS.rebind;
  rebindBtn.addEventListener('click', onRebind);
  actions.append(applyBtn, rebindBtn);

  const status = document.createElement('sp-body');
  status.id = 'status-line';
  status.textContent = STRINGS.statusReady;
  status.style.fontSize = '12px';

  const hint = document.createElement('sp-body');
  hint.textContent = STRINGS.previewHint;
  hint.style.opacity = '0.6';
  hint.style.fontSize = '12px';

  halationPanel.append(basicGroup, halationAdvanced.element);
  scrollArea.append(physicalGroup, halationPanel);
  scrollArea.append(defringePanel, bloomPanel, resolutionPanel, grainPanel);
  workspace.append(domainNav, scrollArea, previewStage);
  const applyMemory = createSelect({
    id: 'applyMemoryMode',
    label: 'Apply memory',
    value: applyMemoryMode,
    options: [
      { value: 'auto', label: 'Auto (safe)' },
      { value: 'high', label: 'High (16 GB+)' },
      { value: 'balanced', label: 'Balanced' },
    ],
    onChange: (value) => onApplyMemoryModeChange(value),
  });
  applyMemory.title = 'High avoids repeated spatial halos when UXP cannot report memory. Use only on systems with at least 16 GB RAM.';
  const languageSelect = createSelect({
    id: 'uiLanguage',
    label: STRINGS.language,
    value: locale,
    options: [
      { value: 'zh-CN', label: STRINGS.languageChinese },
      { value: 'en', label: STRINGS.languageEnglish },
    ],
    onChange: (value) => onLanguageChange(value),
  });
  // 将两个低频全局设置收进一行紧凑工具栏，避免下拉框在底栏横向拉满。
  const footerSettings = document.createElement('div');
  footerSettings.classList.add('fhal-footer-settings');
  footerSettings.style.display = 'flex';
  footerSettings.style.flexWrap = 'wrap';
  footerSettings.style.alignItems = 'center';
  footerSettings.style.gap = '8px';
  footerSettings.style.width = '100%';
  footerSettings.style.minWidth = '0';
  const compactFooterSetting = (row, width, labelWidth) => {
    row.classList.add('fhal-footer-setting');
    row.style.flex = `0 1 ${width}px`;
    row.style.width = `${width}px`;
    row.style.maxWidth = '100%';
    row.style.minWidth = '0';
    const label = row.querySelector?.('sp-label');
    if (label) {
      label.style.width = `${labelWidth}px`;
      label.style.fontSize = '11px';
    }
    const dropdown = row.querySelector?.('sp-dropdown');
    if (dropdown) {
      dropdown.style.flex = '1 1 auto';
      dropdown.style.width = 'auto';
      dropdown.style.minWidth = '0';
    }
    return row;
  };
  footerSettings.append(
    compactFooterSetting(applyMemory, 232, 86),
    compactFooterSetting(languageSelect, 190, 70),
  );
  const runtimeInfo = document.createElement('sp-body');
  runtimeInfo.style.opacity = '0.52';
  runtimeInfo.style.fontSize = '10px';
  let currentReleaseInfo = { ...releaseInfo };
  const setRuntimeInfo = (next = {}) => {
    currentReleaseInfo = { ...currentReleaseInfo, ...next };
    runtimeInfo.textContent = STRINGS.runtimeInfo(
      currentReleaseInfo.name || 'Film Emulation',
      currentReleaseInfo.backend || STRINGS.backendLoading,
    );
  };
  setRuntimeInfo();
  footer.append(footerSettings, actions, status, hint, runtimeInfo);
  panel.append(workspace, footer);

  // 暴露给 main.jsx 的句柄
  const setControl = (id, value) => {
    const el = document.getElementById(id);
    if (!el) return;
    if (id.endsWith('MaskMode') || id.endsWith('MaskInvert') || id === 'profile' || id === 'blendMode' || id === 'diffusionMode' || id === 'extraction' || id === 'sigmaUnits' || id === 'thresholdUnits' || id === 'filmGauge' || id === 'filmResolutionProfile' || id === 'grainProfile' || id === 'grainMode') {
      // sp-dropdown：value 只读，用 selectedIndex
      setDropdownValue(el, value);
    } else if (el.__filmSlider?.setParameterValue) {
      el.__filmSlider.setParameterValue(value);
    } else {
      el.value = value;
    }
  };
  panel.__handles = {
    img,
    sourceImg,
    status,
    applyBtn,
    rebindBtn,
    getPreviewView() {
      return { mode: currentPreviewMode, domain: activeDomain, ...previewViewport() };
    },
    getPreviewLoading() {
      return previewPane.getAttribute('data-loading') === 'true';
    },
    getReportedPreviewPixelRatio() {
      return reportedPreviewPixelRatio();
    },
    getPreviewPixelRatio() {
      return previewPixelRatio();
    },
    setPreviewPixelRatio(value) {
      const next = normalizePreviewPixelRatio(value);
      const changed = Math.abs(next - previewPixelRatio()) > 1e-4;
      configuredPreviewPixelRatio = next;
      if (changed) {
        applyActualImageSize(sourceImg);
        applyActualImageSize(img);
      }
      return changed;
    },
    resetPreviewPanVisual,
    setPreviewLoading,
    setPreviewPixelDimensions(target, width, height) {
      const previewImage = target === 'source' ? sourceImg : img;
      nativeImageSizes.set(previewImage, { width: Number(width), height: Number(height) });
      applyActualImageSize(previewImage);
    },
    setRuntimeInfo,
    dispose() {
      previewResizeObserver?.disconnect?.();
      previewResizeObserver = null;
      clearTimeout(resizeTimer);
      resizeTimer = null;
    },
    updateGraph(nextGraph) {
      currentGraph = nextGraph.map((node) => ({ ...node, params: { ...node.params }, mask: node.mask ? { ...node.mask } : createLumaMask() }));
      const halationNode = currentGraph.find((node) => node.type === 'halation');
      const defringeNode = currentGraph.find((node) => node.type === 'defringe');
      const bloomNode = currentGraph.find((node) => node.type === 'bloom');
      const hpNode = currentGraph.find((node) => node.type === 'highlightProtection');
      const resolutionNode = currentGraph.find((node) => node.type === 'filmResolution');
      const grainNode = currentGraph.find((node) => node.type === 'grain');
      const resolution = resolutionNode?.params;
      const grain = grainNode?.params;
      graphToggles.defringe?.setEnabled(defringeNode?.enabled === true);
      graphToggles.bloom?.setEnabled(bloomNode?.enabled === true);
      graphToggles.highlightProtection?.setEnabled(hpNode?.enabled === true);
      graphToggles.filmResolution?.setEnabled(resolutionNode?.enabled === true);
      graphToggles.grain?.setEnabled(grainNode?.enabled === true);
      if (resolution) {
        setControl('filmResolutionProfile', resolution.profile);
        setControl('filmResolutionAmount', resolution.amount);
        setControl('filmResolutionResponse', resolution.response);
        setControl('filmResolutionToeLoss', resolution.toeLoss);
        setControl('filmResolutionShoulderLoss', resolution.shoulderLoss);
      }
      if (grain) {
        setControl('grainProfile', grain.profile);
        setControl('grainMode', grain.mode);
        setControl('grainAmount', grain.amount);
        setControl('grainSize', grain.size);
        setControl('grainRoughness', grain.roughness);
        setControl('grainChroma', grain.chroma);
      }
      const updateMaskControls = (type, node) => {
        const mask = node?.mask;
        if (!mask) return;
        setControl(`${type}MaskMode`, mask.mode);
        setControl(`${type}MaskLowEV`, mask.lowEV);
        setControl(`${type}MaskHighEV`, mask.highEV);
        setControl(`${type}MaskSoftnessEV`, mask.softnessEV);
        setControl(`${type}MaskInvert`, mask.invert ? 'true' : 'false');
        maskRangeVisibility[type]?.(mask.mode);
      };
      if (defringeNode) {
        const value = defringeNode.params;
        setControl('defringeAmount', value.amount);
        setControl('defringeRadiusPx', value.radiusPx);
        setControl('defringeThreshold', value.threshold);
        setControl('defringeSoftness', value.softness);
        setControl('defringeEdgeSensitivity', value.edgeSensitivity);
      }
      if (bloomNode) {
        const value = bloomNode.params;
        setControl('bloomThresholdEV', value.thresholdEV);
        setControl('bloomSoftnessEV', value.softnessEV);
        setControl('bloomRadius', value.radius);
        setControl('bloomAmplify', value.amplify);
        setControl('bloomSaturation', value.saturation);
        setControl('bloomSaveLights', value.saveLights);
      }
      if (hpNode) {
        const value = hpNode.params;
        setControl('highlightProtectionAmount', value.amount);
        setControl('highlightProtectionThresholdEV', value.thresholdEV);
        setControl('highlightProtectionSoftnessEV', value.softnessEV);
      }
      updateMaskControls('halation', halationNode);
      updateMaskControls('defringe', defringeNode);
      updateMaskControls('bloom', bloomNode);
      updateMaskControls('highlightProtection', hpNode);
      updateMaskControls('filmResolution', resolutionNode);
      updateMaskControls('grain', grainNode);
    },
    updateFormat(nextFormat) {
      currentFormat = { ...nextFormat };
      setControl('filmGauge', currentFormat.gauge);
      setControl('filmIso', currentFormat.iso);
    },
    /** 参数恢复后刷新全部控件显示（不触发预览回调）。 */
    updateParams(p) {
      currentParams = { ...p, redshift: [...p.redshift], sigmaRatio: [...p.sigmaRatio] };
      currentGraph = replaceGraphNodeParams(currentGraph, 'halation', currentParams);
      const sigmaSlider = document.getElementById('sigma');
      setSliderRange(sigmaSlider, p.sigmaUnits === 'diagonal' ? 0.1 : 0.5, p.sigmaUnits === 'diagonal' ? 10 : 50, p.sigmaUnits === 'diagonal' ? 0.1 : 0.5, p.sigma);
      for (const id of ['threshold', 'backgroundThreshold']) {
        const slider = document.getElementById(id);
        setSliderRange(slider, p.thresholdUnits === 'stops' ? -4 : 0, p.thresholdUnits === 'stops' ? 4 : 1, p.thresholdUnits === 'stops' ? 0.1 : 0.01, p[id]);
      }
      setControl('profile', p.profile);
      setControl('strength', p.strength);
      setControl('sigma', p.sigma);
      setControl('threshold', p.threshold);
      setControl('redLayerThresholdBias', p.redLayerThresholdBias);
      setControl('sourceSoftness', p.sourceSoftness);
      setControl('backgroundSoftness', p.backgroundSoftness);
      setControl('smoothness', p.smoothness);
      setControl('backgroundThreshold', p.backgroundThreshold);
      setControl('sourceImpact', p.sourceImpact);
      setControl('amplify', p.amplify);
      setControl('sourceExpansion', p.sourceExpansion);
      setControl('redTail', p.redTail);
      setControl('blueCompensation', p.blueCompensation);
      setControl('colorDensity', p.colorDensity);
      setControl('sourceInteriorProtection', p.sourceInteriorProtection);
      setControl('hotSourceThreshold', p.hotSourceThreshold);
      setControl('hotCoreStrength', p.hotCoreStrength);
      setControl('globalSourceThreshold', p.globalSourceThreshold);
      setControl('spectralSensitivity', p.spectralSensitivity);
      setControl('redshiftR', p.redshift[0]);
      setControl('redshiftG', p.redshift[1]);
      setControl('redshiftB', p.redshift[2]);
      setControl('sigmaRatioR', p.sigmaRatio[0]);
      setControl('sigmaRatioG', p.sigmaRatio[1]);
      setControl('sigmaRatioB', p.sigmaRatio[2]);
      setControl('globalDiffusion', p.globalDiffusion);
      setControl('centerAttenuation', p.centerAttenuation);
      setControl('blendMode', p.blendMode);
      setControl('diffusionMode', p.diffusionMode);
      setControl('extraction', p.extraction);
      setControl('spillMix', p.spillMix);
      setControl('rolloff', p.rolloff);
      setControl('sigmaUnits', p.sigmaUnits);
      setControl('thresholdUnits', p.thresholdUnits);
    },
  };
  localizePanelTree(panel, locale);
  return panel;
}
