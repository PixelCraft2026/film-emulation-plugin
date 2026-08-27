// @ts-check
import { fnv1aUtf8 } from './seed.js';
import { normalizeEffectGraph, getEffectDefinition } from './effectRegistry.js';
import { BACKEND_IDS, GPU_BACKEND_ABI, normalizeBackendCapabilities } from './backendContract.js';

const BYTES_PER_F32 = Float32Array.BYTES_PER_ELEMENT;
const SAFETY_MARGIN = 1.15;
const MINIMUM_BAND_HEIGHT = 64;

/** @param {any} value @param {number} fallback */
function finitePositive(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

/** @param {number} a @param {number} b */
function gcd(a, b) {
  let x = Math.max(1, Math.abs(Math.trunc(a)));
  let y = Math.max(1, Math.abs(Math.trunc(b)));
  while (y) [x, y] = [y, x % y];
  return x;
}

/** @param {number} a @param {number} b */
function lcm(a, b) {
  const x = Math.max(1, Math.trunc(a));
  const y = Math.max(1, Math.trunc(b));
  return Math.min(1024, Math.max(1, (x / gcd(x, y)) * y));
}

/** @param {any} value @returns {string} */
function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

/** @param {any} value */
function hashObject(value) {
  return fnv1aUtf8(stableStringify(value)).toString(16).padStart(8, '0');
}

/** @param {number} width @param {number} height @param {number} bandHeight @param {number} overlap */
function splitBands(width, height, bandHeight, overlap) {
  const bands = [];
  const core = Math.max(1, Math.trunc(bandHeight));
  const halo = Math.max(0, Math.trunc(overlap));
  for (let y0 = 0; y0 < height; y0 += core) {
    const y1 = Math.min(height, y0 + core);
    bands.push({
      y0,
      y1,
      start: Math.max(0, y0 - halo),
      end: Math.min(height, y1 + halo),
      top: Math.max(0, y0 - halo),
      bottom: Math.min(height, y1 + halo),
    });
  }
  return bands;
}

/** @param {any} deviceMemoryGB */
function deviceBudget(deviceMemoryGB) {
  const memory = Math.max(0, Number(deviceMemoryGB ?? 0));
  return Math.floor((memory >= 24 ? 6 : memory >= 16 ? 4 : 1.5) * 1024 ** 3);
}

/** @param {number} componentSize */
function componentBytes(componentSize) {
  return componentSize === 8 ? 1 : componentSize === 32 ? 4 : 2;
}

/** @param {any} node @param {any} context */
function descriptorFor(node, context) {
  const definition = getEffectDefinition(node.type);
  if (!definition) throw new Error(`Unknown effect node type: ${String(node.type)}`);
  const descriptor = definition.describeWorkset
    ? definition.describeWorkset(node.params, context)
    : {};
  const backends = normalizeBackendCapabilities(descriptor);
  return {
    sourceRadius: Math.max(0, Number(descriptor.sourceRadius ?? definition.supportRadius?.(node.params, context) ?? 0)),
    generatedFieldRadius: Math.max(0, Number(descriptor.generatedFieldRadius ?? 0)),
    phasePeriod: Math.max(1, Math.trunc(descriptor.phasePeriod ?? 1)),
    buffers: Array.isArray(descriptor.buffers) ? descriptor.buffers : [],
    wasm: descriptor.wasm ?? { supported: false },
    backends,
    identity: descriptor.identity === true,
  };
}

/**
 * Build maximal consecutive backend-resident node ranges. `planned` ranges
 * are feasibility candidates only and must never be executed in V1.6.
 * @param {Array<{node:any,descriptor:any}>} items
 * @param {string} backendId
 * @param {'supported'|'planned'} flag
 */
function buildBackendSegments(items, backendId, flag) {
  const segments = [];
  /** @param {any} segment */
  const freezeSegment = (segment) => Object.freeze({
    ...segment,
    nodeIds: Object.freeze([...segment.nodeIds]),
    nodeTypes: Object.freeze([...segment.nodeTypes]),
  });
  let current = null;
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const capability = item.descriptor.backends?.[backendId];
    if (capability?.[flag] !== true) {
      if (current) segments.push(freezeSegment(current));
      current = null;
      continue;
    }
    if (!current) {
      current = {
        backend: backendId,
        startIndex: index,
        endIndex: index,
        nodeIds: [item.node.id],
        nodeTypes: [item.node.type],
        resident: capability.resident === true,
        abi: capability.abi ?? null,
      };
    } else {
      current.endIndex = index;
      current.nodeIds.push(item.node.id);
      current.nodeTypes.push(item.node.type);
      current.resident = current.resident && capability.resident === true;
      if (current.abi !== capability.abi) current.abi = null;
    }
  }
  if (current) segments.push(freezeSegment(current));
  return Object.freeze(segments);
}

