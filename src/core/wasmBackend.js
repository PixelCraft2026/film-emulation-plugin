// @ts-nocheck
/** Optional WebAssembly numeric backend. Any failure leaves the pure-JS path active. */
import { createGraphCommandBuffer, validateGraphCommandBuffer, EXECUTOR_ABI_VERSION } from './commandBuffer.js';
let backend = null;
let residentBackend = null;
let simdResidentBackend = null;
let simdQualified = false;
let lastError = null;
let executionMode = 'auto';

function residentNodeSupported(node) {
  const params = node?.params ?? {};
  if (node?.type === 'filmResolution') return true;
  if (node?.type === 'halation') return true;
  if (node?.type === 'grain') return params.mode === 'analogue' || params.mode === 'fast';
  if (node?.type === 'highlightProtection') return true;
  if (node?.type === 'defringe') return true;
  if (node?.type === 'bloom') return true;
  return false;
}

const RESIDENT_ERROR_NAMES = Object.freeze({
  [-1]: 'ERR_ABI_VERSION', [-2]: 'ERR_INVALID_PLAN', [-3]: 'ERR_UNSUPPORTED_NODE',
  [-4]: 'ERR_CAPACITY', [-5]: 'ERR_NONFINITE_PARAM', [-6]: 'ERR_NONFINITE_OUTPUT',
  [-7]: 'ERR_STALE_HANDLE', [-8]: 'ERR_CANCELLED', [-9]: 'ERR_INTERNAL',
});

function residentError(message, code, failureNode = -1) {
  const error = new Error(`${message} with code ${code}`);
  error.code = RESIDENT_ERROR_NAMES[code] ?? 'ERR_WASM_RESIDENT';
  error.failureNode = failureNode;
  return error;
}

function yieldToHost() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** The ABI unit is pixel-visits. Keep every call inside the frozen range while
 * adapting the quantum toward the host's preview/apply responsiveness target. */
function initialWorkBudget(context = {}) {
  const requested = Number(context.stepBudget ?? context.workBudget);
  const fallback = context.intent === 'preview' ? 65_536 : 131_072;
  return Math.min(262_144, Math.max(16_384, Math.trunc(Number.isFinite(requested) ? requested : fallback)));
}

function adaptWorkBudget(current, elapsedMs, targetMs) {
  if (!(elapsedMs > 0) || !Number.isFinite(elapsedMs)) return current;
  if (elapsedMs > targetMs * 1.25) return Math.max(16_384, Math.floor(current * 0.5));
  if (elapsedMs < targetMs * 0.5) return Math.min(262_144, Math.ceil(current * 1.5));
  return current;
}

export async function installWasmModule(bytes, simdBytes = null) {
  try {
    const source = bytes instanceof ArrayBuffer ? bytes : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const instantiated = await WebAssembly.instantiate(source, {});
    const exports = instantiated.instance.exports;
    for (const name of ['memory', 'film_version', 'film_alloc_f32', 'film_free_f32', 'film_box_blur3', 'film_max_filter_square', 'film_gaussian_blur_f32', 'film_vv_gaussian_blur_f32', 'film_hash_field_f32', 'film_accumulate_field_f32', 'film_hash_blur_accumulate_f32', 'film_grain_scale_accumulate_f32', 'film_apply_grain_f32', 'film_apply_grain_planar_f32']) {
      if (!(name in exports)) throw new Error(`WASM export missing: ${name}`);
    }
    backend?.dispose?.();
    residentBackend?.dispose?.();
    simdResidentBackend?.dispose?.();
    backend = new WasmBlurBackend(exports);
    residentBackend = typeof exports.film_executor_abi_version === 'function'
      ? new WasmResidentBackend(exports, 'wasm-resident')
      : null;
    simdResidentBackend = null;
    simdQualified = false;
    if (simdBytes && typeof WebAssembly.validate === 'function') {
      const simdSource = simdBytes instanceof ArrayBuffer
        ? simdBytes
        : simdBytes.buffer.slice(simdBytes.byteOffset, simdBytes.byteOffset + simdBytes.byteLength);
      if (WebAssembly.validate(simdSource)) {
        const simdInstance = await WebAssembly.instantiate(simdSource, {});
        const simdExports = simdInstance.instance.exports;
        if (typeof simdExports.film_executor_capabilities === 'function'
          && (simdExports.film_executor_capabilities() & 2) !== 0
          && typeof simdExports.film_executor_abi_version === 'function'
          && simdExports.film_executor_abi_version() === EXECUTOR_ABI_VERSION
          && (typeof simdExports.film_executor_simd_probe !== 'function'
            || Math.abs(simdExports.film_executor_simd_probe(0.375) - 0.375) <= 1e-7)) {
          simdResidentBackend = new WasmResidentBackend(simdExports, 'wasm-resident-simd');
          // Qualification is deliberately explicit. The QA runner can set it
          // after fixed-vector correctness and >=10% timing gates; merely
          // loading a simd128 module must never change Auto behaviour.
          simdQualified = false;
        }
      }
    }
    lastError = null;
    return getWasmBackendStatus();
  } catch (error) {
    backend = null;
    lastError = error instanceof Error ? error.message : String(error);
    return getWasmBackendStatus();
  }
}

