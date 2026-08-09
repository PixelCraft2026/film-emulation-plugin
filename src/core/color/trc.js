/**
 * TRC（传递函数）转换 — sRGB / AdobeRGB / ProPhoto / linear。
 * 纯数学、零依赖。工作域为 [0, 1] 显示编码 ↔ 线性（可 >1 HDR / 可负值原样透传）。
 *
 * 说明（TDD R-2 / C4）：core 不假设任何位深与 TRC 的绑定关系；调用方
 * （io/colorPipeline 或测试 harness）负责解析 profile 并选择正确的 TRC 枚举。
 *
 * @typedef {{ name: string, decode: (v:number)=>number, encode: (v:number)=>number }} TRC
 */

/**
 * clamp 到 [0,1]。
 * @param {number} v
 * @returns {number}
 */
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

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
  const c = clamp01(v);
  if (c >= 1) return 1; // 避免 1.055·1−0.055 的浮点减法误差
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
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
  const c = clamp01(v);
  return c >= 1 ? 1 : Math.pow(c, 1 / ADOBE_GAMMA);
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
  const c = clamp01(v);
  return c >= 1 ? 1 : Math.pow(c, 1 / PROPHOTO_GAMMA);
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
  AdobeRGB: Object.freeze({ name: 'AdobeRGB', decode: decodeAdobeRGB, encode: encodeAdobeRGB }),
  ProPhoto: Object.freeze({ name: 'ProPhoto', decode: decodeProPhoto, encode: encodeProPhoto }),
  linear: Object.freeze({ name: 'linear', decode: decodeLinear, encode: encodeLinear }),
});

/**
 * 按名称取 TRC；未知名称抛错。
 * 调用方负责把 profile 字符串映射到这些名称（io/colorPipeline 职责）。
 * @param {string} name 'sRGB' | 'AdobeRGB' | 'ProPhoto' | 'linear'
 * @returns {TRC}
 */
export function getTRC(name) {
  const trc = TRCS[name];
  if (!trc) {
    throw new TypeError(`Unknown TRC name: ${name}. Expected one of ${Object.keys(TRCS).join('|')}`);
  }
  return trc;
}
