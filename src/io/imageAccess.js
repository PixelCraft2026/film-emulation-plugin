// @ts-nocheck
/**
 * io/imageAccess — 像素读写封装（唯一接触 imaging API 的模块之一）。
 * 基于 capability spike 实测（PS 27.1 / uxp 9.0.2）：
 *  - getPixels/putPixels 在 require('photoshop').imaging（不在 document 上）；
 *  - sourceBounds 用 {left,top,right,bottom}；componentSize 用数字 8/16/32；
 *  - 写回必须 createImageDataFromBuffer 包装，用完 dispose()；
 *  - 修改文档状态需在 ps.core.executeAsModal 内。
 *
 * 本层职责：像素搬运 + 位深归一化到显示编码 float（0..1，32-bit 可 >1 HDR）。
 * TRC decode/encode 由 io/colorPipeline 负责（本层不假设位深与 TRC 绑定）。
 */
const ps = require('photoshop');
import { resolveDocumentTRC, standardProfileName, matchProfileName } from './colorPipeline.js';
import { resolveTargetLayer, noTargetLayerMessage, isPixelLayer, unreadableLayerMessage, layerPixelBounds, findLayerByIdRecursive, resolveLayerBinding, unlockPixelLayer } from './layerOps.js';
import { splitBlocks } from './tiles.js';
import { blueNoise } from '../core/dither.js';
import { outputKnee } from './rolloff.js';
import { normalizeComponentSize, clampPhotoshop16 } from './bitDepth.js';

/** 16-bit 归一化除数（PS 15+1 编码，fullRange=false 时 32768 = 1.0）。 */
const NORM_16 = 32768;

/**
 * 单次 getPixels/putPixels 的最大像素数（安全块大小）。
 * 真机已验证：UXP 对超大单次调用会静默降采样/缩放——3504x2336（8.2MP）正常，
 * 7008x4672 被缩到 1/4、14016x9344 被缩到 1/16（capability 的 24MP 均匀测试图恰好
 * 掩盖了该问题）。每块 ≤4MP 远低于疑似阈值，分块传输保证原始分辨率。
 */
const MAX_BLOCK_PX = 4 * 1024 * 1024;

/** 打印文档所有图层的 id/kind/name 清单（多图层 id 反查失败的诊断）。 */
function describeLayerList(doc) {
  try {
    const parts = [];
    const layers = doc.layers;
    if (layers && typeof layers.length === 'number') {
      for (let i = 0; i < layers.length; i++) {
        let id = '?';
        let kind = '?';
        let name = '?';
        try { id = layers[i].id; } catch (e) { /* ignore */ }
        try { kind = String(layers[i].kind); } catch (e) { /* ignore */ }
        try { name = String(layers[i].name); } catch (e) { /* ignore */ }
        parts.push(`${id}/${kind}/${name}`);
      }
    }
    return `[${parts.join(', ')}]`;
  } catch (e) {
    return '?';
  }
}

/** 文档上下文摘要（供错误诊断，任何一项读取失败显示 ?）。 */
function describeDocumentContext(doc) {
  let mode = '?';
  let bits = '?';
  let profile = '?';
  let soCount = '?';
  try { mode = String(doc.mode); } catch (e) { /* ignore */ }
  try { bits = String(doc.bitsPerChannel); } catch (e) { /* ignore */ }
  try { profile = String(doc.colorProfileName ?? doc.colorProfile ?? ''); } catch (e) { /* ignore */ }
  try {
    const layers = doc.layers;
    let n = 0;
    if (layers && typeof layers.length === 'number') {
      for (let i = 0; i < layers.length; i++) {
        try {
          if (String(layers[i].kind) === 'smartObject') n++;
        } catch (e) { /* ignore */ }
      }
    }
    soCount = String(n);
  } catch (e) { /* ignore */ }
  return `mode:${mode}, bits:${bits}, profile:"${profile}", smartObjects:${soCount}`;
}

function describeLayer(layer) {
  if (!layer) return 'layer:null';
  let id = '?';
  let kind = 'unknown';
  let name = '?';
  try { id = layer.id; } catch (e) { /* ignore */ }
  try { kind = String(layer.kind); } catch (e) { /* ignore */ }
  try { name = String(layer.name); } catch (e) { /* ignore */ }
  return `layer{id:${id}, kind:${kind}, name:"${name}"}`;
}

