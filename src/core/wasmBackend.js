// @ts-nocheck
/** Optional WebAssembly numeric backend. Any failure leaves the pure-JS path active. */
let backend = null;
let lastError = null;

export async function installWasmModule(bytes) {
  try {
    const source = bytes instanceof ArrayBuffer ? bytes : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const instantiated = await WebAssembly.instantiate(source, {});
    const exports = instantiated.instance.exports;
    for (const name of ['memory', 'film_version', 'film_alloc_f32', 'film_free_f32', 'film_box_blur3', 'film_max_filter_square', 'film_gaussian_blur_f32', 'film_hash_field_f32', 'film_apply_grain_f32']) {
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

  gaussianBlur(src, dst, width, height, sigma) {
    const pixels = width * height;
    this.ensure(pixels * 4);
    let view = new Float32Array(this.exports.memory.buffer, this.pointer, this.length);
    view.set(src, 0);
    const code = this.exports.film_gaussian_blur_f32(this.pointer, pixels, width, height, sigma);
    if (code !== 0) throw new Error(`film_gaussian_blur_f32 failed with code ${code}`);
    view = new Float32Array(this.exports.memory.buffer, this.pointer, this.length);
    dst.set(view.subarray(pixels, pixels * 2));
  }

  maxFilter(src, dst, width, height, radius) {
    const pixels = width * height;
    // Reserve the blur ABI's four-plane capacity up front. Source Expansion runs
    // before PSF blur; allocating 3n and immediately growing to 4n leaves the old
    // block in WebAssembly linear memory and causes a large transient peak.
    this.ensure(pixels * 4);
    let view = new Float32Array(this.exports.memory.buffer, this.pointer, this.length);
    view.set(src, 0);
    const code = this.exports.film_max_filter_square(this.pointer, pixels, width, height, radius);
    if (code !== 0) throw new Error(`film_max_filter_square failed with code ${code}`);
    view = new Float32Array(this.exports.memory.buffer, this.pointer, this.length);
    dst.set(view.subarray(pixels, pixels * 2));
  }

  hashField(dst, width, height, seed, nodeHash, originX, originY, scaleIndex, channelIndex) {
    const pixels = width * height;
    this.ensure(pixels * 4);
    let view = new Float32Array(this.exports.memory.buffer, this.pointer, this.length);
    const code = this.exports.film_hash_field_f32(this.pointer, pixels, width, height, seed >>> 0, nodeHash >>> 0, originX | 0, originY | 0, scaleIndex >>> 0, channelIndex >>> 0);
    if (code !== 0) throw new Error(`film_hash_field_f32 failed with code ${code}`);
    view = new Float32Array(this.exports.memory.buffer, this.pointer, this.length);
    dst.set(view.subarray(0, pixels));
  }

  hashBlurField(dst, width, height, seed, nodeHash, originX, originY, scaleIndex, channelIndex, sigma, mode) {
    const pixels = width * height;
    this.ensure(pixels * 4);
    let code = this.exports.film_hash_field_f32(this.pointer, pixels, width, height, seed >>> 0, nodeHash >>> 0, originX | 0, originY | 0, scaleIndex >>> 0, channelIndex >>> 0);
    if (code !== 0) throw new Error(`film_hash_field_f32 failed with code ${code}`);
    if (sigma >= 0.15) {
      code = mode === 'fast'
        ? this.exports.film_box_blur3(this.pointer, pixels, width, height, sigma)
        : this.exports.film_gaussian_blur_f32(this.pointer, pixels, width, height, sigma);
      if (code !== 0) throw new Error(`${mode === 'fast' ? 'film_box_blur3' : 'film_gaussian_blur_f32'} failed with code ${code}`);
    }
    // Both blur ABIs write the destination to the second plane; the identity
    // path leaves the generated hash field in the first plane.
    const offset = sigma >= 0.15 ? pixels : 0;
    const view = new Float32Array(this.exports.memory.buffer, this.pointer, this.length);
    dst.set(view.subarray(offset, offset + pixels));
  }

  applyGrain(rgb, noisePlanes, alpha, dst, amount, iso, profile) {
    const pixels = rgb.length / 3;
    this.ensure(pixels * 7);
    let view = new Float32Array(this.exports.memory.buffer, this.pointer, this.length);
    view.set(rgb, 0);
    const noiseOffset = pixels * 3;
    const [red, green, blue] = noisePlanes;
    for (let i = 0; i < pixels; i++) {
      const target = noiseOffset + i * 3;
      view[target] = red[i];
      view[target + 1] = green[i];
      view[target + 2] = blue[i];
    }
    const alphaOffset = pixels * 6;
    if (alpha) view.set(alpha, alphaOffset);
    const code = this.exports.film_apply_grain_f32(
      this.pointer,
      this.pointer + noiseOffset * 4,
      alpha ? this.pointer + alphaOffset * 4 : 0,
      pixels,
      amount,
      iso,
      profile === 'positive' ? 1 : 0,
    );
    if (code !== 0) throw new Error(`film_apply_grain_f32 failed with code ${code}`);
    view = new Float32Array(this.exports.memory.buffer, this.pointer, this.length);
    dst.set(view.subarray(0, pixels * 3));
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

export function tryWasmGaussianBlur(src, dst, width, height, sigma) {
  if (!backend) return false;
  try {
    backend.gaussianBlur(src, dst, width, height, sigma);
    return true;
  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error);
    backend.dispose();
    backend = null;
    return false;
  }
}

export function tryWasmMaxFilter(src, dst, width, height, radius) {
  if (!backend) return false;
  try {
    backend.maxFilter(src, dst, width, height, Math.max(0, Math.floor(radius)));
    return true;
  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error);
    backend.dispose();
    backend = null;
    return false;
  }
}

export function tryWasmHashField(dst, width, height, seed, nodeHash, originX, originY, scaleIndex, channelIndex) {
  if (!backend) return false;
  try {
    backend.hashField(dst, width, height, seed, nodeHash, originX, originY, scaleIndex, channelIndex);
    return true;
  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error);
    backend.dispose();
    backend = null;
    return false;
  }
}

/** Generate and correlate one deterministic Grain field without a JS round-trip. */
export function tryWasmHashBlurField(dst, width, height, seed, nodeHash, originX, originY, scaleIndex, channelIndex, sigma, mode) {
  if (!backend) return false;
  try {
    backend.hashBlurField(dst, width, height, seed, nodeHash, originX, originY, scaleIndex, channelIndex, sigma, mode);
    return true;
  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error);
    backend.dispose();
    backend = null;
    return false;
  }
}

/** Composite a complete planar Grain field. Input RGB is copied before WASM mutation. */
export function tryWasmApplyGrain(rgb, noisePlanes, alpha, dst, amount, iso, profile) {
  if (!backend) return false;
  try {
    backend.applyGrain(rgb, noisePlanes, alpha, dst, amount, iso, profile);
    return true;
  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error);
    backend.dispose();
    backend = null;
    return false;
  }
}

export function tryWasmHalation(input, params, options = {}) {
  // 兼容导出：V1.5.1 的曝光分类和三瓣调度统一由 JavaScript 执行，WASM 仅加速
  // 单瓣三盒高斯。这样任意 luma/参数路径都共享同一模型，避免完整 ABI 漂移。
  void input;
  void params;
  void options;
  return null;
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
