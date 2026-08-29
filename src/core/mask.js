/** Linear-light luma masks shared by every V1.7 effect node. */

export const LUMA_MASK_DEFAULTS = Object.freeze({
  mode: 'none',
  lowEV: -6,
  highEV: 6,
  softnessEV: 1,
  invert: false,
});

const MIN_EV = -16;
const MAX_EV = 16;
const MIN_SOFTNESS_EV = 0.1;
const MAX_SOFTNESS_EV = 4;
const MIDDLE_GRAY = 0.18;
const EPSILON_LUMA = 2 ** -24;

/** @param {any} value */
function finite(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/** @param {number} edge0 @param {number} edge1 @param {number} value */
export function maskSmoothstep(edge0, edge1, value) {
  if (edge0 === edge1) return value < edge0 ? 0 : 1;
  const t = Math.max(0, Math.min(1, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/** @param {any} raw */
export function validateLumaMask(raw) {
  if (raw !== undefined && raw !== null && (typeof raw !== 'object' || Array.isArray(raw))) throw new TypeError('Invalid LumaMask: mask must be an object');
  const value = { ...LUMA_MASK_DEFAULTS, ...(raw ?? {}) };
  const errors = [];
  if (raw && typeof raw === 'object') {
    for (const key of Object.keys(raw)) if (!['mode', 'lowEV', 'highEV', 'softnessEV', 'invert'].includes(key)) errors.push(`${key} is unknown`);
  }
  if (value.mode !== 'none' && value.mode !== 'luma') errors.push('mode must be none or luma');
  for (const key of ['lowEV', 'highEV', 'softnessEV']) {
    if (!finite(value[key])) errors.push(`${key} must be finite`);
  }
  if (value.lowEV < MIN_EV || value.lowEV > MAX_EV) errors.push('lowEV must be in [-16, 16]');
  if (value.highEV < MIN_EV || value.highEV > MAX_EV) errors.push('highEV must be in [-16, 16]');
  if (value.lowEV >= value.highEV) errors.push('lowEV must be lower than highEV');
  if (value.softnessEV < MIN_SOFTNESS_EV || value.softnessEV > MAX_SOFTNESS_EV) errors.push('softnessEV must be in [0.1, 4]');
  if (typeof value.invert !== 'boolean') errors.push('invert must be boolean');
  if (errors.length) throw new TypeError(`Invalid LumaMask: ${errors.join('; ')}`);
  return {
    mode: value.mode,
    lowEV: value.lowEV,
    highEV: value.highEV,
    softnessEV: value.softnessEV,
    invert: value.invert,
  };
}

/** @param {any} raw */
export function createLumaMask(raw = {}) {
  return validateLumaMask(raw);
}

/** @param {number} y @param {any} mask */
function lumaMaskValueValidated(y, mask) {
  if (mask.mode === 'none') return 1;
  const ev = Math.log2(Math.max(EPSILON_LUMA, y) / MIDDLE_GRAY);
  const lower = maskSmoothstep(mask.lowEV - mask.softnessEV, mask.lowEV, ev);
  const upper = 1 - maskSmoothstep(mask.highEV, mask.highEV + mask.softnessEV, ev);
  const value = Math.max(0, Math.min(1, lower * upper));
  return mask.invert ? 1 - value : value;
}

/** @param {number} y @param {any} rawMask */
export function lumaMaskValue(y, rawMask) {
  return lumaMaskValueValidated(y, validateLumaMask(rawMask));
}

/** @param {Float32Array} rgb @param {number} width @param {number} height @param {any} rawMask @param {Float32Array|undefined} [out] */
export function computeLumaMask(rgb, width, height, rawMask, out) {
  const mask = validateLumaMask(rawMask);
  const n = width * height;
  if (mask.mode === 'none') return null;
  const result = out ?? new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    const p = i * 3;
    const y = 0.2126 * rgb[p] + 0.7152 * rgb[p + 1] + 0.0722 * rgb[p + 2];
    result[i] = lumaMaskValueValidated(y, mask);
  }
  return result;
}

/** @param {Float32Array} input @param {Float32Array} effected @param {Float32Array|null} mask @param {string} mode */
export function applyEffectMask(input, effected, mask, mode = 'replacement') {
  if (!mask) return effected;
  if (input.length !== effected.length || input.length !== mask.length * 3) throw new RangeError('Effect mask dimensions do not match RGB buffers');
  const output = new Float32Array(input.length);
  for (let i = 0; i < mask.length; i += 1) {
    const coverage = Math.max(0, Math.min(1, mask[i]));
    const p = i * 3;
    if (mode === 'additive') {
      output[p] = input[p] + (effected[p] - input[p]) * coverage;
      output[p + 1] = input[p + 1] + (effected[p + 1] - input[p + 1]) * coverage;
      output[p + 2] = input[p + 2] + (effected[p + 2] - input[p + 2]) * coverage;
    } else {
      output[p] = input[p] + (effected[p] - input[p]) * coverage;
      output[p + 1] = input[p + 1] + (effected[p + 1] - input[p + 1]) * coverage;
      output[p + 2] = input[p + 2] + (effected[p + 2] - input[p + 2]) * coverage;
    }
  }
  return output;
}

/** @param {Float32Array} contribution @param {Float32Array} mask */
export function applyContributionMask(contribution, mask) {
  if (!mask) return contribution;
  if (contribution.length !== mask.length * 3) throw new RangeError('Contribution mask dimensions do not match RGB buffers');
  const output = new Float32Array(contribution.length);
  for (let i = 0; i < mask.length; i += 1) {
    const coverage = Math.max(0, Math.min(1, mask[i]));
    const p = i * 3;
    output[p] = contribution[p] * coverage;
    output[p + 1] = contribution[p + 1] * coverage;
    output[p + 2] = contribution[p + 2] * coverage;
  }
  return output;
}