/** Frame-resident V1.7 command executor adapter.  It is opt-in until the
 * scalar node implementations pass the JS/WASM numerical gates. */
class WasmResidentBackend {
  constructor(exports, backendLabel = 'wasm-resident-scalar') {
    this.exports = exports;
    this.backendLabel = backendLabel;
    this.backendVariant = backendLabel === 'wasm-resident' ? 'wasm-resident-scalar' : backendLabel;
    this.handle = exports.film_executor_create(0);
    this.generation = 0;
    this.width = 0;
    this.height = 0;
    this.commandCapacity = 0;
    this.metrics = { uploadBytes: 0, downloadBytes: 0, commandBytes: 0, steps: 0, stepCalls: 0, maxStepWork: 0, memoryGeneration: 0 };
  }

  reserve(width, height, commandBytes, arenaFloats = width * height * 32, transientFloats = width * height * 7) {
    const abi = this.exports.film_executor_abi_version?.() ?? 0;
    if (abi !== EXECUTOR_ABI_VERSION) throw new Error(`Resident executor ABI ${abi} is unsupported`);
    const required = Math.max(1, Math.trunc(commandBytes));
    const code = this.exports.film_executor_reserve(
      this.handle,
      required,
      width >>> 0,
      height >>> 0,
      Math.max(1, Math.trunc(arenaFloats)) >>> 0,
      Math.max(1, Math.trunc(transientFloats)) >>> 0,
    );
    if (code !== 0) throw residentError('film_executor_reserve failed', code);
    this.width = width;
    this.height = height;
    this.commandCapacity = required;
    this.generation = this.exports.film_executor_memory_generation(this.handle) >>> 0;
    this.metrics.memoryGeneration = this.generation;
    this.metrics.plannedArenaFloats = Math.max(this.metrics.plannedArenaFloats ?? 0, Math.trunc(arenaFloats));
    this.metrics.plannedTransientFloats = Math.max(this.metrics.plannedTransientFloats ?? 0, Math.trunc(transientFloats));
    return this.generation;
  }

  validateGeneration(generation = this.generation) {
    const code = this.exports.film_executor_validate_generation?.(this.handle, generation >>> 0) ?? 0;
    if (code !== 0) throw residentError('resident memory generation is stale', code);
    return true;
  }

