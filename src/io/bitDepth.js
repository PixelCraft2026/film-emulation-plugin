// io/bitDepth — normalize Photoshop DOM BitsPerChannelType values for Imaging API buffers.

/**
 * Photoshop returns values such as "bitDepth16", while the Imaging API uses
 * numeric component sizes. Accept both forms and fail closed on unknown values.
 * @param {unknown} value
 * @returns {8|16|32}
 */
export function normalizeComponentSize(value) {
  if (value === 8 || value === 16 || value === 32) return value;
  const key = String(value ?? '').trim().toLowerCase();
  if (key === '8' || key === 'bitdepth8' || key === 'eight') return 8;
  if (key === '16' || key === 'bitdepth16' || key === 'sixteen') return 16;
  if (key === '32' || key === 'bitdepth32' || key === 'thirtytwo') return 32;
  throw new Error(`Unsupported Photoshop component size: ${String(value)}`);
}

/** @param {{bitsPerChannel:unknown}|null|undefined} doc */
export function documentComponentSize(doc) {
  return normalizeComponentSize(doc?.bitsPerChannel);
}

/**
 * Photoshop 16-bit integer buffers use the reduced 0..32768 range.
 * @param {number} value
 */
export function clampPhotoshop16(value) {
  return value < 0 ? 0 : value > 32768 ? 32768 : Math.round(value);
}