/**
 * 解析可读写目标图层（返回图层对象）：显式 layerID 先递归反查（组嵌套），
 * 失败时只允许 layerName 唯一匹配；未指定时解析当前目标图层并做像素类型检查。
 * 非 RGB 模式提前给出转换指引（UXP imaging 色彩转换对非 RGB 文档不可靠，
 * 真机已见 PS 原生错误）。
 * @param {object} doc
 * @param {number|undefined} explicitLayerID
 * @param {string} [layerName] 反查兜底用的图层名（快照场景）
 * @returns {object} Layer（null 表示交给 PS 原生裁决）
 */
function resolveReadableLayer(doc, explicitLayerID, layerName) {
  let mode = '?';
  try { mode = String(doc.mode); } catch (e) { /* ignore */ }
  if (mode !== 'RGBColorMode') {
    throw new Error(`Document mode is ${mode} - only RGB documents are supported. Convert to RGB (Image > Mode > RGB Color) and retry.`);
  }
  if (typeof explicitLayerID === 'number') {
    // 多图层修复：递归组层级反查（组内图层 / activeLayers-layers id 不一致场景）
    const found = findLayerByIdRecursive(doc, explicitLayerID);
    if (found) return found;
    // id 反查失败：名称兜底必须唯一；重名或更名都不猜测。
    if (layerName) {
      const byName = resolveLayerBinding(doc, { id: explicitLayerID, name: layerName, token: '' });
      if (byName) {
        console.warn(
          `[film-halation] layerID=${explicitLayerID} not found by id; matched by name "${layerName}" (id=${byName.id})`,
        );
        return byName;
      }
    }
    // UXP PS 27：doc.activeLayers[i].id 与 doc.layers[i].id 对同一图层可能返回不同值
    //（真机见多图层时按 id 反查失败——单图层恰好匹配）。不抛错：layerID 直接交给 PS
    // 原生 getPixels/putPixels 裁决（单图层验证过 PS 能接受该 id）；返回 null，调用方
    // 回退到 opts.layerID 原值并打印图层清单供诊断。
    console.warn(
      `[film-halation] layerID=${explicitLayerID} not found by id/name lookup (UXP id mismatch?); layers=${describeLayerList(doc)}`,
    );
    return null;
  }
  const layer = resolveTargetLayer(doc);
  if (!layer) throw new Error(noTargetLayerMessage(doc));
  if (!isPixelLayer(layer)) throw new Error(unreadableLayerMessage(layer));
  return layer;
}

/** getPixels 瞬态失败（剪贴板/复制通道竞争）重试一次，结构性错误直接抛。 */
async function getPixelsWithRetry(args, context) {
  try {
    return await ps.imaging.getPixels(args);
  } catch (e) {
    await new Promise((r) => setTimeout(r, 60));
    try {
      return await ps.imaging.getPixels(args);
    } catch (e2) {
      throw new Error(`${context} - ${e2 && (e2.message || e2)}`);
    }
  }
}

/**
 * 读取文档目标图层的像素。
 * 默认归一化到显示编码 float RGB + 独立 alpha；opts.raw=true 时返回原始 RGB 位深数据
 * （Uint8Array/Uint16Array/Float32Array，供 4.1 紧凑快照——8/16-bit 文档
 * 常驻内存降 2~4×，处理时才转 float）。
 * opts.targetSize：请求 PS 金字塔降采样缓存（#4 面板预览直读小图，IO 降 10-100×；
 * 真机支持需验证——尺寸校验失败/抛错由调用方回退全分辨率读取）。
 * targetSize 模式下禁用分块（单次调用；预览小图远低于 4MP 上限）。
 * @param {object} doc Photoshop Document
 * @param {{layerID?:number,bounds?:{left:number,top:number,right:number,bottom:number},componentSize?:number,colorProfile?:string,raw?:boolean,targetSize?:{width:number,height:number}}} [opts]
 * @returns {Promise<{width:number,height:number,rgb?:Float32Array,alpha:Float32Array,data?:Uint8Array|Uint16Array|Float32Array,componentSize:number,colorProfile:string}>}
 */