  execute(input, plan, context = {}) {
    // The ABI/liveness implementation is deliberately shipped before the
    // node kernels are promoted. Never expose the native identity path as a
    // successful render for a graph with a non-zero effect; the caller will
    // classify this stable error and rerun the complete JS graph from the
    // preserved canonical band input.
    const enabled = Array.isArray(plan?.enabled) ? plan.enabled : [];
    if (enabled.some((node) => !residentNodeSupported(node))) {
      const error = new Error('Resident WASM plan contains an unsupported node or luma mask');
      error.code = 'ERR_UNSUPPORTED_NODE';
      throw error;
    }
    // Reserve once for the largest halo-complete band in the immutable plan.
    // Using the actual per-band maximum avoids the old full-height envelope,
    // while preventing incremental Vec growth/fragmentation when a later band
    // is wider than the first one.
    const plannedBandCapacity = Math.max(
      input.height,
      Array.isArray(plan?.bands)
        ? Math.max(0, ...plan.bands.map((band) => Math.trunc(Number(band.end) - Number(band.start))))
        : input.height,
    );
    const capacityPixels = input.width * plannedBandCapacity;
    const physicalLayout = plan?.physicalLayoutFor?.(input.width, plannedBandCapacity) ?? plan?.physicalLayout;
    const physicalArena = physicalLayout?.residentScratchFloats ?? physicalLayout?.scratchFloats ?? 0;
    const physicalTransient = physicalLayout?.transientFloats ?? 0;
    const activePlan = physicalLayout && Array.isArray(plan?.commands)
      ? { ...plan, commands: plan.commands.map((/** @type {any} */ item, /** @type {number} */ index) => ({ ...item, memoryLayout: (physicalLayout.residentBindings ?? physicalLayout.bindings)[index] })) }
      : plan;
    const command = createGraphCommandBuffer(activePlan, {
      ...context,
      width: input.width,
      height: input.height,
      fullWidth: context.fullWidth ?? plan.fullWidth,
      fullHeight: context.fullHeight ?? plan.fullHeight,
      executorAbiVersion: EXECUTOR_ABI_VERSION,
    });
    validateGraphCommandBuffer(command);
    this.reserve(
      input.width,
      plannedBandCapacity,
      command.byteLength,
      Math.max(1, physicalArena || capacityPixels * Math.max(1, Number(plan?.residentMemory?.arenaFloatsPerPixel ?? 32))),
      Math.max(1, physicalTransient || capacityPixels * Math.max(1, Number(plan?.residentMemory?.transientFloatsPerPixel ?? 7))),
    );
    this.validateGeneration(this.generation);
    let memory = this.exports.memory.buffer;
    let commandView = new Uint8Array(memory, this.exports.film_executor_command_ptr(this.handle) >>> 0, command.byteLength);
    commandView.set(command);
    let rgbView = new Float32Array(memory, this.exports.film_executor_input_rgb_ptr(this.handle) >>> 0, input.rgb.length);
    rgbView.set(input.rgb);
    const alphaView = new Float32Array(memory, this.exports.film_executor_input_alpha_ptr(this.handle) >>> 0, input.width * input.height);
    if (input.alpha) alphaView.set(input.alpha);
    else alphaView.fill(1);
    this.metrics.uploadBytes += input.rgb.byteLength + alphaView.byteLength;
    this.metrics.commandBytes += command.byteLength;
    let code = this.exports.film_executor_begin(this.handle, command.byteLength);
    if (code !== 0) throw residentError('film_executor_begin failed', code, this.exports.film_executor_failure_node?.(this.handle) ?? -1);
    const debugCheckpoints = context.debugCheckpoints === true ? [] : null;
    let previousCursor = 0;
    const workBudget = initialWorkBudget(context);
    while (true) {
      if (context.signal?.aborted) {
        this.exports.film_executor_reset(this.handle);
        throw residentError('Film render cancelled', -8, this.exports.film_executor_cursor?.(this.handle) ?? -1);
      }
      code = this.exports.film_executor_step(this.handle, workBudget);
      this.metrics.stepCalls += 1;
      const progressCursor = this.exports.film_executor_cursor?.(this.handle) ?? previousCursor;
      this.metrics.steps += Math.max(0, progressCursor - previousCursor);
      previousCursor = progressCursor;
      this.metrics.maxStepWork = Math.max(this.metrics.maxStepWork, this.exports.film_executor_step_work?.(this.handle) ?? 0);
      if (debugCheckpoints) {
        const cursor = progressCursor;
        if (cursor > debugCheckpoints.length) {
          const checkpoint = new Float32Array(input.rgb.length);
          checkpoint.set(new Float32Array(this.exports.memory.buffer, this.exports.film_executor_current_rgb_ptr(this.handle) >>> 0, input.rgb.length));
          debugCheckpoints.push({ nodeIndex: cursor - 1, rgb: checkpoint });
        }
      }
      if (code === 0) break;
      if (code !== 1) throw residentError('film_executor_step failed', code, this.exports.film_executor_failure_node?.(this.handle) ?? -1);
    }
    memory = this.exports.memory.buffer;
    const outputView = new Float32Array(memory, this.exports.film_executor_output_rgb_ptr(this.handle) >>> 0, input.rgb.length);
    const output = new Float32Array(input.rgb.length);
    output.set(outputView);
    this.metrics.downloadBytes += output.byteLength;
    const statsLength = this.exports.film_executor_stats_len?.(this.handle) ?? 0;
    const nativeStats = statsLength > 0
      ? new Uint8Array(this.exports.memory.buffer, this.exports.film_executor_stats_ptr(this.handle) >>> 0, statsLength)
      : null;
    const missingBloomContribution = nativeStats?.[4] === 1;
    const residentStats = this.stats();
    const nodes = enabled.map((node) => ({
      id: node.id,
      type: node.type,
      backend: this.backendLabel,
      backendVariant: this.backendVariant,
      elapsedMs: 0,
      scratchBytes: 0,
      warnings: missingBloomContribution && node.type === 'highlightProtection'
        ? ['missingBloomContribution', 'Highlight Protection has no Bloom contribution']
        : [],
      fullPixelPasses: 1,
      inputBytes: 0,
      outputBytes: 0,
    }));
    return {
      width: input.width,
      height: input.height,
      rgb: output,
      alpha: input.alpha,
      ...(debugCheckpoints ? { debugCheckpoints } : {}),
      stats: {
        backend: this.backendLabel,
        backendVariant: this.backendVariant,
        engineVersion: '1.7.0',
        minimumEngineVersion: '1.7.0',
        halationEngineVersion: '1.5.1',
        planHash: plan.planHash,
        graphHash: plan.graphHash,
        layoutHash: physicalLayout?.layoutHash ?? plan?.physicalLayout?.layoutHash ?? null,
        nodes,
        fullPixelPasses: nodes.length,
        passes: { fullPixelPasses: nodes.length, perNode: Object.fromEntries(nodes.map((node) => [node.id, 1])) },
        copies: { inputBytes: input.rgb.byteLength + alphaView.byteLength, outputBytes: output.byteLength, count: 2 },
        timings: { total: 0, read: 0, process: 0, quantize: 0, write: 0, perNode: {}, perStage: {} },
        memoryGeneration: this.generation,
        scheduler: {
          stepCalls: residentStats.nativeStepCalls,
          maxStepWork: residentStats.nativeMaxStepWork,
          plannedArenaFloats: residentStats.plannedArenaFloats,
          actualArenaFloats: residentStats.actualArenaFloats,
          plannedTransientFloats: residentStats.plannedTransientFloats,
          actualTransientFloats: residentStats.actualTransientFloats,
          allocationCount: residentStats.allocationCount,
        },
      },
    };
  }

