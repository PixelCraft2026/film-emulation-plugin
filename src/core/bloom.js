import { boxBlur3 } from './diffuse/box.js';
import { gaussianBlurSep } from './diffuse/conv.js';
import { vvGauss } from './diffuse/vv.js';
import { boxDownsample, bilinearUpsample } from './diffuse/resample.js';
import { tryWasmBoxBlur, tryWasmVvGaussianBlur } from './wasmBackend.js';

export const BLOOM_DEFAULTS = Object.freeze({
  thresholdEV: 2,
  softnessEV: 1,
  radius: 0.7,
  amplify: 0.55,
  saturation: 0.85,
  saveLights: 0.45,
});

export const BLOOM_LOBES = Object.freeze([
  Object.freeze({ name: 'core', sigmaRatio: 0.22, weight: 0.62, minScale: 1 }),
  Object.freeze({ name: 'mid', sigmaRatio: 0.75, weight: 0.28, minScale: 2 }),
  Object.freeze({ name: 'tail', sigmaRatio: 2.4, weight: 0.10, minScale: 4 }),
]);

/** @param {any} value */
function finite(value) { return typeof value === 'number' && Number.isFinite(value); }

/** @param {any} raw */
export function validateBloomParams(raw) {
  const value = { ...BLOOM_DEFAULTS, ...(raw ?? {}) };
  const errors = [];
  for (const key of Object.keys(BLOOM_DEFAULTS)) if (!finite(value[key])) errors.push(`${key} must be finite`);
  if (value.thresholdEV < -2 || value.thresholdEV > 8) errors.push('thresholdEV must be in [-2, 8]');
  if (value.softnessEV < 0.1 || value.softnessEV > 4) errors.push('softnessEV must be in [0.1, 4]');
  if (value.radius < 0.05 || value.radius > 5) errors.push('radius must be in [0.05, 5]');
  if (value.amplify < 0 || value.amplify > 4) errors.push('amplify must be in [0, 4]');
  if (value.saturation < 0 || value.saturation > 1.5) errors.push('saturation must be in [0, 1.5]');
  if (value.saveLights < 0 || value.saveLights > 1) errors.push('saveLights must be in [0, 1]');
  if (errors.length) throw new TypeError(`Invalid BloomParams: ${errors.join('; ')}`);
  return value;
}

