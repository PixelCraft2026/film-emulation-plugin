// @ts-check
import { processFilm } from './film.js';
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
  if (value === 'gpu' || value === BACKEND_IDS.GPU) return BACKEND_IDS.GPU;
  throw new RangeError(`Unsupported film backend: ${String(value)}`);
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
  const backend = normalizeExecutorBackend(options.backend);
  const gpuBackend = options.gpuBackend ?? createUnavailableGpuBackend();
  const allowExperimentalGpu = options.allowExperimentalGpu === true;
  let disposed = false;
  let preparedGpu = false;
  let gpuDisabledForRequest = false;
  /** @type {any} */
  let lastFallback = null;

  const gpuExecutableSegments = plan.backendSegments?.[BACKEND_IDS.GPU] ?? [];
  const gpuCandidateSegments = plan.backendCandidates?.[BACKEND_IDS.GPU] ?? [];

  /** @param {any} input @param {any} document @param {any} context */
  function renderCpu(input, document, context) {
    const executionMode = backend === BACKEND_IDS.JS ? 'js' : 'auto';
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
      return renderCpu(input, document, context);
    },
    stats() {
      return {
        ...arena.stats(),
        backend,
        gpuDisabledForRequest,
        gpu: gpuBackend.stats?.() ?? null,
        fallback: lastFallback,
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      gpuBackend.dispose?.();
      arena.dispose();
    },
  };
}
