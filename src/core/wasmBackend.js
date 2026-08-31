// @ts-nocheck
/** Optional WebAssembly numeric backend. Any failure leaves the pure-JS path active. */
import { createGraphCommandBuffer, validateGraphCommandBuffer, EXECUTOR_ABI_VERSION } from './commandBuffer.js';
let backend = null;
let residentBackend = null;
let simdResidentBackend = null;
let residentModule = null;
let simdResidentModule = null;
const residentSessionPool = new Map();
let simdQualified = false;
let lastError = null;
let executionMode = 'auto';
const RESIDENT_REQUIRED_CAPABILITIES = (1 << 2) | (1 << 3);
const SEGMENTED_REQUIRED_CAPABILITIES = (1 << 4) | (1 << 5);
const SIMD_REQUIRED_CAPABILITIES = (1 << 1) | (1 << 7);
// PF-12 qualification is deliberately artifact-bound. Rebuilding either
// module changes this identity and makes Auto fall back to scalar until the
// fixed-vector and 24MP 2+10 protocol is approved again.
const SIMD_RELEASE_QUALIFICATION = Object.freeze({
  scalar: Object.freeze({ byteLength: 140988, fnv1a32: 0x844cfa76 }),
  simd: Object.freeze({ byteLength: 156481, fnv1a32: 0x76a4df8f }),
  p95Speedup: 0.16495332222587433,
});

function artifactBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}

function artifactIdentityMatches(value, expected) {
  const bytes = artifactBytes(value);
  if (bytes.byteLength !== expected.byteLength) return false;
  let hash = 0x811c9dc5;
  for (let index = 0; index < bytes.length; index += 1) {
    hash ^= bytes[index];
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash === expected.fnv1a32;
}

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

let hostYieldChannel = null;
const hostYieldResolvers = [];

function yieldToHost() {
  if (typeof globalThis.scheduler?.yield === 'function') return globalThis.scheduler.yield();
  if (typeof globalThis.setImmediate === 'function') return new Promise((resolve) => globalThis.setImmediate(resolve));
  if (typeof globalThis.MessageChannel === 'function') {
    if (!hostYieldChannel) {
      hostYieldChannel = new globalThis.MessageChannel();
      hostYieldChannel.port1.onmessage = () => {
        const resolve = hostYieldResolvers.shift();
        resolve?.();
        if (hostYieldResolvers.length === 0) {
          hostYieldChannel.port1.unref?.();
          hostYieldChannel.port2.unref?.();
        }
      };
      hostYieldChannel.port1.unref?.();
      hostYieldChannel.port2.unref?.();
    }
    return new Promise((resolve) => {
      if (hostYieldResolvers.length === 0) {
        hostYieldChannel.port1.ref?.();
        hostYieldChannel.port2.ref?.();
      }
      hostYieldResolvers.push(resolve);
      hostYieldChannel.port2.postMessage(0);
    });
  }
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

const RESIDENT_PHASES = Object.freeze({
  defringe: ['extract', 'blurY', 'blurCg', 'composite'],
  bloom: ['extract', 'diffuse', 'composite'],
  highlightProtection: ['protect'],
  halation: ['extract', 'sourceExpansion', 'diffuse', 'interiorProtection', 'globalDiffusion', 'composite'],
  filmResolution: ['weights', 'channelExtract', 'primaryBlur', 'wideBlur', 'composite'],
  grain: ['init', 'fieldGenerate', 'fieldBlur', 'fieldAccumulate', 'composite'],
});

function residentPhaseLabel(node, phase, channel = 0, lobe = 0, pass = 0) {
  const phases = RESIDENT_PHASES[node?.type] ?? [];
  const base = phases[phase] ?? `phase-${phase}`;
  if (node?.type === 'highlightProtection' && pass === 31) return 'protect[fusedBloomComposite]';
  return base === 'diffuse' ? `${base}[${channel},${lobe}]` : base;
}

function quantile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1))];
}

