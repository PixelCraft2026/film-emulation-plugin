import { boxBlur3, boxRadiusForSigma } from './diffuse/box.js';
import { gaussianKernel1D } from './diffuse/conv.js';
import { gaussianBlurSep } from './diffuse/conv.js';
import { normalizeFilmFormat, physicalMicronsToPixels } from './format.js';
import { fnv1aUtf8, gaussianApprox } from './seed.js';
import {
  tryWasmBoxBlur,
  tryWasmGaussianBlur,
  tryWasmApplyGrain,
  tryWasmApplyResidentGrain,
  tryWasmHashBlurField,
  tryWasmHashField,
  tryWasmBeginGrainAccum,
  tryWasmHashBlurFieldIntoGrain,
  tryWasmGrainScaleIntoAccum,
  tryWasmFinishGrainAccum,
} from './wasmBackend.js';

export const GRAIN_DEFAULTS = Object.freeze({
  amount: 1,
  size: 1,
  roughness: 0.55,
  chroma: 0.18,
  profile: 'negative',
  mode: 'analogue',
  seedMode: 'randomOnCreate',
  seed: 0x4f1bbcdc,
});

/** @param {any} value */
function finite(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/** @param {any} params */
export function validateGrainParams(params) {
  const errors = [];
  for (const key of ['amount', 'size', 'roughness', 'chroma', 'seed']) {
    if (!finite(params[key])) errors.push(`${key} must be finite`);
  }
  if (params.amount < 0 || params.amount > 2) errors.push('amount must be in [0, 2]');
  if (params.size < 0.5 || params.size > 2) errors.push('size must be in [0.5, 2]');
  if (params.roughness < 0 || params.roughness > 1) errors.push('roughness must be in [0, 1]');
  if (params.chroma < 0 || params.chroma > 1) errors.push('chroma must be in [0, 1]');
  if (!Number.isInteger(params.seed) || params.seed < 0 || params.seed > 0xffffffff) errors.push('seed must be a uint32');
  if (params.profile !== 'negative' && params.profile !== 'positive') errors.push('profile must be negative or positive');
  if (params.mode !== 'analogue' && params.mode !== 'fast') errors.push('mode must be analogue or fast');
  if (params.seedMode !== 'fixed' && params.seedMode !== 'randomOnCreate') errors.push('seedMode is invalid');
  if (errors.length) throw new TypeError(`Invalid GrainParams: ${errors.join('; ')}`);
  return params;
}

/** @param {Record<string, any>} [overrides={}] */
export function createGrainParams(overrides = {}) {
  return validateGrainParams({ ...GRAIN_DEFAULTS, ...overrides });
}

/** @param {number} y @param {string} profile */
function exposureEnvelope(y, profile) {
  const x = Math.log2(Math.max(y, 1e-6) / 0.18);
  return profile === 'positive'
    ? 0.35 + 0.75 * Math.exp(-0.5 * ((x - 0.3) / 1.4) ** 2)
    : 0.42 + 0.58 * Math.exp(-0.5 * ((x + 0.5) / 2.0) ** 2);
}

/** @param {Float32Array} src @param {Float32Array} dst @param {Float32Array} tempA @param {Float32Array} tempB @param {number} width @param {number} height @param {number} sigma @param {string} mode */
function blurField(src, dst, tempA, tempB, width, height, sigma, mode) {
  if (sigma < 0.15) {
    dst.set(src);
    return false;
  }
  if (mode === 'fast') {
    if (tryWasmBoxBlur(src, dst, width, height, sigma)) return true;
    boxBlur3(src, dst, tempA, tempB, width, height, sigma);
  } else {
    if (tryWasmGaussianBlur(src, dst, width, height, sigma)) return true;
    gaussianBlurSep(src, dst, tempA, tempB, width, height, sigma);
  }
  return false;
}

/** @param {number} sigma @param {string} mode */
function correlationStdScale(sigma, mode) {
  if (sigma < 0.15) return 1;
  if (mode === 'fast') {
    const radius = boxRadiusForSigma(sigma);
    if (radius === 0) return 1;
    const box = new Float64Array(2 * radius + 1).fill(1 / (2 * radius + 1));
    let a = box;
    for (let pass = 1; pass < 3; pass++) {
      const next = new Float64Array(a.length + box.length - 1);
      for (let i = 0; i < a.length; i++) for (let j = 0; j < box.length; j++) next[i + j] += a[i] * box[j];
      a = next;
    }
    let l2 = 0;
    for (const value of a) l2 += value * value;
    return l2 > 0 ? 1 / l2 : 1;
  }
  const kernel = gaussianKernel1D(sigma, Math.ceil(3 * sigma));
  let l2 = 0;
  for (const value of kernel) l2 += value * value;
  return l2 > 0 ? 1 / l2 : 1;
}

/** @param {number} sigma @param {string} mode */
function fieldRadius(sigma, mode) {
  return mode === 'fast' ? 3 * boxRadiusForSigma(sigma) : Math.ceil(3 * sigma);
}

/** @param {number} width @param {number} height @param {number} originX @param {number} originY @param {number} previewScale @param {any} params @param {number} nodeHash @param {number} scaleIndex @param {number} channelIndex @param {Float32Array} dst */
function makeField(width, height, originX, originY, previewScale, params, nodeHash, scaleIndex, channelIndex, dst) {
  const signal = params.signal;
  if (previewScale === 1 && Number.isInteger(originX) && Number.isInteger(originY)
    && tryWasmHashField(dst, width, height, params.seed, nodeHash, originX, originY, scaleIndex, channelIndex)) return true;
  for (let y = 0; y < height; y++) {
    const absoluteY = Math.floor(originY + y / previewScale);
    for (let x = 0; x < width; x++) {
      const absoluteX = Math.floor(originX + x / previewScale);
      const index = y * width + x;
      dst[index] = gaussianApprox(params.seed, nodeHash, absoluteX, absoluteY, scaleIndex, channelIndex);
    }
    if ((y & 31) === 0 && signal?.aborted) throw new Error('Film render cancelled');
  }
  return false;
}

/** @param {Float32Array} accum @param {Float32Array} field @param {number} coefficient @param {number} width @param {number} height @param {number} fieldWidth @param {number} pad @param {AbortSignal|undefined} signal */
function addFieldCrop(accum, field, coefficient, width, height, fieldWidth, pad, signal) {
  for (let y = 0; y < height; y++) {
    if ((y & 31) === 0 && signal?.aborted) throw new Error('Film render cancelled');
    const sourceRow = (y + pad) * fieldWidth + pad;
    const targetRow = y * width;
    for (let x = 0; x < width; x++) accum[targetRow + x] += field[sourceRow + x] * coefficient;
  }
}

/**
 * Add a statistical field computed on a 1/2, 1/4 or 1/8 preview grid.
 * @param {Float32Array} accum @param {Float32Array} field @param {number} coefficient
 * @param {number} width @param {number} height @param {number} fieldWidth
 * @param {number} fieldHeight @param {number} pad @param {number} scale
 * @param {AbortSignal|undefined} signal
 */
function addFieldResampled(accum, field, coefficient, width, height, fieldWidth, fieldHeight, pad, scale, signal) {
  const inv = 1 / scale;
  for (let y = 0; y < height; y++) {
    if ((y & 31) === 0 && signal?.aborted) throw new Error('Film render cancelled');
    const fy = Math.max(0, Math.min(fieldHeight - 1, (y + 0.5) * inv - 0.5 + pad));
    const y0 = Math.floor(fy);
    const y1 = Math.min(fieldHeight - 1, y0 + 1);
    const ty = fy - y0;
    for (let x = 0; x < width; x++) {
      const fx = Math.max(0, Math.min(fieldWidth - 1, (x + 0.5) * inv - 0.5 + pad));
      const x0 = Math.floor(fx);
      const x1 = Math.min(fieldWidth - 1, x0 + 1);
      const tx = fx - x0;
      const top = field[y0 * fieldWidth + x0] + (field[y0 * fieldWidth + x1] - field[y0 * fieldWidth + x0]) * tx;
      const bottom = field[y1 * fieldWidth + x0] + (field[y1 * fieldWidth + x1] - field[y1 * fieldWidth + x0]) * tx;
      accum[y * width + x] += (top + (bottom - top) * ty) * coefficient;
    }
  }
}

/** Add one shared field to RGB accumulators while reading/interpolating it only once.
 * @param {Float32Array[]} accum @param {Float32Array} field @param {number} coefficient
 * @param {number} width @param {number} height @param {number} fieldWidth @param {number} pad
 * @param {AbortSignal|undefined} signal
 */
function addSharedFieldCrop(accum, field, coefficient, width, height, fieldWidth, pad, signal) {
  const [red, green, blue] = accum;
  for (let y = 0; y < height; y++) {
    if ((y & 31) === 0 && signal?.aborted) throw new Error('Film render cancelled');
    const sourceRow = (y + pad) * fieldWidth + pad;
    const targetRow = y * width;
    for (let x = 0; x < width; x++) {
      const value = field[sourceRow + x] * coefficient;
      const index = targetRow + x;
      red[index] += value;
      green[index] += value;
      blue[index] += value;
    }
  }
}

/** @param {Float32Array[]} accum @param {Float32Array} field @param {number} coefficient
 * @param {number} width @param {number} height @param {number} fieldWidth @param {number} fieldHeight
 * @param {number} pad @param {number} scale @param {AbortSignal|undefined} signal
 */
function addSharedFieldResampled(accum, field, coefficient, width, height, fieldWidth, fieldHeight, pad, scale, signal) {
  const [red, green, blue] = accum;
  const inv = 1 / scale;
  for (let y = 0; y < height; y++) {
    if ((y & 31) === 0 && signal?.aborted) throw new Error('Film render cancelled');
    const fy = Math.max(0, Math.min(fieldHeight - 1, (y + 0.5) * inv - 0.5 + pad));
    const y0 = Math.floor(fy);
    const y1 = Math.min(fieldHeight - 1, y0 + 1);
    const ty = fy - y0;
    for (let x = 0; x < width; x++) {
      const fx = Math.max(0, Math.min(fieldWidth - 1, (x + 0.5) * inv - 0.5 + pad));
      const x0 = Math.floor(fx);
      const x1 = Math.min(fieldWidth - 1, x0 + 1);
      const tx = fx - x0;
      const top = field[y0 * fieldWidth + x0] + (field[y0 * fieldWidth + x1] - field[y0 * fieldWidth + x0]) * tx;
      const bottom = field[y1 * fieldWidth + x0] + (field[y1 * fieldWidth + x1] - field[y1 * fieldWidth + x0]) * tx;
      const value = (top + (bottom - top) * ty) * coefficient;
      const index = y * width + x;
      red[index] += value;
      green[index] += value;
      blue[index] += value;
    }
  }
}

/** @param {Float32Array} rgb @param {number} pixel */
function lumaAt(rgb, pixel) {
  const p = pixel * 3;
  return Math.max(1e-6, 0.2126 * rgb[p] + 0.7152 * rgb[p + 1] + 0.0722 * rgb[p + 2]);
}

/** Generate and composite density-dependent film grain in linear RGB. */
/** @param {any} input @param {any} rawParams @param {Record<string, any>} [context={}] */
export function processGrain(input, rawParams, context = {}) {
  const params = validateGrainParams(rawParams);
  if (params.amount === 0) return {
    ...input,
    stats: { identity: true, backend: 'js', fullPixelPasses: 0, inputBytes: 0, outputBytes: 0 },
  };
  const format = normalizeFilmFormat(context.format);
  const fullWidth = context.fullWidth ?? input.width;
  const previewScale = context.previewScale ?? 1;
  const baseDiameter = 7.5 * Math.max(0.65, Math.min(2.2, Math.pow(format.iso / 250, 0.28))) * params.size;
  const basePx = physicalMicronsToPixels(baseDiameter, format, fullWidth, previewScale);
  const diameters = [0.65 * basePx, 1.35 * basePx, 2.80 * basePx];
  const sigmas = diameters.map((diameter) => diameter / 2.35482);
  const fineWeight = 0.295 + 0.300 * params.roughness;
  const mediumWeight = 0.380;
  const coarseWeight = 0.325 - 0.300 * params.roughness;
  const weights = params.mode === 'fast'
    ? [{ weight: fineWeight + mediumWeight, sigma: Math.sqrt((fineWeight * sigmas[0] ** 2 + mediumWeight * sigmas[1] ** 2) / (fineWeight + mediumWeight)) }, { weight: coarseWeight, sigma: sigmas[2] }]
    : [{ weight: fineWeight, sigma: sigmas[0] }, { weight: mediumWeight, sigma: sigmas[1] }, { weight: coarseWeight, sigma: sigmas[2] }];

  const n = input.width * input.height;
  const nodeHash = fnv1aUtf8(context.nodeId ?? 'grain-main');
  const sharedWeight = Math.sqrt(1 - 0.18 * params.chroma);
  const independentWeight = Math.sqrt(0.18 * params.chroma);
  const signal = context.signal;
  // Quality keeps full-resolution fields for ordinary previews and documents,
  // but large Apply images use a 1/2-resolution statistical field.  Grain is
  // coordinate-addressed and the field is bilinearly reconstructed, so this
  // reduces work without changing source RGB, alpha or deterministic seed.
  const fieldScale = context.quality === 'fast'
    ? (previewScale < 0.25 ? 4 : previewScale < 1 ? 2 : 1)
    : (previewScale === 1 && fullWidth >= 4096 ? 2 : 1);
  const fieldPreviewScale = previewScale / fieldScale;
  const lowSigmas = weights.map((item) => item.sigma / fieldScale);
  const maxPad = Math.max(...lowSigmas.map((sigma) => fieldRadius(sigma, params.mode)));
  const fieldWidth = Math.ceil(input.width / fieldScale) + 2 * maxPad;
  const fieldHeight = Math.ceil(input.height / fieldScale) + 2 * maxPad;
  const fieldPixels = fieldWidth * fieldHeight;
  const fieldOriginX = (context.originX ?? 0) - maxPad / fieldPreviewScale;
  const fieldOriginY = (context.originY ?? 0) - maxPad / fieldPreviewScale;
  const grainKey = [
    input.width,
    input.height,
    fullWidth,
    previewScale,
    context.originX ?? 0,
    context.originY ?? 0,
    context.quality ?? 'quality',
    format.gauge,
    format.iso,
    params.size,
    params.roughness,
    params.chroma,
    params.mode,
    params.seed,
    context.nodeId ?? 'grain-main',
  ].join(':');
  const previewCache = context.cache;
  const cacheHit = !!(
    previewCache
    && previewCache.grainKey === grainKey
    && previewCache.grainAccums?.length === 3
    && previewCache.grainAccums[0]?.length === n
  );
  const scaleConfigs = weights.map((item, scale) => {
    const sigma = lowSigmas[scale];
    const normalization = correlationStdScale(sigma, params.mode);
    return {
      sigma,
      sharedCoefficient: Math.sqrt(item.weight) * sharedWeight * normalization,
      independentCoefficient: Math.sqrt(item.weight) * independentWeight * normalization,
    };
  });
  /** @type {Float32Array[]|null} */
  let accum = cacheHit ? previewCache.grainAccums : null;
  const ensureAccums = () => {
    if (!accum) accum = [new Float32Array(n), new Float32Array(n), new Float32Array(n)];
    return accum;
  };
  let usedWasm = false;
  let residentAccumReady = false;
  let sharedFieldsGenerated = 0;
  let independentFieldsGenerated = 0;

  if (!cacheHit) {
    let fusedAccum = Number.isInteger(fieldScale)
      && Number.isInteger(fieldOriginX)
      && Number.isInteger(fieldOriginY)
      && tryWasmBeginGrainAccum(input.width, input.height);
    let filtered = fusedAccum ? null : new Float32Array(fieldPixels);
    /** @type {Float32Array|null} */
    let raw = null;
    /** @type {Float32Array|null} */
    let tempA = null;
    /** @type {Float32Array|null} */
    let tempB = null;
    const fieldParams = { ...params, signal };
    const ensureJsScratch = () => {
      if (!filtered) filtered = new Float32Array(fieldPixels);
      if (!raw) {
        raw = new Float32Array(fieldPixels);
        tempA = new Float32Array(fieldPixels);
        tempB = new Float32Array(fieldPixels);
      }
    };
    /** @param {number} scaleIndex @param {number} channelIndex @param {number} sigma */
    /** @param {number} scaleIndex @param {number} channelIndex @param {number} sigma @param {number} coefficient */
    const generateCorrelated = (scaleIndex, channelIndex, sigma, coefficient) => {
      if (fusedAccum) {
        const fused = tryWasmHashBlurFieldIntoGrain(
          input.width,
          input.height,
          fieldWidth,
          fieldHeight,
          maxPad,
          fieldScale,
          channelIndex === 0 ? 3 : channelIndex - 1,
          coefficient,
          params.seed,
          nodeHash,
          fieldOriginX,
          fieldOriginY,
          scaleIndex,
          channelIndex,
          sigma,
          params.mode,
          fieldPreviewScale,
        );
        if (fused) {
          usedWasm = true;
          return true;
        }
        // A failed field operation may leave earlier fields in the resident
        // accumulator. Download them before switching this complete band to
        // the JS path; never mix an incomplete native field into the result.
        tryWasmFinishGrainAccum(ensureAccums());
        fusedAccum = false;
      }
      if (!filtered) ensureJsScratch();
      const fusedWasm = fieldPreviewScale === 1
        && Number.isInteger(fieldOriginX)
        && Number.isInteger(fieldOriginY)
        && tryWasmHashBlurField(
          filtered,
          fieldWidth,
          fieldHeight,
          params.seed,
          nodeHash,
          fieldOriginX,
          fieldOriginY,
          scaleIndex,
          channelIndex,
          sigma,
          params.mode,
        );
      if (fusedWasm) {
        usedWasm = true;
        return false;
      }
      ensureJsScratch();
      const rawPlane = raw;
      const scratchA = tempA;
      const scratchB = tempB;
      if (!rawPlane || !scratchA || !scratchB) throw new Error('Grain scratch allocation failed');
      if (!filtered) throw new Error('Grain filtered field allocation failed');
      usedWasm = makeField(fieldWidth, fieldHeight, fieldOriginX, fieldOriginY, fieldPreviewScale, fieldParams, nodeHash, scaleIndex, channelIndex, rawPlane) || usedWasm;
      usedWasm = blurField(rawPlane, filtered, scratchA, scratchB, fieldWidth, fieldHeight, sigma, params.mode) || usedWasm;
      return false;
    };

    for (let scale = 0; scale < weights.length; scale++) {
      const config = scaleConfigs[scale];
      // The four fields at one physical scale share the same coordinate/hash
      // prefix. Generate, correlate and accumulate them in one native call
      // when chroma requires all four; this preserves the exact field values
      // and Gaussian kernel while removing three duplicate prefix walks and
      // three JS/WASM boundary calls per scale.
      if (fusedAccum && config.independentCoefficient > 0) {
        const fusedScale = tryWasmGrainScaleIntoAccum(
          input.width,
          input.height,
          fieldWidth,
          fieldHeight,
          maxPad,
          fieldScale,
          config.sharedCoefficient,
          config.independentCoefficient,
          params.seed,
          nodeHash,
          fieldOriginX,
          fieldOriginY,
          scale,
          config.sigma,
          params.mode,
          fieldPreviewScale,
        );
        if (fusedScale) {
          usedWasm = true;
          sharedFieldsGenerated++;
          independentFieldsGenerated += 3;
          continue;
        }
        tryWasmFinishGrainAccum(ensureAccums());
        fusedAccum = false;
      }
      // Generate a true halo around each band. The correlation kernel sees
      // coordinate-hash samples beyond the document edge instead of a clamp.
      const fieldSigma = config.sigma;
      sharedFieldsGenerated++;
      const sharedGenerated = generateCorrelated(scale, 0, fieldSigma, config.sharedCoefficient);
      const sharedCoefficient = config.sharedCoefficient;
      if (!sharedGenerated) {
        if (!filtered) throw new Error('Grain filtered field allocation failed');
        const planes = ensureAccums();
        if (fieldScale === 1) addSharedFieldCrop(planes, filtered, sharedCoefficient, input.width, input.height, fieldWidth, maxPad, signal);
        else addSharedFieldResampled(planes, filtered, sharedCoefficient, input.width, input.height, fieldWidth, fieldHeight, maxPad, fieldScale, signal);
      }

      const independentCoefficient = config.independentCoefficient;
      // Chroma=0 is a true shared-field mode. Avoid generating and filtering
      // three independent fields whose coefficient is exactly zero.
      if (independentCoefficient > 0) {
        for (let channel = 0; channel < 3; channel++) {
          independentFieldsGenerated++;
          const independentGenerated = generateCorrelated(scale, channel + 1, fieldSigma, independentCoefficient);
          if (!independentGenerated) {
            if (!filtered) throw new Error('Grain filtered field allocation failed');
            const planes = ensureAccums();
            if (fieldScale === 1) addFieldCrop(planes[channel], filtered, independentCoefficient, input.width, input.height, fieldWidth, maxPad, signal);
            else addFieldResampled(planes[channel], filtered, independentCoefficient, input.width, input.height, fieldWidth, fieldHeight, maxPad, fieldScale, signal);
          }
        }
      }
    }
    if (fusedAccum) {
      if (previewCache) tryWasmFinishGrainAccum(ensureAccums());
      else residentAccumReady = true;
    }
    if (previewCache) {
      // Do not publish partial state when an AbortSignal interrupted generation.
      previewCache.grainKey = grainKey;
      previewCache.grainAccums = ensureAccums();
    }
  }

  const output = new Float32Array(input.rgb.length);
  // The V1.6 WASM grain ABI keeps RGB, three unit fields and alpha in one
  // resident capacity.  It is faster for both preview and large Apply bands;
  // the JS loop remains the deterministic fallback when allocation fails.
  let wasmComposite = residentAccumReady
    ? tryWasmApplyResidentGrain(input.rgb, input.alpha, output, params.amount, format.iso, params.profile)
    : tryWasmApplyGrain(
      input.rgb,
      ensureAccums(),
      input.alpha,
      output,
      params.amount,
      format.iso,
      params.profile,
    );
  if (residentAccumReady && !wasmComposite) {
    // A resident composite failure must not silently fall through with newly
    // allocated zero fields. Recover the complete accumulator first, then
    // retry the established planar-field composite/JS fallback path.
    const planes = ensureAccums();
    if (!tryWasmFinishGrainAccum(planes)) {
      throw new Error('WASM Grain resident handoff failed');
    }
    residentAccumReady = false;
    wasmComposite = tryWasmApplyGrain(
      input.rgb,
      planes,
      input.alpha,
      output,
      params.amount,
      format.iso,
      params.profile,
    );
  }
  usedWasm = wasmComposite || usedWasm;
  if (!wasmComposite) {
    const planes = ensureAccums();
    for (let i = 0; i < n; i++) {
      if ((i & 4095) === 0 && signal?.aborted) throw new Error('Film render cancelled');
      const envelope = exposureEnvelope(lumaAt(input.rgb, i), params.profile);
      const sigmaD = 0.085 * params.amount * Math.sqrt(format.iso / 250) * envelope;
      const varianceZ = (Math.LN2 * sigmaD) ** 2;
      const alpha = input.alpha ? input.alpha[i] : 1;
      const p = i * 3;
      for (let channel = 0; channel < 3; channel++) {
        const z = Math.LN2 * sigmaD * planes[channel][i];
        // The coordinate hash is bounded but variance normalization can produce
        // very rare extreme tails at maximum ISO/size. Keep the Float32 output
        // finite without clipping ordinary photographic grain excursions.
        const gain = Math.exp(Math.max(-20, Math.min(20, z - 0.5 * varianceZ)));
        const grained = input.rgb[p + channel] * gain;
        output[p + channel] = input.rgb[p + channel] + alpha * (grained - input.rgb[p + channel]);
      }
    }
  }
  return {
    width: input.width,
    height: input.height,
    rgb: output,
    alpha: input.alpha,
    stats: {
      identity: false,
      backend: usedWasm ? 'wasm' : 'js',
      baseDiameterPx: basePx,
      cacheHit,
      fieldsGenerated: sharedFieldsGenerated + independentFieldsGenerated,
      sharedFieldsGenerated,
      independentFieldsGenerated,
      scratchBytes: cacheHit ? 0 : (3 * n + fieldPixels) * 4,
      fullPixelPasses: cacheHit ? 2 : 8,
      inputBytes: input.rgb.byteLength,
      outputBytes: output.byteLength,
    },
  };
}

/** @param {any} rawParams @param {Record<string, any>} [context={}] */
export function grainSupport(rawParams, context = {}) {
  // A few callers inspect a graph by numeric index while V1.7 adds nodes
  // ahead of Grain.  Non-Grain descriptors have no generated halo and should
  // not be interpreted as malformed Grain parameters.
  if (!rawParams || rawParams.amount === undefined || rawParams.size === undefined) return 0;
  const params = validateGrainParams(rawParams);
  if (params.amount === 0) return 0;
  const format = normalizeFilmFormat(context.format);
  const fullWidth = context.fullWidth ?? 1;
  const scale = context.previewScale ?? 1;
  const base = physicalMicronsToPixels(7.5 * Math.max(0.65, Math.min(2.2, Math.pow(format.iso / 250, 0.28))) * params.size, format, fullWidth, scale);
  const values = [0.65, 1.35, 2.80].map((factor) => base * factor / 2.35482);
  const fineWeight = 0.295 + 0.300 * params.roughness;
  const mediumWeight = 0.380;
  const coarseWeight = 0.325 - 0.300 * params.roughness;
  const sigmas = params.mode === 'fast'
    ? [Math.sqrt((fineWeight * values[0] ** 2 + mediumWeight * values[1] ** 2) / (fineWeight + mediumWeight)), values[2]]
    : values;
  return Math.max(...sigmas.map((sigma) => fieldRadius(sigma, params.mode)));
}