export async function readDocumentPixels(doc, opts = {}) {
  const { bounds, raw = false, targetSize } = opts;
  const componentSize = normalizeComponentSize(opts.componentSize ?? 32);
  const layer = resolveReadableLayer(doc, opts.layerID, opts.layerName);
  const layerID = layer ? layer.id : opts.layerID;
  if (typeof layerID !== 'number') {
    throw new Error(noTargetLayerMessage(doc));
  }
  // 目标区域 = 图层有效像素范围（文档坐标）；boundsNoEffects 不可用则回退全文档
  const region = bounds ?? (layer && layerPixelBounds(layer)) ?? { left: 0, top: 0, right: doc.width, bottom: doc.height };
  const width = targetSize ? targetSize.width : region.right - region.left;
  const height = targetSize ? targetSize.height : region.bottom - region.top;
  const n = width * height;
  const context = `getPixels failed: doc{${describeDocumentContext(doc)}} ${describeLayer(layer)}`;

  const rgb = new Float32Array(n * 3);
  const alpha = new Float32Array(n);
  const rawData = raw
    ? componentSize === 8
      ? new Uint8Array(n * 3)
      : componentSize === 16
        ? new Uint16Array(n * 3)
        : new Float32Array(n * 3)
    : null;
  // 分块读取（单次调用超限会被 PS 静默降采样/缩放，见 MAX_BLOCK_PX 注释）。
  // targetSize 模式：单次调用（预览小图），禁用分块。
  const blocks = targetSize ? [{ top: 0, h: region.bottom - region.top }] : splitBlocks(width, height, MAX_BLOCK_PX);
  let returnedColorProfile = '';
  console.log(
    `[film-halation] read: doc=${doc.width}x${doc.height} region=${region.left},${region.top},${region.right},${region.bottom} blocks=${blocks.length} -> ${width}x${height}${raw ? ` (raw ${componentSize}-bit)` : ''}${targetSize ? ` (targetSize ${width}x${height})` : ''}`,
  );
  for (const b of blocks) {
    const { imageData, level } = await getPixelsWithRetry(
      {
        documentID: doc.id,
        layerID,
        sourceBounds: {
          left: region.left,
          top: region.top + b.top,
          right: targetSize ? region.right : region.left + width,
          bottom: targetSize ? region.bottom : region.top + b.top + b.h,
        },
        colorSpace: 'RGB',
        // Preview requests sRGB explicitly so Photoshop's ICC engine performs
        // the document-profile conversion. Apply omits this and receives the
        // source document profile unchanged.
        ...(opts.colorProfile ? { colorProfile: opts.colorProfile } : {}),
        componentSize,
        // V1.5：禁止透明区白色铺底；RGBA 分离读取并在写回时恢复同一 alpha。
        applyAlpha: false,
        // #4：请求金字塔降采样缓存（真机支持待验证；调用方负责回退）
        ...(targetSize ? { targetSize } : {}),
      },
      context,
    );
    // 金字塔缓存防御：未请求 targetSize 时不应返回降采样 level（官方文档：
    // level 0 = 全分辨率；>0 = 降采样缓存）。返回 >0 说明单块仍过大，需调小 MAX_BLOCK_PX。
    // targetSize 模式下 level>0 是预期行为（降采样缓存）。
    if (typeof level === 'number' && level !== 0 && !targetSize) {
      imageData.dispose();
      throw new Error(`${context} - PS returned cached level ${level} (downscaled); block too large?`);
    }
    // 校验返回尺寸与通道数（防静默降采样/意外 alpha 通道）
    const gotW = typeof imageData.width === 'number' ? imageData.width : width;
    const gotH = typeof imageData.height === 'number' ? imageData.height : b.h;
    const wOk = targetSize ? Math.abs(gotW - width) <= 1 : gotW === width;
    const hOk = targetSize ? Math.abs(gotH - height) <= 1 : gotH === b.h;
    if (!wOk || !hOk) {
      imageData.dispose();
      throw new Error(`${context} - UXP returned ${gotW}x${gotH} for requested ${width}x${targetSize ? height : b.h} (downscaled?)`);
    }
    const components = typeof imageData.components === 'number' ? imageData.components : 4;
    const blockColorProfile = String(imageData.colorProfile || '');
    if (!returnedColorProfile) returnedColorProfile = blockColorProfile;
    else if (blockColorProfile && blockColorProfile !== returnedColorProfile) {
      imageData.dispose();
      throw new Error(`${context} - inconsistent block color profiles: "${returnedColorProfile}" vs "${blockColorProfile}"`);
    }
    if (components !== 3 && components !== 4) {
      imageData.dispose();
      throw new Error(`${context} - UXP returned ${imageData.components} components (expected RGB or RGBA)`);
    }
    const arr = await imageData.getData();
    imageData.dispose();

    const rowStride = width * 3;
    const blockTop = targetSize ? 0 : b.top;
    const base = blockTop * rowStride;
    const alphaBase = blockTop * width;
    const pixels = targetSize ? width * height : width * b.h;
    const norm = componentSize === 8 ? 255 : componentSize === 16 ? NORM_16 : 1;
    for (let i = 0; i < pixels; i++) {
      const src = i * components;
      const dst = base + i * 3;
      alpha[alphaBase + i] = components === 4 ? arr[src + 3] / norm : 1;
      if (raw) {
        rawData[dst] = arr[src];
        rawData[dst + 1] = arr[src + 1];
        rawData[dst + 2] = arr[src + 2];
      } else {
        rgb[dst] = arr[src] / norm;
        rgb[dst + 1] = arr[src + 1] / norm;
        rgb[dst + 2] = arr[src + 2] / norm;
      }
    }
  }
  if (raw) return { width, height, data: rawData, alpha, componentSize, colorProfile: returnedColorProfile };
  return { width, height, rgb, alpha, componentSize, colorProfile: returnedColorProfile };
}

