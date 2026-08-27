// @ts-nocheck
/** Optional WebAssembly numeric backend. Any failure leaves the pure-JS path active. */
let backend = null;
let lastError = null;
let executionMode = 'auto';

export async function installWasmModule(bytes) {
  try {
    const source = bytes instanceof ArrayBuffer ? bytes : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const instantiated = await WebAssembly.instantiate(source, {});
    const exports = instantiated.instance.exports;
    for (const name of ['memory', 'film_version', 'film_alloc_f32', 'film_free_f32', 'film_box_blur3', 'film_max_filter_square', 'film_gaussian_blur_f32', 'film_vv_gaussian_blur_f32', 'film_hash_field_f32', 'film_accumulate_field_f32', 'film_hash_blur_accumulate_f32', 'film_apply_grain_f32']) {
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
    this.metrics = {
      copyInBytes: 0,
      copyOutBytes: 0,
      copyCount: 0,
      workspaceBytes: 0,
    };
  }

  ensure(length) {
    if (length <= this.capacity) return;
    if (this.pointer) this.exports.film_free_f32(this.pointer, this.length);
    this.pointer = 0;
    this.capacity = 0;
    this.length = 0;
    this.length = length;
    this.pointer = this.exports.film_alloc_f32(this.length);
    if (!this.pointer) throw new Error(`WASM allocation failed for ${length} float values`);
    this.capacity = length;
    this.metrics.workspaceBytes = Math.max(this.metrics.workspaceBytes, (this.length + (this.grainCapacity ?? 0)) * Float32Array.BYTES_PER_ELEMENT);
  }

  copyIn(view, source, offset = 0) {
    view.set(source, offset);
    this.metrics.copyInBytes += source.byteLength;
    this.metrics.copyCount += 1;
  }

  copyOut(destination, view, offset, length) {
    destination.set(view.subarray(offset, offset + length));
    this.metrics.copyOutBytes += destination.byteLength;
    this.metrics.copyCount += 1;
  }

  blur(src, dst, width, height, sigma) {
    const pixels = width * height;
    this.ensure(pixels * 4);
    let view = new Float32Array(this.exports.memory.buffer, this.pointer, this.length);
    this.copyIn(view, src, 0);
    const code = this.exports.film_box_blur3(this.pointer, pixels, width, height, sigma);
    if (code !== 0) throw new Error(`film_box_blur3 failed with code ${code}`);
    // memory.grow invalidates old views; refresh defensively after the call.
    view = new Float32Array(this.exports.memory.buffer, this.pointer, this.length);
    this.copyOut(dst, view, pixels, pixels);
  }

  gaussianBlur(src, dst, width, height, sigma) {
    const pixels = width * height;
    this.ensure(pixels * 4);
    let view = new Float32Array(this.exports.memory.buffer, this.pointer, this.length);
    this.copyIn(view, src, 0);
    const code = this.exports.film_gaussian_blur_f32(this.pointer, pixels, width, height, sigma);
    if (code !== 0) throw new Error(`film_gaussian_blur_f32 failed with code ${code}`);
    view = new Float32Array(this.exports.memory.buffer, this.pointer, this.length);
    this.copyOut(dst, view, pixels, pixels);
  }

  vvGaussianBlur(src, dst, width, height, sigma) {
    const pixels = width * height;
    this.ensure(pixels * 4);
    let view = new Float32Array(this.exports.memory.buffer, this.pointer, this.length);
    this.copyIn(view, src, 0);
    const code = this.exports.film_vv_gaussian_blur_f32(this.pointer, pixels, width, height, sigma);
    if (code !== 0) throw new Error(`film_vv_gaussian_blur_f32 failed with code ${code}`);
    view = new Float32Array(this.exports.memory.buffer, this.pointer, this.length);
    this.copyOut(dst, view, pixels, pixels);
  }

  maxFilter(src, dst, width, height, radius) {
    const pixels = width * height;
    // Reserve the blur ABI's four-plane capacity up front. Source Expansion runs
    // before PSF blur; allocating 3n and immediately growing to 4n leaves the old
    // block in WebAssembly linear memory and causes a large transient peak.
    this.ensure(pixels * 4);
    let view = new Float32Array(this.exports.memory.buffer, this.pointer, this.length);
    this.copyIn(view, src, 0);
    const code = this.exports.film_max_filter_square(this.pointer, pixels, width, height, radius);
    if (code !== 0) throw new Error(`film_max_filter_square failed with code ${code}`);
    view = new Float32Array(this.exports.memory.buffer, this.pointer, this.length);
    this.copyOut(dst, view, pixels, pixels);
  }

  hashField(dst, width, height, seed, nodeHash, originX, originY, scaleIndex, channelIndex) {
    const pixels = width * height;
    this.ensure(pixels * 4);
    let view = new Float32Array(this.exports.memory.buffer, this.pointer, this.length);
    const code = this.exports.film_hash_field_f32(this.pointer, pixels, width, height, seed >>> 0, nodeHash >>> 0, originX | 0, originY | 0, scaleIndex >>> 0, channelIndex >>> 0);
    if (code !== 0) throw new Error(`film_hash_field_f32 failed with code ${code}`);
    view = new Float32Array(this.exports.memory.buffer, this.pointer, this.length);
    this.copyOut(dst, view, 0, pixels);
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
    this.copyOut(dst, view, offset, pixels);
  }

  hashBlurFieldIntoGrain(width, height, fieldWidth, fieldHeight, pad, scale, targetChannel, coefficient, seed, nodeHash, originX, originY, scaleIndex, channelIndex, sigma, mode, fieldPreviewScale = 1) {
    const pixels = fieldWidth * fieldHeight;
    this.ensure(pixels * 4);
    if (fieldPreviewScale !== 1) {
      const code = this.exports.film_hash_blur_accumulate_f32(
        this.grainPointer,
        this.pointer,
        width >>> 0,
        height >>> 0,
        fieldWidth >>> 0,
        fieldHeight >>> 0,
        pad >>> 0,
        fieldPreviewScale,
        Math.max(1, scale | 0) >>> 0,
        targetChannel >>> 0,
        coefficient,
        seed >>> 0,
        nodeHash >>> 0,
        originX,
        originY,
        scaleIndex >>> 0,
        channelIndex >>> 0,
        sigma,
        mode === 'fast' ? 0 : 1,
      );
      if (code !== 0) throw new Error(`film_hash_blur_accumulate_f32 failed with code ${code}`);
      return;
    }
    let code = this.exports.film_hash_field_f32(this.pointer, pixels, fieldWidth, fieldHeight, seed >>> 0, nodeHash >>> 0, originX | 0, originY | 0, scaleIndex >>> 0, channelIndex >>> 0);
    if (code !== 0) throw new Error(`film_hash_field_f32 failed with code ${code}`);
    let offset = 0;
    if (sigma >= 0.15) {
      code = mode === 'fast'
        ? this.exports.film_box_blur3(this.pointer, pixels, fieldWidth, fieldHeight, sigma)
        : this.exports.film_gaussian_blur_f32(this.pointer, pixels, fieldWidth, fieldHeight, sigma);
      if (code !== 0) throw new Error(`${mode === 'fast' ? 'film_box_blur3' : 'film_gaussian_blur_f32'} failed with code ${code}`);
      offset = pixels;
    }
    this.grainAccumulate(width, height, fieldWidth, fieldHeight, pad, scale, targetChannel, coefficient, offset);
  }

  grainBegin(width, height) {
    const pixels = Math.max(0, Math.trunc(width)) * Math.max(0, Math.trunc(height));
    if (!pixels) throw new Error('Grain workspace dimensions must be positive');
    if (!this.grainPointer || this.grainCapacity < pixels * 3) {
      if (this.grainPointer) this.exports.film_free_f32(this.grainPointer, this.grainCapacity);
      this.grainCapacity = pixels * 3;
      this.grainPointer = this.exports.film_alloc_f32(this.grainCapacity);
      if (!this.grainPointer) throw new Error(`WASM Grain allocation failed for ${pixels} pixels`);
    }
    const view = new Float32Array(this.exports.memory.buffer, this.grainPointer, this.grainCapacity);
    view.fill(0, 0, pixels * 3);
    this.grainPixels = pixels;
    this.metrics.workspaceBytes = Math.max(this.metrics.workspaceBytes, (this.capacity + this.grainCapacity) * Float32Array.BYTES_PER_ELEMENT);
  }

  grainAccumulate(width, height, fieldWidth, fieldHeight, pad, scale, channel, coefficient, fieldOffset = 0) {
    if (!this.grainPointer || this.grainPixels !== width * height) throw new Error('WASM Grain workspace is not reserved');
    const fieldPointer = this.pointer + Math.max(0, Math.trunc(fieldOffset)) * 4;
    const code = this.exports.film_accumulate_field_f32(
      this.grainPointer,
      fieldPointer,
      width >>> 0,
      height >>> 0,
      fieldWidth >>> 0,
      fieldHeight >>> 0,
      pad >>> 0,
      Math.max(1, scale | 0) >>> 0,
      channel >>> 0,
      coefficient,
    );
    if (code !== 0) throw new Error(`film_accumulate_field_f32 failed with code ${code}`);
  }

  grainFinish(noisePlanes) {
    if (!this.grainPointer || !this.grainPixels) throw new Error('WASM Grain workspace is not reserved');
    const view = new Float32Array(this.exports.memory.buffer, this.grainPointer, this.grainPixels * 3);
    for (let channel = 0; channel < 3; channel++) {
      this.copyOut(noisePlanes[channel], view, channel * this.grainPixels, this.grainPixels);
    }
  }

  applyGrain(rgb, noisePlanes, alpha, dst, amount, iso, profile) {
    const pixels = rgb.length / 3;
    this.ensure(pixels * 7);
    let view = new Float32Array(this.exports.memory.buffer, this.pointer, this.length);
    this.copyIn(view, rgb, 0);
    const noiseOffset = pixels * 3;
    const [red, green, blue] = noisePlanes;
    for (let i = 0; i < pixels; i++) {
      const target = noiseOffset + i * 3;
      view[target] = red[i];
      view[target + 1] = green[i];
      view[target + 2] = blue[i];
    }
    this.metrics.copyInBytes += noisePlanes.reduce((total, plane) => total + plane.byteLength, 0);
    this.metrics.copyCount += noisePlanes.length;
    const alphaOffset = pixels * 6;
    if (alpha) {
      this.copyIn(view, alpha, alphaOffset);
    }
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
    this.copyOut(dst, view, 0, pixels * 3);
  }

  dispose() {
    if (this.pointer) this.exports.film_free_f32(this.pointer, this.length);
    if (this.grainPointer) this.exports.film_free_f32(this.grainPointer, this.grainCapacity);
    this.pointer = 0;
    this.capacity = 0;
    this.length = 0;
    this.grainPointer = 0;
    this.grainCapacity = 0;
    this.grainPixels = 0;
  }

  stats() {
    return { ...this.metrics, capacityFloats: this.capacity, grainCapacityFloats: this.grainCapacity ?? 0 };
  }
}

/**
 * Private V1.6 workspace seam.  It owns a separate linear-memory allocation
 * and is intentionally not a generic graph ABI; V1.7 can replace it after
 * effect semantics settle.  Primitive callers may use run() to keep one
 * capacity alive for a complete band instead of growing per operation.
 */
export function createV16ResidentBackend(plan = {}) {
  if (!backend) return null;
  const resident = new WasmBlurBackend(backend.exports);
  return {
    abiVersion: 0x010600,
    planHash: plan.planHash ?? null,
    reserve(width, height, planes = 8) {
      const pixels = Math.max(0, Math.trunc(width)) * Math.max(0, Math.trunc(height));
      resident.ensure(pixels * Math.max(1, Math.trunc(planes)));
      return resident.stats();
    },
    run(operation) {
      if (typeof operation !== 'function') throw new TypeError('V16 resident operation must be a function');
      return operation(resident);
    },
    stats() { return resident.stats(); },
    dispose() { resident.dispose(); },
  };
}

export function tryWasmBoxBlur(src, dst, width, height, sigma) {
  if (!backend || executionMode === 'js') return false;
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
  if (!backend || executionMode === 'js') return false;
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

export function tryWasmVvGaussianBlur(src, dst, width, height, sigma) {
  if (!backend || executionMode === 'js') return false;
  try {
    backend.vvGaussianBlur(src, dst, width, height, sigma);
    return true;
  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error);
    backend.dispose();
    backend = null;
    return false;
  }
}

export function tryWasmMaxFilter(src, dst, width, height, radius) {
  if (!backend || executionMode === 'js') return false;
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
  if (!backend || executionMode === 'js') return false;
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
  if (!backend || executionMode === 'js') return false;
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

export function tryWasmBeginGrainAccum(width, height) {
  if (!backend || executionMode === 'js') return false;
  try {
    backend.grainBegin(width, height);
    return true;
  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error);
    backend.dispose();
    backend = null;
    return false;
  }
}

export function tryWasmHashBlurFieldIntoGrain(width, height, fieldWidth, fieldHeight, pad, scale, targetChannel, coefficient, seed, nodeHash, originX, originY, scaleIndex, channelIndex, sigma, mode, fieldPreviewScale = 1) {
  if (!backend || executionMode === 'js') return false;
  try {
    backend.hashBlurFieldIntoGrain(width, height, fieldWidth, fieldHeight, pad, scale, targetChannel, coefficient, seed, nodeHash, originX, originY, scaleIndex, channelIndex, sigma, mode, fieldPreviewScale);
    return true;
  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error);
    // The caller downloads already accumulated fields before switching the
    // current band to JS. Keep the module alive so that hand-off is safe.
    return false;
  }
}

export function tryWasmFinishGrainAccum(noisePlanes) {
  if (!backend || executionMode === 'js') return false;
  try {
    backend.grainFinish(noisePlanes);
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
  if (!backend || executionMode === 'js') return false;
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
    backend: executionMode === 'js' ? 'js' : backend ? 'wasm' : 'js',
    executionMode,
    version: backend ? backend.exports.film_version() : null,
    error: lastError,
    metrics: backend ? backend.stats() : null,
  };
}

export function resetWasmBackend() {
  backend?.dispose?.();
  backend = null;
  lastError = null;
}

/** Set the request-local policy used by the stable FilmExecutor seam. */
export function setWasmExecutionMode(mode = 'auto') {
  if (mode !== 'auto' && mode !== 'js') throw new TypeError(`Unknown WASM execution mode: ${mode}`);
  const previous = executionMode;
  executionMode = mode;
  return previous;
}

export function getWasmExecutionMode() {
  return executionMode;
}
