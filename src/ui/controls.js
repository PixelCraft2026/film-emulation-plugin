// @ts-nocheck
/**
 * ui/controls — 参数控件工厂（原生 UXP DOM，Spectrum 组件）。
 * 每个控件与 HalationParams 的一个字段绑定，变更时调用 onChange(params)。
 * 解耦：控件不接触算法/宿主，只持有参数对象与回调。
 */

const clamp01 = (value) => Math.max(0, Math.min(1, Number(value) || 0));

/**
 * Maps the physical slider position to a normalized parameter coordinate.
 * `fine-min` spends more track near the minimum; `fine-max` spends more track
 * near the maximum. The mapping only belongs to the UI and never changes the
 * serialized parameter value.
 * @param {number} position
 * @param {'linear'|'fine-min'|'fine-max'} [curve]
 * @param {number} [exponent]
 */
export function sliderPositionToUnit(position, curve = 'linear', exponent = 2.2) {
  const t = clamp01(position);
  const power = Number.isFinite(exponent) && exponent > 1 ? exponent : 2.2;
  if (curve === 'fine-min') return t ** power;
  if (curve === 'fine-max') return 1 - ((1 - t) ** power);
  return t;
}

/** Inverse of sliderPositionToUnit(). */
export function sliderUnitToPosition(unit, curve = 'linear', exponent = 2.2) {
  const u = clamp01(unit);
  const power = Number.isFinite(exponent) && exponent > 1 ? exponent : 2.2;
  if (curve === 'fine-min') return u ** (1 / power);
  if (curve === 'fine-max') return 1 - ((1 - u) ** (1 / power));
  return u;
}

function decimalPlaces(step) {
  const text = String(step);
  if (text.includes('e-')) return Number(text.split('e-')[1]) || 0;
  return text.includes('.') ? text.length - text.indexOf('.') - 1 : 0;
}

function quantizeParameter(value, min, max, step) {
  const bounded = Math.max(min, Math.min(max, Number(value)));
  if (!(step > 0)) return bounded;
  const rounded = min + Math.round((bounded - min) / step) * step;
  return Number(Math.max(min, Math.min(max, rounded)).toFixed(Math.min(10, decimalPlaces(step) + 2)));
}

/**
 * 滑块控件。
 * @param {{id:string,label:string,value:number,min:number,max:number,step:number,curve?:'linear'|'fine-min'|'fine-max',curveExponent?:number,fineStepScale?:number,onInput:(v:number)=>void}} o
 * @returns {HTMLElement} 容器（field-label + sp-slider）
 */
export function createSlider(o) {
  const row = document.createElement('div');
  // 一行式：label 固定宽 + 滑块自适应（紧凑布局；label 过长省略，title 显示全名）
  row.style.display = 'flex';
  row.style.alignItems = 'center';
  row.style.gap = '6px';

  const label = document.createElement('sp-label');
  label.textContent = o.label;
  label.title = o.label;
  label.style.flexShrink = '0';
  label.style.width = '110px';
  label.style.overflow = 'hidden';
  label.style.whiteSpace = 'nowrap';
  label.style.textOverflow = 'ellipsis';
  const slider = document.createElement('sp-slider');
  slider.id = o.id;
  slider.style.flex = '1';
  slider.style.minWidth = '0';
  const curve = o.curve ?? 'linear';
  if (curve === 'linear') {
    slider.min = o.min;
    slider.max = o.max;
    slider.step = o.step;
    slider.value = o.value;
    slider.addEventListener('input', () => o.onInput(Number(slider.value)));
  } else {
    const mapping = {
      min: Number(o.min),
      max: Number(o.max),
      stepScale: Number(o.fineStepScale ?? 1),
      step: Number(o.step) * Number(o.fineStepScale ?? 1),
      curve,
      exponent: Number(o.curveExponent ?? 2.2),
    };
    const setAccessibilityValue = (value) => {
      slider.setAttribute('aria-valuetext', String(value));
      slider.title = `${o.label}: ${value}`;
    };
    const setParameterValue = (value) => {
      const parameter = quantizeParameter(value, mapping.min, mapping.max, mapping.step);
      const unit = mapping.max === mapping.min ? 0 : (parameter - mapping.min) / (mapping.max - mapping.min);
      slider.value = sliderUnitToPosition(unit, mapping.curve, mapping.exponent);
      setAccessibilityValue(parameter);
      return parameter;
    };
    const setRange = (min, max, step, value) => {
      mapping.min = Number(min);
      mapping.max = Number(max);
      mapping.step = Number(step) * mapping.stepScale;
      const nextValue = value === undefined
        ? mapping.min + sliderPositionToUnit(Number(slider.value), mapping.curve, mapping.exponent) * (mapping.max - mapping.min)
        : Number(value);
      return setParameterValue(nextValue);
    };
    slider.min = 0;
    slider.max = 1;
    slider.step = 0.001;
    slider.__filmSlider = { setParameterValue, setRange, mapping };
    setParameterValue(o.value);
    slider.addEventListener('input', () => {
      const raw = mapping.min + sliderPositionToUnit(Number(slider.value), mapping.curve, mapping.exponent) * (mapping.max - mapping.min);
      const parameter = quantizeParameter(raw, mapping.min, mapping.max, mapping.step);
      setAccessibilityValue(parameter);
      o.onInput(parameter);
    });
  }
  row.append(label, slider);
  return row;
}

