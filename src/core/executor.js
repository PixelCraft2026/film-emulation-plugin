// @ts-check
import { processFilm, processFilmStages } from './film.js';
import { BufferArena } from './bufferArena.js';
import { setWasmExecutionMode } from './wasmBackend.js';
import {
  BACKEND_IDS,
  backendErrorCode,
  createBackendError,
  createBackendTransferStats,
  createUnavailableGpuBackend,
} from './backendContract.js';

/** @param {any} value */
function normalizeExecutorBackend(value) {
  if (value === undefined || value === null || value === 'auto') return 'auto';
  if (value === 'js' || value === BACKEND_IDS.JS) return BACKEND_IDS.JS;
  if (value === 'wasm' || value === 'wasm-v16' || value === BACKEND_IDS.WASM) return BACKEND_IDS.WASM;
  if (value === 'resident' || value === 'wasm-resident') return 'wasm-resident';
  if (value === 'resident-simd' || value === 'wasm-resident-simd') return 'wasm-resident-simd';
  if (value === 'gpu' || value === BACKEND_IDS.GPU) return BACKEND_IDS.GPU;
  throw new RangeError(`Unsupported film backend: ${String(value)}`);
}

/** @param {any} error @param {any} signal */
function isCancellation(error, signal) {
  return signal?.aborted === true
    || error?.code === 'ERR_CANCELLED'
    || /cancelled|canceled|abort/i.test(String(error?.message ?? error ?? ''));
}

/** @param {any} result @param {any} gpuStats @param {any} fallback @param {string|null} [backendOverride] */
function withBackendStats(result, gpuStats, fallback, backendOverride = null) {
  if (!result || typeof result !== 'object' || !result.stats) {
    throw createBackendError('Backend returned an invalid Film result', 'ERR_BACKEND_RESULT');
  }
  const transfers = gpuStats?.transfers ?? {};
  const gpuMemory = gpuStats?.memory ?? {};
  const existingFallback = result.stats.fallback ?? null;
  return {
    ...result,
    stats: {
      ...result.stats,
      backend: backendOverride ?? result.stats.backend,
      copies: {
        ...createBackendTransferStats(),
        ...(result.stats.copies ?? {}),
        ...transfers,
      },
      memory: {
        ...(result.stats.memory ?? {}),
        breakdown: {
          ...(result.stats.memory?.breakdown ?? {}),
          gpuResidentBytes: Number(gpuMemory.gpuResidentBytes ?? result.stats.memory?.breakdown?.gpuResidentBytes ?? 0),
          gpuScratchBytes: Number(gpuMemory.gpuScratchBytes ?? result.stats.memory?.breakdown?.gpuScratchBytes ?? 0),
          stagingBytes: Number(gpuMemory.stagingBytes ?? result.stats.memory?.breakdown?.stagingBytes ?? 0),
        },
      },
      fallback: fallback
        ? { ...fallback, next: existingFallback }
        : existingFallback,
    },
  };
}

/** @param {Float32Array} actual @param {Float32Array} expected @param {number} width @param {any} plan @param {any} options */
function dualRunReport(actual, expected, width, plan, options) {
  const maxTolerance = Number(options.dualRunMaxTolerance ?? 1e-3);
  let squaredError = 0;
  let max = 0;
  let first = null;
  for (let index = 0; index < actual.length; index += 1) {
    const delta = actual[index] - expected[index];
    const absolute = Math.abs(delta);
    squaredError += delta * delta;
    max = Math.max(max, absolute);
    if (!first && absolute > maxTolerance) {
      const pixel = Math.floor(index / 3);
      first = {
        x: pixel % width,
        y: Math.floor(pixel / width),
        channel: ['R', 'G', 'B'][index % 3],
        nodeId: Array.isArray(plan.enabled) && plan.enabled.length ? plan.enabled[plan.enabled.length - 1].id : null,
        actual: actual[index],
        expected: expected[index],
        absoluteError: absolute,
      };
    }
  }
  return {
    rms: Math.sqrt(squaredError / Math.max(1, actual.length)),
    max,
    firstExcess: first,
    rmsTolerance: Number(options.dualRunRmsTolerance ?? 1e-4),
    maxTolerance,
  };
}

