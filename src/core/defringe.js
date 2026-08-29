import { boxBlur3 } from './diffuse/box.js';
import { gaussianBlurSep } from './diffuse/conv.js';

export const DEFRINGE_DEFAULTS = Object.freeze({
  amount: 0.65,
  radiusPx: 1.5,
  threshold: 0.08,
  softness: 0.12,
  edgeSensitivity: 1,
});

/** @param {any} value */
function finite(value) { return typeof value === 'number' && Number.isFinite(value); }

/** @param {any} raw */
export function validateDefringeParams(raw) {
  const value = { ...DEFRINGE_DEFAULTS, ...(raw ?? {}) };
  const errors = [];
  for (const key of Object.keys(DEFRINGE_DEFAULTS)) if (!finite(value[key])) errors.push(`${key} must be finite`);
  if (value.amount < 0 || value.amount > 1) errors.push('amount must be in [0, 1]');
  if (value.radiusPx < 0.5 || value.radiusPx > 4) errors.push('radiusPx must be in [0.5, 4]');
  if (value.threshold < 0 || value.threshold > 1) errors.push('threshold must be in [0, 1]');
  if (value.softness < 0.01 || value.softness > 0.5) errors.push('softness must be in [0.01, 0.5]');
  if (value.edgeSensitivity < 0 || value.edgeSensitivity > 2) errors.push('edgeSensitivity must be in [0, 2]');
  if (errors.length) throw new TypeError(`Invalid DefringeParams: ${errors.join('; ')}`);
  return value;
}

/** @param {number} edge0 @param {number} edge1 @param {number} value */
function smoothstep(edge0, edge1, value) {
  if (edge0 === edge1) return value < edge0 ? 0 : 1;
  const t = Math.max(0, Math.min(1, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/** @param {any} input @param {any} rawParams @param {any} [context={}] */
export function processDefringe(input, rawParams, context = {}) {
  const params = validateDefringeParams(rawParams);
  if (params.amount === 0 || params.edgeSensitivity === 0) return {
    ...input,
    stats: { identity: true, backend: 'js-reference', fullPixelPasses: 0, inputBytes: 0, outputBytes: 0 },
  };
  const width = input.width;
  const height = input.height;
  const n = width * height;
  const scale = Number.isFinite(context.previewScale) ? Math.max(0.01, context.previewScale) : 1;
  const radius = Math.max(0.05, params.radiusPx * scale);
  const y = new Float32Array(n);
  const cg = new Float32Array(n);
  const yBlur = new Float32Array(n);
  const cgBlur = new Float32Array(n);
  const tempA = new Float32Array(n);
  const tempB = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    const p = i * 3;
    const r = input.rgb[p];
    const g = input.rgb[p + 1];
    const b = input.rgb[p + 2];
    y[i] = (r + 2 * g + b) * 0.25;
    cg[i] = (-r + 2 * g - b) * 0.25;
  }
  const quality = context.quality === 'fast' ? 'fast' : 'quality';
  if (quality === 'fast') {
    boxBlur3(y, yBlur, tempA, tempB, width, height, radius);
    boxBlur3(cg, cgBlur, tempA, tempB, width, height, radius);
  } else {
    gaussianBlurSep(y, yBlur, tempA, tempB, width, height, radius);
    gaussianBlurSep(cg, cgBlur, tempA, tempB, width, height, radius);
  }
  const output = new Float32Array(input.rgb.length);
  for (let i = 0; i < n; i += 1) {
    if ((i & 4095) === 0 && context.signal?.aborted) throw new Error('Film render cancelled');
    const edge = Math.abs(y[i] - yBlur[i]);
    const fringe = Math.abs(cg[i] - cgBlur[i]);
    const edgeGate = smoothstep(0.01 / params.edgeSensitivity, 0.08 / params.edgeSensitivity, edge);
    const chromaGate = smoothstep(params.threshold, params.threshold + params.softness, fringe);
    const alpha = input.alpha ? Math.max(0, Math.min(1, input.alpha[i])) : 1;
    const mix = params.amount * edgeGate * chromaGate * alpha;
    const p = i * 3;
    const r = input.rgb[p];
    const g = input.rgb[p + 1];
    const b = input.rgb[p + 2];
    const correctedCg = cg[i] + (cgBlur[i] - cg[i]) * mix;
    // Exact inverse of the YCoCg transform used above. Co is retained.
    const co = (r - b) * 0.5;
    const nextG = y[i] + correctedCg;
    const chromaBase = y[i] - correctedCg;
    output[p] = chromaBase + co;
    output[p + 1] = nextG;
    output[p + 2] = chromaBase - co;
  }
  return {
    width,
    height,
    rgb: output,
    alpha: input.alpha,
    transient: input.transient,
    stats: {
      identity: false,
      backend: 'js-reference',
      fullPixelPasses: 6,
      inputBytes: input.rgb.byteLength,
      outputBytes: output.byteLength,
      scratchBytes: 5 * n * 4,
    },
  };
}

/** @param {any} params @param {any} context */
export function defringeSupport(params, context = {}) {
  const value = validateDefringeParams(params);
  if (value.amount === 0 || value.edgeSensitivity === 0) return 0;
  const scale = Number.isFinite(context.previewScale) ? Math.max(0.01, context.previewScale) : 1;
  return Math.ceil(5 * value.radiusPx * scale);
}

export function createDefringeParams(overrides = {}) { return validateDefringeParams(overrides); }