/**
 * 下拉选择控件。
 * @param {{id:string,label:string,value:string,options:{value:string,label:string}[],onChange:(v:string)=>void}} o
 * @returns {HTMLElement}
 */
export function createSelect(o) {
  const row = document.createElement('div');
  // 一行式：label 固定宽 + 下拉自适应
  row.style.display = 'flex';
  row.style.alignItems = 'center';
  row.style.gap = '6px';

  const label = document.createElement('sp-label');
  label.textContent = o.label;
  label.title = o.label;
  label.style.flexShrink = '0';
  label.style.width = '110px';
  label.style.overflow = 'hidden';
  label.style.whiteSpace = 'nowrap';
  label.style.textOverflow = 'ellipsis';
  const select = document.createElement('sp-dropdown');
  select.id = o.id;
  select.style.flex = '1';
  select.style.minWidth = '0';
  // sp-dropdown 硬性要求：菜单需 slot="options"
  const menu = document.createElement('sp-menu');
  menu.slot = 'options';
  for (const opt of o.options) {
    const item = document.createElement('sp-menu-item');
    item.value = opt.value;
    item.textContent = opt.label;
    menu.append(item);
  }
  select.append(menu);
  // sp-dropdown 的 value 为只读 getter——用 selectedIndex 初始化
  const initIdx = o.options.findIndex((opt) => opt.value === o.value);
  select.selectedIndex = initIdx >= 0 ? initIdx : 0;
  select.addEventListener('change', () => {
    const idx = select.selectedIndex;
    const opt = o.options[idx];
    o.onChange(opt ? opt.value : String(select.value));
  });
  row.append(label, select);
  return row;
}

/**
 * Effect enable switch. It is a native button with switch semantics instead
 * of a Spectrum-only custom element so the control remains usable on older
 * Photoshop UXP hosts as well.
 * @param {{id:string,label:string,enabled:boolean,onChange:(enabled:boolean)=>void,onLabel?:string,offLabel?:string,ariaLabel?:string,title?:string}} o
 * @returns {{element:HTMLElement,setEnabled:(enabled:boolean)=>void}}
 */
export function createEffectSwitch(o) {
  const button = document.createElement('button');
  button.type = 'button';
  button.id = o.id;
  button.classList.add('fhal-effect-toggle');
  button.setAttribute('role', 'switch');
  button.setAttribute('aria-label', o.ariaLabel ?? `Enable ${o.label}`);
  button.title = o.title ?? `${o.label}: enable or disable`;

  const track = document.createElement('span');
  track.classList.add('fhal-toggle-track');
  const thumb = document.createElement('span');
  thumb.classList.add('fhal-toggle-thumb');
  track.append(thumb);
  const state = document.createElement('span');
  state.classList.add('fhal-toggle-state');
  button.append(track, state);

  const setEnabled = (enabled) => {
    const value = enabled === true;
    button.setAttribute('aria-checked', String(value));
    button.setAttribute('data-enabled', String(value));
    state.textContent = value ? (o.onLabel ?? 'On') : (o.offLabel ?? 'Off');
  };
  setEnabled(o.enabled);
  button.addEventListener('click', () => {
    const next = button.getAttribute('aria-checked') !== 'true';
    setEnabled(next);
    o.onChange(next);
  });
  return { element: button, setEnabled };
}

/** 数值显示辅助（红色偏移等小数值）。 */
export function formatNum(v, digits = 3) {
  return Number(v).toFixed(digits);
}