/** @param {any} plan @param {any} segment */
function segmentExecutionPlan(plan, segment) {
  const enabled = plan.enabled.slice(segment.nodeStart, segment.nodeEnd + 1);
  const commands = plan.commands.slice(segment.nodeStart, segment.nodeEnd + 1).map((command, index) => ({
    ...command,
    memoryLayout: segment.physicalLayout?.residentBindings?.[index]
      ?? segment.physicalLayout?.bindings?.[index]
      ?? command.memoryLayout,
  }));
  return {
    ...plan,
    enabled,
    commands,
    physicalLayout: segment.physicalLayout,
    width: plan.width,
    height: segment.bandHeight,
  };
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
    clearResidentSessionPool();
    backend = new WasmBlurBackend(exports);
    residentModule = instantiated.module;
    residentBackend = typeof exports.film_executor_abi_version === 'function'
      && typeof exports.film_executor_capabilities === 'function'
      && (exports.film_executor_capabilities() & RESIDENT_REQUIRED_CAPABILITIES) === RESIDENT_REQUIRED_CAPABILITIES
      ? new WasmResidentBackend(exports, 'wasm-resident')
      : null;
    simdResidentBackend = null;
    simdResidentModule = null;
    simdQualified = false;
    if (simdBytes && typeof WebAssembly.validate === 'function') {
      const simdSource = simdBytes instanceof ArrayBuffer
        ? simdBytes
        : simdBytes.buffer.slice(simdBytes.byteOffset, simdBytes.byteOffset + simdBytes.byteLength);
      if (WebAssembly.validate(simdSource)) {
        const simdInstance = await WebAssembly.instantiate(simdSource, {});
        const simdExports = simdInstance.instance.exports;
        if (typeof simdExports.film_executor_capabilities === 'function'
          && (simdExports.film_executor_capabilities() & SIMD_REQUIRED_CAPABILITIES) === SIMD_REQUIRED_CAPABILITIES
          && (simdExports.film_executor_capabilities() & RESIDENT_REQUIRED_CAPABILITIES) === RESIDENT_REQUIRED_CAPABILITIES
          && typeof simdExports.film_executor_abi_version === 'function'
          && simdExports.film_executor_abi_version() === EXECUTOR_ABI_VERSION
          && (typeof simdExports.film_executor_simd_probe !== 'function'
            || Math.abs(simdExports.film_executor_simd_probe(0.375) - 0.375) <= 1e-7)) {
          simdResidentBackend = new WasmResidentBackend(simdExports, 'wasm-resident-simd');
          simdResidentModule = simdInstance.module;
          simdQualified = SIMD_RELEASE_QUALIFICATION.p95Speedup >= 0.10
            && artifactIdentityMatches(bytes, SIMD_RELEASE_QUALIFICATION.scalar)
            && artifactIdentityMatches(simdBytes, SIMD_RELEASE_QUALIFICATION.simd);
        }
      }
    }
    lastError = null;
    return getWasmBackendStatus();
  } catch (error) {
    clearResidentSessionPool();
    residentBackend?.dispose?.();
    simdResidentBackend?.dispose?.();
    backend?.dispose?.();
    backend = null;
    residentBackend = null;
    simdResidentBackend = null;
    residentModule = null;
    simdResidentModule = null;
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
    this.segmentedSupported = ((exports.film_executor_capabilities?.() ?? 0) & SEGMENTED_REQUIRED_CAPABILITIES) === SEGMENTED_REQUIRED_CAPABILITIES;
    this.resetMetrics();
  }

  resetMetrics() {
    this.metrics = { uploadBytes: 0, downloadBytes: 0, commandBytes: 0, steps: 0, stepCalls: 0, maxStepWork: 0, memoryGeneration: 0, fusionCount: 0 };
  }

  resetForReuse() {
    if (this.handle === null || this.handle === undefined) return false;
    try {
      return (this.exports.film_executor_reset?.(this.handle) ?? 0) === 0;
    } catch {
      return false;
    }
  }

  _setDebugIntermediates(context = {}) {
    const code = this.exports.film_executor_set_debug_intermediates?.(
      this.handle,
      context.debugCheckpoints === true ? 1 : 0,
    ) ?? 0;
    if (code !== 0) throw residentError('film_executor_set_debug_intermediates failed', code);
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

  reserveSegmented(width, fullHeight, maxBandHeight, commandBytes, arenaFloats, transientFloats) {
    if (!this.segmentedSupported || typeof this.exports.film_executor_reserve_segmented !== 'function') {
      const error = new Error('Resident segmented frame capability is unavailable');
      error.code = 'ERR_WASM_SEGMENTED_UNAVAILABLE';
      throw error;
    }
    const required = Math.max(1, Math.trunc(commandBytes));
    const code = this.exports.film_executor_reserve_segmented(
      this.handle,
      required,
      width >>> 0,
      fullHeight >>> 0,
      maxBandHeight >>> 0,
      Math.max(1, Math.trunc(arenaFloats)) >>> 0,
      Math.max(1, Math.trunc(transientFloats)) >>> 0,
    );
    if (code !== 0) throw residentError('film_executor_reserve_segmented failed', code);
    this.width = width;
    this.height = fullHeight;
    this.maxBandHeight = maxBandHeight;
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

  _stepResident(enabled, context, tracker, workBudget, debugCheckpoints, inputLength) {
    if (context.signal?.aborted) {
      if (typeof this.exports.film_executor_cancel === 'function') this.exports.film_executor_cancel(this.handle);
      else this.exports.film_executor_reset(this.handle);
      throw residentError('Film render cancelled', -8, this.exports.film_executor_cursor?.(this.handle) ?? -1);
    }
    const stepStartedAt = globalThis.performance?.now?.() ?? Date.now();
    const code = this.exports.film_executor_step(this.handle, workBudget);
    const stepElapsedMs = (globalThis.performance?.now?.() ?? Date.now()) - stepStartedAt;
    tracker.residentCost.scheduler += stepElapsedMs;
    this.metrics.stepCalls += 1;
    const progressCursor = this.exports.film_executor_cursor?.(this.handle) ?? tracker.previousCursor;
    this.metrics.steps += Math.max(0, progressCursor - tracker.previousCursor);
    tracker.previousCursor = progressCursor;
    tracker.stepLatency.count += 1;
    tracker.stepLatency.total += stepElapsedMs;
    tracker.stepLatency.max = Math.max(tracker.stepLatency.max, stepElapsedMs);
    if (tracker.stepSamples) tracker.stepSamples.push(stepElapsedMs);
    const needsSnapshot = tracker.profileResident || typeof context.onResidentStep === 'function';
    let snapshot = null;
    if (needsSnapshot) {
      const work = this.exports.film_executor_step_work?.(this.handle) ?? 0;
      const nodeIndex = this.exports.film_executor_last_step_node?.(this.handle) ?? 0xffffffff;
      const phase = this.exports.film_executor_last_step_phase?.(this.handle) ?? 0;
      const channel = this.exports.film_executor_last_step_channel?.(this.handle) ?? 0;
      const lobe = this.exports.film_executor_last_step_lobe?.(this.handle) ?? 0;
      const pass = this.exports.film_executor_last_step_pass?.(this.handle) ?? 0;
      const reads = this.exports.film_executor_last_step_reads?.(this.handle) ?? work;
      const writes = this.exports.film_executor_last_step_writes?.(this.handle) ?? work;
      const taps = this.exports.film_executor_last_step_taps?.(this.handle) ?? 0;
      const downsamplePixels = this.exports.film_executor_last_step_downsample_pixels?.(this.handle) ?? 0;
      const upsamplePixels = this.exports.film_executor_last_step_upsample_pixels?.(this.handle) ?? 0;
      snapshot = { code, node: nodeIndex, phase, channel, lobe, pass, work, reads, writes, taps, downsamplePixels, upsamplePixels, elapsedMs: stepElapsedMs };
      this.metrics.maxStepWork = Math.max(this.metrics.maxStepWork, work);
      if (tracker.profileResident) {
        const node = enabled[nodeIndex];
        if (node) {
          tracker.perNode[node.id] = (tracker.perNode[node.id] ?? 0) + stepElapsedMs;
          const stage = `${node.id}.${residentPhaseLabel(node, phase, channel, lobe, pass)}`;
          tracker.perStage[stage] = (tracker.perStage[stage] ?? 0) + stepElapsedMs;
        }
        tracker.work.pixelVisits += work;
        tracker.work.pixelsRead += reads;
        tracker.work.pixelsWritten += writes;
        tracker.work.convolutionTaps += taps;
        tracker.work.downsamplePixels += downsamplePixels;
        tracker.work.upsamplePixels += upsamplePixels;
      }
    }
    if (typeof context.onResidentStep === 'function') context.onResidentStep(snapshot);
    if (context.signal?.aborted) {
      if (typeof this.exports.film_executor_cancel === 'function') this.exports.film_executor_cancel(this.handle);
      else this.exports.film_executor_reset(this.handle);
      throw residentError('Film render cancelled', -8, this.exports.film_executor_cursor?.(this.handle) ?? -1);
    }
    if (debugCheckpoints && progressCursor > debugCheckpoints.length) {
      const checkpoint = new Float32Array(inputLength);
      checkpoint.set(new Float32Array(this.exports.memory.buffer, this.exports.film_executor_current_rgb_ptr(this.handle) >>> 0, inputLength));
      debugCheckpoints.push({ nodeIndex: progressCursor - 1, rgb: checkpoint });
    }
    if (code !== 0 && code !== 1) throw residentError('film_executor_step failed', code, this.exports.film_executor_failure_node?.(this.handle) ?? -1);
    return { code, elapsedMs: stepElapsedMs };
  }

  execute(input, plan, context = {}) {
    if (plan?.executionMode === 'resident-segmented') {
      if (!this.segmentedSupported) {
        throw residentError('Resident segmented frame capability is unavailable', -9, -1);
      }
      return this.executeSegmented(input, plan, context);
    }
    // Resident kernels are capability-gated at module installation. Any
    // numerical/ABI failure remains request-scoped: the executor preserves the
    // canonical input and may rerun the complete graph through JavaScript.
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
    const processStartedAt = globalThis.performance?.now?.() ?? Date.now();
    const profileResident = context.profileResident !== false;
    const collectStepSamples = profileResident && context.collectStepSamples === true;
    const stepSamples = collectStepSamples ? [] : null;
    const perNode = Object.fromEntries(enabled.map((node) => [node.id, 0]));
    const perStage = {};
    const work = { pixelVisits: 0, pixelsRead: 0, pixelsWritten: 0, convolutionTaps: 0, downsamplePixels: 0, upsamplePixels: 0 };
    const stepLatency = { count: 0, total: 0, max: 0 };
    const residentCost = { command: 0, upload: 0, yield: 0, scheduler: 0, download: 0 };
    const commandStartedAt = globalThis.performance?.now?.() ?? Date.now();
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
    this._setDebugIntermediates(context);
    residentCost.command = (globalThis.performance?.now?.() ?? Date.now()) - commandStartedAt;
    this.validateGeneration(this.generation);
    let memory = this.exports.memory.buffer;
    const uploadStartedAt = globalThis.performance?.now?.() ?? Date.now();
    let commandView = new Uint8Array(memory, this.exports.film_executor_command_ptr(this.handle) >>> 0, command.byteLength);
    commandView.set(command);
    let rgbView = new Float32Array(memory, this.exports.film_executor_input_rgb_ptr(this.handle) >>> 0, input.rgb.length);
    rgbView.set(input.rgb);
    const alphaView = new Float32Array(memory, this.exports.film_executor_input_alpha_ptr(this.handle) >>> 0, input.width * input.height);
    if (input.alpha) alphaView.set(input.alpha);
    else alphaView.fill(1);
    this.metrics.uploadBytes += input.rgb.byteLength + alphaView.byteLength;
    this.metrics.commandBytes += command.byteLength;
    residentCost.upload = (globalThis.performance?.now?.() ?? Date.now()) - uploadStartedAt;
    let code = this.exports.film_executor_begin(this.handle, command.byteLength);
    if (code !== 0) throw residentError('film_executor_begin failed', code, this.exports.film_executor_failure_node?.(this.handle) ?? -1);
    const debugCheckpoints = context.debugCheckpoints === true ? [] : null;
    const workBudget = initialWorkBudget(context);
    const tracker = { profileResident, stepSamples, perNode, perStage, work, stepLatency, residentCost, previousCursor: 0 };
    while (true) {
      ({ code } = this._stepResident(enabled, context, tracker, workBudget, debugCheckpoints, input.rgb.length));
      if (code === 0) break;
    }
    memory = this.exports.memory.buffer;
    const downloadStartedAt = globalThis.performance?.now?.() ?? Date.now();
    const outputView = new Float32Array(memory, this.exports.film_executor_output_rgb_ptr(this.handle) >>> 0, input.rgb.length);
    const output = new Float32Array(input.rgb.length);
    output.set(outputView);
    this.metrics.downloadBytes += output.byteLength;
    residentCost.download = (globalThis.performance?.now?.() ?? Date.now()) - downloadStartedAt;
    const statsLength = profileResident ? (this.exports.film_executor_stats_len?.(this.handle) ?? 0) : 0;
    const nativeStats = statsLength > 0
      ? new Uint8Array(this.exports.memory.buffer, this.exports.film_executor_stats_ptr(this.handle) >>> 0, statsLength)
      : null;
    const missingBloomContribution = profileResident && nativeStats?.[4] === 1;
    // The comparison mode intentionally avoids the per-run native counters;
    // async scheduling still owns the wall-clock step timer above.  Keep the
    // lightweight step count in the result so callers can verify progress.
    const residentStats = profileResident
      ? this.stats()
      : { nativeStepCalls: stepLatency.count, nativeMaxStepWork: 0, plannedArenaFloats: 0, actualArenaFloats: 0, plannedTransientFloats: 0, actualTransientFloats: 0, allocationCount: 0 };
    const processElapsedMs = (globalThis.performance?.now?.() ?? Date.now()) - processStartedAt;
    const kernelElapsedMs = Object.values(perNode).reduce((sum, value) => sum + Number(value || 0), 0);
    residentCost.scheduler = Math.max(0, processElapsedMs - residentCost.command - residentCost.upload - residentCost.yield - residentCost.download - kernelElapsedMs);
    const bindings = physicalLayout?.residentBindings ?? physicalLayout?.bindings ?? [];
    const nodes = enabled.map((node, index) => ({
      id: node.id,
      type: node.type,
      backend: this.backendLabel,
      backendVariant: this.backendVariant,
      elapsedMs: profileResident ? (perNode[node.id] ?? 0) : 0,
      scratchBytes: Math.max(0, Math.trunc(Number(bindings[index]?.residentScratchFloats ?? 0) * Float32Array.BYTES_PER_ELEMENT)),
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
        executionMode: plan?.executionMode ?? 'whole-frame',
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
        timings: { total: processElapsedMs, read: 0, process: processElapsedMs, quantize: 0, write: 0, perNode: profileResident ? perNode : {}, perStage: profileResident ? { ...perStage, 'resident.command': residentCost.command, 'resident.upload': residentCost.upload, 'resident.yield': residentCost.yield, 'resident.scheduler': residentCost.scheduler, 'resident.download': residentCost.download } : {} },
        memoryGeneration: this.generation,
        scheduler: {
          stepCalls: residentStats.nativeStepCalls,
          maxStepWork: residentStats.nativeMaxStepWork,
          plannedArenaFloats: residentStats.plannedArenaFloats,
          actualArenaFloats: residentStats.actualArenaFloats,
          plannedTransientFloats: residentStats.plannedTransientFloats,
          actualTransientFloats: residentStats.actualTransientFloats,
          allocationCount: residentStats.allocationCount,
          fusionCount: this.metrics.fusionCount,
          stepLatencyMs: collectStepSamples ? { ...stepLatency, p50: quantile(stepSamples, 0.5), p95: quantile(stepSamples, 0.95) } : stepLatency,
          work,
        },
      },
    };
  }

  async executeAsync(input, plan, context = {}) {
    if (plan?.executionMode === 'resident-segmented') {
      if (!this.segmentedSupported) {
        throw residentError('Resident segmented frame capability is unavailable', -9, -1);
      }
      return this.executeSegmentedAsync(input, plan, context);
    }
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
    const processStartedAt = globalThis.performance?.now?.() ?? Date.now();
    const profileResident = context.profileResident !== false;
    const collectStepSamples = profileResident && context.collectStepSamples === true;
    const stepSamples = collectStepSamples ? [] : null;
    const perNode = Object.fromEntries(enabled.map((node) => [node.id, 0]));
    const perStage = {};
    const work = { pixelVisits: 0, pixelsRead: 0, pixelsWritten: 0, convolutionTaps: 0, downsamplePixels: 0, upsamplePixels: 0 };
    const stepLatency = { count: 0, total: 0, max: 0 };
    const residentCost = { command: 0, upload: 0, yield: 0, scheduler: 0, download: 0 };
    const commandStartedAt = globalThis.performance?.now?.() ?? Date.now();
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
    this._setDebugIntermediates(context);
    residentCost.command = (globalThis.performance?.now?.() ?? Date.now()) - commandStartedAt;
    this.validateGeneration(this.generation);
    let memory = this.exports.memory.buffer;
    const uploadStartedAt = globalThis.performance?.now?.() ?? Date.now();
    new Uint8Array(memory, this.exports.film_executor_command_ptr(this.handle) >>> 0, command.byteLength).set(command);
    new Float32Array(memory, this.exports.film_executor_input_rgb_ptr(this.handle) >>> 0, input.rgb.length).set(input.rgb);
    const alphaView = new Float32Array(memory, this.exports.film_executor_input_alpha_ptr(this.handle) >>> 0, input.width * input.height);
    if (input.alpha) alphaView.set(input.alpha);
    else alphaView.fill(1);
    this.metrics.uploadBytes += input.rgb.byteLength + alphaView.byteLength;
    this.metrics.commandBytes += command.byteLength;
    residentCost.upload = (globalThis.performance?.now?.() ?? Date.now()) - uploadStartedAt;
    let code = this.exports.film_executor_begin(this.handle, command.byteLength);
    if (code !== 0) throw residentError('film_executor_begin failed', code, this.exports.film_executor_failure_node?.(this.handle) ?? -1);
    const yieldIntervalMs = Math.max(1, Number(context.yieldIntervalMs ?? (context.intent === 'preview' ? 12 : 50)));
    const targetStepMs = Math.max(1, Number(context.targetStepMs ?? (context.intent === 'preview' ? 12 : 50)));
    let workBudget = initialWorkBudget(context);
    let yieldedAt = globalThis.performance?.now?.() ?? Date.now();
    const debugCheckpoints = context.debugCheckpoints === true ? [] : null;
    const tracker = { profileResident, stepSamples, perNode, perStage, work, stepLatency, residentCost, previousCursor: 0 };
    while (true) {
      const step = this._stepResident(enabled, context, tracker, workBudget, debugCheckpoints, input.rgb.length);
      code = step.code;
      workBudget = adaptWorkBudget(workBudget, step.elapsedMs, targetStepMs);
      if (code === 0) break;
      const currentTime = globalThis.performance?.now?.() ?? Date.now();
      if (currentTime - yieldedAt >= yieldIntervalMs) {
        const yieldStartedAt = currentTime;
        await yieldToHost();
        residentCost.yield += (globalThis.performance?.now?.() ?? Date.now()) - yieldStartedAt;
        yieldedAt = globalThis.performance?.now?.() ?? Date.now();
      }
    }
    if (context.signal?.aborted) {
      if (typeof this.exports.film_executor_cancel === 'function') this.exports.film_executor_cancel(this.handle);
      else this.exports.film_executor_reset(this.handle);
      throw residentError('Film render cancelled', -8, this.exports.film_executor_cursor?.(this.handle) ?? -1);
    }
    memory = this.exports.memory.buffer;
    const downloadStartedAt = globalThis.performance?.now?.() ?? Date.now();
    const output = new Float32Array(input.rgb.length);
    output.set(new Float32Array(memory, this.exports.film_executor_output_rgb_ptr(this.handle) >>> 0, input.rgb.length));
    this.metrics.downloadBytes += output.byteLength;
    residentCost.download = (globalThis.performance?.now?.() ?? Date.now()) - downloadStartedAt;
    const statsLength = profileResident ? (this.exports.film_executor_stats_len?.(this.handle) ?? 0) : 0;
    const nativeStats = statsLength > 0
      ? new Uint8Array(memory, this.exports.film_executor_stats_ptr(this.handle) >>> 0, statsLength)
      : null;
    const missingBloomContribution = profileResident && nativeStats?.[4] === 1;
    const residentStats = profileResident
      ? this.stats()
      : { nativeStepCalls: stepLatency.count, nativeMaxStepWork: 0, plannedArenaFloats: 0, actualArenaFloats: 0, plannedTransientFloats: 0, actualTransientFloats: 0, allocationCount: 0 };
    const processElapsedMs = (globalThis.performance?.now?.() ?? Date.now()) - processStartedAt;
    const kernelElapsedMs = Object.values(perNode).reduce((sum, value) => sum + Number(value || 0), 0);
    residentCost.scheduler = Math.max(0, processElapsedMs - residentCost.command - residentCost.upload - residentCost.yield - residentCost.download - kernelElapsedMs);
    const bindings = physicalLayout?.residentBindings ?? physicalLayout?.bindings ?? [];
    const nodes = enabled.map((node, index) => ({
      id: node.id,
      type: node.type,
      backend: this.backendLabel,
      backendVariant: this.backendVariant,
      elapsedMs: profileResident ? (perNode[node.id] ?? 0) : 0,
      scratchBytes: Math.max(0, Math.trunc(Number(bindings[index]?.residentScratchFloats ?? 0) * Float32Array.BYTES_PER_ELEMENT)),
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
        executionMode: plan?.executionMode ?? 'whole-frame',
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
        timings: { total: processElapsedMs, read: 0, process: processElapsedMs, quantize: 0, write: 0, perNode: profileResident ? perNode : {}, perStage: profileResident ? { ...perStage, 'resident.command': residentCost.command, 'resident.upload': residentCost.upload, 'resident.yield': residentCost.yield, 'resident.scheduler': residentCost.scheduler, 'resident.download': residentCost.download } : {} },
        memoryGeneration: this.generation,
        scheduler: {
          stepCalls: residentStats.nativeStepCalls,
          maxStepWork: residentStats.nativeMaxStepWork,
          plannedArenaFloats: residentStats.plannedArenaFloats,
          actualArenaFloats: residentStats.actualArenaFloats,
          plannedTransientFloats: residentStats.plannedTransientFloats,
          actualTransientFloats: residentStats.actualTransientFloats,
          allocationCount: residentStats.allocationCount,
          fusionCount: this.metrics.fusionCount,
          stepLatencyMs: collectStepSamples ? { ...stepLatency, p50: quantile(stepSamples, 0.5), p95: quantile(stepSamples, 0.95) } : stepLatency,
          work,
        },
      },
    };
  }

  /** @param {any} input @param {any} plan @param {any} context */
  executeSegmented(input, plan, context = {}) {
    const enabled = Array.isArray(plan?.enabled) ? plan.enabled : [];
    const segments = Array.isArray(plan?.spatialSegments) ? plan.spatialSegments : [];
    if (!segments.length) return { width: input.width, height: input.height, rgb: new Float32Array(input.rgb), alpha: input.alpha, stats: { backend: this.backendLabel, executionMode: 'resident-segmented', nodes: [] } };
    if (enabled.some((node) => !residentNodeSupported(node))) {
      const error = new Error('Resident segmented plan contains an unsupported node or luma mask');
      error.code = 'ERR_UNSUPPORTED_NODE';
      throw error;
    }
    const maxBandHeight = Math.max(1, ...segments.flatMap((segment) => segment.bands.map((band) => band.end - band.start)));
    const segmentPlans = segments.map((segment) => segmentExecutionPlan(plan, segment));
    const commands = segmentPlans.map((segmentPlan, index) => createGraphCommandBuffer(segmentPlan, {
      ...context,
      width: input.width,
      height: Math.max(1, segments[index].bandHeight + segments[index].inputHalo * 2),
      fullWidth: context.fullWidth ?? plan.fullWidth,
      fullHeight: context.fullHeight ?? plan.fullHeight,
      executorAbiVersion: EXECUTOR_ABI_VERSION,
    }));
    commands.forEach(validateGraphCommandBuffer);
    const arenaFloats = Math.max(1, ...segments.map((segment) => Number(segment.physicalLayout?.residentScratchFloats ?? segment.memory?.scratchFloats ?? 0)));
    const transientFloats = Math.max(1, ...segments.map((segment) => Number(segment.physicalLayout?.transientFloats ?? segment.memory?.transientFloats ?? 0)));
    const commandCapacity = Math.max(1, ...commands.map((command) => command.byteLength));
    const startedAt = globalThis.performance?.now?.() ?? Date.now();
    const profileResident = context.profileResident !== false;
    const collectStepSamples = profileResident && context.collectStepSamples === true;
    const stepSamples = collectStepSamples ? [] : null;
    const perNode = Object.fromEntries(enabled.map((node) => [node.id, 0]));
    const perStage = {};
    const work = { pixelVisits: 0, pixelsRead: 0, pixelsWritten: 0, convolutionTaps: 0, downsamplePixels: 0, upsamplePixels: 0 };
    const stepLatency = { count: 0, total: 0, max: 0 };
    const residentCost = { command: 0, upload: 0, yield: 0, scheduler: 0, download: 0, materialize: 0, segmentCommit: 0 };
    this.reserveSegmented(input.width, input.height, maxBandHeight, commandCapacity, arenaFloats, transientFloats);
    this._setDebugIntermediates(context);
    this.validateGeneration(this.generation);
    let memory = this.exports.memory.buffer;
    const stagingRgb = new Float32Array(memory, this.exports.film_executor_staging_rgb_ptr(this.handle) >>> 0, input.width * maxBandHeight * 3);
    const stagingAlpha = new Float32Array(memory, this.exports.film_executor_staging_alpha_ptr(this.handle) >>> 0, input.width * maxBandHeight);
    const rowValues = input.width * 3;
    const uploadStartedAt = globalThis.performance?.now?.() ?? Date.now();
    for (let y0 = 0; y0 < input.height; y0 += maxBandHeight) {
      if (context.signal?.aborted) throw residentError('Film render cancelled', -8, -1);
      const rows = Math.min(maxBandHeight, input.height - y0);
      stagingRgb.set(input.rgb.subarray(y0 * rowValues, (y0 + rows) * rowValues), 0);
      if (input.alpha) stagingAlpha.set(input.alpha.subarray(y0 * input.width, (y0 + rows) * input.width), 0);
      else stagingAlpha.fill(1, 0, rows * input.width);
      const code = this.exports.film_executor_upload_rows(this.handle, y0 >>> 0, rows >>> 0);
      if (code !== 0) throw residentError('film_executor_upload_rows failed', code);
    }
    let code = this.exports.film_executor_finish_upload(this.handle);
    if (code !== 0) throw residentError('film_executor_finish_upload failed', code);
    residentCost.upload = (globalThis.performance?.now?.() ?? Date.now()) - uploadStartedAt;
    this.metrics.uploadBytes += input.rgb.byteLength + input.width * input.height * Float32Array.BYTES_PER_ELEMENT;
    const segmentStats = [];
    const debugSegmentSnapshots = context.debugSegmentSnapshots === true ? [] : null;
    for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex += 1) {
      const segment = segments[segmentIndex];
      const segmentPlan = segmentPlans[segmentIndex];
      const segmentStartedAt = globalThis.performance?.now?.() ?? Date.now();
      for (const band of segment.bands) {
        if (context.signal?.aborted) {
          this.exports.film_executor_abort_segment?.(this.handle);
          throw residentError('Film render cancelled', -8, -1);
        }
        const inputRows = band.end - band.start;
        const commandStartedAt = globalThis.performance?.now?.() ?? Date.now();
        const command = createGraphCommandBuffer(segmentPlan, {
          ...context,
          width: input.width,
          height: inputRows,
          fullWidth: context.fullWidth ?? plan.fullWidth,
          fullHeight: context.fullHeight ?? plan.fullHeight,
          originX: context.originX ?? 0,
          originY: (context.originY ?? 0) + band.start,
          executorAbiVersion: EXECUTOR_ABI_VERSION,
        });
        residentCost.command += (globalThis.performance?.now?.() ?? Date.now()) - commandStartedAt;
        this.metrics.commandBytes += command.byteLength;
        memory = this.exports.memory.buffer;
        new Uint8Array(memory, this.exports.film_executor_command_ptr(this.handle) >>> 0, command.byteLength).set(command);
        const materializeStartedAt = globalThis.performance?.now?.() ?? Date.now();
        code = this.exports.film_executor_begin_segment_band(this.handle, band.start >>> 0, band.end >>> 0, band.y0 >>> 0, band.y1 >>> 0);
        if (code !== 0) throw residentError('film_executor_begin_segment_band failed', code);
        residentCost.materialize += (globalThis.performance?.now?.() ?? Date.now()) - materializeStartedAt;
        code = this.exports.film_executor_begin(this.handle, command.byteLength);
        if (code !== 0) throw residentError('film_executor_begin failed', code, this.exports.film_executor_failure_node?.(this.handle) ?? -1);
        const tracker = { profileResident, stepSamples, perNode, perStage, work, stepLatency, residentCost, previousCursor: 0 };
        const debugCheckpoints = null;
        while (true) {
          const step = this._stepResident(segmentPlan.enabled, context, tracker, initialWorkBudget(context), debugCheckpoints, inputRows * rowValues);
          code = step.code;
          if (code === 0) break;
        }
        this.metrics.fusionCount += this.exports.film_executor_fusion_count?.(this.handle) ?? 0;
        const bandCommitStartedAt = globalThis.performance?.now?.() ?? Date.now();
        code = this.exports.film_executor_commit_band(this.handle);
        if (code !== 0) throw residentError('film_executor_commit_band failed', code);
        residentCost.segmentCommit += (globalThis.performance?.now?.() ?? Date.now()) - bandCommitStartedAt;
      }
      const commitStartedAt = globalThis.performance?.now?.() ?? Date.now();
      code = this.exports.film_executor_commit_segment(this.handle);
      if (code !== 0) throw residentError('film_executor_commit_segment failed', code);
      if (debugSegmentSnapshots) {
        memory = this.exports.memory.buffer;
        const snapshot = new Float32Array(input.rgb.length);
        snapshot.set(new Float32Array(memory, this.exports.film_executor_stable_rgb_ptr(this.handle) >>> 0, input.rgb.length));
        debugSegmentSnapshots.push(snapshot);
      }
      residentCost.segmentCommit += (globalThis.performance?.now?.() ?? Date.now()) - commitStartedAt;
      segmentStats.push({
        id: segment.nodeIds.join('+'),
        nodeIds: segment.nodeIds,
        transients: segment.transients,
        bands: segment.bands.length,
        inputHalo: segment.inputHalo,
        generatedFieldHalo: segment.generatedFieldHalo,
        inputPixels: segment.estimatedCost?.inputPixels ?? 0,
        corePixels: segment.estimatedCost?.corePixels ?? 0,
        inputAmplification: (segment.estimatedCost?.inputPixels ?? 0) / Math.max(1, segment.estimatedCost?.corePixels ?? 1),
        materializationBytes: segment.estimatedCost?.materializationBytes ?? 0,
        elapsedMs: (globalThis.performance?.now?.() ?? Date.now()) - segmentStartedAt,
      });
    }
    if (context.signal?.aborted) throw residentError('Film render cancelled', -8, -1);
    memory = this.exports.memory.buffer;
    const downloadStartedAt = globalThis.performance?.now?.() ?? Date.now();
    const output = new Float32Array(input.rgb.length);
    const stablePtr = this.exports.film_executor_stable_rgb_ptr(this.handle) >>> 0;
    output.set(new Float32Array(memory, stablePtr, input.rgb.length));
    this.metrics.downloadBytes += output.byteLength;
    residentCost.download = (globalThis.performance?.now?.() ?? Date.now()) - downloadStartedAt;
    const processElapsedMs = (globalThis.performance?.now?.() ?? Date.now()) - startedAt;
    const residentStats = profileResident
      ? this.stats()
      : { nativeStepCalls: stepLatency.count, nativeMaxStepWork: 0, plannedArenaFloats: 0, actualArenaFloats: 0, plannedTransientFloats: 0, actualTransientFloats: 0, allocationCount: 0 };
    const kernelElapsedMs = Object.values(perNode).reduce((sum, value) => sum + Number(value || 0), 0);
    residentCost.scheduler = Math.max(0, processElapsedMs - residentCost.command - residentCost.upload - residentCost.materialize - residentCost.download - residentCost.segmentCommit - residentCost.yield - kernelElapsedMs);
    const nodes = enabled.map((node, nodeIndex) => {
      const binding = plan.physicalLayout?.residentBindings?.[nodeIndex] ?? plan.physicalLayout?.bindings?.[nodeIndex];
      const segment = segmentStats.find((item) => item.nodeIds.includes(node.id));
      return {
        id: node.id,
        type: node.type,
        backend: this.backendLabel,
        backendVariant: this.backendVariant,
        elapsedMs: profileResident ? (perNode[node.id] ?? 0) : 0,
        scratchBytes: Math.max(0, Math.trunc(Number(binding?.residentScratchFloats ?? 0) * Float32Array.BYTES_PER_ELEMENT)),
        warnings: node.type === 'highlightProtection' && !(segment?.nodeIds ?? []).some((id) => id !== node.id && segment?.transients?.writes?.includes('bloomBase'))
          ? ['missingBloomContribution', 'Highlight Protection has no Bloom contribution']
          : [],
        fullPixelPasses: 1,
        inputBytes: 0,
        outputBytes: 0,
      };
    });
    return {
      width: input.width,
      height: input.height,
      rgb: output,
      alpha: input.alpha,
      ...(debugSegmentSnapshots ? { debugSegmentSnapshots } : {}),
      stats: {
        backend: this.backendLabel,
        backendVariant: this.backendVariant,
        executionMode: 'resident-segmented',
        engineVersion: '1.7.0',
        minimumEngineVersion: '1.7.0',
        halationEngineVersion: '1.5.1',
        planHash: plan.planHash,
        graphHash: plan.graphHash,
        layoutHash: plan.physicalLayout?.layoutHash ?? null,
        nodes,
        segments: Object.fromEntries(segmentStats.map((item) => [item.id, item])),
        fullPixelPasses: nodes.length,
        passes: { fullPixelPasses: nodes.length, perNode: Object.fromEntries(nodes.map((node) => [node.id, 1])) },
        copies: { inputBytes: input.rgb.byteLength + input.width * input.height * Float32Array.BYTES_PER_ELEMENT, outputBytes: output.byteLength, count: 2 },
        timings: { total: processElapsedMs, read: 0, process: processElapsedMs, quantize: 0, write: 0, perNode: profileResident ? perNode : {}, perStage: profileResident ? { ...perStage, 'resident.command': residentCost.command, 'resident.upload': residentCost.upload, 'resident.materialize': residentCost.materialize, 'resident.segmentCommit': residentCost.segmentCommit, 'resident.scheduler': residentCost.scheduler, 'resident.download': residentCost.download } : {} },
        memoryGeneration: this.generation,
        scheduler: { stepCalls: residentStats.nativeStepCalls, maxStepWork: residentStats.nativeMaxStepWork, plannedArenaFloats: residentStats.plannedArenaFloats, actualArenaFloats: residentStats.actualArenaFloats, plannedTransientFloats: residentStats.plannedTransientFloats, actualTransientFloats: residentStats.actualTransientFloats, allocationCount: residentStats.allocationCount, fusionCount: this.metrics.fusionCount, stepLatencyMs: collectStepSamples ? { ...stepLatency, p50: quantile(stepSamples, 0.5), p95: quantile(stepSamples, 0.95) } : stepLatency, work },
      },
    };
  }

  /** Async PF-10 driver.  Native work is identical; the yield boundary is
   * inserted between cooperative steps and therefore shares cancellation and
   * telemetry semantics with the legacy async driver. */
  async executeSegmentedAsync(input, plan, context = {}) {
    const enabled = Array.isArray(plan?.enabled) ? plan.enabled : [];
    const segments = Array.isArray(plan?.spatialSegments) ? plan.spatialSegments : [];
    if (!segments.length) return { width: input.width, height: input.height, rgb: new Float32Array(input.rgb), alpha: input.alpha, stats: { backend: this.backendLabel, executionMode: 'resident-segmented', nodes: [] } };
    if (enabled.some((node) => !residentNodeSupported(node))) {
      const error = new Error('Resident segmented plan contains an unsupported node or luma mask');
      error.code = 'ERR_UNSUPPORTED_NODE';
      throw error;
    }
    const maxBandHeight = Math.max(1, ...segments.flatMap((segment) => segment.bands.map((band) => band.end - band.start)));
    const segmentPlans = segments.map((segment) => segmentExecutionPlan(plan, segment));
    const commands = segmentPlans.map((segmentPlan, index) => createGraphCommandBuffer(segmentPlan, {
      ...context,
      width: input.width,
      height: Math.max(1, segments[index].bandHeight + segments[index].inputHalo * 2),
      fullWidth: context.fullWidth ?? plan.fullWidth,
      fullHeight: context.fullHeight ?? plan.fullHeight,
      executorAbiVersion: EXECUTOR_ABI_VERSION,
    }));
    commands.forEach(validateGraphCommandBuffer);
    const arenaFloats = Math.max(1, ...segments.map((segment) => Number(segment.physicalLayout?.residentScratchFloats ?? segment.memory?.scratchFloats ?? 0)));
    const transientFloats = Math.max(1, ...segments.map((segment) => Number(segment.physicalLayout?.transientFloats ?? segment.memory?.transientFloats ?? 0)));
    const commandCapacity = Math.max(1, ...commands.map((command) => command.byteLength));
    const startedAt = globalThis.performance?.now?.() ?? Date.now();
    const profileResident = context.profileResident !== false;
    const collectStepSamples = profileResident && context.collectStepSamples === true;
    const stepSamples = collectStepSamples ? [] : null;
    const perNode = Object.fromEntries(enabled.map((node) => [node.id, 0]));
    const perStage = {};
    const work = { pixelVisits: 0, pixelsRead: 0, pixelsWritten: 0, convolutionTaps: 0, downsamplePixels: 0, upsamplePixels: 0 };
    const stepLatency = { count: 0, total: 0, max: 0 };
    const residentCost = { command: 0, upload: 0, yield: 0, scheduler: 0, download: 0, materialize: 0, segmentCommit: 0 };
    this.reserveSegmented(input.width, input.height, maxBandHeight, commandCapacity, arenaFloats, transientFloats);
    this._setDebugIntermediates(context);
    this.validateGeneration(this.generation);
    let memory = this.exports.memory.buffer;
    const stagingRgb = new Float32Array(memory, this.exports.film_executor_staging_rgb_ptr(this.handle) >>> 0, input.width * maxBandHeight * 3);
    const stagingAlpha = new Float32Array(memory, this.exports.film_executor_staging_alpha_ptr(this.handle) >>> 0, input.width * maxBandHeight);
    const rowValues = input.width * 3;
    const uploadStartedAt = globalThis.performance?.now?.() ?? Date.now();
    const uploadYieldMs = Math.max(1, Number(context.yieldIntervalMs ?? (context.intent === 'preview' ? 12 : 50)));
    let lastYieldAt = uploadStartedAt;
    for (let y0 = 0; y0 < input.height; y0 += maxBandHeight) {
      if (context.signal?.aborted) throw residentError('Film render cancelled', -8, -1);
      const rows = Math.min(maxBandHeight, input.height - y0);
      stagingRgb.set(input.rgb.subarray(y0 * rowValues, (y0 + rows) * rowValues), 0);
      if (input.alpha) stagingAlpha.set(input.alpha.subarray(y0 * input.width, (y0 + rows) * input.width), 0);
      else stagingAlpha.fill(1, 0, rows * input.width);
      const uploadCode = this.exports.film_executor_upload_rows(this.handle, y0 >>> 0, rows >>> 0);
      if (uploadCode !== 0) throw residentError('film_executor_upload_rows failed', uploadCode);
      if ((globalThis.performance?.now?.() ?? Date.now()) - lastYieldAt >= uploadYieldMs) {
        const yieldStartedAt = globalThis.performance?.now?.() ?? Date.now();
        await yieldToHost();
        residentCost.yield += (globalThis.performance?.now?.() ?? Date.now()) - yieldStartedAt;
        lastYieldAt = globalThis.performance?.now?.() ?? Date.now();
      }
    }
    let code = this.exports.film_executor_finish_upload(this.handle);
    if (code !== 0) throw residentError('film_executor_finish_upload failed', code);
    residentCost.upload = (globalThis.performance?.now?.() ?? Date.now()) - uploadStartedAt;
    this.metrics.uploadBytes += input.rgb.byteLength + input.width * input.height * Float32Array.BYTES_PER_ELEMENT;
    const segmentStats = [];
    const debugSegmentSnapshots = context.debugSegmentSnapshots === true ? [] : null;
    const yieldIntervalMs = Math.max(1, Number(context.yieldIntervalMs ?? (context.intent === 'preview' ? 12 : 50)));
    const targetStepMs = Math.max(1, Number(context.targetStepMs ?? (context.intent === 'preview' ? 12 : 50)));
    for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex += 1) {
      const segment = segments[segmentIndex];
      const segmentPlan = segmentPlans[segmentIndex];
      const segmentStartedAt = globalThis.performance?.now?.() ?? Date.now();
      for (const band of segment.bands) {
        if (context.signal?.aborted) {
          this.exports.film_executor_abort_segment?.(this.handle);
          throw residentError('Film render cancelled', -8, -1);
        }
        const inputRows = band.end - band.start;
        const commandStartedAt = globalThis.performance?.now?.() ?? Date.now();
        const command = createGraphCommandBuffer(segmentPlan, {
          ...context,
          width: input.width,
          height: inputRows,
          fullWidth: context.fullWidth ?? plan.fullWidth,
          fullHeight: context.fullHeight ?? plan.fullHeight,
          originX: context.originX ?? 0,
          originY: (context.originY ?? 0) + band.start,
          executorAbiVersion: EXECUTOR_ABI_VERSION,
        });
        residentCost.command += (globalThis.performance?.now?.() ?? Date.now()) - commandStartedAt;
        this.metrics.commandBytes += command.byteLength;
        memory = this.exports.memory.buffer;
        new Uint8Array(memory, this.exports.film_executor_command_ptr(this.handle) >>> 0, command.byteLength).set(command);
        const materializeStartedAt = globalThis.performance?.now?.() ?? Date.now();
        code = this.exports.film_executor_begin_segment_band(this.handle, band.start >>> 0, band.end >>> 0, band.y0 >>> 0, band.y1 >>> 0);
        if (code !== 0) throw residentError('film_executor_begin_segment_band failed', code);
        residentCost.materialize += (globalThis.performance?.now?.() ?? Date.now()) - materializeStartedAt;
        code = this.exports.film_executor_begin(this.handle, command.byteLength);
        if (code !== 0) throw residentError('film_executor_begin failed', code, this.exports.film_executor_failure_node?.(this.handle) ?? -1);
        const tracker = { profileResident, stepSamples, perNode, perStage, work, stepLatency, residentCost, previousCursor: 0 };
        let workBudget = initialWorkBudget(context);
        let yieldedAt = globalThis.performance?.now?.() ?? Date.now();
        while (true) {
          const step = this._stepResident(segmentPlan.enabled, context, tracker, workBudget, null, inputRows * rowValues);
          code = step.code;
          workBudget = adaptWorkBudget(workBudget, step.elapsedMs, targetStepMs);
          if (code === 0) break;
          const now = globalThis.performance?.now?.() ?? Date.now();
          if (now - yieldedAt >= yieldIntervalMs) {
            const yieldStartedAt = now;
            await yieldToHost();
            residentCost.yield += (globalThis.performance?.now?.() ?? Date.now()) - yieldStartedAt;
            yieldedAt = globalThis.performance?.now?.() ?? Date.now();
          }
        }
        this.metrics.fusionCount += this.exports.film_executor_fusion_count?.(this.handle) ?? 0;
        const bandCommitStartedAt = globalThis.performance?.now?.() ?? Date.now();
        code = this.exports.film_executor_commit_band(this.handle);
        if (code !== 0) throw residentError('film_executor_commit_band failed', code);
        residentCost.segmentCommit += (globalThis.performance?.now?.() ?? Date.now()) - bandCommitStartedAt;
        await yieldToHost();
      }
      const commitStartedAt = globalThis.performance?.now?.() ?? Date.now();
      code = this.exports.film_executor_commit_segment(this.handle);
      if (code !== 0) throw residentError('film_executor_commit_segment failed', code);
      if (debugSegmentSnapshots) {
        memory = this.exports.memory.buffer;
        const snapshot = new Float32Array(input.rgb.length);
        snapshot.set(new Float32Array(memory, this.exports.film_executor_stable_rgb_ptr(this.handle) >>> 0, input.rgb.length));
        debugSegmentSnapshots.push(snapshot);
      }
      residentCost.segmentCommit += (globalThis.performance?.now?.() ?? Date.now()) - commitStartedAt;
      segmentStats.push({
        id: segment.nodeIds.join('+'),
        nodeIds: segment.nodeIds,
        transients: segment.transients,
        bands: segment.bands.length,
        inputHalo: segment.inputHalo,
        generatedFieldHalo: segment.generatedFieldHalo,
        inputPixels: segment.estimatedCost?.inputPixels ?? 0,
        corePixels: segment.estimatedCost?.corePixels ?? 0,
        inputAmplification: (segment.estimatedCost?.inputPixels ?? 0) / Math.max(1, segment.estimatedCost?.corePixels ?? 1),
        materializationBytes: segment.estimatedCost?.materializationBytes ?? 0,
        elapsedMs: (globalThis.performance?.now?.() ?? Date.now()) - segmentStartedAt,
      });
      await yieldToHost();
    }
    if (context.signal?.aborted) throw residentError('Film render cancelled', -8, -1);
    memory = this.exports.memory.buffer;
    const downloadStartedAt = globalThis.performance?.now?.() ?? Date.now();
    const output = new Float32Array(input.rgb.length);
    output.set(new Float32Array(memory, this.exports.film_executor_stable_rgb_ptr(this.handle) >>> 0, input.rgb.length));
    this.metrics.downloadBytes += output.byteLength;
    residentCost.download = (globalThis.performance?.now?.() ?? Date.now()) - downloadStartedAt;
    const processElapsedMs = (globalThis.performance?.now?.() ?? Date.now()) - startedAt;
    const residentStats = profileResident
      ? this.stats()
      : { nativeStepCalls: stepLatency.count, nativeMaxStepWork: 0, plannedArenaFloats: 0, actualArenaFloats: 0, plannedTransientFloats: 0, actualTransientFloats: 0, allocationCount: 0 };
    const kernelElapsedMs = Object.values(perNode).reduce((sum, value) => sum + Number(value || 0), 0);
    residentCost.scheduler = Math.max(0, processElapsedMs - residentCost.command - residentCost.upload - residentCost.materialize - residentCost.download - residentCost.segmentCommit - residentCost.yield - kernelElapsedMs);
    const nodes = enabled.map((node, nodeIndex) => {
      const binding = plan.physicalLayout?.residentBindings?.[nodeIndex] ?? plan.physicalLayout?.bindings?.[nodeIndex];
      const segment = segmentStats.find((item) => item.nodeIds.includes(node.id));
      return {
        id: node.id,
        type: node.type,
        backend: this.backendLabel,
        backendVariant: this.backendVariant,
        elapsedMs: profileResident ? (perNode[node.id] ?? 0) : 0,
        scratchBytes: Math.max(0, Math.trunc(Number(binding?.residentScratchFloats ?? 0) * Float32Array.BYTES_PER_ELEMENT)),
        warnings: node.type === 'highlightProtection' && !(segment?.nodeIds ?? []).some((id) => id !== node.id && segment?.transients?.writes?.includes('bloomBase'))
          ? ['missingBloomContribution', 'Highlight Protection has no Bloom contribution']
          : [],
        fullPixelPasses: 1,
        inputBytes: 0,
        outputBytes: 0,
      };
    });
    return {
      width: input.width,
      height: input.height,
      rgb: output,
      alpha: input.alpha,
      ...(debugSegmentSnapshots ? { debugSegmentSnapshots } : {}),
      stats: {
        backend: this.backendLabel,
        backendVariant: this.backendVariant,
        executionMode: 'resident-segmented',
        engineVersion: '1.7.0',
        minimumEngineVersion: '1.7.0',
        halationEngineVersion: '1.5.1',
        planHash: plan.planHash,
        graphHash: plan.graphHash,
        layoutHash: plan.physicalLayout?.layoutHash ?? null,
        nodes,
        segments: Object.fromEntries(segmentStats.map((item) => [item.id, item])),
        fullPixelPasses: nodes.length,
        passes: { fullPixelPasses: nodes.length, perNode: Object.fromEntries(nodes.map((node) => [node.id, 1])) },
        copies: { inputBytes: input.rgb.byteLength + input.width * input.height * Float32Array.BYTES_PER_ELEMENT, outputBytes: output.byteLength, count: 2 },
        timings: { total: processElapsedMs, read: 0, process: processElapsedMs, quantize: 0, write: 0, perNode: profileResident ? perNode : {}, perStage: profileResident ? { ...perStage, 'resident.command': residentCost.command, 'resident.upload': residentCost.upload, 'resident.materialize': residentCost.materialize, 'resident.segmentCommit': residentCost.segmentCommit, 'resident.yield': residentCost.yield, 'resident.scheduler': residentCost.scheduler, 'resident.download': residentCost.download } : {} },
        memoryGeneration: this.generation,
        scheduler: { stepCalls: residentStats.nativeStepCalls, maxStepWork: residentStats.nativeMaxStepWork, plannedArenaFloats: residentStats.plannedArenaFloats, actualArenaFloats: residentStats.actualArenaFloats, plannedTransientFloats: residentStats.plannedTransientFloats, actualTransientFloats: residentStats.actualTransientFloats, allocationCount: residentStats.allocationCount, fusionCount: this.metrics.fusionCount, stepLatencyMs: collectStepSamples ? { ...stepLatency, p50: quantile(stepSamples, 0.5), p95: quantile(stepSamples, 0.95) } : stepLatency, work },
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
      fusionCount: this.metrics.fusionCount ?? (this.exports.film_executor_fusion_count?.(this.handle) ?? 0),
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

/** Keep one idle resident instance per scalar/SIMD variant.  The capacity key
 * deliberately excludes effect parameters: requests with the same physical
 * envelope may reuse a warmed allocation, while a smaller or differently
 * shaped plan can never inherit a larger arena from an unrelated render. */
function residentCapacityKey(plan = {}) {
  const width = Math.max(1, Math.trunc(Number(plan?.width ?? 1)));
  const height = Math.max(1, Math.trunc(Number(plan?.height ?? 1)));
  const segmented = plan?.executionMode === 'resident-segmented' && Array.isArray(plan?.spatialSegments);
  if (segmented) {
    const segments = plan.spatialSegments;
    const maxBandRows = Math.max(1, ...segments.flatMap((segment) => (segment.bands ?? []).map((band) => Math.max(1, Math.trunc(Number(band.end) - Number(band.start))))));
    const arenaFloats = Math.max(1, ...segments.map((segment) => Math.trunc(Number(segment.physicalLayout?.residentScratchFloats ?? segment.memory?.scratchFloats ?? 0))));
    const transientFloats = Math.max(1, ...segments.map((segment) => Math.trunc(Number(segment.physicalLayout?.transientFloats ?? segment.memory?.transientFloats ?? 0))));
    return ['segmented', width, height, maxBandRows, arenaFloats, transientFloats, plan?.physicalLayout?.version ?? 0].join(':');
  }
  const maxBandRows = Math.max(
    height,
    Array.isArray(plan?.bands)
      ? Math.max(1, ...plan.bands.map((band) => Math.max(1, Math.trunc(Number(band.end) - Number(band.start)))))
      : height,
  );
  const layout = plan?.physicalLayoutFor?.(width, maxBandRows) ?? plan?.physicalLayout;
  return [
    'whole', width, maxBandRows,
    Math.max(1, Math.trunc(Number(layout?.residentScratchFloats ?? layout?.scratchFloats ?? 0))),
    Math.max(1, Math.trunc(Number(layout?.transientFloats ?? 0))),
    layout?.version ?? 0,
  ].join(':');
}

function clearResidentSessionPool() {
  for (const entry of residentSessionPool.values()) entry.backend?.dispose?.();
  residentSessionPool.clear();
}

function acquireResidentSession(plan, variant, module, template) {
  const capacityKey = residentCapacityKey(plan);
  const pooled = residentSessionPool.get(variant);
  if (pooled?.capacityKey === capacityKey) {
    residentSessionPool.delete(variant);
    pooled.backend.resetMetrics();
    return { backend: pooled.backend, capacityKey };
  }
  if (pooled) {
    pooled.backend.dispose();
    residentSessionPool.delete(variant);
  }
  const instance = module ? new WebAssembly.Instance(module, {}) : null;
  const exports = instance?.exports ?? template?.exports;
  if (!exports) throw new Error(`Resident ${variant} module is unavailable`);
  const session = new WasmResidentBackend(exports, template.backendLabel);
  session.resetMetrics();
  return { backend: session, capacityKey };
}

function releaseResidentSession(variant, capacityKey, session) {
  if (!session) return;
  if (!session.resetForReuse()) {
    session.dispose();
    return;
  }
  const pooled = residentSessionPool.get(variant);
  if (pooled?.backend && pooled.backend !== session) pooled.backend.dispose();
  residentSessionPool.set(variant, { capacityKey, backend: session });
}

/** Create a V1.7 frame-resident adapter when the loaded module exposes ABI v1. */
export function createV17ResidentBackend(plan = {}) {
  const useSimd = executionMode === 'wasm-resident-simd' || (executionMode === 'auto' && simdQualified);
  const template = useSimd ? simdResidentBackend : residentBackend;
  const module = useSimd ? simdResidentModule : residentModule;
  const variant = useSimd ? 'simd' : 'scalar';
  if (!template) return null;
  let acquired;
  try {
    acquired = acquireResidentSession(plan, variant, module, template);
  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error);
    return null;
  }
  let selectedBackend = acquired.backend;
  let lastStats = null;
  let reusable = true;
  return {
    requestScoped: true,
    backend: selectedBackend.backendLabel,
    backendVariant: selectedBackend.backendVariant,
    abiVersion: selectedBackend.exports.film_executor_abi_version?.() ?? 0,
    capabilities: selectedBackend.exports.film_executor_capabilities?.() ?? 0,
    supportsPlan(candidate = plan) {
      const enabled = Array.isArray(candidate?.enabled) ? candidate.enabled : [];
      const layout = candidate?.physicalLayout;
      const layoutReady = !layout || ((layout.version === 1 || layout.version === 2)
        && Number.isInteger(layout.scratchFloats) && layout.scratchFloats >= 0
        && Number.isInteger(layout.transientFloats) && layout.transientFloats >= 0
        && Array.isArray(layout.bindings) && layout.bindings.length === enabled.length);
      return layoutReady && enabled.every(residentNodeSupported)
        && (!candidate?.executionMode || candidate.executionMode !== 'resident-segmented' || selectedBackend.segmentedSupported);
    },
    supportsSegmented(candidate = plan) {
      return selectedBackend.segmentedSupported === true
        && candidate?.executionMode === 'resident-segmented'
        && Array.isArray(candidate?.spatialSegments);
    },
    execute(input, candidatePlanOrContext = {}, maybeContext = {}) {
      // FilmExecutor passes (input, renderPlan, context); direct callers may
      // use the shorter (input, context) form. Preserve AbortSignal and band
      // geometry in both cases.
      const hasPlanShape = candidatePlanOrContext && typeof candidatePlanOrContext === 'object'
        && typeof candidatePlanOrContext.planHash === 'string';
      const selectedPlan = hasPlanShape ? candidatePlanOrContext : plan;
      const context = hasPlanShape ? maybeContext : candidatePlanOrContext;
      try {
        return selectedBackend.execute(input, selectedPlan, context);
      } catch (error) {
        reusable = false;
        throw error;
      }
    },
    async executeAsync(input, candidatePlanOrContext = {}, maybeContext = {}) {
      const hasPlanShape = candidatePlanOrContext && typeof candidatePlanOrContext === 'object'
        && typeof candidatePlanOrContext.planHash === 'string';
      const selectedPlan = hasPlanShape ? candidatePlanOrContext : plan;
      const context = hasPlanShape ? maybeContext : candidatePlanOrContext;
      try {
        return await selectedBackend.executeAsync(input, selectedPlan, context);
      } catch (error) {
        reusable = false;
        throw error;
      }
    },
    reserve(width, height, commandBytes) { return selectedBackend.reserve(width, height, commandBytes); },
    reserveSegmented(width, fullHeight, maxBandHeight, commandBytes, arenaFloats, transientFloats) {
      return selectedBackend.reserveSegmented(width, fullHeight, maxBandHeight, commandBytes, arenaFloats, transientFloats);
    },
    stats() { return selectedBackend?.stats?.() ?? lastStats; },
    dispose() {
      if (!selectedBackend) return;
      lastStats = selectedBackend.stats();
      if (reusable) releaseResidentSession(variant, acquired.capacityKey, selectedBackend);
      else selectedBackend.dispose();
      selectedBackend = null;
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
  clearResidentSessionPool();
  residentBackend?.dispose?.();
  simdResidentBackend?.dispose?.();
  backend?.dispose?.();
  backend = null;
  residentBackend = null;
  simdResidentBackend = null;
  residentModule = null;
  simdResidentModule = null;
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