/** @param {any} input @param {any} result @param {any} plan @param {any} context @param {any} options */
function dualRunStageReport(input, result, plan, context, options) {
  if (!Array.isArray(result?.debugCheckpoints) || !result.debugCheckpoints.length) return null;
  let reference = input;
  let lastReport = null;
  for (let index = 0; index < plan.enabled.length; index += 1) {
    const node = plan.enabled[index];
    reference = processFilmStages(reference, [node], { ...context, renderPlan: plan });
    const checkpoint = result.debugCheckpoints.find((/** @type {any} */ item) => item.nodeIndex === index);
    if (!checkpoint) continue;
    const report = dualRunReport(checkpoint.rgb, reference.rgb, input.width, { enabled: [node] }, options);
    lastReport = report;
    if (report.firstExcess || report.rms > report.rmsTolerance || report.max > report.maxTolerance) {
      return {
        ...report,
        firstExcess: report.firstExcess ? { ...report.firstExcess, nodeId: node.id } : null,
        nodeId: node.id,
        nodeIndex: index,
      };
    }
  }
  return lastReport
    ? { ...lastReport, nodeId: plan.enabled[plan.enabled.length - 1]?.id ?? null, nodeIndex: plan.enabled.length - 1 }
    : null;
}

/**
 * Create a request-scoped executor.  The V1.6 resident backend remains an
 * implementation detail; this object is the stable seam that V1.7 can extend
 * without changing the graph schema or callers of processFilm().
 */
