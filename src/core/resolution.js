import { boxBlur3, boxRadiusForSigma } from './diffuse/box.js';
import { gaussianBlurSep, gaussianKernel1D } from './diffuse/conv.js';
import { normalizeFilmFormat, pixelsPerMm } from './format.js';
import { tryWasmBoxBlur, tryWasmGaussianBlur } from './wasmBackend.js';

export const FILM_RESOLUTION_DEFAULTS = Object.freeze({
  amount: 1,
  response: 1,
  toeLoss: 0.25,
  shoulderLoss: 0.15,
  profile: 'negative',
});

/** @param {any} value */
function finite(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/** @param {any} params */
export function validateFilmResolutionParams(params) {
  const errors = [];
  for (const key of ['amount', 'response', 'toeLoss', 'shoulderLoss']) {
    if (!finite(params[key])) errors.push(`${key} must be finite`);
  }
  if (params.amount < 0 || params.amount > 1.5) errors.push('amount must be in [0, 1.5]');
  if (params.response < 0.5 || params.response > 2) errors.push('response must be in [0.5, 2]');
  if (params.toeLoss < 0 || params.toeLoss > 1) errors.push('toeLoss must be in [0, 1]');
  if (params.shoulderLoss < 0 || params.shoulderLoss > 1) errors.push('shoulderLoss must be in [0, 1]');
  if (params.profile !== 'negative' && params.profile !== 'positive') errors.push('profile must be negative or positive');
  if (errors.length) throw new TypeError(`Invalid FilmResolutionParams: ${errors.join('; ')}`);
  return params;
}

/** @param {Record<string, any>} [overrides={}] */
export function createFilmResolutionParams(overrides = {}) {
  return validateFilmResolutionParams({ ...FILM_RESOLUTION_DEFAULTS, ...overrides });
}

/** @param {number} edge0 @param {number} edge1 @param {number} value */
function smoothstep(edge0, edge1, value) {
  if (edge0 === edge1) return value < edge0 ? 0 : 1;
  const t = Math.max(0, Math.min(1, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/** @param {any} params @param {any} format @param {number} fullWidth @param {number} [previewScale=1] */
export function filmResolutionTarget(params, format, fullWidth, previewScale = 1) {
  const normalized = normalizeFilmFormat(format);
  const base = params.profile === 'positive' ? 42 : 56;
  const isoFactor = Math.max(0.75, Math.min(1.25, Math.pow(250 / normalized.iso, 0.10)));
  const f50Mm = Math.max(12, Math.min(120, base * isoFactor * params.response));
  const f50Px = f50Mm / pixelsPerMm(normalized, fullWidth);
  const sigmaFull = Math.sqrt(Math.log(2)) / (Math.sqrt(2) * Math.PI * Math.max(f50Px, 1e-4));
  return {
    f50Mm,
    f50Px,
    sigmaPx: sigmaFull * previewScale,
    sigmaFull,
  };
}

/** @param {Float32Array} rgb @param {number} pixel */
function lumaAt(rgb, pixel) {
  const p = pixel * 3;
  return Math.max(1e-6, 0.2126 * rgb[p] + 0.7152 * rgb[p + 1] + 0.0722 * rgb[p + 2]);
}

/** @param {Float32Array} src @param {Float32Array} dst @param {Float32Array} tempA @param {Float32Array} tempB @param {number} width @param {number} height @param {number} sigma @param {string} quality */
function blurPlane(src, dst, tempA, tempB, width, height, sigma, quality) {
  if (sigma < 0.15) {
    dst.set(src);
    return 'js';
  }
  if (quality === 'fast') {
    if (tryWasmBoxBlur(src, dst, width, height, sigma)) return 'wasm';
    boxBlur3(src, dst, tempA, tempB, width, height, sigma);
  } else {
    if (tryWasmGaussianBlur(src, dst, width, height, sigma)) return 'wasm';
    gaussianBlurSep(src, dst, tempA, tempB, width, height, sigma);
  }
  return 'js';
}

/**
 * Apply the V1.6 density-weighted Gaussian resolution loss in linear RGB.
 * The returned alpha is the original alpha plane; alpha never enters MTF.
 */
/** @param {any} input @param {any} rawParams @param {Record<string, any>} [context={}] */
export function processFilmResolution(input, rawParams, context = {}) {
  const params = validateFilmResolutionParams(rawParams);
  if (params.amount === 0) return { ...input, stats: { sigmaPx: 0, identity: true, backend: 'js' } };
  const fullWidth = context.fullWidth ?? input.width;
  const previewScale = context.previewScale ?? 1;
  const format = normalizeFilmFormat(context.format);
  const target = filmResolutionTarget(params, format, fullWidth, previewScale);
  if (target.sigmaPx < 0.15) return { ...input, stats: { ...target, identity: true, backend: 'js' } };

  const n = input.width * input.height;
  const weights = new Float32Array(n);
  let needsWide = false;
  const signal = context.signal;
  for (let i = 0; i < n; i++) {
    if ((i & 4095) === 0 && signal?.aborted) throw new Error('Film render cancelled');
    const x = Math.log2(lumaAt(input.rgb, i) / 0.18);
    const toe = 1 - smoothstep(-6, -2, x);
    const shoulder = smoothstep(2, 6, x);
    const amount = Math.max(0, Math.min(1.5, params.amount * (1 + params.toeLoss * toe + params.shoulderLoss * shoulder)));
    weights[i] = amount;
    if (amount > 1) needsWide = true;
  }

  const output = new Float32Array(input.rgb.length);
  const quality = context.quality === 'fast' ? 'fast' : 'quality';
  let usedWasm = false;
  const previewCache = context.cache;
  if (previewCache) {
    const blurKey = `${input.width}:${input.height}:${target.sigmaPx}:${quality}`;
    const cacheHit = previewCache.resolutionInput === input.rgb && previewCache.resolutionBlurKey === blurKey;
    let firstRgb = cacheHit ? previewCache.resolutionFirstRgb : null;
    let wideRgb = cacheHit ? previewCache.resolutionWideRgb : null;
    const source = new Float32Array(n);
    const blurred = new Float32Array(n);
    const tempA = new Float32Array(n);
    const tempB = new Float32Array(n);
    /** @param {number} sigma */
    const renderBlurredRgb = (sigma) => {
      const result = new Float32Array(input.rgb.length);
      for (let channel = 0; channel < 3; channel++) {
        if (signal?.aborted) throw new Error('Film render cancelled');
        for (let i = 0; i < n; i++) source[i] = input.rgb[i * 3 + channel];
        usedWasm = blurPlane(source, blurred, tempA, tempB, input.width, input.height, sigma, quality) === 'wasm' || usedWasm;
        for (let i = 0; i < n; i++) result[i * 3 + channel] = blurred[i];
      }
      return result;
    };
    if (!firstRgb) firstRgb = renderBlurredRgb(target.sigmaPx);
    if (needsWide && !wideRgb) wideRgb = renderBlurredRgb(target.sigmaPx * 2.2);
    for (let i = 0; i < n; i++) {
      if ((i & 4095) === 0 && signal?.aborted) throw new Error('Film render cancelled');
      const amount = weights[i];
      const p = i * 3;
      for (let channel = 0; channel < 3; channel++) {
        const sourceValue = input.rgb[p + channel];
        output[p + channel] = amount <= 1
          ? sourceValue + amount * (firstRgb[p + channel] - sourceValue)
          : (2 - amount) * firstRgb[p + channel] + (amount - 1) * wideRgb[p + channel];
      }
    }
    // Publish only complete caches so a cancelled preview cannot poison the next render.
    previewCache.resolutionInput = input.rgb;
    previewCache.resolutionBlurKey = blurKey;
    previewCache.resolutionFirstRgb = firstRgb;
    previewCache.resolutionWideRgb = wideRgb;
    return {
      width: input.width,
      height: input.height,
      rgb: output,
      alpha: input.alpha,
      stats: { ...target, identity: false, backend: usedWasm ? 'wasm' : 'js', cacheHit },
    };
  }

  const source = new Float32Array(n);
  const first = new Float32Array(n);
  const wide = needsWide ? new Float32Array(n) : null;
  const tempA = new Float32Array(n);
  const tempB = new Float32Array(n);
  for (let channel = 0; channel < 3; channel++) {
    for (let i = 0; i < n; i++) source[i] = input.rgb[i * 3 + channel];
    usedWasm = blurPlane(source, first, tempA, tempB, input.width, input.height, target.sigmaPx, quality) === 'wasm' || usedWasm;
    if (needsWide && wide) usedWasm = blurPlane(source, wide, tempA, tempB, input.width, input.height, target.sigmaPx * 2.2, quality) === 'wasm' || usedWasm;
    for (let i = 0; i < n; i++) {
      if ((i & 4095) === 0 && signal?.aborted) throw new Error('Film render cancelled');
      const amount = weights[i];
      const wideValue = wide ? wide[i] : first[i];
      const value = amount <= 1
        ? source[i] + amount * (first[i] - source[i])
        : (2 - amount) * first[i] + (amount - 1) * wideValue;
      output[i * 3 + channel] = value;
    }
  }
  return {
    width: input.width,
    height: input.height,
    rgb: output,
    alpha: input.alpha,
    stats: { ...target, identity: false, backend: usedWasm ? 'wasm' : 'js' },
  };
}

/** Exact finite Gaussian support used by row-band preflight. */
/** @param {any} params @param {any} format @param {number} fullWidth @param {number} [previewScale=1] @param {string} [quality='quality'] */
export function filmResolutionSupport(params, format, fullWidth, previewScale = 1, quality = 'quality') {
  const target = filmResolutionTarget(params, format, fullWidth, previewScale);
  if (params.amount === 0 || target.sigmaPx < 0.15) return 0;
  const sigma = target.sigmaPx * 2.2;
  return quality === 'fast' ? 3 * boxRadiusForSigma(sigma) : Math.ceil(3 * sigma);
}

/** @param {number} sigma */
export function gaussianVarianceScale(sigma) {
  if (sigma <= 0) return 1;
  const kernel = gaussianKernel1D(sigma, Math.ceil(3 * sigma));
  let l2 = 0;
  for (const value of kernel) l2 += value * value;
  return l2 > 0 ? 1 / l2 : 1;
}