/** @param {number} width @param {number} height @param {number} componentSize @param {any[]} enabledDescriptors */
function slotEstimate(width, height, componentSize, enabledDescriptors) {
  const pixels = width * height;
  const hostBytes = pixels * 4 * componentBytes(componentSize);
  const canonicalBytes = pixels * 4 * BYTES_PER_F32; // RGB + alpha
  const outputBytes = hostBytes;
  let arenaBytes = pixels * BYTES_PER_F32 * 2; // ping-pong RGB planes
  let wasmBytes = pixels * BYTES_PER_F32 * 2;
  for (const descriptor of enabledDescriptors) {
    for (const buffer of descriptor.buffers) {
      const scale = finitePositive(buffer.scale, 1);
      const channels = Math.max(1, Math.trunc(buffer.channels ?? 1));
      const factor = Math.max(1, Number(buffer.factor ?? 1));
      arenaBytes = Math.max(arenaBytes, Math.ceil(pixels / (scale * scale) * channels * factor * BYTES_PER_F32));
      if (descriptor.backends?.[BACKEND_IDS.WASM]?.supported) {
        wasmBytes = Math.max(wasmBytes, Math.ceil(pixels / (scale * scale) * channels * factor * BYTES_PER_F32));
      }
    }
  }
  return {
    hostBytes,
    canonicalBytes,
    outputBytes,
    arenaBytes,
    wasmBytes,
    // Informational aliases/counters for the future GPU adapter. They are not
    // added again to plannedPeakBytes while no GPU allocation is executable.
    stagingBytes: hostBytes,
    gpuResidentBytes: 0,
    gpuScratchBytes: 0,
    plannedPeakBytes: hostBytes + canonicalBytes + outputBytes + arenaBytes + wasmBytes,
  };
}

/**
 * Compile a graph into immutable spatial, memory and band geometry metadata.
 * The planner is host-independent and can be used by Node benchmarks.
 */
