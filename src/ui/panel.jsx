// @ts-nocheck
/**
 * ui/panel — Film Halation 面板（Spectrum UXP，原生 DOM）。
 * 布局：效果领域导航 / 当前领域参数 / 大幅检查预览 / Apply + 状态行。
 * 控件变更 → handlers.onParamsChange()（main.jsx 负责 debounce 预览与状态刷新）。
 * 本文件只做视图与事件转发，不含算法与宿主逻辑。
 */
import { STRINGS } from './i18n.js';
import { createSlider, createSelect } from './controls.js';
import { createHalationPreset, HALATION_PRESET_LABELS, createFilmResolutionParams, createGrainParams } from '../core/index.js';


function setDropdownValue(el, value) {
  if (!el) return;
  const items = Array.from((el.querySelector('sp-menu') || { children: [] }).children || []);
  const idx = items.findIndex((it) => it.value === value);
  el.selectedIndex = idx >= 0 ? idx : 0;
}

/**
 * @param {{
 *   params: object,                       // 当前 HalationParams
 *   graph?: Array<object>,                // V1.6 graph
 *   format?: object,                      // V1.6 physical format
 *   featureLevel?: 'current'|'v1.5-bridge',
 *   onParamsChange: (partial:object)=>void, // 参数变更（partial 合并）
 *   onGraphChange?: (graph:Array<object>)=>void,
 *   onFormatChange?: (partial:object)=>void,
 *   onRandomizeGrain?: ()=>void,
 *   onApply: ()=>void,                    // 触发 Apply
 *   onRebind: ()=>void,                   // 显式把当前像素层重新绑定为 source
 *   migrationRole?: 'export'|'import'|'none',
 *   onExportMigration?: ()=>void,
 *   onImportMigration?: ()=>void,
 * }} handlers
 * @returns {HTMLElement}
 */
