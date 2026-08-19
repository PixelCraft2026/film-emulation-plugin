/**
 * TRC（传递函数）转换 — sRGB / AdobeRGB / ProPhoto / linear。
 * 纯数学、零依赖。工作域为 [0, 1] 显示编码 ↔ 线性（可 >1 HDR）。
 *
 * 说明（TDD R-2 / C4）：core 不假设任何位深与 TRC 的绑定关系；调用方
 * （io/colorPipeline 或测试 harness）负责解析 profile 并选择正确的 TRC 枚举。
 *
 * HDR 语义（PRD §6.1/§7.3）：decode 不 clamp（保留 >1）；encode 对 >1 延拓
 * （不裁剪）——32-bit 文档写回时高光不丢失，8/16-bit 写回由量化层 clamp 兜底。
 * encode 仅把负值（非法输入）归零。
 *
 * @typedef {{ name: string, decode: (v:number)=>number, encode: (v:number)=>number }} TRC
 */

/**
 * sRGB 传递函数（IEC 61966-2.1）。decode 不 clamp（保留 HDR>1）。
 * @param {number} v
 * @returns {number}
 */
export function decodeSRGB(v) {
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}
/**
 * @param {number} v
 * @returns {number}
 */
export function encodeSRGB(v) {
  if (v <= 0) return 0;
  if (v >= 1) return v === 1 ? 1 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055; // HDR 延拓，不裁剪
  return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
}

/** AdobeRGB（1998）传递函数，gamma 563/256 ≈ 2.19921875。decode 不 clamp（保留 HDR>1）。 */
const ADOBE_GAMMA = 563 / 256;
/**
 * @param {number} v
 * @returns {number}
 */
export function decodeAdobeRGB(v) {
  return Math.pow(v, ADOBE_GAMMA);
}
/**
 * @param {number} v
 * @returns {number}
 */
export function encodeAdobeRGB(v) {
  if (v <= 0) return 0;
  return Math.pow(v, 1 / ADOBE_GAMMA); // >1 延拓，不裁剪
}

/** ProPhoto RGB 传递函数，参考 gamma 1.8。decode 不 clamp（保留 HDR>1）。 */
const PROPHOTO_GAMMA = 1.8;
/**
 * @param {number} v
 * @returns {number}
 */
export function decodeProPhoto(v) {
  return Math.pow(v, PROPHOTO_GAMMA);
}
/**
 * @param {number} v
 * @returns {number}
 */
export function encodeProPhoto(v) {
  if (v <= 0) return 0;
  return Math.pow(v, 1 / PROPHOTO_GAMMA); // >1 延拓，不裁剪
}

/** Rec.2020 ICC/reference-display TRC used by Photoshop/ACR: gamma 2.4. */
const REC2020_GAMMA = 2.4;

/** BT.2020 camera/signal OETF constants, retained separately from the ICC TRC. */
const BT2020_ALPHA = 1.09929682680944;
const BT2020_BETA = 0.018053968510807;
const BT2020_ETH = 4.5 * BT2020_BETA; // ≈ 0.08124286

/** @param {number} v @returns {number} */
export function decodeRec2020(v) {
  return v <= 0 ? 0 : Math.pow(v, REC2020_GAMMA);
}
/**
 * @param {number} v
 * @returns {number}
 */
export function encodeRec2020(v) {
  if (v <= 0) return 0;
  return Math.pow(v, 1 / REC2020_GAMMA); // >1 延拓，不裁剪
}

/**
 * BT.2020 production OETF decode; not used for Photoshop Rec. 2020 ICC documents.
 * @param {number} v
 * @returns {number}
 */
export function decodeBT2020OETF(v) {
  return v < BT2020_ETH ? v / 4.5 : Math.pow((v + BT2020_ALPHA - 1) / BT2020_ALPHA, 1 / 0.45);
}

/**
 * BT.2020 production OETF encode; not used for Photoshop Rec. 2020 ICC documents.
 * @param {number} v
 * @returns {number}
 */
export function encodeBT2020OETF(v) {
  if (v <= 0) return 0;
  return v < BT2020_BETA ? v * 4.5 : BT2020_ALPHA * Math.pow(v, 0.45) - (BT2020_ALPHA - 1);
}

/** linear：恒等。 */
/**
 * @param {number} v
 * @returns {number}
 */
export const decodeLinear = (v) => v;
/**
 * @param {number} v
 * @returns {number}
 */
export const encodeLinear = (v) => v;

/** @type {Readonly<Record<string, TRC>>} TRC 枚举：{ name, decode, encode }。 */
export const TRCS = Object.freeze({
  sRGB: Object.freeze({ name: 'sRGB', decode: decodeSRGB, encode: encodeSRGB }),
  DisplayP3: Object.freeze({ name: 'DisplayP3', decode: decodeSRGB, encode: encodeSRGB }),
  AdobeRGB: Object.freeze({ name: 'AdobeRGB', decode: decodeAdobeRGB, encode: encodeAdobeRGB }),
  ProPhoto: Object.freeze({ name: 'ProPhoto', decode: decodeProPhoto, encode: encodeProPhoto }),
  Rec2020: Object.freeze({ name: 'Rec2020', decode: decodeRec2020, encode: encodeRec2020 }),
  linear: Object.freeze({ name: 'linear', decode: decodeLinear, encode: encodeLinear }),
});

/**
 * 按名称取 TRC；未知名称抛错。
 * 调用方负责把 profile 字符串映射到这些名称（io/colorPipeline 职责）。
 * @param {string} name 'sRGB' | 'DisplayP3' | 'AdobeRGB' | 'ProPhoto' | 'Rec2020' | 'linear'
 * @returns {TRC}
 */
export function getTRC(name) {
  const trc = TRCS[name];
  if (!trc) {
    throw new TypeError(`Unknown TRC name: ${name}. Expected one of ${Object.keys(TRCS).join('|')}`);
  }
  return trc;
}
