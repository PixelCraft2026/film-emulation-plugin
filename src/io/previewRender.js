// @ts-nocheck
/**
 * io/previewRender — 实时预览管线：文档像素 → 降采样(≤1024) → 线性 → fast 算法 →
 * 显示编码 → PNG data URL（面板内显示，不触碰文档，满足 A3 预览 <500ms）。
 * 注意：UXP 无 canvas/内置 PNG 编码，用 ui/pngEncoder 的最小编码器。
 */
import { processHalation } from '../core/index.js';
import { readDocumentPixels } from './imageAccess.js';
import { decodeToLinear, encodeFromLinear } from './colorPipeline.js';
import { computePreviewScale, downsampleBox } from './preview.js';
import { floatRgbaToPng, pngToDataUrl } from '../ui/pngEncoder.js';

/**
 * 渲染预览图（fast 扩散）。
 * @param {object} doc Photoshop Document
 * @param {object} params HalationParams（预览强制 fast）
 * @param {{decode:(v:number)=>number,encode:(v:number)=>number}} trc
 * @returns {Promise<{dataUrl:string,width:number,height:number,ms:number}>}
 */
export async function renderPreviewDataURL(doc, params, trc) {
  const t0 = Date.now();
  const { width, height, rgb } = await readDocumentPixels(doc, { componentSize: 32 });

  // 降采样
  const scale = computePreviewScale(width, height);
  let work;
  if (scale < 1) {
    const dw = Math.max(1, Math.round(width * scale));
    const dh = Math.max(1, Math.round(height * scale));
    work = { width: dw, height: dh, rgb: downsampleBox(rgb, width, height, dw, dh) };
  } else {
    work = { width, height, rgb };
  }

  const linear = decodeToLinear(work.rgb, trc);
  const fastParams = { ...params, diffusionMode: 'fast' };
  const out = processHalation({ width: work.width, height: work.height, rgb: linear }, fastParams);
  const display = encodeFromLinear(out.rgb, trc);

  // 组装 RGBA 并编码
  const rgba = new Float32Array(work.width * work.height * 4);
  for (let i = 0, p = 0; i < work.width * work.height; i++, p += 3) {
    rgba[i * 4] = display[p];
    rgba[i * 4 + 1] = display[p + 1];
    rgba[i * 4 + 2] = display[p + 2];
    rgba[i * 4 + 3] = 1;
  }
  const png = floatRgbaToPng(work.width, work.height, rgba);
  const dataUrl = pngToDataUrl(png);
  return { dataUrl, width: work.width, height: work.height, ms: Date.now() - t0 };
}
