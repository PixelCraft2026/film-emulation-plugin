// @ts-nocheck
/**
 * ui/controls — 参数控件工厂（原生 UXP DOM，Spectrum 组件）。
 * 每个控件与 HalationParams 的一个字段绑定，变更时调用 onChange(params)。
 * 解耦：控件不接触算法/宿主，只持有参数对象与回调。
 */

/**
 * 滑块控件。
 * @param {{id:string,label:string,value:number,min:number,max:number,step:number,onInput:(v:number)=>void}} o
 * @returns {HTMLElement} 容器（field-label + sp-slider）
 */
export function createSlider(o) {
  const row = document.createElement('div');
  row.style.display = 'flex';
  row.style.flexDirection = 'column';
  row.style.gap = '4px';

  const label = document.createElement('sp-field-label');
  label.textContent = o.label;
  const slider = document.createElement('sp-slider');
  slider.id = o.id;
  slider.min = o.min;
  slider.max = o.max;
  slider.step = o.step;
  slider.value = o.value;
  slider.style.width = '100%';
  slider.addEventListener('input', () => o.onInput(Number(slider.value)));
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
  row.style.display = 'flex';
  row.style.flexDirection = 'column';
  row.style.gap = '4px';

  const label = document.createElement('sp-field-label');
  label.textContent = o.label;
  const select = document.createElement('sp-dropdown');
  select.id = o.id;
  select.style.width = '100%';
  // sp-dropdown 用 menu 列表；简化：用原生 select 语义的 sp-menu 组合
  const menu = document.createElement('sp-menu');
  for (const opt of o.options) {
    const item = document.createElement('sp-menu-item');
    item.value = opt.value;
    item.textContent = opt.label;
    menu.append(item);
  }
  select.append(menu);
  select.value = o.value;
  select.addEventListener('change', () => o.onChange(String(select.value)));
  row.append(label, select);
  return row;
}

/** 数值显示辅助（红色偏移等小数值）。 */
export function formatNum(v, digits = 3) {
  return Number(v).toFixed(digits);
}
