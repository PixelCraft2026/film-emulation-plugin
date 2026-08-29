export const HIGHLIGHT_PROTECTION_DEFAULTS = Object.freeze({
  amount: 0.5,
  thresholdEV: 2.5,
  softnessEV: 1,
});

/** @param {any} value */
function finite(value) { return typeof value === 'number' && Number.isFinite(value); }

/** @param {any} raw */
export function validateHighlightProtectionParams(raw) {
  const value = { ...HIGHLIGHT_PROTECTION_DEFAULTS, ...(raw ?? {}) };
  const errors = [];
  for (const key of Object.keys(HIGHLIGHT_PROTECTION_DEFAULTS)) if (!finite(value[key])) errors.push(`${key} must be finite`);
  if (value.amount < 0 || value.amount > 1) errors.push('amount must be in [0, 1]');
  if (value.thresholdEV < 0 || value.thresholdEV > 8) errors.push('thresholdEV must be in [0, 8]');
  if (value.softnessEV < 0.1 || value.softnessEV > 4) errors.push('softnessEV must be in [0.1, 4]');
  if (errors.length) throw new TypeError(`Invalid HighlightProtectionParams: ${errors.join('; ')}`);
  return value;
}

/** @param {number} edge0 @param {number} edge1 @param {number} value */
function smoothstep(edge0, edge1, value) {
  if (edge0 === edge1) return value < edge0 ? 0 : 1;
  const t = Math.max(0, Math.min(1, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/** @param {any} input @param {any} rawParams @param {any} context */
export function processHighlightProtection(input, rawParams, context = {}) {
  const params = validateHighlightProtectionParams(rawParams);
  const transient = context.transient ?? input.transient ?? {};
  const base = transient.bloomBase;
  const contribution = transient.bloomContribution;
  if (!(base instanceof Float32Array) || !(contribution instanceof Float32Array)
    || base.length !== input.rgb.length || contribution.length !== input.rgb.length) {
    return {
      ...input,
      stats: { identity: true, backend: 'js-reference', fullPixelPasses: 0, inputBytes: 0, outputBytes: 0, warnings: ['missingBloomContribution', 'Highlight Protection has no Bloom contribution'] },
    };
  }
  if (params.amount === 0) return { ...input, stats: { identity: true, backend: 'js-reference', fullPixelPasses: 0, inputBytes: 0, outputBytes: 0 } };
  const threshold = 0.18 * 2 ** params.thresholdEV;
  const gateEnd = threshold * 2 ** params.softnessEV;
  const output = new Float32Array(input.rgb.length);
  for (let i = 0; i < input.width * input.height; i += 1) {
    const p = i * 3;
    const protection = smoothstep(threshold, gateEnd, Math.max(base[p], base[p + 1], base[p + 2]));
    const keep = 1 - params.amount * protection;
    output[p] = base[p] + contribution[p] * keep;
    output[p + 1] = base[p + 1] + contribution[p + 1] * keep;
    output[p + 2] = base[p + 2] + contribution[p + 2] * keep;
  }
  return {
    width: input.width,
    height: input.height,
    rgb: output,
    alpha: input.alpha,
    transient,
    stats: { identity: false, backend: 'js-reference', fullPixelPasses: 1, inputBytes: input.rgb.byteLength, outputBytes: output.byteLength },
  };
}

export function createHighlightProtectionParams(overrides = {}) { return validateHighlightProtectionParams(overrides); }