  async executeAsync(input, plan, context = {}) {
    const enabled = Array.isArray(plan?.enabled) ? plan.enabled : [];
    if (enabled.some((node) => !residentNodeSupported(node))) {
      const error = new Error('Resident WASM plan contains an unsupported node or luma mask');
      error.code = 'ERR_UNSUPPORTED_NODE';
      throw error;
    }
    const plannedBandCapacity = Math.max(
      input.height,
      Array.isArray(plan?.bands)
        ? Math.max(0, ...plan.bands.map((band) => Math.trunc(Number(band.end) - Number(band.start))))
        : input.height,
    );
    const capacityPixels = input.width * plannedBandCapacity;
    const physicalLayout = plan?.physicalLayoutFor?.(input.width, plannedBandCapacity) ?? plan?.physicalLayout;
    const physicalArena = physicalLayout?.residentScratchFloats ?? physicalLayout?.scratchFloats ?? 0;
    const physicalTransient = physicalLayout?.transientFloats ?? 0;
    const activePlan = physicalLayout && Array.isArray(plan?.commands)
      ? { ...plan, commands: plan.commands.map((/** @type {any} */ item, /** @type {number} */ index) => ({ ...item, memoryLayout: (physicalLayout.residentBindings ?? physicalLayout.bindings)[index] })) }
      : plan;
    const command = createGraphCommandBuffer(activePlan, {
      ...context,
      width: input.width,
      height: input.height,
      fullWidth: context.fullWidth ?? plan.fullWidth,
      fullHeight: context.fullHeight ?? plan.fullHeight,
      executorAbiVersion: EXECUTOR_ABI_VERSION,
    });
    validateGraphCommandBuffer(command);
    this.reserve(
      input.width,
      plannedBandCapacity,
      command.byteLength,
      Math.max(1, physicalArena || capacityPixels * Math.max(1, Number(plan?.residentMemory?.arenaFloatsPerPixel ?? 32))),
      Math.max(1, physicalTransient || capacityPixels * Math.max(1, Number(plan?.residentMemory?.transientFloatsPerPixel ?? 7))),
    );
    this.validateGeneration(this.generation);
    let memory = this.exports.memory.buffer;
    new Uint8Array(memory, this.exports.film_executor_command_ptr(this.handle) >>> 0, command.byteLength).set(command);
    new Float32Array(memory, this.exports.film_executor_input_rgb_ptr(this.handle) >>> 0, input.rgb.length).set(input.rgb);
    const alphaView = new Float32Array(memory, this.exports.film_executor_input_alpha_ptr(this.handle) >>> 0, input.width * input.height);
    if (input.alpha) alphaView.set(input.alpha);
    else alphaView.fill(1);
    this.metrics.uploadBytes += input.rgb.byteLength + alphaView.byteLength;
    this.metrics.commandBytes += command.byteLength;
    let code = this.exports.film_executor_begin(this.handle, command.byteLength);
    if (code !== 0) throw residentError('film_executor_begin failed', code, this.exports.film_executor_failure_node?.(this.handle) ?? -1);
    const yieldIntervalMs = Math.max(1, Number(context.yieldIntervalMs ?? (context.intent === 'preview' ? 12 : 50)));
    const targetStepMs = Math.max(1, Number(context.targetStepMs ?? (context.intent === 'preview' ? 12 : 50)));
    let workBudget = initialWorkBudget(context);
    let yieldedAt = globalThis.performance?.now?.() ?? Date.now();
    const debugCheckpoints = context.debugCheckpoints === true ? [] : null;
    let previousCursor = 0;
    while (true) {
      if (context.signal?.aborted) {
        this.exports.film_executor_reset(this.handle);
        throw residentError('Film render cancelled', -8, this.exports.film_executor_cursor?.(this.handle) ?? -1);
      }
      // Pixel-visits are the ABI unit. The quantum is adapted between safe
      // node/pass boundaries but never leaves the frozen 16K–262K range.
      const stepStartedAt = globalThis.performance?.now?.() ?? Date.now();
      code = this.exports.film_executor_step(this.handle, workBudget);
      const stepElapsedMs = (globalThis.performance?.now?.() ?? Date.now()) - stepStartedAt;
      this.metrics.stepCalls += 1;
      const progressCursor = this.exports.film_executor_cursor?.(this.handle) ?? previousCursor;
      this.metrics.steps += Math.max(0, progressCursor - previousCursor);
      previousCursor = progressCursor;
      this.metrics.maxStepWork = Math.max(this.metrics.maxStepWork, this.exports.film_executor_step_work?.(this.handle) ?? 0);
      workBudget = adaptWorkBudget(workBudget, stepElapsedMs, targetStepMs);
      if (debugCheckpoints) {
        const cursor = progressCursor;
        if (cursor > debugCheckpoints.length) {
          const checkpoint = new Float32Array(input.rgb.length);
          checkpoint.set(new Float32Array(this.exports.memory.buffer, this.exports.film_executor_current_rgb_ptr(this.handle) >>> 0, input.rgb.length));
          debugCheckpoints.push({ nodeIndex: cursor - 1, rgb: checkpoint });
        }
      }
      if (code === 0) break;
      if (code !== 1) throw residentError('film_executor_step failed', code, this.exports.film_executor_failure_node?.(this.handle) ?? -1);
      const currentTime = globalThis.performance?.now?.() ?? Date.now();
      if (currentTime - yieldedAt >= yieldIntervalMs) {
        await yieldToHost();
        yieldedAt = globalThis.performance?.now?.() ?? Date.now();
      }
    }
    if (context.signal?.aborted) {
      this.exports.film_executor_reset(this.handle);
      throw residentError('Film render cancelled', -8, this.exports.film_executor_cursor?.(this.handle) ?? -1);
    }
    memory = this.exports.memory.buffer;
    const output = new Float32Array(input.rgb.length);
    output.set(new Float32Array(memory, this.exports.film_executor_output_rgb_ptr(this.handle) >>> 0, input.rgb.length));
    this.metrics.downloadBytes += output.byteLength;
    const statsLength = this.exports.film_executor_stats_len?.(this.handle) ?? 0;
    const nativeStats = statsLength > 0
      ? new Uint8Array(memory, this.exports.film_executor_stats_ptr(this.handle) >>> 0, statsLength)
      : null;
    const missingBloomContribution = nativeStats?.[4] === 1;
    const residentStats = this.stats();
    const nodes = enabled.map((node) => ({
      id: node.id,
      type: node.type,
      backend: this.backendLabel,
      backendVariant: this.backendVariant,
      elapsedMs: 0,
      scratchBytes: 0,
      warnings: missingBloomContribution && node.type === 'highlightProtection'
        ? ['missingBloomContribution', 'Highlight Protection has no Bloom contribution']
        : [],
      fullPixelPasses: 1,
      inputBytes: 0,
      outputBytes: 0,
    }));
    return {
      width: input.width,
      height: input.height,
      rgb: output,
      alpha: input.alpha,
      ...(debugCheckpoints ? { debugCheckpoints } : {}),
      stats: {
        backend: this.backendLabel,
        backendVariant: this.backendVariant,
        engineVersion: '1.7.0',
        minimumEngineVersion: '1.7.0',
        halationEngineVersion: '1.5.1',
        planHash: plan.planHash,
        graphHash: plan.graphHash,
        layoutHash: physicalLayout?.layoutHash ?? plan?.physicalLayout?.layoutHash ?? null,
        nodes,
        fullPixelPasses: nodes.length,
        passes: { fullPixelPasses: nodes.length, perNode: Object.fromEntries(nodes.map((node) => [node.id, 1])) },
        copies: { inputBytes: input.rgb.byteLength + alphaView.byteLength, outputBytes: output.byteLength, count: 2 },
        timings: { total: 0, read: 0, process: 0, quantize: 0, write: 0, perNode: {}, perStage: {} },
        memoryGeneration: this.generation,
        scheduler: {
          stepCalls: residentStats.nativeStepCalls,
          maxStepWork: residentStats.nativeMaxStepWork,
          plannedArenaFloats: residentStats.plannedArenaFloats,
          actualArenaFloats: residentStats.actualArenaFloats,
          plannedTransientFloats: residentStats.plannedTransientFloats,
          actualTransientFloats: residentStats.actualTransientFloats,
          allocationCount: residentStats.allocationCount,
        },
      },
    };
  }

