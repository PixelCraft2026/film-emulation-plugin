// @ts-nocheck
/**
 * io/previewRender — 实时预览管线：文档像素 → 降采样(≤1024) → 线性 → fast 算法 →
 * 显示编码 → PNG data URL（面板内显示，不触碰文档，满足 A3 预览 <500ms）。
 * 注意：UXP 无 canvas/内置 PNG 编码，用 ui/pngEncoder 的最小编码器。
 */
import { extractStep, diffuseStep, haloStep, blendStep, applyMatrix3, resolveSigmaParams } from '../core/index.js';
import { readDocumentPixels } from './imageAccess.js';
import { decodeToLinear, encodePanelPreviewSRGB, primariesMatrices, standardProfileName } from './colorPipeline.js';
import { computePreviewScale, downsampleBox, downsamplePlane } from './preview.js';
import { floatRgbaToPng, pngToDataUrl } from '../ui/pngEncoder.js';
import { applyRolloff } from './rolloff.js';

/**
 * 读取面板预览原图（#4）：大图优先尝试 getPixels targetSize 金字塔直读小图
 * （IO 降 10-100×）；不支持/失败则回退全分辨率读取（模块级标记避免反复重试）。
 */
let targetSizeUnsupported = false;
const PANEL_COLOR_PROFILE = standardProfileName('sRGB');
async function readPreviewSource(doc) {
  if (targetSizeUnsupported) return readDocumentPixels(doc, { componentSize: 32, colorProfile: PANEL_COLOR_PROFILE });
  const scale = computePreviewScale(doc.width, doc.height);
  if (scale >= 0.5) return readDocumentPixels(doc, { componentSize: 32, colorProfile: PANEL_COLOR_PROFILE }); // 小图无收益
  try {
    return await readDocumentPixels(doc, {
      componentSize: 8, // 预览精度足够；传输量 1/4
      colorProfile: PANEL_COLOR_PROFILE,
      targetSize: {
        width: Math.max(1, Math.round(doc.width * scale)),
        height: Math.max(1, Math.round(doc.height * scale)),
      },
    });
  } catch (e) {
    targetSizeUnsupported = true;
    console.warn('[film-halation] getPixels targetSize unsupported, falling back to full read: ' + (e && e.message ? e.message : e));
    return readDocumentPixels(doc, { componentSize: 32, colorProfile: PANEL_COLOR_PROFILE });
  }
}

/**
 * 增量预览渲染（Phase 6）：四步管线 + 中间量缓存。
 * 参数局部变更只重算受影响步骤（提取/扩散/halo/blend）。
 * @param {object} doc
 * @param {object} params HalationParams（预览强制 fast）
 * @param {{decode:(v:number)=>number,encode:(v:number)=>number}} trc
 * @param {object|null} cache 上次的中间量缓存（{W,G,plane,temp,temp2,blurFn,halo,kExtract,kDiffuse,kHalo}）
 * @param {{width:number,height:number,rgb:Float32Array}|null} [source] 显示编码原图像素
 *   （可由调用方提供只读源快照；传 null 时从文档图层读取）
 * @returns {Promise<{dataUrl:string,width:number,height:number,ms:number,cache:object}>}
 */
