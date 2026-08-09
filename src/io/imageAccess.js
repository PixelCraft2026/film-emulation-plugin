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

/** 16-bit 归一化除数（PS 15+1 编码，fullRange=false 时 32768 = 1.0）。 */
const NORM_16 = 32768;

/**
 * 读取文档活动图层的像素，归一化到显示编码 float RGB。
 * @param {object} doc Photoshop Document
 * @param {{bounds?:{left:number,top:number,right:number,bottom:number},componentSize?:number}} [opts]
 * @returns {Promise<{width:number,height:number,rgb:Float32Array,componentSize:number}>}
 */
export async function readDocumentPixels(doc, opts = {}) {
  const { bounds, componentSize = 32 } = opts;
  const layerID = doc.activeLayers[0].id;
  const sourceBounds = bounds ?? { left: 0, top: 0, right: doc.width, bottom: doc.height };
  const width = sourceBounds.right - sourceBounds.left;
  const height = sourceBounds.bottom - sourceBounds.top;

  const { imageData } = await ps.imaging.getPixels({
    layerID,
    sourceBounds,
    colorSpace: 'RGB',
    componentSize,
    applyAlpha: false,
  });
  const arr = await imageData.getData();
  imageData.dispose();

  const n = width * height;
  const rgb = new Float32Array(n * 3);
  const src = arr; // Uint8Array | Uint16Array | Float32Array
  if (componentSize === 8) {
    for (let i = 0; i < n * 3; i++) rgb[i] = src[i] / 255;
  } else if (componentSize === 16) {
    for (let i = 0; i < n * 3; i++) rgb[i] = src[i] / NORM_16;
  } else {
    for (let i = 0; i < n * 3; i++) rgb[i] = src[i]; // 32-bit：0..1，可 >1
  }
  return { width, height, rgb, componentSize };
}

/**
 * 把显示编码 float RGB 写回指定图层（自动按位深量化）。
 * 必须在 executeAsModal 内调用。HDR >1 值仅 32-bit 文档保留（8/16-bit 会 clamp，符合预期）。
 * @param {object} doc Photoshop Document
 * @param {{width:number,height:number,rgb:Float32Array}} image 显示编码 RGB
 * @param {{layerID?:number,componentSize?:number}} [opts] layerID：目标图层（默认活动图层）
 * @returns {Promise<void>}
 */
export async function writeDocumentPixels(doc, image, opts = {}) {
  const { layerID: explicitLayerID, componentSize = 32 } = opts;
  const layerID = explicitLayerID ?? doc.activeLayers[0].id;
  const width = image.width;
  const height = image.height;

  let buf;
  if (componentSize === 8) {
    buf = new Uint8Array(width * height * 4);
    for (let i = 0, p = 0; i < width * height; i++, p += 3) {
      buf[i * 4] = clampByte(image.rgb[p] * 255);
      buf[i * 4 + 1] = clampByte(image.rgb[p + 1] * 255);
      buf[i * 4 + 2] = clampByte(image.rgb[p + 2] * 255);
      buf[i * 4 + 3] = 255;
    }
  } else if (componentSize === 16) {
    buf = new Uint16Array(width * height * 4);
    for (let i = 0, p = 0; i < width * height; i++, p += 3) {
      buf[i * 4] = clampU16(image.rgb[p] * NORM_16);
      buf[i * 4 + 1] = clampU16(image.rgb[p + 1] * NORM_16);
      buf[i * 4 + 2] = clampU16(image.rgb[p + 2] * NORM_16);
      buf[i * 4 + 3] = 32768;
    }
  } else {
    buf = new Float32Array(width * height * 4);
    for (let i = 0, p = 0; i < width * height; i++, p += 3) {
      buf[i * 4] = image.rgb[p];
      buf[i * 4 + 1] = image.rgb[p + 1];
      buf[i * 4 + 2] = image.rgb[p + 2];
      buf[i * 4 + 3] = 1.0;
    }
  }

  const imageData = await ps.imaging.createImageDataFromBuffer(buf, {
    width,
    height,
    components: 4,
    colorSpace: 'RGB',
    colorProfile: 'sRGB IEC61966-2.1',
  });
  try {
    await ps.imaging.putPixels({
      layerID,
      imageData,
      replace: true,
    });
  } finally {
    imageData.dispose();
  }
}

function clampByte(v) {
  return v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
}
function clampU16(v) {
  return v < 0 ? 0 : v > 65535 ? 65535 : Math.round(v);
}