  stats() {
    return {
      ...this.metrics,
      abiVersion: this.exports.film_executor_abi_version?.() ?? 0,
      capabilities: this.exports.film_executor_capabilities?.() ?? 0,
      backendVariant: this.backendVariant,
      nativeStepCalls: this.exports.film_executor_step_count?.(this.handle) ?? 0,
      nativeMaxStepWork: this.exports.film_executor_max_step_work?.(this.handle) ?? this.metrics.maxStepWork ?? 0,
      plannedArenaFloats: this.exports.film_executor_planned_arena_floats?.(this.handle) ?? 0,
      actualArenaFloats: this.exports.film_executor_actual_arena_floats?.(this.handle) ?? 0,
      plannedTransientFloats: this.exports.film_executor_planned_transient_floats?.(this.handle) ?? 0,
      actualTransientFloats: this.exports.film_executor_actual_transient_floats?.(this.handle) ?? 0,
      allocationCount: this.exports.film_executor_allocation_count?.(this.handle) ?? 0,
    };
  }

  dispose() {
    if (this.handle !== null && this.handle !== undefined) this.exports.film_executor_destroy(this.handle);
    this.handle = null;
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

  grainScaleIntoAccum(width, height, fieldWidth, fieldHeight, pad, scale, sharedCoefficient, independentCoefficient, seed, nodeHash, originX, originY, scaleIndex, sigma, mode, fieldPreviewScale = 1) {
    if (!this.grainPointer || this.grainPixels !== width * height) throw new Error('WASM Grain workspace is not reserved');
    const fieldPixels = fieldWidth * fieldHeight;
    this.ensure(fieldPixels * 7);
    const code = this.exports.film_grain_scale_accumulate_f32(
      this.grainPointer,
      this.pointer,
      width >>> 0,
      height >>> 0,
      fieldWidth >>> 0,
      fieldHeight >>> 0,
      pad >>> 0,
      fieldPreviewScale,
      Math.max(1, scale | 0) >>> 0,
      sharedCoefficient,
      independentCoefficient,
      seed >>> 0,
      nodeHash >>> 0,
      originX,
      originY,
      scaleIndex >>> 0,
      sigma,
      mode === 'fast' ? 0 : 1,
    );
    if (code !== 0) throw new Error(`film_grain_scale_accumulate_f32 failed with code ${code}`);
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

  applyResidentGrain(rgb, alpha, dst, amount, iso, profile) {
    const pixels = rgb.length / 3;
    if (!this.grainPointer || this.grainPixels !== pixels) throw new Error('WASM Grain workspace is not reserved');
    this.ensure(pixels * 4);
    let view = new Float32Array(this.exports.memory.buffer, this.pointer, this.length);
    this.copyIn(view, rgb, 0);
    const alphaOffset = pixels * 3;
    if (alpha) this.copyIn(view, alpha, alphaOffset);
    const code = this.exports.film_apply_grain_planar_f32(
      this.pointer,
      this.grainPointer,
      alpha ? this.pointer + alphaOffset * 4 : 0,
      pixels,
      amount,
      iso,
      profile === 'positive' ? 1 : 0,
    );
    if (code !== 0) throw new Error(`film_apply_grain_planar_f32 failed with code ${code}`);
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

/** Create a V1.7 frame-resident adapter when the loaded module exposes ABI v1. */
export function createV17ResidentBackend(plan = {}) {
  const selectedBackend = executionMode === 'wasm-resident-simd'
    ? simdResidentBackend
    : (executionMode === 'auto' && simdQualified ? simdResidentBackend : residentBackend);
  if (!selectedBackend) return null;
  return {
    backend: selectedBackend.backendLabel,
    backendVariant: selectedBackend.backendVariant,
    abiVersion: selectedBackend.exports.film_executor_abi_version?.() ?? 0,
    capabilities: selectedBackend.exports.film_executor_capabilities?.() ?? 0,
    supportsPlan(candidate = plan) {
      const enabled = Array.isArray(candidate?.enabled) ? candidate.enabled : [];
      const layout = candidate?.physicalLayout;
      const layoutReady = !layout || (layout.version === 1
        && Number.isInteger(layout.scratchFloats) && layout.scratchFloats >= 0
        && Number.isInteger(layout.transientFloats) && layout.transientFloats >= 0
        && Array.isArray(layout.bindings) && layout.bindings.length === enabled.length);
      return layoutReady && enabled.every(residentNodeSupported);
    },
    execute(input, candidatePlanOrContext = {}, maybeContext = {}) {
      // FilmExecutor passes (input, renderPlan, context); direct callers may
      // use the shorter (input, context) form. Preserve AbortSignal and band
      // geometry in both cases.
      const hasPlanShape = candidatePlanOrContext && typeof candidatePlanOrContext === 'object'
        && typeof candidatePlanOrContext.planHash === 'string';
      const selectedPlan = hasPlanShape ? candidatePlanOrContext : plan;
      const context = hasPlanShape ? maybeContext : candidatePlanOrContext;
      return selectedBackend.execute(input, selectedPlan, context);
    },
    async executeAsync(input, candidatePlanOrContext = {}, maybeContext = {}) {
      const hasPlanShape = candidatePlanOrContext && typeof candidatePlanOrContext === 'object'
        && typeof candidatePlanOrContext.planHash === 'string';
      const selectedPlan = hasPlanShape ? candidatePlanOrContext : plan;
      const context = hasPlanShape ? maybeContext : candidatePlanOrContext;
      return selectedBackend.executeAsync(input, selectedPlan, context);
    },
    reserve(width, height, commandBytes) { return selectedBackend.reserve(width, height, commandBytes); },
    stats() { return selectedBackend.stats(); },
    dispose() {
      selectedBackend.dispose();
      if (selectedBackend === residentBackend) residentBackend = null;
      if (selectedBackend === simdResidentBackend) simdResidentBackend = null;
    },
  };
}

export function tryWasmBoxBlur(src, dst, width, height, sigma) {
  if (!backend || executionMode === 'js' || (executionMode === 'wasm-resident' || executionMode === 'wasm-resident-simd')) return false;
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
  if (!backend || executionMode === 'js' || (executionMode === 'wasm-resident' || executionMode === 'wasm-resident-simd')) return false;
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
  if (!backend || executionMode === 'js' || (executionMode === 'wasm-resident' || executionMode === 'wasm-resident-simd')) return false;
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
  if (!backend || executionMode === 'js' || (executionMode === 'wasm-resident' || executionMode === 'wasm-resident-simd')) return false;
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
  if (!backend || executionMode === 'js' || (executionMode === 'wasm-resident' || executionMode === 'wasm-resident-simd')) return false;
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
  if (!backend || executionMode === 'js' || (executionMode === 'wasm-resident' || executionMode === 'wasm-resident-simd')) return false;
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
  if (!backend || executionMode === 'js' || (executionMode === 'wasm-resident' || executionMode === 'wasm-resident-simd')) return false;
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
  if (!backend || executionMode === 'js' || (executionMode === 'wasm-resident' || executionMode === 'wasm-resident-simd')) return false;
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

/** Generate shared/R/G/B fields for one Grain scale and accumulate them without JS materialization. */
export function tryWasmGrainScaleIntoAccum(width, height, fieldWidth, fieldHeight, pad, scale, sharedCoefficient, independentCoefficient, seed, nodeHash, originX, originY, scaleIndex, sigma, mode, fieldPreviewScale = 1) {
  if (!backend || executionMode === 'js' || (executionMode === 'wasm-resident' || executionMode === 'wasm-resident-simd')) return false;
  try {
    backend.grainScaleIntoAccum(width, height, fieldWidth, fieldHeight, pad, scale, sharedCoefficient, independentCoefficient, seed, nodeHash, originX, originY, scaleIndex, sigma, mode, fieldPreviewScale);
    return true;
  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error);
    return false;
  }
}

export function tryWasmFinishGrainAccum(noisePlanes) {
  if (!backend || executionMode === 'js' || (executionMode === 'wasm-resident' || executionMode === 'wasm-resident-simd')) return false;
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
  if (!backend || executionMode === 'js' || (executionMode === 'wasm-resident' || executionMode === 'wasm-resident-simd')) return false;
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

/** Composite from the resident planar Grain accumulator without a noise-plane round trip. */
export function tryWasmApplyResidentGrain(rgb, alpha, dst, amount, iso, profile) {
  if (!backend || executionMode === 'js' || (executionMode === 'wasm-resident' || executionMode === 'wasm-resident-simd')) return false;
  try {
    backend.applyResidentGrain(rgb, alpha, dst, amount, iso, profile);
    return true;
  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error);
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
    backend: executionMode === 'js' ? 'js'
      : executionMode === 'wasm-resident-simd' && simdResidentBackend ? 'wasm-resident-simd'
        : executionMode === 'wasm-resident' && residentBackend ? 'wasm-resident-scalar'
          : backend ? 'wasm' : 'js',
    executionMode,
    version: backend ? backend.exports.film_version() : null,
    error: lastError,
    metrics: backend ? {
      ...backend.stats(),
      resident: residentBackend?.stats?.() ?? null,
      simdResident: simdResidentBackend?.stats?.() ?? null,
      simdQualified,
    } : null,
  };
}

export function resetWasmBackend() {
  residentBackend?.dispose?.();
  simdResidentBackend?.dispose?.();
  backend?.dispose?.();
  backend = null;
  residentBackend = null;
  simdResidentBackend = null;
  simdQualified = false;
  lastError = null;
}

/** Set the request-local policy used by the stable FilmExecutor seam. */
export function setWasmExecutionMode(mode = 'auto') {
  if (!['auto', 'js', 'wasm-primitive', 'wasm-resident', 'wasm-resident-simd'].includes(mode)) throw new TypeError(`Unknown WASM execution mode: ${mode}`);
  const previous = executionMode;
  executionMode = mode;
  return previous;
}

export function getWasmExecutionMode() {
  return executionMode;
}

/** QA-only qualification gate for Auto SIMD selection.  Correctness and a
 * measured protocol speedup of at least 10% are both required; production
 * code never promotes a merely loadable simd128 module. */
export function setWasmSimdQualification({ correct = false, speedup = 0 } = {}) {
  simdQualified = !!simdResidentBackend && correct === true && Number(speedup) >= 0.10;
  return simdQualified;
}