/** @param {number} edge0 @param {number} edge1 @param {number} value */
function smoothstep(edge0, edge1, value) {
  if (edge0 === edge1) return value < edge0 ? 0 : 1;
  const t = Math.max(0, Math.min(1, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/** @param {any} params @param {any} context */
export function bloomRadiusPx(params, context = {}) {
  const fullWidth = Number(context.fullWidth ?? context.width ?? 1);
  const fullHeight = Number(context.fullHeight ?? context.height ?? 1);
  const previewScale = Number(context.previewScale ?? 1);
  return params.radius * 0.01 * Math.hypot(fullWidth, fullHeight) * previewScale;
}

/** @param {number} sigma @param {string} name */
export function bloomLobeScale(sigma, name) {
  if (name === 'core') return 1;
  if (name === 'mid') return sigma >= 16 ? 4 : 2;
  return sigma >= 32 ? 8 : 4;
}

/**
 * Blur one channel into caller-owned full-resolution storage. Keeping `dst`
 * outside the lobe/channel loop avoids nine large temporary outputs per
 * Bloom node. JS fallback scratch is allocated only when the native primitive
 * is unavailable; a successful WASM call must not pay for unused JS planes.
 *
 * @param {Float32Array} src @param {Float32Array} dst
 * @param {number} width @param {number} height @param {number} sigma
 * @param {number} scale @param {string} quality
 */
function blurAtScale(src, dst, width, height, sigma, scale, quality) {
  if (scale === 1) {
    if (quality === 'fast') {
      if (!tryWasmBoxBlur(src, dst, width, height, sigma)) {
        boxBlur3(src, dst, new Float32Array(src.length), new Float32Array(src.length), width, height, sigma);
      }
    } else if (sigma < 0.4) {
      // Young-van Vliet is not positivity-preserving below roughly 0.35 px.
      // Bloom is emitted light, so its PSF must never acquire negative lobes.
      gaussianBlurSep(src, dst, new Float32Array(src.length), new Float32Array(0), width, height, sigma);
    } else if (!tryWasmVvGaussianBlur(src, dst, width, height, sigma)) {
      vvGauss(src, dst, new Float32Array(src.length), new Float32Array(0), width, height, sigma);
    }
    return;
  }
  const down = boxDownsample(src, width, height, scale);
  const low = new Float32Array(down.data.length);
  if (quality === 'fast') {
    if (!tryWasmBoxBlur(down.data, low, down.dw, down.dh, sigma / scale)) {
      boxBlur3(down.data, low, new Float32Array(down.data.length), new Float32Array(down.data.length), down.dw, down.dh, sigma / scale);
    }
  } else if (sigma / scale < 0.4) {
    gaussianBlurSep(down.data, low, new Float32Array(down.data.length), new Float32Array(0), down.dw, down.dh, sigma / scale);
  } else if (!tryWasmVvGaussianBlur(down.data, low, down.dw, down.dh, sigma / scale)) {
    vvGauss(down.data, low, new Float32Array(down.data.length), new Float32Array(0), down.dw, down.dh, sigma / scale);
  }
  bilinearUpsample(low, down.dw, down.dh, width, height, scale, dst);
}

/** @param {any} input @param {any} rawParams @param {any} [context={}] */
export function processBloom(input, rawParams, context = {}) {
  const params = validateBloomParams(rawParams);
  const width = input.width;
  const height = input.height;
  const n = width * height;
  const base = input.rgb;
  const contribution = new Float32Array(base.length);
  if (params.amplify === 0) {
    return {
      ...input,
      transient: { ...(input.transient ?? {}), bloomBase: base, bloomContribution: contribution },
      stats: {
        identity: true,
        backend: 'js-reference',
        radiusPx: 0,
        fullPixelPasses: 0,
        inputBytes: 0,
        outputBytes: 0,
        scratchBytes: contribution.byteLength,
      },
    };
  }
  const threshold = 0.18 * 2 ** params.thresholdEV;
  const gateEnd = threshold * 2 ** params.softnessEV;
  const source = new Float32Array(base.length);
  for (let i = 0; i < n; i += 1) {
    const p = i * 3;
    const alpha = input.alpha ? Math.max(0, Math.min(1, input.alpha[i])) : 1;
    const gate = smoothstep(threshold, gateEnd, Math.max(base[p], base[p + 1], base[p + 2]));
    // Bloom is an emitted-light contribution. Negative HDR residuals and
    // saturated-channel extrapolation must never turn it into a subtraction.
    const sr = Math.max(0, base[p]) * gate * alpha;
    const sg = Math.max(0, base[p + 1]) * gate * alpha;
    const sb = Math.max(0, base[p + 2]) * gate * alpha;
    const sy = 0.2126 * sr + 0.7152 * sg + 0.0722 * sb;
    source[p] = Math.max(0, sy + (sr - sy) * params.saturation);
    source[p + 1] = Math.max(0, sy + (sg - sy) * params.saturation);
    source[p + 2] = Math.max(0, sy + (sb - sy) * params.saturation);
  }
  const quality = context.quality === 'fast' ? 'fast' : 'quality';
  const radiusPx = bloomRadiusPx(params, { ...context, width, height });
  // These two full-resolution planes are overwritten for every channel and
  // lobe. They are scratch, not graph transients, and never need nine distinct
  // allocations.
  const plane = new Float32Array(n);
  const blurred = new Float32Array(n);
  // Keep one channel resident in the planar scratch while all three physical
  // lobes are evaluated. The previous lobe-major loop unpacked the same
  // interleaved channel three times (nine full source scans in total).
  for (let channel = 0; channel < 3; channel += 1) {
    for (let i = 0; i < n; i += 1) plane[i] = source[i * 3 + channel];
    for (const lobe of BLOOM_LOBES) {
      const sigma = Math.max(0.05, radiusPx * lobe.sigmaRatio);
      const scale = bloomLobeScale(sigma, lobe.name);
      blurAtScale(plane, blurred, width, height, sigma, scale, quality);
      for (let i = 0; i < n; i += 1) contribution[i * 3 + channel] += blurred[i] * lobe.weight;
    }
  }
  const output = new Float32Array(base.length);
  for (let i = 0; i < n; i += 1) {
    const p = i * 3;
    const lightMask = smoothstep(threshold, gateEnd, Math.max(base[p], base[p + 1], base[p + 2]));
    const keep = 1 - params.saveLights * lightMask;
    contribution[p] *= params.amplify * keep;
    contribution[p + 1] *= params.amplify * keep;
    contribution[p + 2] *= params.amplify * keep;
    output[p] = base[p] + contribution[p];
    output[p + 1] = base[p + 1] + contribution[p + 1];
    output[p + 2] = base[p + 2] + contribution[p + 2];
  }
  return {
    width,
    height,
    rgb: output,
    alpha: input.alpha,
    transient: { ...(input.transient ?? {}), bloomBase: base, bloomContribution: contribution },
    stats: {
      identity: params.amplify === 0,
      backend: 'js-reference',
      radiusPx,
      fullPixelPasses: 1 + BLOOM_LOBES.length * 3 * 2,
      inputBytes: base.byteLength,
      outputBytes: output.byteLength,
      scratchBytes: 0,
    },
  };
}

/** @param {any} params @param {any} context */
export function bloomSupport(params, context = {}) {
  const value = validateBloomParams(params);
  if (value.amplify === 0) return 0;
  return Math.ceil(5 * value.radius * 0.01 * Math.hypot(Number(context.fullWidth ?? 1), Number(context.fullHeight ?? 1)) * Number(context.previewScale ?? 1) * BLOOM_LOBES[2].sigmaRatio);
}

export function createBloomParams(overrides = {}) { return validateBloomParams(overrides); }