/**
 * 把显示编码 float RGB 写回指定图层（自动按位深量化）。
 * 必须在 executeAsModal 内调用。HDR >1 值仅 32-bit 文档保留（8/16-bit 会 clamp，符合预期）。
 * @param {object} doc Photoshop Document
 * @param {{width:number,height:number,rgb:Float32Array,alpha?:Float32Array}} image 显示编码 RGB + 原始 alpha
 * @param {{layerID?:number,layerName?:string,componentSize?:number,colorProfile?:string,rolloff?:number,dither?:boolean,seed?:number,bounds?:object}} [opts]
 *   layerID：目标图层（默认活动图层）；layerName：id 反查失败时的名称兜底（快照场景）；
 *   colorProfile：数据声明的标准 ICC profile 名；显式传入空字符串时不在
 *   createImageDataFromBuffer 中声明 profile，putPixels 将使用目标文档 profile。
 *   未提供该属性时按文档工作空间解析（兼容旧调用方）。
 *   rolloff：2.3 高光软拐点 0..1（仅 8/16-bit 量化前对 >1 值软滚降；0=硬裁剪，32-bit 不适用）。
 * @returns {Promise<void>}
 */
export async function writeDocumentPixels(doc, image, opts = {}) {
  const buffer = encodeDisplayRgbaBuffer(image, opts.componentSize ?? 32, opts);
  return writeDocumentRgbaBuffer(doc, { width: image.width, height: image.height, buffer }, opts);
}

/** 将显示编码 RGB/alpha 量化为一次 putPixels 所需的 RGBA buffer。 */
export function encodeDisplayRgbaBuffer(image, componentSize, opts = {}) {
  componentSize = normalizeComponentSize(componentSize);
  const { rolloff = 0, dither = true, seed = 0x46534c4d, pixelOffset = 0 } = opts;
  const n = image.width * image.height;
  const knee = rolloff > 0 ? (v) => outputKnee(v, rolloff) : (v) => v;
  const buffer = componentSize === 8 ? new Uint8Array(n * 4) : componentSize === 16 ? new Uint16Array(n * 4) : new Float32Array(n * 4);
  const norm = componentSize === 8 ? 255 : componentSize === 16 ? NORM_16 : 1;
  const clamp = componentSize === 8 ? clampByte : componentSize === 16 ? clampPhotoshop16 : (v) => v;
  for (let i = 0, p = 0; i < n; i++, p += 3) {
    const absolute = pixelOffset + i;
    const noise0 = dither && componentSize !== 32 ? quantizationNoise(absolute, 0, seed, image.width) : 0;
    const noise1 = dither && componentSize !== 32 ? quantizationNoise(absolute, 1, seed, image.width) : 0;
    const noise2 = dither && componentSize !== 32 ? quantizationNoise(absolute, 2, seed, image.width) : 0;
    buffer[i * 4] = clamp(knee(image.rgb[p]) * norm + noise0);
    buffer[i * 4 + 1] = clamp(knee(image.rgb[p + 1]) * norm + noise1);
    buffer[i * 4 + 2] = clamp(knee(image.rgb[p + 2]) * norm + noise2);
    buffer[i * 4 + 3] = clamp((image.alpha ? image.alpha[i] : 1) * norm);
  }
  return buffer;
}