/** @param {any} plan @param {any} [options] @returns {any} */
export function createFilmExecutor(plan, options = {}) {
  if (!plan || typeof plan !== 'object' || typeof plan.planHash !== 'string') {
    throw new TypeError('createFilmExecutor requires a RenderPlan');
  }
  const arena = options.arena ?? new BufferArena({ debug: options.debug === true });
  const ownsArena = !options.arena;
  const backend = normalizeExecutorBackend(options.backend);
  const gpuBackend = options.gpuBackend ?? createUnavailableGpuBackend();
  const allowExperimentalGpu = options.allowExperimentalGpu === true;
  const residentBackend = options.residentBackend ?? null;
  let residentDisabledForRequest = false;
  let disposed = false;
  let preparedGpu = false;
  let gpuDisabledForRequest = false;
  /** @type {any} */
  let lastFallback = null;

  const gpuExecutableSegments = plan.backendSegments?.[BACKEND_IDS.GPU] ?? [];
  const gpuCandidateSegments = plan.backendCandidates?.[BACKEND_IDS.GPU] ?? [];
  const residentPlanSupported = residentBackend?.supportsPlan
    ? residentBackend.supportsPlan(plan) === true
    : false;

  /** @param {any} input @param {any} document @param {any} context */
  function renderCpu(input, document, context, forceJs = false) {
    const executionMode = forceJs || backend === BACKEND_IDS.JS ? 'js' : 'auto';
    const previousMode = setWasmExecutionMode(executionMode);
    try {
      const result = processFilm(input, document, {
        ...context,
        backend: executionMode,
        renderPlan: plan,
        arena,
      });
      return withBackendStats(result, gpuBackend.stats?.(), lastFallback);
    } finally {
      setWasmExecutionMode(previousMode);
    }
  }

  /** @param {any} input @param {any} document @param {any} context */
  function renderResident(input, document, context) {
    if (!residentBackend || typeof residentBackend.execute !== 'function') {
      throw createBackendError('Resident WASM backend is unavailable', 'ERR_WASM_RESIDENT_UNAVAILABLE');
    }
    const result = residentBackend.execute(input, plan, {
      ...context,
      document,
      debugCheckpoints: options.debugDualRun === true,
    });
    if (!result || result.width !== input.width || result.height !== input.height
      || !(result.rgb instanceof Float32Array) || result.rgb.length !== input.rgb.length) {
      throw createBackendError('Resident WASM backend returned invalid output', 'ERR_WASM_RESIDENT_RESULT_LAYOUT');
    }
    if (result.alpha !== undefined && result.alpha !== input.alpha) {
      throw createBackendError('Resident WASM backend must preserve source alpha', 'ERR_WASM_RESIDENT_ALPHA_CHANGED');
    }
    for (const value of result.rgb) if (!Number.isFinite(value)) throw createBackendError('Resident WASM backend returned NaN or Infinity', 'ERR_WASM_RESIDENT_NONFINITE');
    const wrapped = withBackendStats({ ...result, alpha: input.alpha }, null, null, result.stats?.backend ?? 'wasm-resident');
    if (options.debugDualRun !== true) return wrapped;
    const stageReport = dualRunStageReport(input, result, plan, context, options);
    const reference = stageReport ? null : renderCpu(input, document, context, true);
    return {
      ...wrapped,
      stats: {
        ...wrapped.stats,
        dualRun: stageReport ?? dualRunReport(wrapped.rgb, reference.rgb, input.width, plan, options),
      },
    };
  }

  /** @param {any} input @param {any} document @param {any} context */
  async function renderResidentAsync(input, document, context) {
    if (!residentBackend || (typeof residentBackend.executeAsync !== 'function' && typeof residentBackend.execute !== 'function')) {
      throw createBackendError('Resident WASM backend is unavailable', 'ERR_WASM_RESIDENT_UNAVAILABLE');
    }
    const result = typeof residentBackend.executeAsync === 'function'
      ? await residentBackend.executeAsync(input, plan, { ...context, document, debugCheckpoints: options.debugDualRun === true })
      : residentBackend.execute(input, plan, { ...context, document, debugCheckpoints: options.debugDualRun === true });
    if (!result || result.width !== input.width || result.height !== input.height
      || !(result.rgb instanceof Float32Array) || result.rgb.length !== input.rgb.length) {
      throw createBackendError('Resident WASM backend returned invalid output', 'ERR_WASM_RESIDENT_RESULT_LAYOUT');
    }
    if (result.alpha !== undefined && result.alpha !== input.alpha) {
      throw createBackendError('Resident WASM backend must preserve source alpha', 'ERR_WASM_RESIDENT_ALPHA_CHANGED');
    }
    for (const value of result.rgb) if (!Number.isFinite(value)) throw createBackendError('Resident WASM backend returned NaN or Infinity', 'ERR_WASM_RESIDENT_NONFINITE');
    const wrapped = withBackendStats({ ...result, alpha: input.alpha }, null, null, result.stats?.backend ?? 'wasm-resident');
    if (options.debugDualRun !== true) return wrapped;
    const stageReport = dualRunStageReport(input, result, plan, context, options);
    const reference = stageReport ? null : renderCpu(input, document, context, true);
    return {
      ...wrapped,
      stats: {
        ...wrapped.stats,
        dualRun: stageReport ?? dualRunReport(wrapped.rgb, reference.rgb, input.width, plan, options),
      },
    };
  }

  /** @param {any} input @param {any} document @param {any} context */
  function renderGpu(input, document, context) {
    const segments = gpuExecutableSegments.length
      ? gpuExecutableSegments
      : allowExperimentalGpu ? gpuCandidateSegments : [];
    if (!gpuBackend.available) {
      throw createBackendError(gpuBackend.reason ?? 'GPU backend is unavailable');
    }
    if (gpuBackend.id !== BACKEND_IDS.GPU || gpuBackend.abi !== plan.backendAbi?.[BACKEND_IDS.GPU]) {
      throw createBackendError('GPU backend ABI does not match the RenderPlan', 'ERR_GPU_ABI_MISMATCH');
    }
    if (!segments.length) {
      throw createBackendError('RenderPlan has no executable GPU segment', 'ERR_GPU_PLAN_UNSUPPORTED');
    }
    if (!preparedGpu) {
      gpuBackend.prepare?.({ plan, arena });
      preparedGpu = true;
    }
    const result = gpuBackend.render({ input, document, context, plan, arena, segments });
    if (result?.width !== input.width || result?.height !== input.height
      || !(result?.rgb instanceof Float32Array) || result.rgb.length !== input.rgb.length) {
      throw createBackendError('GPU backend returned invalid output geometry or layout', 'ERR_GPU_RESULT_LAYOUT');
    }
    if (result.alpha !== undefined && result.alpha !== input.alpha) {
      throw createBackendError('GPU backend must preserve the source alpha reference', 'ERR_GPU_ALPHA_CHANGED');
    }
    for (let index = 0; index < result.rgb.length; index += 1) {
      if (!Number.isFinite(result.rgb[index])) {
        throw createBackendError('GPU backend returned NaN or Infinity', 'ERR_GPU_NONFINITE');
      }
    }
    return withBackendStats({ ...result, alpha: input.alpha }, gpuBackend.stats?.(), null, BACKEND_IDS.GPU);
  }

  return {
    plan,
    arena,
    backend,
    /** @param {any} input @param {any} document @param {any} [context] */
    render(input, document, context = {}) {
      if (disposed) throw new Error('Film executor has been disposed');
      const shouldAttemptGpu = !gpuDisabledForRequest && (
        backend === BACKEND_IDS.GPU
        || (backend === 'auto' && gpuBackend.available === true && gpuExecutableSegments.length > 0)
      );
      if (shouldAttemptGpu) {
        try {
          return renderGpu(input, document, context);
        } catch (error) {
          const caught = /** @type {any} */ (error);
          if (isCancellation(caught, context.signal)) throw caught;
          lastFallback = {
            stage: preparedGpu ? 'gpu-execute' : 'gpu-prepare',
            code: backendErrorCode(caught),
            message: String(caught?.message ?? caught),
            from: BACKEND_IDS.GPU,
            to: BACKEND_IDS.WASM,
            order: [BACKEND_IDS.GPU, BACKEND_IDS.WASM, BACKEND_IDS.JS],
          };
          // One adapter failure disables GPU for the request-scoped executor.
          // Later bands/renders go directly to CPU and cannot repeatedly fail.
          gpuDisabledForRequest = true;
        }
      }
      const shouldAttemptResident = !residentDisabledForRequest && residentBackend
        && (backend === 'wasm-resident' || backend === 'wasm-resident-simd'
          || (backend === 'auto' && residentPlanSupported && plan.backendSegments?.['wasm-resident']?.length));
      if (shouldAttemptResident) {
        try {
          return renderResident(input, document, context);
        } catch (error) {
          const caught = /** @type {any} */ (error);
          if (isCancellation(caught, context.signal)) throw caught;
          residentDisabledForRequest = true;
          lastFallback = {
            stage: backend === 'wasm-resident-simd' ? 'wasm-resident-simd' : 'wasm-resident',
            code: backendErrorCode(caught),
            message: String(caught?.message ?? caught),
            from: backend === 'wasm-resident-simd' ? 'wasm-resident-simd' : 'wasm-resident',
            to: BACKEND_IDS.JS,
            order: [backend === 'wasm-resident-simd' ? 'wasm-resident-simd' : 'wasm-resident', BACKEND_IDS.JS],
          };
        }
      }
      return renderCpu(input, document, context, residentDisabledForRequest && !!residentBackend);
    },
    /** @param {any} input @param {any} document @param {any} [context] */
    async renderAsync(input, document, context = {}) {
      if (disposed) throw new Error('Film executor has been disposed');
      const shouldAttemptGpu = !gpuDisabledForRequest && (
        backend === BACKEND_IDS.GPU
        || (backend === 'auto' && gpuBackend.available === true && gpuExecutableSegments.length > 0)
      );
      if (shouldAttemptGpu) {
        try {
          return renderGpu(input, document, context);
        } catch (error) {
          const caught = /** @type {any} */ (error);
          if (isCancellation(caught, context.signal)) throw caught;
          lastFallback = {
            stage: preparedGpu ? 'gpu-execute' : 'gpu-prepare',
            code: backendErrorCode(caught),
            message: String(caught?.message ?? caught),
            from: BACKEND_IDS.GPU,
            to: BACKEND_IDS.WASM,
            order: [BACKEND_IDS.GPU, BACKEND_IDS.WASM, BACKEND_IDS.JS],
          };
          gpuDisabledForRequest = true;
        }
      }
      const shouldAttemptResident = !residentDisabledForRequest && residentBackend
        && (backend === 'wasm-resident' || backend === 'wasm-resident-simd'
          || (backend === 'auto' && residentPlanSupported && plan.backendSegments?.['wasm-resident']?.length));
      if (shouldAttemptResident) {
        try {
          return await renderResidentAsync(input, document, context);
        } catch (error) {
          const caught = /** @type {any} */ (error);
          if (isCancellation(caught, context.signal)) throw caught;
          residentDisabledForRequest = true;
          lastFallback = {
            stage: backend === 'wasm-resident-simd' ? 'wasm-resident-simd' : 'wasm-resident',
            code: backendErrorCode(caught),
            message: String(caught?.message ?? caught),
            from: backend === 'wasm-resident-simd' ? 'wasm-resident-simd' : 'wasm-resident',
            to: BACKEND_IDS.JS,
            order: [backend === 'wasm-resident-simd' ? 'wasm-resident-simd' : 'wasm-resident', BACKEND_IDS.JS],
          };
        }
      }
      return renderCpu(input, document, context, residentDisabledForRequest && !!residentBackend);
    },
    stats() {
      return {
        ...arena.stats(),
        backend,
        gpuDisabledForRequest,
        residentDisabledForRequest,
        gpu: gpuBackend.stats?.() ?? null,
        fallback: lastFallback,
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      gpuBackend.dispose?.();
      if (ownsArena) arena.dispose();
    },
  };
}
