// @ts-nocheck
/**
 * io/previewRender — 实时预览管线：文档像素 → 降采样(≤1024) → 线性 → fast 算法 →
 * 显示编码 → PNG data URL（面板内显示，不触碰文档，满足 A3 预览 <500ms）。
 * 注意：UXP 无 canvas/内置 PNG 编码，用 ui/pngEncoder 的最小编码器。
 */
import { extractStep, diffuseStep, haloStep, blendStep, processFilmStages, applyMatrix3, resolveSigmaParams } from '../core/index.js';
import { readDocumentPixels } from './imageAccess.js';
import { decodeToLinear, encodePanelPreviewSRGB, primariesMatrices, standardProfileName } from './colorPipeline.js';
import { documentComponentSize } from './bitDepth.js';
import {
  PREVIEW_EFFECT_MAX_EDGE,
  computePreviewScale,
  downsampleBox,
  downsampleExtractedFields,
  downsamplePlane,
} from './preview.js';
import { floatRgbToPng, pngToDataUrl } from '../ui/pngEncoder.js';
import { applyRolloff } from './rolloff.js';

/**
 * 读取面板预览原图（#4）：大图优先尝试 getPixels targetSize 金字塔直读小图
 * （IO 降 10-100×）；不支持/失败则回退全分辨率读取（模块级标记避免反复重试）。
 */
let targetSizeUnsupported = false;
const PANEL_COLOR_PROFILE = standardProfileName('sRGB');

function throwIfCancelled(signal) {
  if (signal?.aborted) throw new Error('Film render cancelled');
}

function assertFinitePreview(rgb) {
  for (let i = 0; i < rgb.length; i++) {
    if (!Number.isFinite(rgb[i])) throw new Error(`Preview produced a non-finite RGB sample at ${i}`);
  }
}
async function readPreviewSource(doc) {
  // Preserve native bit depth so Photoshop does not need to perform the
  // problematic 16 -> 8/32 conversion, while retaining its ICC conversion to
  // sRGB so panel midtones match the color-managed document canvas.
  const componentSize = documentComponentSize(doc);
  if (targetSizeUnsupported) return readDocumentPixels(doc, { componentSize, colorProfile: PANEL_COLOR_PROFILE });
  const scale = computePreviewScale(doc.width, doc.height);
  if (scale >= 0.5) return readDocumentPixels(doc, { componentSize, colorProfile: PANEL_COLOR_PROFILE }); // 小图无收益
  try {
    return await readDocumentPixels(doc, {
      // Keep the source bit depth. In particular, 16 -> 8/32 conversion can
      // trigger Photoshop's misleading smart-object update error even for a
      // plain pixel layer. targetSize still reduces the transferred pixels.
      componentSize,
      colorProfile: PANEL_COLOR_PROFILE,
      targetSize: {
        width: Math.max(1, Math.round(doc.width * scale)),
        height: Math.max(1, Math.round(doc.height * scale)),
      },
    });
  } catch (e) {
    targetSizeUnsupported = true;
    console.warn('[film-halation] getPixels targetSize unsupported, falling back to full read: ' + (e && e.message ? e.message : e));
    return readDocumentPixels(doc, { componentSize, colorProfile: PANEL_COLOR_PROFILE });
  }
}

/**
 * 增量预览渲染（Phase 6）：四步管线 + 中间量缓存。
 * 参数局部变更只重算受影响步骤（提取/扩散/halo/blend）。
 * @param {object} doc
 * @param {object} params HalationParams（预览强制 fast）
 * @param {{display?:object,effect?:object,decode?:(v:number)=>number,encode?:(v:number)=>number}} trc
 *   双源模式分别传 display/effect TRC；单源旧调用可直接传一个 TRC。
 * @param {object|null} cache 上次的 canonical 输入和中间量缓存
 * @param {{display?:object,effect?:object,cacheKey?:string,width?:number,height?:number,rgb?:Float32Array}|null} [source]
 *   双源模式：1024px ICC display + 2048px native effect；单源旧调用仍兼容。
 * @param {{signal?:AbortSignal,returnDataUrl?:boolean}} [options]
 * @returns {Promise<{dataUrl:string|null,png:Uint8Array,width:number,height:number,ms:number,cache:object,timings:object}>}
 */
