// @ts-nocheck
/**
 * ui/panel — Film Halation 面板（Spectrum UXP，原生 DOM）。
 * 布局：Basic（Strength）/ Advanced 折叠（其余参数）/ 预览图 / Apply + 状态行。
 * 控件变更 → handlers.onParamsChange()（main.jsx 负责 debounce 预览与状态刷新）。
 * 本文件只做视图与事件转发，不含算法与宿主逻辑。
 */
import { STRINGS } from './i18n.js';
import { createSlider, createSelect } from './controls.js';

/**
 * @param {{
 *   params: object,                       // 当前 HalationParams
 *   onParamsChange: (partial:object)=>void, // 参数变更（partial 合并）
 *   onApply: ()=>void,                    // 触发 Apply
 *   onRebind: ()=>void,                   // 显式把当前像素层重新绑定为 source
 * }} handlers
 * @returns {HTMLElement}
 */
export function createPanel(handlers) {
  const { params, onParamsChange, onApply, onRebind } = handlers;
  let currentParams = { ...params, redshift: [...params.redshift], sigmaRatio: [...params.sigmaRatio] };
  const set = (partial) => {
    currentParams = { ...currentParams, ...partial };
    onParamsChange(partial);
  };

  const panel = document.createElement('div');
  // 全局紧凑样式 + 滚动条视觉；body 限高（滚动只发生在 panel 内）
  const style = document.createElement('style');
  style.textContent = `
    html, body { height: 100%; margin: 0; padding: 0; overflow: hidden; }
    ::-webkit-scrollbar { width: 8px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: rgba(128, 128, 128, 0.45); border-radius: 4px; }
    ::-webkit-scrollbar-thumb:hover { background: rgba(128, 128, 128, 0.65); }
    sp-heading { margin: 0 0 2px 0; }
    sp-label { font-size: 11px; line-height: 1.2; margin: 0; }
    sp-body { margin: 0; }
    /* 滚动区子项禁止压缩：窗口太短时整体滚动，而不是挤压导致文字重叠 */
    .fhal-scroll > * { flex-shrink: 0; }
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

  // 滚动区：参数与预览图在此滚动（flex:1 占满剩余高度，minHeight:0 允许收缩触发滚动）
  const scrollArea = document.createElement('div');
  scrollArea.style.flex = '1';
  scrollArea.style.minHeight = '0';
  scrollArea.style.overflowY = 'auto';
  scrollArea.style.display = 'flex';
  scrollArea.style.flexDirection = 'column';
  scrollArea.style.gap = '8px';
  scrollArea.style.padding = '10px';
  scrollArea.style.boxSizing = 'border-box';
  scrollArea.classList.add('fhal-scroll');

  // ---- Basic ----
  const basicGroup = document.createElement('div');
  basicGroup.style.display = 'flex';
  basicGroup.style.flexDirection = 'column';
  basicGroup.style.gap = '6px';
  const basicHeading = document.createElement('sp-heading');
  basicHeading.textContent = STRINGS.basic;
  basicGroup.append(basicHeading);
  basicGroup.append(
    createSlider({
      id: 'strength',
      label: STRINGS.strength,
      value: params.strength,
      min: 0,
      max: 100,
      step: 1,
      onInput: (v) => set({ strength: v }),
    }),
  );

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
    createSlider({ id: 'sigma', label: STRINGS.sigma, value: params.sigma, min: 0.5, max: 50, step: 0.5, onInput: (v) => set({ sigma: v }) }),
    createSlider({ id: 'threshold', label: STRINGS.threshold, value: params.threshold, min: params.thresholdUnits === 'stops' ? -4 : 0, max: params.thresholdUnits === 'stops' ? 4 : 1, step: params.thresholdUnits === 'stops' ? 0.1 : 0.01, onInput: (v) => set({ threshold: v }) }),
    createSlider({ id: 'sourceSoftness', label: STRINGS.sourceSoftness, value: params.sourceSoftness, min: 0, max: 1, step: 0.01, onInput: (v) => set({ sourceSoftness: v, thresholdSoftness: v }) }),
    createSlider({ id: 'backgroundSoftness', label: STRINGS.backgroundSoftness, value: params.backgroundSoftness, min: 0, max: 1, step: 0.01, onInput: (v) => set({ backgroundSoftness: v }) }),
    createSlider({ id: 'smoothness', label: STRINGS.smoothness, value: params.smoothness, min: 0, max: 1, step: 0.01, onInput: (v) => set({ smoothness: v }) }),
    createSlider({ id: 'backgroundThreshold', label: STRINGS.backgroundThreshold, value: params.backgroundThreshold, min: params.thresholdUnits === 'stops' ? -4 : 0, max: params.thresholdUnits === 'stops' ? 4 : 1, step: params.thresholdUnits === 'stops' ? 0.1 : 0.01, onInput: (v) => set({ backgroundThreshold: v }) }),
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
  img.style.width = '100%';
  img.style.height = 'auto';
  img.alt = 'preview';

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

  scrollArea.append(basicGroup, details, img);
  footer.append(actions, status, hint);
  panel.append(scrollArea, footer);

  // 暴露给 main.jsx 的句柄
  const setControl = (id, value) => {
    const el = document.getElementById(id);
    if (!el) return;
    if (id === 'blendMode' || id === 'diffusionMode' || id === 'extraction' || id === 'sigmaUnits' || id === 'thresholdUnits') {
      // sp-dropdown：value 只读，用 selectedIndex
      const items = Array.from((el.querySelector('sp-menu') || { children: [] }).children || []);
      const idx = items.findIndex((it) => it.value === value);
      el.selectedIndex = idx >= 0 ? idx : 0;
    } else {
      el.value = value;
    }
  };
  panel.__handles = {
    img,
    status,
    applyBtn,
    rebindBtn,
    /** 参数恢复后刷新全部控件显示（不触发预览回调）。 */
    updateParams(p) {
      currentParams = { ...p, redshift: [...p.redshift], sigmaRatio: [...p.sigmaRatio] };
      setControl('strength', p.strength);
      setControl('sigma', p.sigma);
      setControl('threshold', p.threshold);
      setControl('sourceSoftness', p.sourceSoftness);
      setControl('backgroundSoftness', p.backgroundSoftness);
      setControl('smoothness', p.smoothness);
      setControl('backgroundThreshold', p.backgroundThreshold);
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