/** 一次性写入已经编码的 RGBA buffer；供行带渲染避免同时保留整图 RGB。 */
export async function writeDocumentRgbaBuffer(doc, image, opts = {}) {
  const componentSize = normalizeComponentSize(opts.componentSize ?? 32);
  const layer = resolveReadableLayer(doc, opts.layerID, opts.layerName);
  const layerID = layer ? layer.id : opts.layerID;
  if (typeof layerID !== 'number') throw new Error(noTargetLayerMessage(doc));
  const { width, height, buffer } = image;
  if (!buffer || buffer.length !== width * height * 4) throw new Error('RGBA output buffer length mismatch');
  const trc = resolveDocumentTRC(doc);
  const hasColorProfileOption = Object.prototype.hasOwnProperty.call(opts, 'colorProfile');
  let colorProfile = hasColorProfileOption ? String(opts.colorProfile || '') : '';
  if (!hasColorProfileOption) colorProfile = (await resolveWriteProfile(trc.baseKey)) ?? standardProfileName('sRGB');
  const region = opts.bounds ?? (layer && layerPixelBounds(layer)) ?? { left: 0, top: 0, right: doc.width, bottom: doc.height };
  if (region.right - region.left !== width || region.bottom - region.top !== height) {
    throw new Error(`Layer bounds mismatch: writing ${width}x${height} but target is ${region.right - region.left}x${region.bottom - region.top}`);
  }
  const imageDataOptions = {
    width,
    height,
    components: 4,
    colorSpace: 'RGB',
    // An omitted profile is intentional for the Apply path: Adobe specifies
    // that empty-profile image data adopts the target document profile. This
    // also avoids feeding getPixels-only profile labels back to the creator.
    ...(colorProfile ? { colorProfile } : {}),
  };
  const imageData = await ps.imaging.createImageDataFromBuffer(buffer, imageDataOptions);
  if (layer) {
    unlockPixelLayer(layer);
    try { doc.activeLayers = [layer]; } catch (e) { /* ignore */ }
  }
  const put = () => ps.imaging.putPixels({
    documentID: doc.id,
    layerID,
    imageData,
    replace: true,
    targetBounds: { left: region.left, top: region.top },
  });
  try {
    await put();
  } catch (error) {
    const message = String(error && (error.message || error));
    if (!/protected/i.test(message)) throw new Error(`putPixels failed: ${message}`);
    if (layer) unlockPixelLayer(layer);
    try { await put(); } catch (retry) { throw new Error(`putPixels failed: ${retry && (retry.message || retry)}`); }
  } finally {
    imageData.dispose();
  }
}

/**
 * 从 PS 可用 RGB profile 名单中按 baseKey 匹配写回名（结果缓存；PS 颜色设置变化需重载插件）。
 * @param {'sRGB'|'DisplayP3'|'AdobeRGB'|'ProPhoto'|'Rec2020'} baseKey
 * @returns {Promise<string|null>}
 */
let profileCache = null;
async function resolveWriteProfile(baseKey) {
  try {
    if (!profileCache) profileCache = await ps.app.getColorProfiles('RGB');
    return matchProfileName(profileCache, baseKey);
  } catch (e) {
    console.error('[film-halation] getColorProfiles failed:', e && (e.message || e));
    return null;
  }
}

function clampByte(v) {
  return v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
}
/** 确定性零均值量化抖动（[-0.5, 0.5) LSB），不修改 alpha。 */
export function quantizationNoise(index, channel, seed, width = 64) {
  return blueNoise(index, width, channel, seed);
}

export { outputKnee } from './rolloff.js';
