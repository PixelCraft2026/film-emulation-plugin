// @ts-nocheck
/**
 * io/previewRender — 实时预览管线：文档像素 → 降采样(≤1024) → 线性 → fast 算法 →
 * 显示编码 → PNG data URL（面板内显示，不触碰文档，满足 A3 预览 <500ms）。
 * 注意：UXP 无 canvas/内置 PNG 编码，用 ui/pngEncoder 的最小编码器。
 */
import { processHalation, extractStep, diffuseStep, haloStep, blendStep } from '../core/index.js';
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

/**
 * 增量预览渲染（Phase 6）：四步管线 + 中间量缓存。
 * 参数局部变更只重算受影响步骤（提取/扩散/halo/blend）。
 * @param {object} doc
 * @param {object} params HalationParams（预览强制 fast）
 * @param {{decode:(v:number)=>number,encode:(v:number)=>number}} trc
 * @param {object|null} cache 上次的中间量缓存（{S,G,plane,temp,blurFn,halo,kExtract,kDiffuse,kHalo}）
 * @returns {Promise<{dataUrl:string,width:number,height:number,ms:number,cache:object}>}
 */
export async function renderPreviewIncremental(doc, params, trc, cache) {
  const t0 = Date.now();
  const { width, height, rgb } = await readDocumentPixels(doc, { componentSize: 32 });

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
  const p = { ...params, diffusionMode: 'fast' };
  const w = work.width;
  const h = work.height;

  const key = (o) => JSON.stringify(o);
  const kExtract = key({ t: p.threshold, ts: p.thresholdSoftness, bt: p.backgroundThreshold });
  const kDiffuse = key({ s: p.sigma, sr: p.sigmaRatio, w, h });
  const kHalo = key({ rs: p.redshift, ca: p.centerAttenuation, gd: p.globalDiffusion });

  const c = cache && cache.w === w && cache.h === h ? cache : {};
  let { S, G, plane, temp, blurFn, halo } = c;
  if (!S || c.kExtract !== kExtract) {
    ({ S, G } = extractStep({ width: w, height: h, rgb: linear }, p));
    c.kExtract = kExtract;
  }
  if (!plane || c.kDiffuse !== kDiffuse || c.S !== S) {
    ({ plane, temp, blurFn } = diffuseStep(S, w, h, p));
    c.kDiffuse = kDiffuse;
  }
  if (!halo || c.kHalo !== kHalo || c.plane !== plane) {
    halo = haloStep(S, plane, w, h, p, blurFn, temp);
    c.kHalo = kHalo;
  }
  c.S = S;
  c.G = G;
  c.plane = plane;
  c.temp = temp;
  c.blurFn = blurFn;
  c.halo = halo;
  c.w = w;
  c.h = h;

  const out = blendStep({ rgb: linear }, halo, G, w, h, p);
  const display = encodeFromLinear(out, trc);
  const rgba = new Float32Array(w * h * 4);
  for (let i = 0, q = 0; i < w * h; i++, q += 3) {
    rgba[i * 4] = display[q];
    rgba[i * 4 + 1] = display[q + 1];
    rgba[i * 4 + 2] = display[q + 2];
    rgba[i * 4 + 3] = 1;
  }
  const png = floatRgbaToPng(w, h, rgba);
  return { dataUrl: pngToDataUrl(png), width: w, height: h, ms: Date.now() - t0, cache: c };
}
