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
 *   onPreview: ()=>void,                  // 触发预览（外部 debounce）
 *   onApply: ()=>void,                    // 触发 Apply
 * }} handlers
 * @returns {HTMLElement}
 */
export function createPanel(handlers) {
  const { params, onParamsChange, onPreview, onApply } = handlers;
  const set = (partial) => { onParamsChange(partial); };

  // UXP 无 sp-panel 组件（退化为 div）——用普通 div 容器 + 基础样式
  const panel = document.createElement('div');
  panel.style.display = 'flex';
  panel.style.flexDirection = 'column';
  panel.style.gap = '12px';
  panel.style.padding = '12px';
  panel.style.overflowY = 'auto';
  panel.style.height = '100%';

  // ---- Basic ----
  const basicGroup = document.createElement('div');
  basicGroup.style.display = 'flex';
  basicGroup.style.flexDirection = 'column';
  basicGroup.style.gap = '8px';
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
  advBody.style.gap = '8px';
  advToggle.addEventListener('click', () => {
    advBody.style.display = advBody.style.display === 'none' ? 'flex' : 'none';
  });
  details.append(advToggle, advBody);
  const advGroup = document.createElement('div');
  advGroup.style.display = 'flex';
  advGroup.style.flexDirection = 'column';
  advGroup.style.gap = '8px';
  advGroup.append(
    createSlider({ id: 'sigma', label: STRINGS.sigma, value: params.sigma, min: 0.5, max: 50, step: 0.5, onInput: (v) => set({ sigma: v }) }),
    createSlider({ id: 'threshold', label: STRINGS.threshold, value: params.threshold, min: 0, max: 1, step: 0.01, onInput: (v) => set({ threshold: v }) }),
    createSlider({ id: 'thresholdSoftness', label: STRINGS.thresholdSoftness, value: params.thresholdSoftness, min: 0, max: 1, step: 0.01, onInput: (v) => set({ thresholdSoftness: v }) }),
    createSlider({ id: 'backgroundThreshold', label: STRINGS.backgroundThreshold, value: params.backgroundThreshold, min: 0, max: 1, step: 0.01, onInput: (v) => set({ backgroundThreshold: v }) }),
    createSlider({ id: 'redshiftR', label: STRINGS.redshiftR, value: params.redshift[0], min: 0, max: 2, step: 0.01, onInput: (v) => set({ redshift: [v, params.redshift[1], params.redshift[2]] }) }),
    createSlider({ id: 'redshiftG', label: STRINGS.redshiftG, value: params.redshift[1], min: 0, max: 2, step: 0.01, onInput: (v) => set({ redshift: [params.redshift[0], v, params.redshift[2]] }) }),
    createSlider({ id: 'redshiftB', label: STRINGS.redshiftB, value: params.redshift[2], min: 0, max: 2, step: 0.01, onInput: (v) => set({ redshift: [params.redshift[0], params.redshift[1], v] }) }),
    createSlider({ id: 'sigmaRatioR', label: STRINGS.sigmaRatioR, value: params.sigmaRatio[0], min: 0.1, max: 2, step: 0.01, onInput: (v) => set({ sigmaRatio: [v, params.sigmaRatio[1], params.sigmaRatio[2]] }) }),
    createSlider({ id: 'sigmaRatioG', label: STRINGS.sigmaRatioG, value: params.sigmaRatio[1], min: 0.1, max: 2, step: 0.01, onInput: (v) => set({ sigmaRatio: [params.sigmaRatio[0], v, params.sigmaRatio[2]] }) }),
    createSlider({ id: 'sigmaRatioB', label: STRINGS.sigmaRatioB, value: params.sigmaRatio[2], min: 0.1, max: 2, step: 0.01, onInput: (v) => set({ sigmaRatio: [params.sigmaRatio[0], params.sigmaRatio[1], v] }) }),
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
  );
  advBody.append(advGroup);

  // ---- Preview 图 ----
  const img = document.createElement('img');
  img.id = 'preview-image';
  img.style.width = '100%';
  img.style.height = 'auto';
  img.alt = 'preview';

  // ---- 按钮与状态 ----
  const actions = document.createElement('div');
  actions.style.display = 'flex';
  actions.style.gap = '8px';
  actions.style.marginTop = '8px';
  const applyBtn = document.createElement('sp-button');
  applyBtn.textContent = STRINGS.apply;
  applyBtn.addEventListener('click', onApply);
  actions.append(applyBtn);

  const status = document.createElement('sp-body');
  status.id = 'status-line';
  status.textContent = STRINGS.statusReady;
  status.style.marginTop = '8px';

  const hint = document.createElement('sp-body');
  hint.textContent = STRINGS.previewHint;
  hint.style.opacity = '0.6';
  hint.style.fontSize = '12px';

  panel.append(basicGroup, details, img, actions, status, hint);

  // 暴露给 main.jsx 的句柄
  const setControl = (id, value) => {
    const el = document.getElementById(id);
    if (!el) return;
    if (id === 'blendMode' || id === 'diffusionMode') {
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
    /** 参数恢复后刷新全部控件显示（不触发预览回调）。 */
    updateParams(p) {
      setControl('strength', p.strength);
      setControl('sigma', p.sigma);
      setControl('threshold', p.threshold);
      setControl('thresholdSoftness', p.thresholdSoftness);
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
    },
  };
  return panel;
}
