// @ts-nocheck
/**
 * io/tileRender — 行带分块渲染（大图内存兜底，主线程串行）。
 * 背景（capability R-6）：UXP 无 Web Worker → 并行降级为主线程分块 + 进度提示。
 * 用法：整图线性像素 → 按行带（含 5σ 重叠）逐带 processHalation → 写回有效区。
 * 结果与整图渲染在重叠充分时数值一致（L2 极小，可测）。
 */
import { processHalation } from '../core/index.js';
import { splitBands } from './tiles.js';

/**
 * 分块渲染（线性 RGB in/out）。
 * @param {{width:number,height:number,rgb:Float32Array}} input 线性整图
 * @param {object} params HalationParams
 * @param {{bandHeight?:number,overlapPx?:number,onBand?:()=>void}} [opts]
 * @returns {{width:number,height:number,rgb:Float32Array}}
 */
export function processTiled(input, params, opts = {}) {
  const { width, height, rgb } = input;
  const { bandHeight = 256, overlapPx = 35, onBand } = opts;
  const out = new Float32Array(width * height * 3);
  const bands = splitBands(width, height, bandHeight, overlapPx);

  for (const band of bands) {
    const bh = band.end - band.start;
    // 提取带（含重叠）的线性像素
    const bandRgb = new Float32Array(width * bh * 3);
    for (let y = band.start; y < band.end; y++) {
      const srcOff = y * width * 3;
      const dstOff = (y - band.start) * width * 3;
      for (let i = 0; i < width * 3; i++) bandRgb[dstOff + i] = rgb[srcOff + i];
    }
    const result = processHalation({ width, height: bh, rgb: bandRgb }, params);
    // 写回有效区（band.y0..y1）
    for (let y = band.y0; y < band.y1; y++) {
      const srcOff = (y - band.start) * width * 3;
      const dstOff = y * width * 3;
      for (let i = 0; i < width * 3; i++) out[dstOff + i] = result.rgb[srcOff + i];
    }
    onBand?.();
  }
  return { width, height, rgb: out };
}