/** @param {any} request @returns {any} */
export function createFilmRenderPlan(request = {}) {
  const width = Math.trunc(Number(request.width));
  const height = Math.trunc(Number(request.height));
  if (!Number.isSafeInteger(width) || width <= 0 || !Number.isSafeInteger(height) || height <= 0) {
    throw new RangeError('createFilmRenderPlan requires positive integer width and height');
  }
  const graph = normalizeEffectGraph(request.graph ?? request.document?.graph);
  const componentSize = Number(request.componentSize ?? 16);
  if (![8, 16, 32].includes(componentSize)) throw new RangeError(`Unsupported componentSize: ${componentSize}`);
  const quality = request.quality === 'fast' ? 'fast' : 'quality';
  const fullWidth = Math.trunc(Number(request.fullWidth ?? width));
  const fullHeight = Math.trunc(Number(request.fullHeight ?? height));
  const previewScale = Number(request.previewScale ?? 1);
  const format = request.format ?? request.document?.format;
  const context = { fullWidth, fullHeight, previewScale, quality, format };
  const enabled = graph.filter((node) => node.enabled !== false);
  const descriptors = enabled.map((node) => ({ node, descriptor: descriptorFor(node, context) }));

  let downstreamSourceRadius = 0;
  const dependencies = new Array(descriptors.length);
  for (let index = descriptors.length - 1; index >= 0; index -= 1) {
    const { node, descriptor } = descriptors[index];
    const requiredInputHalo = Math.ceil(descriptor.sourceRadius + downstreamSourceRadius);
    dependencies[index] = Object.freeze({
      id: node.id,
      type: node.type,
      sourceRadius: descriptor.sourceRadius,
      requiredInputHalo,
      generatedFieldRadius: descriptor.generatedFieldRadius,
      phasePeriod: descriptor.phasePeriod,
      buffers: descriptor.buffers,
      backends: descriptor.backends,
    });
    downstreamSourceRadius += descriptor.sourceRadius;
  }
  const phasePeriod = descriptors.reduce((value, item) => lcm(value, item.descriptor.phasePeriod), 1);
  const overlap = Math.max(0, ...dependencies.map((item) => item.requiredInputHalo), ...dependencies.map((item) => item.generatedFieldRadius));
  const alignedOverlap = Math.ceil(overlap / phasePeriod) * phasePeriod;
  const memory = slotEstimate(width, height, componentSize, descriptors.map((item) => item.descriptor));
  const budgetBytes = deviceBudget(request.deviceMemoryGB);
  const requestedMode = request.memoryMode ?? 'auto';
  const highFits = memory.plannedPeakBytes * SAFETY_MARGIN <= budgetBytes;
  // navigator.deviceMemory is not guaranteed in UXP.  Unknown hosts stay in
  // Balanced even when the estimate happens to fit the conservative budget;
  // this avoids selecting High based on an optimistic model.
  const hasKnownMemory = Number(request.deviceMemoryGB ?? 0) > 0;
  const high = requestedMode === 'high' ? highFits : requestedMode === 'balanced' ? false : hasKnownMemory && highFits;
  const bandBytesPerPixel = componentBytes(componentSize) * 4 + BYTES_PER_F32 * 14;
  const hardBudgetBytes = Math.floor((Number(request.deviceMemoryGB ?? 0) >= 24 ? 2.5 : 1.5) * 1024 ** 3);
  const usableBandBytes = Math.min(budgetBytes * 0.55, hardBudgetBytes / SAFETY_MARGIN);
  let bandHeight = height;
  if (!high) {
    const maximumRows = Math.floor(usableBandBytes / Math.max(1, width * bandBytesPerPixel)) - alignedOverlap * 2;
    bandHeight = Math.max(MINIMUM_BAND_HEIGHT, Math.min(height, maximumRows));
    bandHeight = Math.max(MINIMUM_BAND_HEIGHT, Math.floor(bandHeight / phasePeriod) * phasePeriod);
    if (bandHeight > height) bandHeight = height;
  }
  const bands = splitBands(width, height, bandHeight, high ? 0 : alignedOverlap);
  const bandPixels = width * Math.min(height, bandHeight + (high ? 0 : alignedOverlap * 2));
  const estimatedBandBytes = Math.ceil(bandPixels * bandBytesPerPixel);
  const hardBudgetExceeded = high
    ? memory.plannedPeakBytes * SAFETY_MARGIN > budgetBytes
    : estimatedBandBytes * SAFETY_MARGIN > hardBudgetBytes;
  const normalizedGraph = graph.map((node) => ({ id: node.id, type: node.type, enabled: node.enabled !== false, params: node.params }));
  const graphHash = hashObject(normalizedGraph);
  const backendSegments = Object.freeze({
    [BACKEND_IDS.JS]: buildBackendSegments(descriptors, BACKEND_IDS.JS, 'supported'),
    [BACKEND_IDS.WASM]: buildBackendSegments(descriptors, BACKEND_IDS.WASM, 'supported'),
    [BACKEND_IDS.GPU]: buildBackendSegments(descriptors, BACKEND_IDS.GPU, 'supported'),
  });
  const backendCandidates = Object.freeze({
    [BACKEND_IDS.GPU]: buildBackendSegments(descriptors, BACKEND_IDS.GPU, 'planned'),
  });
  const backendOrder = Object.freeze([BACKEND_IDS.WASM, BACKEND_IDS.JS]);
  const planData = {
    width, height, fullWidth, fullHeight, previewScale, componentSize, quality,
    memoryMode: high ? 'high' : 'balanced', overlap: high ? 0 : alignedOverlap,
    bandHeight, phasePeriod, graphHash, dependencies, backendSegments, backendCandidates, backendOrder,
  };
  const planHash = hashObject(planData);
  return Object.freeze({
    width, height, fullWidth, fullHeight, previewScale, componentSize, quality, format,
    graph: Object.freeze(graph), enabled: Object.freeze(enabled),
    graphHash, planHash, dependencies: Object.freeze(dependencies), phasePeriod,
    backendSegments, backendCandidates, backendOrder,
    backendAbi: Object.freeze({ [BACKEND_IDS.GPU]: GPU_BACKEND_ABI }),
    overlap: high ? 0 : alignedOverlap, bandHeight, bands: Object.freeze(bands),
    memoryMode: high ? 'high' : 'balanced', budgetBytes, hardBudgetBytes,
    safetyMargin: SAFETY_MARGIN, hardBudgetExceeded,
    memory: Object.freeze({ ...memory, estimatedBandBytes }),
  });
}

export { stableStringify, splitBands, deviceBudget };
