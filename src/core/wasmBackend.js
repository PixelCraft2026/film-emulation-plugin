// @ts-nocheck
/** Optional WebAssembly numeric backend. Any failure leaves the pure-JS path active. */
import { thresholdLinear } from './params.js';
let backend = null;
let lastError = null;

export async function installWasmModule(bytes) {
  try {
    const source = bytes instanceof ArrayBuffer ? bytes : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const instantiated = await WebAssembly.instantiate(source, {});
    const exports = instantiated.instance.exports;
    for (const name of ['memory', 'film_version', 'film_alloc_f32', 'film_free_f32', 'film_box_blur3', 'film_process_halation_fast']) {
      if (!(name in exports)) throw new Error(`WASM export missing: ${name}`);
    }
    backend?.dispose?.();
    backend = new WasmBlurBackend(exports);
    lastError = null;
    return getWasmBackendStatus();
  } catch (error) {
    backend = null;
    lastError = error instanceof Error ? error.message : String(error);
    return getWasmBackendStatus();
  }
}

class WasmBlurBackend {
  constructor(exports) {
    this.exports = exports;
    this.pointer = 0;
    this.capacity = 0;
    this.length = 0;
  }

  ensure(length) {
    if (length <= this.capacity) return;
    this.dispose();
    this.length = length;
    this.pointer = this.exports.film_alloc_f32(this.length);
    if (!this.pointer) throw new Error(`WASM allocation failed for ${length} float values`);
    this.capacity = length;
  }

  blur(src, dst, width, height, sigma) {
    const pixels = width * height;
    this.ensure(pixels * 4);
    let view = new Float32Array(this.exports.memory.buffer, this.pointer, this.length);
    view.set(src, 0);
    const code = this.exports.film_box_blur3(this.pointer, pixels, width, height, sigma);
    if (code !== 0) throw new Error(`film_box_blur3 failed with code ${code}`);
    // memory.grow invalidates old views; refresh defensively after the call.
    view = new Float32Array(this.exports.memory.buffer, this.pointer, this.length);
    dst.set(view.subarray(pixels, pixels * 2));
  }

  process(input, params) {
    const pixels = input.width * input.height;
    this.ensure(pixels * 7);
    let view = new Float32Array(this.exports.memory.buffer, this.pointer, this.length);
    view.set(input.rgb, 0);
    if (input.alpha) view.set(input.alpha, pixels * 3);
    else view.fill(1, pixels * 3, pixels * 4);
    const code = this.exports.film_process_halation_fast(
      this.pointer,
      pixels,
      input.width,
      input.height,
      params.strength,
      params.sigma,
      thresholdLinear(params.threshold, params.thresholdUnits),
      params.sourceSoftness,
      thresholdLinear(params.backgroundThreshold, params.thresholdUnits),
      params.backgroundSoftness,
      params.redshift[0],
      params.redshift[1],
      params.redshift[2],
      params.sigmaRatio[0],
      params.sigmaRatio[1],
      params.sigmaRatio[2],
      params.smoothness,
      params.globalDiffusion,
      params.centerAttenuation,
      params.blendMode === 'screen' ? 1 : 0,
      params.extraction === 'spill' ? params.spillMix : 0,
    );
    if (code !== 0) throw new Error(`film_process_halation_fast failed with code ${code}`);
    view = new Float32Array(this.exports.memory.buffer, this.pointer, this.length);
    return {
      width: input.width,
      height: input.height,
      rgb: new Float32Array(view.subarray(pixels * 4, pixels * 7)),
      alpha: input.alpha ? new Float32Array(input.alpha) : undefined,
      S: undefined,
      G: undefined,
      W: undefined,
      halo: undefined,
      stats: { backend: 'wasm', psf: 'dual-gaussian-multiscale' },
    };
  }

  dispose() {
    if (this.pointer) this.exports.film_free_f32(this.pointer, this.length);
    this.pointer = 0;
    this.capacity = 0;
    this.length = 0;
  }
}

export function tryWasmBoxBlur(src, dst, width, height, sigma) {
  if (!backend) return false;
  try {
    backend.blur(src, dst, width, height, sigma);
    return true;
  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error);
    backend.dispose();
    backend = null;
    return false;
  }
}

export function tryWasmHalation(input, params, options = {}) {
  // The compact path is used by the streaming host renderer and does not
  // promise the diagnostic S/G/W/halo planes exposed by the public API.
  if (!backend || params.diffusionMode !== 'fast' || options.compact !== true) return null;
  const luma = options.luma;
  if (luma && (Math.abs(luma[0] - 0.2126) > 1e-7 || Math.abs(luma[1] - 0.7152) > 1e-7 || Math.abs(luma[2] - 0.0722) > 1e-7)) {
    return null;
  }
  try {
    return backend.process(input, params);
  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error);
    backend.dispose();
    backend = null;
    return null;
  }
}

export function getWasmBackendStatus() {
  return {
    available: !!backend,
    backend: backend ? 'wasm' : 'js',
    version: backend ? backend.exports.film_version() : null,
    error: lastError,
  };
}

export function resetWasmBackend() {
  backend?.dispose?.();
  backend = null;
  lastError = null;
}
