// @ts-check

/** Stable planner/executor identifiers. They do not imply runtime availability. */
export const BACKEND_IDS = Object.freeze({
  JS: 'js-reference',
  WASM: 'wasm-resident',
  WASM_SIMD: 'wasm-resident-simd',
  GPU: 'gpu-native',
});

/** Reserved ABI label for a future native GPU adapter. No V1.6 implementation exists. */
export const GPU_BACKEND_ABI = 'gpu-native-reserved-v1';
export const GPU_UNAVAILABLE_CODE = 'ERR_GPU_UNAVAILABLE';

/**
 * Fixed-shape transfer counters. Keeping the zero-valued GPU fields in V1.6
 * makes future benchmark reports comparable without pretending GPU work ran.
 */
export function createBackendTransferStats() {
  return {
    hostToWasmBytes: 0,
    wasmToHostBytes: 0,
    hostToGpuBytes: 0,
    gpuToHostBytes: 0,
    boundaryCount: 0,
  };
}

/** Fixed-shape backend memory counters used by plans and runtime adapters. */
export function createBackendMemoryStats() {
  return {
    hostBytes: 0,
    wasmBytes: 0,
    gpuResidentBytes: 0,
    gpuScratchBytes: 0,
    stagingBytes: 0,
  };
}

/** @param {any} value */
function frozenCapability(value = {}) {
  return Object.freeze({
    supported: value.supported === true,
    planned: value.planned === true,
    resident: value.resident === true,
    abi: typeof value.abi === 'string' ? value.abi : null,
    precision: typeof value.precision === 'string' ? value.precision : 'f32',
    reason: typeof value.reason === 'string' ? value.reason : null,
  });
}

/**
 * Normalize a workset's backend declaration while retaining compatibility
 * with the V1.6 `wasm` flag used before the generic contract was introduced.
 * @param {any} descriptor
 */
export function normalizeBackendCapabilities(descriptor = {}) {
  const declared = descriptor.backends ?? {};
  const legacyWasm = descriptor.wasm ?? {};
  return Object.freeze({
    [BACKEND_IDS.JS]: frozenCapability(declared[BACKEND_IDS.JS] ?? { supported: true }),
    [BACKEND_IDS.WASM]: frozenCapability(declared[BACKEND_IDS.WASM] ?? {
      supported: legacyWasm.supported === true,
      resident: legacyWasm.mode === 'v16-resident',
      abi: legacyWasm.mode ?? null,
    }),
    [BACKEND_IDS.WASM_SIMD]: frozenCapability(declared[BACKEND_IDS.WASM_SIMD] ?? {
      supported: false,
      resident: true,
      abi: 'v17-command-v1',
      reason: 'SIMD requires runtime capability and QA qualification',
    }),
    [BACKEND_IDS.GPU]: frozenCapability(declared[BACKEND_IDS.GPU] ?? {
      supported: false,
      planned: false,
      resident: true,
      abi: GPU_BACKEND_ABI,
      reason: 'GPU backend is not implemented in V1.6',
    }),
  });
}

/** @param {string} message @param {string} [code] */
export function createBackendError(message, code = GPU_UNAVAILABLE_CODE) {
  /** @type {Error & {code:string}} */
  const error = /** @type {any} */ (new Error(message));
  error.code = code;
  return error;
}

/**
 * Default GPU adapter. It deliberately exposes the complete lifecycle and
 * zero-valued telemetry but cannot execute. Tests and a V1.7 proof of concept
 * may inject an adapter with the same shape through createFilmExecutor().
 */
/** @param {{reason?:string}} [options] */
export function createUnavailableGpuBackend(options = {}) {
  const reason = options.reason ?? 'No supported native GPU adapter is installed';
  const transfers = createBackendTransferStats();
  const memory = createBackendMemoryStats();
  let disposed = false;
  const unavailable = () => {
    if (disposed) throw createBackendError('GPU backend has been disposed', 'ERR_GPU_DISPOSED');
    throw createBackendError(reason);
  };
  return Object.freeze({
    id: BACKEND_IDS.GPU,
    abi: GPU_BACKEND_ABI,
    available: false,
    reason,
    prepare: unavailable,
    render: unavailable,
    stats() {
      return { transfers: { ...transfers }, memory: { ...memory } };
    },
    dispose() { disposed = true; },
  });
}

/** @param {any} error @param {string} fallback */
export function backendErrorCode(error, fallback = 'ERR_BACKEND_EXECUTE') {
  return typeof error?.code === 'string' && error.code ? error.code : fallback;
}