export function createPanel(handlers) {
  const {
    params,
    graph = [],
    format = { gauge: '35mm', iso: 250 },
    featureLevel = 'current',
    onParamsChange,
    onGraphChange = () => {},
    onFormatChange = () => {},
    onRandomizeGrain = () => {},
    onApply,
    onRebind,
    migrationRole = 'none',
    onExportMigration,
    onImportMigration,
  } = handlers;
  let currentParams = { ...params, redshift: [...params.redshift], sigmaRatio: [...params.sigmaRatio] };
  let currentGraph = graph.map((node) => ({ ...node, params: { ...node.params } }));
  let currentFormat = { ...format };
  const set = (partial) => {
    const explicitProfile = Object.prototype.hasOwnProperty.call(partial, 'profile');
    const effective = explicitProfile ? partial : { ...partial, profile: 'custom' };
    currentParams = { ...currentParams, ...effective };
    if (!explicitProfile) setDropdownValue(document.getElementById('profile'), 'custom');
    onParamsChange(effective);
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
      position: relative; width: 100%; min-height: 42px; padding: 7px 8px 7px 12px;
      border: 0; border-left: 2px solid transparent; border-radius: 2px; box-sizing: border-box;
      color: rgba(255,255,255,.68); background: transparent; text-align: left;
      font: 600 12px/1.2 "Adobe Clean", "Segoe UI", sans-serif; cursor: pointer;
    }
    .fhal-domain-button:hover { color: #fff; background: rgba(255,255,255,.055); }
    .fhal-domain-button:focus { outline: 1px solid #55a9d8; outline-offset: -1px; }
    .fhal-domain-button[aria-pressed="true"] { color: #fff; background: rgba(255,255,255,.085); }
    .fhal-domain-button[data-domain="halation"][aria-pressed="true"] { border-left-color: #e77f42; }
    .fhal-domain-button[data-domain="resolution"][aria-pressed="true"] { border-left-color: #55a9d8; }
    .fhal-domain-button[data-domain="grain"][aria-pressed="true"] { border-left-color: #b7b1a5; }
    .fhal-domain-code { display: block; margin-top: 3px; color: rgba(255,255,255,.36); font: 9px/1 Consolas, monospace; letter-spacing: .08em; }
    .fhal-controls {
      flex: 0 0 340px; min-width: 280px; max-width: 380px; overflow-y: auto;
      padding: 12px; box-sizing: border-box; background: #242528; border-right: 1px solid rgba(128,128,128,.28);
    }
    .fhal-controls > * { flex-shrink: 0; }
    .fhal-domain-panel { display: none; flex-direction: column; gap: 8px; }
    .fhal-domain-panel[data-active="true"] { display: flex; }
    .fhal-section-heading { padding-bottom: 6px; border-bottom: 1px solid rgba(255,255,255,.09); }
    .fhal-physical-group { display: none; flex-direction: column; gap: 6px; margin-bottom: 4px; padding-bottom: 10px; border-bottom: 1px solid rgba(255,255,255,.09); }
    .fhal-physical-group[data-visible="true"] { display: flex; }
    .fhal-preview-stage {
      flex: 1 1 auto; min-width: 300px; min-height: 0; display: flex; flex-direction: column;
      padding: 12px; box-sizing: border-box; background: #1d1e20;
    }
    .fhal-preview-frame {
      flex: 1; min-height: 220px; display: flex; align-items: center; justify-content: center;
      overflow: hidden; background: #101113; border: 1px solid rgba(255,255,255,.10);
      box-shadow: inset 0 0 0 1px rgba(0,0,0,.42), 0 8px 28px rgba(0,0,0,.18);
    }
    #preview-image { width: 100%; height: 100%; object-fit: contain; }
    @media (max-width: 760px) {
      .fhal-workspace { flex-direction: column; }
      .fhal-domain-nav {
        flex: 0 0 auto; min-width: 0; flex-direction: row; overflow-x: auto; overflow-y: hidden;
        padding: 6px; border-right: 0; border-bottom: 1px solid rgba(255,255,255,.09);
      }
      .fhal-nav-kicker { display: none; }
      .fhal-domain-button { min-width: 94px; min-height: 36px; border-left: 0; border-bottom: 2px solid transparent; }
      .fhal-domain-button[data-domain="halation"][aria-pressed="true"] { border-bottom-color: #e77f42; }
      .fhal-domain-button[data-domain="resolution"][aria-pressed="true"] { border-bottom-color: #55a9d8; }
      .fhal-domain-button[data-domain="grain"][aria-pressed="true"] { border-bottom-color: #b7b1a5; }
      .fhal-domain-code { display: none; }
      .fhal-controls {
        flex: 1 1 52%; width: 100%; min-width: 0; max-width: none;
        border-right: 0; border-bottom: 1px solid rgba(128,128,128,.28);
      }
      .fhal-preview-stage { flex: 1 1 48%; min-width: 0; min-height: 220px; }
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
  navKicker.textContent = 'Emulsion stages';
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
  const domainPanels = { halation: halationPanel, resolution: resolutionPanel, grain: grainPanel };
  const domainButtons = {};
  const addDomainButton = (domain, label, code) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.classList.add('fhal-domain-button');
    button.setAttribute('data-domain', domain);
    button.setAttribute('aria-pressed', 'false');
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-controls', `film-domain-${domain}`);
    const codeLabel = document.createElement('span');
    codeLabel.classList.add('fhal-domain-code');
    codeLabel.textContent = code;
    button.textContent = label;
    button.append(codeLabel);
    button.addEventListener('click', () => showDomain(domain));
    domainButtons[domain] = button;
    domainNav.append(button);
  };
  const showDomain = (domain) => {
    for (const [name, section] of Object.entries(domainPanels)) {
      section.setAttribute('data-active', String(name === domain));
      section.setAttribute('aria-hidden', String(name !== domain));
    }
    for (const [name, button] of Object.entries(domainButtons)) {
      button.setAttribute('aria-pressed', String(name === domain));
      button.setAttribute('aria-selected', String(name === domain));
    }
    physicalGroup.setAttribute('data-visible', String(domain === 'resolution' || domain === 'grain'));
  };
  addDomainButton('halation', 'Halation', 'HAL / 30');
  const currentBuild = __FILM_FEATURE_LEVEL__ === 'current' && featureLevel === 'current';
  if (__FILM_FEATURE_LEVEL__ === 'current' && featureLevel === 'current') {
    addDomainButton('resolution', 'Resolution', 'MTF / 60');
    addDomainButton('grain', 'Grain', 'GRN / 70');
  }
  showDomain('halation');

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
    createSlider({ id: 'sigma', label: STRINGS.sigma, value: params.sigma, min: params.sigmaUnits === 'diagonal' ? 0.1 : 0.5, max: params.sigmaUnits === 'diagonal' ? 10 : 50, step: params.sigmaUnits === 'diagonal' ? 0.1 : 0.5, onInput: (v) => set({ sigma: v }) }),
    createSlider({ id: 'threshold', label: STRINGS.threshold, value: params.threshold, min: params.thresholdUnits === 'stops' ? -4 : 0, max: params.thresholdUnits === 'stops' ? 4 : 1, step: params.thresholdUnits === 'stops' ? 0.1 : 0.01, onInput: (v) => set({ threshold: v }) }),
  );

  if (__FILM_FEATURE_LEVEL__ === 'current' && featureLevel === 'current') {
    const resolution = currentGraph.find((node) => node.type === 'filmResolution')?.params ?? createFilmResolutionParams();
    const grain = currentGraph.find((node) => node.type === 'grain')?.params ?? createGrainParams();
    const setNode = (type, partial) => {
      const present = currentGraph.some((node) => node.type === type);
      currentGraph = currentGraph.map((node) => node.type === type
        ? { ...node, params: type === 'filmResolution' ? createFilmResolutionParams({ ...node.params, ...partial }) : createGrainParams({ ...node.params, ...partial }) }
        : node);
      if (!present) currentGraph.push({
        id: type === 'filmResolution' ? 'film-resolution-main' : 'grain-main',
        type,
        enabled: true,
        params: type === 'filmResolution' ? createFilmResolutionParams(partial) : createGrainParams(partial),
      });
      onGraphChange(currentGraph);
    };

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

    const resolutionHeading = document.createElement('sp-heading');
    resolutionHeading.textContent = 'Film Resolution';
    resolutionHeading.classList.add('fhal-section-heading');
    resolutionPanel.append(
      resolutionHeading,
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

    const grainHeading = document.createElement('sp-heading');
    grainHeading.textContent = 'Film Grain';
    grainHeading.classList.add('fhal-section-heading');
    grainPanel.append(
      grainHeading,
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
  }

  // ---- Advanced（折叠）----
  const details = document.createElement('div');
  const advToggle = document.createElement('sp-button');
  advToggle.variant = 'secondary';
  advToggle.textContent = STRINGS.advanced;
  const advBody = document.createElement('div');
  advBody.style.display = 'none';
  advBody.style.flexDirection = 'column';
  advBody.style.gap = '6px';
  advToggle.addEventListener('click', () => {
    advBody.style.display = advBody.style.display === 'none' ? 'flex' : 'none';
  });
  details.append(advToggle, advBody);
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
        if (slider) {
          slider.min = v === 'diagonal' ? 0.1 : 0.5;
          slider.max = v === 'diagonal' ? 10 : 50;
          slider.step = v === 'diagonal' ? 0.1 : 0.5;
        }
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
          if (slider) {
            slider.min = v === 'stops' ? -4 : 0;
            slider.max = v === 'stops' ? 4 : 1;
            slider.step = v === 'stops' ? 0.1 : 0.01;
          }
        }
        set({ thresholdUnits: v });
      },
    }),
  );
  advBody.append(advGroup);

  // ---- Preview 图 ----
  const img = document.createElement('img');
  img.id = 'preview-image';
  img.alt = 'preview';

  const previewStage = document.createElement('div');
  previewStage.classList.add('fhal-preview-stage');
  const previewLabel = document.createElement('sp-label');
  previewLabel.textContent = STRINGS.previewStage;
  previewLabel.style.marginBottom = '7px';
  previewLabel.style.letterSpacing = '0.08em';
  previewLabel.style.opacity = '0.72';
  const previewFrame = document.createElement('div');
  previewFrame.classList.add('fhal-preview-frame');
  previewFrame.append(img);
  previewStage.append(previewLabel, previewFrame);

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
  let migrationBtn = null;
  if (migrationRole === 'export' || migrationRole === 'import') {
    migrationBtn = document.createElement('sp-button');
    migrationBtn.variant = 'secondary';
    migrationBtn.textContent = migrationRole === 'export' ? STRINGS.exportMigration : STRINGS.importMigration;
    migrationBtn.addEventListener('click', migrationRole === 'export' ? onExportMigration : onImportMigration);
    actions.append(migrationBtn);
  }

  const status = document.createElement('sp-body');
  status.id = 'status-line';
  status.textContent = STRINGS.statusReady;
  status.style.fontSize = '12px';

  const hint = document.createElement('sp-body');
  hint.textContent = STRINGS.previewHint;
  hint.style.opacity = '0.6';
  hint.style.fontSize = '12px';

  halationPanel.append(basicGroup, details);
  scrollArea.append(physicalGroup, halationPanel);
  if (currentBuild) scrollArea.append(resolutionPanel, grainPanel);
  workspace.append(domainNav, scrollArea, previewStage);
  footer.append(actions, status, hint);
  panel.append(workspace, footer);

  /** Conflict selector: new-ID state is preserved unless the user checks an item. */
  const chooseMigrationConflicts = (conflicts) => new Promise((resolve) => {
    if (!conflicts.length) {
      resolve([]);
      return;
    }
    const overlay = document.createElement('div');
    overlay.style.position = 'absolute';
    overlay.style.inset = '0';
    overlay.style.zIndex = '1000';
    overlay.style.display = 'flex';
    overlay.style.alignItems = 'center';
    overlay.style.justifyContent = 'center';
    overlay.style.padding = '18px';
    overlay.style.background = 'rgba(0,0,0,.72)';
    const card = document.createElement('div');
    card.style.width = 'min(620px, 100%)';
    card.style.maxHeight = '80%';
    card.style.display = 'flex';
    card.style.flexDirection = 'column';
    card.style.gap = '10px';
    card.style.padding = '16px';
    card.style.background = '#2b2b2b';
    card.style.border = '1px solid rgba(255,255,255,.18)';
    const heading = document.createElement('sp-heading');
    heading.textContent = STRINGS.migrationConflictsTitle;
    const explanation = document.createElement('sp-body');
    explanation.textContent = STRINGS.migrationConflictsHint;
    const list = document.createElement('div');
    list.style.overflowY = 'auto';
    list.style.maxHeight = '360px';
    list.style.display = 'flex';
    list.style.flexDirection = 'column';
    list.style.gap = '6px';
    const selections = [];
    for (const conflict of conflicts) {
      const label = document.createElement('label');
      label.style.display = 'flex';
      label.style.gap = '8px';
      label.style.alignItems = 'center';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = false;
      const text = document.createElement('span');
      text.textContent = conflict.label;
      label.append(checkbox, text);
      list.append(label);
      selections.push({ checkbox, key: conflict.key });
    }
    const dialogActions = document.createElement('div');
    dialogActions.style.display = 'flex';
    dialogActions.style.gap = '8px';
    dialogActions.style.justifyContent = 'flex-end';
    const cancel = document.createElement('sp-button');
    cancel.variant = 'secondary';
    cancel.textContent = STRINGS.migrationCancel;
    const confirm = document.createElement('sp-button');
    confirm.textContent = STRINGS.migrationConfirm;
    const finish = (value) => {
      overlay.remove();
      resolve(value);
    };
    cancel.addEventListener('click', () => finish(null));
    confirm.addEventListener('click', () => finish(selections.filter((item) => item.checkbox.checked).map((item) => item.key)));
    dialogActions.append(cancel, confirm);
    card.append(heading, explanation, list, dialogActions);
    overlay.append(card);
    panel.append(overlay);
  });

  // 暴露给 main.jsx 的句柄
  const setControl = (id, value) => {
    const el = document.getElementById(id);
    if (!el) return;
    if (id === 'profile' || id === 'blendMode' || id === 'diffusionMode' || id === 'extraction' || id === 'sigmaUnits' || id === 'thresholdUnits' || id === 'filmGauge' || id === 'filmResolutionProfile' || id === 'grainProfile' || id === 'grainMode') {
      // sp-dropdown：value 只读，用 selectedIndex
      setDropdownValue(el, value);
    } else {
      el.value = value;
    }
  };
  panel.__handles = {
    img,
    status,
    applyBtn,
    rebindBtn,
    migrationBtn,
    chooseMigrationConflicts,
    updateGraph(nextGraph) {
      currentGraph = nextGraph.map((node) => ({ ...node, params: { ...node.params } }));
      const resolution = currentGraph.find((node) => node.type === 'filmResolution')?.params;
      const grain = currentGraph.find((node) => node.type === 'grain')?.params;
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
    },
    updateFormat(nextFormat) {
      currentFormat = { ...nextFormat };
      setControl('filmGauge', currentFormat.gauge);
      setControl('filmIso', currentFormat.iso);
    },
    /** 参数恢复后刷新全部控件显示（不触发预览回调）。 */
    updateParams(p) {
      currentParams = { ...p, redshift: [...p.redshift], sigmaRatio: [...p.sigmaRatio] };
      const sigmaSlider = document.getElementById('sigma');
      if (sigmaSlider) {
        sigmaSlider.min = p.sigmaUnits === 'diagonal' ? 0.1 : 0.5;
        sigmaSlider.max = p.sigmaUnits === 'diagonal' ? 10 : 50;
        sigmaSlider.step = p.sigmaUnits === 'diagonal' ? 0.1 : 0.5;
      }
      for (const id of ['threshold', 'backgroundThreshold']) {
        const slider = document.getElementById(id);
        if (slider) {
          slider.min = p.thresholdUnits === 'stops' ? -4 : 0;
          slider.max = p.thresholdUnits === 'stops' ? 4 : 1;
          slider.step = p.thresholdUnits === 'stops' ? 0.1 : 0.01;
        }
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
  return panel;
}
