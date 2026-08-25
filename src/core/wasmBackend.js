// @ts-nocheck
/** Optional WebAssembly numeric backend. Any failure leaves the pure-JS path active. */
let backend = null;
let lastError = null;

export async function installWasmModule(bytes) {
  try {
    const source = bytes instanceof ArrayBuffer ? bytes : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const instantiated = await WebAssembly.instantiate(source, {});
    const exports = instantiated.instance.exports;
    for (const name of ['memory', 'film_version', 'film_alloc_f32', 'film_free_f32', 'film_box_blur3', 'film_max_filter_square']) {
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