export async function renderPreviewIncremental(doc, paramsOrDocument, trc, cache, source = null, options = {}) {
  const t0 = Date.now();
  const timings = { prepareMs: 0, algorithmMs: 0, encodeMs: 0, base64Ms: 0 };
  const signal = options.signal;
  throwIfCancelled(signal);
  const filmDocument = paramsOrDocument?.graph ? paramsOrDocument : null;
  const params = filmDocument?.graph.find((node) => node.type === 'halation')?.params ?? paramsOrDocument;
  const fallbackSource = source ? null : await readPreviewSource(doc);
  const displaySource = source?.display ?? source ?? fallbackSource;
  const effectSource = source?.effect ?? displaySource;
  const displayTrc = trc?.display ?? trc;
  const effectTrc = trc?.effect ?? displayTrc;
  const { width, height, rgb, alpha } = displaySource;

  const scale = computePreviewScale(width, height);
  let displayWork;
  if (scale < 1) {
    const dw = Math.max(1, Math.round(width * scale));
    const dh = Math.max(1, Math.round(height * scale));
    displayWork = {
      width: dw,
      height: dh,
      rgb: downsampleBox(rgb, width, height, dw, dh),
      alpha: alpha ? downsamplePlane(alpha, width, height, dw, dh) : undefined,
    };
  } else {
    displayWork = { width, height, rgb, alpha };
  }
  throwIfCancelled(signal);

  // 效果源保持文档原生 profile，并使用与 Apply 相同的 TRC + primaries 路径。
  // 只有 targetSize 回退返回过大图像时才在此限制到 2048px；正常宿主路径已直接
  // 请求 2048px 代理，避免先把非线性高光压到 1024px。
  const effectScale = computePreviewScale(effectSource.width, effectSource.height, PREVIEW_EFFECT_MAX_EDGE);
  let effectWork;
  if (effectScale < 1) {
    const ew = Math.max(1, Math.round(effectSource.width * effectScale));
    const eh = Math.max(1, Math.round(effectSource.height * effectScale));
    effectWork = {
      width: ew,
      height: eh,
      rgb: downsampleBox(effectSource.rgb, effectSource.width, effectSource.height, ew, eh),
      alpha: effectSource.alpha
        ? downsamplePlane(effectSource.alpha, effectSource.width, effectSource.height, ew, eh)
        : undefined,
    };
  } else {
    effectWork = effectSource;
  }
  throwIfCancelled(signal);

  const w = displayWork.width;
  const h = displayWork.height;
  const ew = effectWork.width;
  const eh = effectWork.height;
  const sourceKey = source?.cacheKey ?? displaySource?.cacheKey ?? null;
  const originX = source?.originX ?? displaySource?.originX ?? 0;
  const originY = source?.originY ?? displaySource?.originY ?? 0;
  timings.prepareMs = Date.now() - t0;
  const algorithmStarted = Date.now();
  const c = cache
    && cache.w === w
    && cache.h === h
    && cache.ew === ew
    && cache.eh === eh
    && sourceKey
    && cache.sourceKey === sourceKey
    ? cache
    : {};

  // 两条 canonical linear 输入只依赖源快照；缓存后，拖动参数无需重复解码
  // 约 5MP 像素或再次执行 Rec.2020 -> sRGB 矩阵。
  let baseLinear = c.baseLinear;
  if (!baseLinear) {
    baseLinear = decodeToLinear(displayWork.rgb, displayTrc);
    const { toSRGB: displayToSRGB } = primariesMatrices(displayTrc.baseKey);
    if (displayToSRGB) applyMatrix3(baseLinear, displayToSRGB);
    c.baseLinear = baseLinear;
  }
  throwIfCancelled(signal);
  let effectLinear = c.effectLinear;
  if (!effectLinear) {
    effectLinear = decodeToLinear(effectWork.rgb, effectTrc);
    const { toSRGB: effectToSRGB } = primariesMatrices(effectTrc.baseKey);
    if (effectToSRGB) applyMatrix3(effectLinear, effectToSRGB);
    c.effectLinear = effectLinear;
  }
  throwIfCancelled(signal);

  // #5：σ 单位按原图尺寸解析（预览小图的 σ 保持原图语义）
  const rp = resolveSigmaParams(params, doc.width || width, doc.height || height);
  const previewScale = Math.min(
    displayWork.width / Math.max(1, doc.width || width),
    displayWork.height / Math.max(1, doc.height || height),
  );
  const effectProxyScale = Math.min(
    effectWork.width / Math.max(1, doc.width || width),
    effectWork.height / Math.max(1, doc.height || height),
  );
  const p = { ...rp, sigma: Math.max(0.05, rp.sigma * previewScale), diffusionMode: 'fast' };
  // Source Expansion 在 2048px 光源代理上执行，其邻域半径必须使用代理尺度；
  // 扩散本身仍在 1024px 显示尺寸执行。
  const extractParams = { ...p, sigma: Math.max(0.05, rp.sigma * effectProxyScale) };
  const key = (o) => JSON.stringify(o);
  const kExtract = key({
    t: p.threshold,
    rb: p.redLayerThresholdBias,
    u: p.thresholdUnits,
    ss: p.sourceSoftness,
    bs: p.backgroundSoftness,
    bt: p.backgroundThreshold,
    ex: p.extraction,
    sm: p.spillMix,
    si: p.sourceImpact,
    amp: p.amplify,
    sx: p.sourceExpansion,
    es: extractParams.sigma,
    hs: p.hotSourceThreshold,
    hr: p.spectralSensitivity,
    bc: p.blueCompensation,
    ip: p.sourceInteriorProtection,
  });
  const kDiffuse = key({ s: p.sigma, sr: p.sigmaRatio, rs: p.redshift, smooth: p.smoothness, rt: p.redTail, mode: p.diffusionMode, w, h });
  const kHalo = key({
    ca: p.centerAttenuation,
    ip: p.sourceInteriorProtection,
    hc: p.hotCoreStrength,
    hs: p.hotSourceThreshold,
    gd: p.globalDiffusion,
    gs: p.globalSourceThreshold,
    dp: p.colorDensity > 0,
  });

  let { W, G, Y, U, K, sourceR, sourceG, sourceB, plane, temp, temp2, blurFn, halo, densityGate } = c;
  if (!W || c.kExtract !== kExtract) {
    const extracted = extractStep(
      { width: ew, height: eh, rgb: effectLinear, alpha: effectWork.alpha },
      extractParams,
      { luma: [0.2126, 0.7152, 0.0722], compact: true, keepW: true },
    );
    // 线性扩散所需的能量场使用面积平均，近似 downsample(blur(fullSource))；
    // 强源分类 U 按 W 加权，避免孤立强灯被零背景平均成弱光。
    ({ G, W, Y, U, K, sourceR, sourceG, sourceB } = downsampleExtractedFields(extracted, ew, eh, w, h));
    c.kExtract = kExtract;
  }
  throwIfCancelled(signal);
  if (!plane || c.kDiffuse !== kDiffuse || c.W !== W) {
    ({ plane, temp, temp2, blurFn } = diffuseStep({ sourceR, sourceG, sourceB, W, U, K }, w, h, p));
    c.kDiffuse = kDiffuse;
  }
  throwIfCancelled(signal);
  if (!halo || c.kHalo !== kHalo || c.plane !== plane) {
    const haloContext = {
      localGate: G,
      luminance: Y,
      sourceRgb: baseLinear,
    };
    halo = haloStep({ sourceR, sourceG, sourceB, W, U, K }, plane, w, h, p, blurFn, temp, temp2, haloContext);
    densityGate = haloContext.densityGate ?? null;
    c.kHalo = kHalo;
  }
  throwIfCancelled(signal);
  c.W = W;
  c.G = G;
  c.Y = Y;
  c.U = U;
  c.K = K;
  c.sourceR = sourceR;
  c.sourceG = sourceG;
  c.sourceB = sourceB;
  c.plane = plane;
  c.temp = temp;
  c.temp2 = temp2;
  c.blurFn = blurFn;
  c.halo = halo;
  c.densityGate = densityGate;
  c.w = w;
  c.h = h;
  c.ew = ew;
  c.eh = eh;
  c.sourceKey = sourceKey;

  // 注意：halo 是缓存中间量，blend 必须分配新输出（不能就地写坏缓存）
  const kBlend = key(p);
  const cachedHalationOut = c.halationOut
    && c.kBlend === kBlend
    && c.blendHalo === halo
    && c.blendInput === baseLinear
    ? c.halationOut
    : null;
  const halationOut = cachedHalationOut ?? {
    width: w,
    height: h,
    rgb: blendStep({ rgb: baseLinear }, halo, null, w, h, p, densityGate),
    alpha: displayWork.alpha,
  };
  c.kBlend = kBlend;
  c.blendHalo = halo;
  c.blendInput = baseLinear;
  c.halationOut = halationOut;
  const laterNodes = filmDocument?.graph.filter((node) => node.type === 'filmResolution' || node.type === 'grain') ?? [];
  const graphKey = JSON.stringify({
    nodes: laterNodes,
    format: filmDocument?.format ?? null,
    fullWidth: doc.width || width,
    fullHeight: doc.height || height,
    originX,
    originY,
    previewScale,
    quality: 'fast',
  });
  c.nodeCaches ??= Object.create(null);
  const graphResult = c.graphResult
    && c.graphKey === graphKey
    && c.graphInput === halationOut.rgb
    ? c.graphResult
    : laterNodes.length
      ? processFilmStages(
        { width: w, height: h, rgb: halationOut.rgb, alpha: displayWork.alpha },
        laterNodes,
        {
          width: w,
          height: h,
          fullWidth: doc.width || width,
          fullHeight: doc.height || height,
          originX,
          originY,
          previewScale,
          format: filmDocument?.format,
          quality: 'fast',
          seed: laterNodes.find((node) => node.type === 'grain')?.params.seed ?? 0,
          signal,
          nodeCaches: c.nodeCaches,
        },
      )
      : halationOut;
  throwIfCancelled(signal);
  c.graphKey = graphKey;
  c.graphInput = halationOut.rgb;
  c.graphResult = graphResult;
  assertFinitePreview(graphResult.rgb);
  timings.algorithmMs = Date.now() - algorithmStarted;
  // Panel PNG has no embedded ICC profile. Keep the canonical linear-sRGB
  // result in sRGB primaries and encode with the sRGB TRC so sp-image does not
  // misinterpret Rec.2020/ProPhoto numeric values as sRGB.
  const display = encodePanelPreviewSRGB(graphResult.rgb);
  // 2.3：面板预览与画布写回保持一致的 soft-knee（>1 值软滚降；0=硬裁剪）
  if (p.rolloff > 0) applyRolloff(display, p.rolloff);
  throwIfCancelled(signal);
  const encodeStarted = Date.now();
  const png = floatRgbToPng(w, h, display, displayWork.alpha);
  timings.encodeMs = Date.now() - encodeStarted;
  throwIfCancelled(signal);
  let dataUrl = null;
  if (options.returnDataUrl !== false) {
    const base64Started = Date.now();
    dataUrl = pngToDataUrl(png);
    timings.base64Ms = Date.now() - base64Started;
  }
  return { dataUrl, png, width: w, height: h, ms: Date.now() - t0, cache: c, timings };
}
