// @ts-nocheck
/**
 * io/colorPipeline — 色彩管理编排（唯一负责 TRC 与 profile 映射的模块）。
 * 职责：
 *  - 解析 document.colorProfile 字符串 → TRC 枚举（sRGB/AdobeRGB/ProPhoto）；
 *  - 未知 profile → 明确拒绝（抛错），绝不猜测色彩空间（TDD R-2 / C4 语义）；
 *  - 提供整图批量 decode（显示编码→线性）与 encode（线性→显示编码），
 *    decode 不 clamp（保留 32-bit HDR >1），encode 不 clamp（HDR 语义留到写回时按位深量化）。
 */
import { getTRC } from '../core/index.js';

/**
 * profile 名称 → TRC 名称。
 * @param {string|null|undefined} profileName
 * @returns {'sRGB'|'AdobeRGB'|'ProPhoto'|null}
 */
export function trcNameFromProfile(profileName) {
  if (!profileName) return null;
  const s = String(profileName).toLowerCase();
  if (s.includes('srgb')) return 'sRGB';
  if (s.includes('adobe rgb')) return 'AdobeRGB';
  if (s.includes('prophoto')) return 'ProPhoto';
  return null;
}

/**
 * 解析文档 TRC；未知 profile 抛错。
 * @param {object} doc Photoshop Document（含 colorProfile）
 * @returns {import('../core/index.js').TRCS[keyof import('../core/index.js').TRCS]}
 */
export function resolveDocumentTRC(doc) {
  const name = trcNameFromProfile(doc.colorProfile);
  if (!name) {
    throw new Error(
      `Unsupported color profile: ${JSON.stringify(doc.colorProfile)}. ` +
        'Supported: sRGB / Adobe RGB (1998) / ProPhoto RGB. ' +
        'Please convert the document to one of these working spaces.',
    );
  }
  return getTRC(name);
}

/**
 * 批量 decode：显示编码 RGB → 线性 RGB（保留 HDR >1）。
 * @param {Float32Array} rgb 显示编码（w*h*3）
 * @param {{decode:(v:number)=>number}} trc
 * @returns {Float32Array} 线性（新数组，不改输入）
 */
export function decodeToLinear(rgb, trc) {
  const out = new Float32Array(rgb.length);
  for (let i = 0; i < rgb.length; i++) out[i] = trc.decode(rgb[i]);
  return out;
}

/**
 * 批量 encode：线性 RGB → 显示编码 RGB（不 clamp，HDR 语义交给写回量化）。
 * @param {Float32Array} rgb 线性（w*h*3）
 * @param {{encode:(v:number)=>number}} trc
 * @returns {Float32Array} 显示编码（新数组，不改输入）
 */
export function encodeFromLinear(rgb, trc) {
  const out = new Float32Array(rgb.length);
  for (let i = 0; i < rgb.length; i++) out[i] = trc.encode(rgb[i]);
  return out;
}