export async function renderPreviewIncremental(doc, params, trc, cache, source = null) {
  const t0 = Date.now();
  const { width, height, rgb, alpha } = source ?? (await readPreviewSource(doc));

  const scale = computePreviewScale(width, height);
  let work;
  if (scale < 1) {
    const dw = Math.max(1, Math.round(width * scale));
    const dh = Math.max(1, Math.round(height * scale));
    work = {
      width: dw,
      height: dh,
      rgb: downsampleBox(rgb, width, height, dw, dh),
      alpha: alpha ? downsamplePlane(alpha, width, height, dw, dh) : undefined,
    };
  } else {
    work = { width, height, rgb, alpha };
  }
  const linear = decodeToLinear(work.rgb, trc);
  // #7 canonical space：面板预览同样统一到线性 sRGB primaries（luma 恒 Rec.709）
  const { toSRGB } = primariesMatrices(trc.baseKey);
  if (toSRGB) applyMatrix3(linear, toSRGB);
  // #5：σ 单位按原图尺寸解析（预览小图的 σ 保持原图语义）
  const rp = resolveSigmaParams(params, doc.width || width, doc.height || height);
  const previewScale = Math.min(work.width / Math.max(1, doc.width || width), work.height / Math.max(1, doc.height || height));
  const p = { ...rp, sigma: Math.max(0.05, rp.sigma * previewScale), diffusionMode: 'fast' };
  const w = work.width;
  const h = work.height;

  const key = (o) => JSON.stringify(o);
  const kExtract = key({
    t: p.threshold,
    u: p.thresholdUnits,
    ss: p.sourceSoftness,
    bs: p.backgroundSoftness,
    bt: p.backgroundThreshold,
    ex: p.extraction,
    sm: p.spillMix,
  });
  const kDiffuse = key({ s: p.sigma, sr: p.sigmaRatio, rs: p.redshift, smooth: p.smoothness, mode: p.diffusionMode, w, h });
  const kHalo = key({ ca: p.centerAttenuation, gd: p.globalDiffusion });

  const sourceKey = source?.cacheKey ?? null;
  const c = cache && cache.w === w && cache.h === h && sourceKey && cache.sourceKey === sourceKey ? cache : {};
  let { W, G, Y, sourceR, sourceG, sourceB, plane, temp, temp2, blurFn, halo } = c;
  if (!W || c.kExtract !== kExtract) {
    ({ G, W, Y, sourceR, sourceG, sourceB } = extractStep(
      { width: w, height: h, rgb: linear, alpha: work.alpha },
      p,
      { luma: [0.2126, 0.7152, 0.0722] },
    ));
    c.kExtract = kExtract;
  }
  if (!plane || c.kDiffuse !== kDiffuse || c.W !== W) {
    ({ plane, temp, temp2, blurFn } = diffuseStep({ sourceR, sourceG, sourceB, W }, w, h, p));
    c.kDiffuse = kDiffuse;
  }
  if (!halo || c.kHalo !== kHalo || c.plane !== plane) {
    halo = haloStep({ sourceR, sourceG, sourceB, W }, plane, w, h, p, blurFn, temp, temp2, {
      localGate: G,
      luminance: Y,
    });
    c.kHalo = kHalo;
  }
  c.W = W;
  c.G = G;
  c.Y = Y;
  c.sourceR = sourceR;
  c.sourceG = sourceG;
  c.sourceB = sourceB;
  c.plane = plane;
  c.temp = temp;
  c.temp2 = temp2;
  c.blurFn = blurFn;
  c.halo = halo;
  c.w = w;
  c.h = h;
  c.sourceKey = sourceKey;

  // 注意：halo 是缓存中间量，blend 必须分配新输出（不能就地写坏缓存）
  const out = blendStep({ rgb: linear }, halo, null, w, h, p);
  // Panel PNG has no embedded ICC profile. Keep the canonical linear-sRGB
  // result in sRGB primaries and encode with the sRGB TRC so sp-image does not
  // misinterpret Rec.2020/ProPhoto numeric values as sRGB.
  const display = encodePanelPreviewSRGB(out);
  // 2.3：面板预览与画布写回保持一致的 soft-knee（>1 值软滚降；0=硬裁剪）
  if (p.rolloff > 0) applyRolloff(display, p.rolloff);
  const rgba = new Float32Array(w * h * 4);
  for (let i = 0, q = 0; i < w * h; i++, q += 3) {
    rgba[i * 4] = display[q];
    rgba[i * 4 + 1] = display[q + 1];
    rgba[i * 4 + 2] = display[q + 2];
    rgba[i * 4 + 3] = work.alpha ? work.alpha[i] : 1;
  }
  const png = floatRgbaToPng(w, h, rgba);
  return { dataUrl: pngToDataUrl(png), width: w, height: h, ms: Date.now() - t0, cache: c };
}
