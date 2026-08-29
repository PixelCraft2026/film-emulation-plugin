// @ts-check
import { fnv1aUtf8 } from './seed.js';
import { normalizeEffectGraph, getEffectDefinition } from './effectRegistry.js';
import { BACKEND_IDS, GPU_BACKEND_ABI, normalizeBackendCapabilities } from './backendContract.js';

const BYTES_PER_F32 = Float32Array.BYTES_PER_ELEMENT;
const SAFETY_MARGIN = 1.15;
// wasm32 linear memory also needs room for allocator metadata, command/frame
// headers and transient growth. Keep the public budget margin unchanged for
// telemetry, but use a stricter resident-only bound when selecting the
// largest physical band.
const RESIDENT_LAYOUT_SAFETY_MARGIN = 1.70;
const MINIMUM_BAND_HEIGHT = 64;
const RESIDENT_MINIMUM_CORE = 256;

/** Stable V1.7 transient slots shared by JS, primitive WASM and resident WASM. */
export const TRANSIENT_SLOTS = Object.freeze({
  bloomBase: 0,
  bloomContribution: 1,
  sharedLuminance: 2,
  highlightSource: 3,
});

/** Physical stage values are part of the command ABI and must not be renumbered. */
export const STAGE_OPCODES = Object.freeze({
  defringe: 10,
  vignette: 20,
  halation: 30,
  bloom: 40,
  highlightProtection: 50,
  filmResolution: 60,
  grain: 70,
  damage: 80,
  overscan: 90,
});

/** Order used when promoting JS reference nodes into resident implementations. */
export const RESIDENT_MIGRATION_ORDER = Object.freeze([
  'filmResolution', 'grain', 'halation', 'defringe', 'bloom', 'highlightProtection',
]);

/** Physical resident layout is intentionally versioned separately from the
 * command-buffer and executor ABI.  A layout change can therefore be tested
 * and rejected without silently changing command decoding. */
export const RESIDENT_LAYOUT_VERSION = 1;
export const RESIDENT_LAYOUT_ALIGNMENT_FLOATS = 16;

/** @param {number} value @param {number} alignment */
function alignUp(value, alignment) {
  const a = Math.max(1, Math.trunc(alignment));
  return Math.ceil(Math.max(0, value) / a) * a;
}

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
    buffers: Object.freeze((Array.isArray(descriptor.buffers) ? descriptor.buffers : []).map((/** @type {any} */ buffer) => Object.freeze({
      ...buffer,
      name: String(buffer.name ?? `${node.id}:buffer`),
      kind: buffer.kind ?? 'scratch',
      scale: finitePositive(buffer.scale, 1),
      lifetime: buffer.lifetime ?? 'node',
      alias: buffer.alias ?? String(buffer.name ?? `${node.id}:buffer`),
      alignment: Math.max(1, Math.trunc(buffer.alignment ?? RESIDENT_LAYOUT_ALIGNMENT_FLOATS)),
      inPlaceSafe: buffer.inPlaceSafe === true || node.type === 'highlightProtection',
    }))),
    compositeMode: descriptor.compositeMode ?? definition.compositeMode ?? 'replacement',
    transientsRead: Array.isArray(descriptor.transientsRead) ? descriptor.transientsRead : [],
    transientsWrite: Array.isArray(descriptor.transientsWrite) ? descriptor.transientsWrite : [],
    residentArenaPlanes: Math.max(0, Number(descriptor.residentArenaPlanes ?? 0)),
    residentTransientPlanes: Math.max(0, Number(descriptor.residentTransientPlanes ?? 0)),
    wasm: descriptor.wasm ?? { supported: false },
    backends,
    identity: descriptor.identity === true,
  };
}

/**
 * Assign reusable arena slots from the descriptor liveness intervals.  A
 * transient buffer remains live through its nearest consumer (HP for Bloom),
 * while ordinary node scratch can alias as soon as the node completes.
 */
/** @param {any[]} items @returns {any} */
function planArenaAliases(items) {
  /** @type {any[]} */
  const intervals = [];
  for (let index = 0; index < items.length; index += 1) {
    const { node, descriptor } = items[index];
    for (const buffer of descriptor.buffers) {
      const name = String(buffer.name ?? `${node.id}:buffer`);
      const alias = buffer.alias ?? name;
      let last = index;
      if (buffer.lifetime === 'until-consumed' || buffer.lifetime === 'transient') {
        for (let consumer = index + 1; consumer < items.length; consumer += 1) {
          if (items[consumer].descriptor.transientsRead.includes(alias)) last = consumer;
        }
      }
    intervals.push(/** @type {any} */ ({
        name,
        alias,
        first: index,
        last,
        channels: Math.max(1, Math.trunc(buffer.channels ?? 1)),
        factor: Math.max(1, Number(buffer.factor ?? 1)),
        scale: finitePositive(buffer.scale, 1),
      kind: buffer.kind ?? 'scratch',
      }));
    }
    // Resident kernels may share a large phase workspace that is not exposed
    // as a public JS buffer (for example Halation's extraction/lobe planes or
    // Grain's generated fields). Model that workspace as a liveness interval
    // so the physical planner, rather than a fixed reserve multiplier, owns
    // the actual capacity calculation.
    if (descriptor.residentArenaPlanes > 0) {
      // Public workset buffers are part of the same resident arena.  Only
      // model the portion of the native phase workspace that is not already
      // represented by those buffers; adding the full node estimate on top
      // of them double-counts live storage and can exceed wasm32 capacity on
      // a legitimate multi-node band.
      const declaredPlanes = descriptor.buffers
        .filter((/** @type {any} */ buffer) => (buffer.kind ?? 'scratch') !== 'transient')
        .reduce((/** @type {number} */ sum, /** @type {any} */ buffer) => sum
          + Math.max(1, Number(buffer.channels ?? 1)) * Math.max(1, Number(buffer.factor ?? 1))
          / Math.max(1, finitePositive(buffer.scale, 1) ** 2), 0);
      const residentExtraPlanes = Math.max(0, descriptor.residentArenaPlanes - declaredPlanes);
      if (residentExtraPlanes <= 0) continue;
      intervals.push({
        name: `__resident-arena-${node.id}`,
        alias: `__resident-arena-${node.id}`,
        first: index,
        last: index,
        channels: 1,
        factor: residentExtraPlanes,
        scale: 1,
        kind: 'scratch',
      });
    }
  }
  const slots = [];
  for (const interval of intervals) {
    const bytes = interval.channels * interval.factor / (interval.scale * interval.scale) * BYTES_PER_F32;
    /** @type {any} */
    let slot = slots.find((candidate) => candidate.last < interval.first
      && candidate.bytes >= bytes
      && candidate.channels === interval.channels
      && candidate.kind === interval.kind);
    if (!slot) {
      slot = { id: slots.length, first: interval.first, last: interval.last, bytes, channels: interval.channels, kind: interval.kind, names: [] };
      slots.push(slot);
    } else {
      slot.last = interval.last;
      slot.bytes = Math.max(slot.bytes, bytes);
    }
    slot.names.push(interval.name);
    interval.slot = slot.id;
  }
  return { intervals, slots };
}

/**
 * Resolve the logical alias plan into a deterministic physical layout for a
 * particular band.  The Rust executor receives this layout through the
 * prepared-plan metadata; the JS planner remains the authority for geometry,
 * scale and aliasing decisions.
 *
 * @param {any} aliasPlan
 * @param {any[]} descriptors
 * @param {number} width
 * @param {number} height
 */
export function createPhysicalLayout(aliasPlan, descriptors, width, height) {
  const pixelCount = width * height;
  const slots = aliasPlan.slots.map((/** @type {any} */ slot) => {
    const names = new Set(slot.names ?? []);
    const intervals = aliasPlan.intervals.filter((/** @type {any} */ interval) => names.has(interval.name));
    let lengthFloats = 0;
    let scale = 1;
    let channels = 1;
    let factor = 1;
    for (const interval of intervals) {
      const intervalWidth = Math.max(1, Math.ceil(width / interval.scale));
      const intervalHeight = Math.max(1, Math.ceil(height / interval.scale));
      lengthFloats = Math.max(lengthFloats, intervalWidth * intervalHeight * interval.channels * interval.factor);
      scale = Math.min(scale, interval.scale);
      channels = Math.max(channels, interval.channels);
      factor = Math.max(factor, interval.factor);
    }
    return {
      id: slot.id,
      kind: slot.kind,
      first: slot.first,
      last: slot.last,
      names: Object.freeze([...names]),
      scale,
      channels,
      factor,
      offsetFloats: 0,
      lengthFloats: alignUp(lengthFloats, RESIDENT_LAYOUT_ALIGNMENT_FLOATS),
      alignmentFloats: RESIDENT_LAYOUT_ALIGNMENT_FLOATS,
    };
  });
  let scratchCursor = 0;
  for (const slot of slots.filter((/** @type {any} */ slot) => slot.kind !== 'transient')) {
    slot.offsetFloats = scratchCursor;
    scratchCursor += slot.lengthFloats;
  }
  const scratchSlots = Object.freeze(slots.map((/** @type {any} */ slot) => Object.freeze({ ...slot })));
  const scratchOnly = Object.freeze(scratchSlots.filter((/** @type {any} */ slot) => slot.kind !== 'transient'));
  const transientChannels = /** @type {Record<string, number>} */ (Object.freeze({ bloomBase: 0, bloomContribution: 3, sharedLuminance: 1, highlightSource: 3 }));
  let transientCursor = 0;
  const transient = Object.freeze(Object.entries(TRANSIENT_SLOTS).map(([name, slot]) => {
    // bloomBase is a read-only frame handle, not an arena allocation.
    const channels = transientChannels[name] ?? 1;
    const lengthFloats = name === 'bloomBase' ? 0 : alignUp(pixelCount * channels, RESIDENT_LAYOUT_ALIGNMENT_FLOATS);
    const binding = { name, slot, offsetFloats: transientCursor, lengthFloats, channels, lifetime: name === 'bloomContribution' ? 'until-consumed' : 'fixed' };
    transientCursor += lengthFloats;
    return Object.freeze(binding);
  }));
  const physicalIntervals = Object.freeze(aliasPlan.intervals.map((/** @type {any} */ interval) => {
    const slot = scratchSlots[interval.slot];
    const transientSlot = transient.find((/** @type {any} */ candidate) => candidate.name === interval.alias);
    return Object.freeze({
      ...interval,
      // A transient alias is backed by the fixed transient slot (or the
      // bloomBase frame handle with zero arena length), never by scratch slot
      // zero. This keeps planner telemetry and native bindings identical.
      offsetFloats: transientSlot?.offsetFloats ?? slot?.offsetFloats ?? 0,
      lengthFloats: transientSlot?.lengthFloats ?? slot?.lengthFloats ?? 0,
      alignmentFloats: transientSlot ? RESIDENT_LAYOUT_ALIGNMENT_FLOATS : (slot?.alignmentFloats ?? RESIDENT_LAYOUT_ALIGNMENT_FLOATS),
    });
  }));
  let frameSlot = 0;
  const bufferBindings = descriptors.map(({ node, descriptor }, nodeIndex) => {
    const inputFrame = frameSlot;
    const outputFrame = node.type === 'highlightProtection' ? inputFrame : 1 - inputFrame;
    frameSlot = outputFrame;
    const buffers = descriptor.buffers.map((/** @type {any} */ buffer) => {
      const interval = aliasPlan.intervals.find((/** @type {any} */ candidate) => candidate.name === buffer.name);
      const slot = interval ? scratchSlots[interval.slot] : null;
      const transientSlot = Object.prototype.hasOwnProperty.call(TRANSIENT_SLOTS, buffer.alias)
        ? transient.find((/** @type {any} */ candidate) => candidate.name === buffer.alias)
        : null;
      return Object.freeze({
        name: buffer.name,
        alias: buffer.alias ?? buffer.name,
        kind: buffer.kind ?? 'scratch',
        slot: transientSlot?.slot ?? slot?.id ?? -1,
        offsetFloats: transientSlot?.offsetFloats ?? slot?.offsetFloats ?? 0,
        lengthFloats: transientSlot?.lengthFloats ?? slot?.lengthFloats ?? 0,
        scale: buffer.scale,
        channels: buffer.channels ?? 1,
        factor: buffer.factor ?? 1,
        lifetime: buffer.lifetime ?? 'node',
        inPlaceSafe: buffer.inPlaceSafe === true || node.type === 'highlightProtection',
      });
    });
    return Object.freeze({
      nodeIndex,
      nodeId: node.id,
      inputFrame,
      outputFrame,
      buffers: Object.freeze(buffers),
      transientReads: Object.freeze(descriptor.transientsRead.map((/** @type {string} */ name) => transient.find((/** @type {any} */ item) => item.name === name)?.slot ?? -1)),
      transientWrites: Object.freeze(descriptor.transientsWrite.map((/** @type {string} */ name) => transient.find((/** @type {any} */ item) => item.name === name)?.slot ?? -1)),
    });
  });
  const layoutHash = hashObject({
    version: RESIDENT_LAYOUT_VERSION,
    alignmentFloats: RESIDENT_LAYOUT_ALIGNMENT_FLOATS,
    width,
    height,
    scratch: scratchOnly.map((/** @type {any} */ slot) => ({ id: slot.id, kind: slot.kind, offsetFloats: slot.offsetFloats, lengthFloats: slot.lengthFloats, scale: slot.scale, channels: slot.channels })),
    transient: transient.map((/** @type {any} */ slot) => ({ name: slot.name, slot: slot.slot, offsetFloats: slot.offsetFloats, lengthFloats: slot.lengthFloats, channels: slot.channels })),
  });
  // The liveness layout above is the authoritative logical map used for
  // planning and diagnostics.  Resident kernels execute one node at a time,
  // so their scratch can safely reuse a compact per-node arena.  Emit a
  // second, planner-derived binding view for that executor; transient offsets
  // remain fixed and are never folded into this compact scratch allocation.
  const residentArenaPlanes = Math.max(1, ...descriptors.map(({ descriptor }) => descriptor.residentArenaPlanes));
  const residentScratchFloats = alignUp(pixelCount * residentArenaPlanes, RESIDENT_LAYOUT_ALIGNMENT_FLOATS);
  const residentBindings = Object.freeze(bufferBindings.map((/** @type {any} */ binding) => Object.freeze({
    ...binding,
    buffers: Object.freeze(binding.buffers.map((/** @type {any} */ buffer) => {
      if (buffer.kind === 'transient') return Object.freeze({ ...buffer });
      return Object.freeze({
        ...buffer,
        // Node worksets are mutually exclusive in the resident scheduler;
        // each one starts at the compact arena origin and is bounded by its
        // declared length. Native kernels still validate this envelope.
        offsetFloats: 0,
        lengthFloats: Math.min(buffer.lengthFloats, residentScratchFloats),
      });
    })),
  })));
  return Object.freeze({
    version: RESIDENT_LAYOUT_VERSION,
    alignmentFloats: RESIDENT_LAYOUT_ALIGNMENT_FLOATS,
    width,
    height,
    frameRgbFloats: pixelCount * 3,
    alphaFloats: pixelCount,
    scratchFloats: scratchCursor,
    residentScratchFloats,
    residentArenaPlanes,
    transientFloats: transientCursor,
    // `slots` retains stable logical ids for interval bindings; `scratch`
    // exposes only physically allocated scratch slots. Transient aliases are
    // represented in the separate fixed `transient` table below.
    slots: scratchSlots,
    scratch: scratchOnly,
    intervals: physicalIntervals,
    transient,
    bindings: Object.freeze(bufferBindings.map((/** @type {any} */ binding) => Object.freeze({ ...binding, layoutHash }))),
    residentBindings,
    layoutHash,
    highWater: Object.freeze({ scratchFloats: scratchCursor, transientFloats: transientCursor }),
  });
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
    firstNode: segment.startIndex,
    lastNodeInclusive: segment.endIndex,
    uploadRgb: backendId === BACKEND_IDS.WASM || backendId === BACKEND_IDS.WASM_SIMD,
    uploadAlpha: backendId === BACKEND_IDS.WASM || backendId === BACKEND_IDS.WASM_SIMD,
    downloadRgb: (backendId === BACKEND_IDS.WASM || backendId === BACKEND_IDS.WASM_SIMD) && segment.endIndex < items.length - 1,
    materializedTransients: Object.freeze(items
      .slice(segment.startIndex, segment.endIndex + 1)
      .flatMap(({ descriptor }) => descriptor.transientsWrite)
      .filter((name, index, values) => values.indexOf(name) === index)
      .filter((name) => items
        .slice(segment.endIndex + 1)
        .some(({ descriptor }) => descriptor.transientsRead.includes(name)))),
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
      compositeMode: descriptor.compositeMode,
      transientsRead: Object.freeze([...descriptor.transientsRead]),
      transientsWrite: Object.freeze([...descriptor.transientsWrite]),
      backends: descriptor.backends,
    });
    downstreamSourceRadius += descriptor.sourceRadius;
  }
  const phasePeriod = descriptors.reduce((value, item) => lcm(value, item.descriptor.phasePeriod), 1);
  const overlap = Math.max(0, ...dependencies.map((item) => item.requiredInputHalo), ...dependencies.map((item) => item.generatedFieldRadius));
  const alignedOverlap = Math.ceil(overlap / phasePeriod) * phasePeriod;
  /** @type {any} */
  const aliasPlan = planArenaAliases(descriptors);
  const physicalLayout = createPhysicalLayout(aliasPlan, descriptors, width, height);
  /** @type {any} */
  const memory = slotEstimate(width, height, componentSize, descriptors.map((item) => item.descriptor));
  // Report both the conservative legacy estimate and the liveness-aware slot
  // layout.  The latter is consumed by resident WASM once the V1.7 adapter is
  // enabled; retaining the former keeps V1.6 JS/WASM telemetry comparable.
  memory.aliasArenaBytes = physicalLayout.scratchFloats * BYTES_PER_F32;
  memory.arenaSlots = physicalLayout.scratch;
  const residentMemory = Object.freeze({
    arenaFloatsPerPixel: Math.max(1, ...descriptors.map(({ descriptor }) => descriptor.residentArenaPlanes)),
    // Fixed transient slots are part of the resident ABI. Slot 0 is a frame
    // handle, while slots 1–3 occupy contribution/luminance/source planes.
    // Keep the descriptor estimate as a lower bound for forward-compatible
    // nodes, but never under-allocate the V1.7 fixed slots.
    transientFloatsPerPixel: Math.max(1, 7, ...descriptors.map(({ descriptor }) => descriptor.residentTransientPlanes)),
    frameSlots: 2,
    alphaPlanes: 1,
  });
  const requestedMode = request.memoryMode ?? 'auto';
  const reportedDeviceMemoryGB = Math.max(0, Number(request.deviceMemoryGB ?? 0));
  // UXP does not consistently expose navigator.deviceMemory. Auto must stay
  // conservative, but an explicit High selection is a user acknowledgement
  // that the host has at least 16 GiB and may use the established 4 GiB
  // working budget. This prevents an unknown-memory host from repeatedly
  // rendering very wide spatial halos while preserving the safe default.
  const assumedDeviceMemoryGB = requestedMode === 'high' && reportedDeviceMemoryGB <= 0
    ? 16
    : reportedDeviceMemoryGB;
  const budgetBytes = deviceBudget(assumedDeviceMemoryGB);
  const highFits = memory.plannedPeakBytes * SAFETY_MARGIN <= budgetBytes;
  // navigator.deviceMemory is not guaranteed in UXP.  Unknown hosts stay in
  // Balanced even when the estimate happens to fit the conservative budget;
  // this avoids selecting High based on an optimistic model.
  const hasKnownMemory = reportedDeviceMemoryGB > 0;
  const high = requestedMode === 'high' ? highFits : requestedMode === 'balanced' ? false : hasKnownMemory && highFits;
  const residentContiguous = descriptors.length > 0
    && descriptors.every(({ descriptor }) => descriptor.backends?.[BACKEND_IDS.WASM]?.supported === true);
  // Use the actual liveness/alias layout for the resident estimate.  The
  // descriptor maximum is only a per-node lower bound: overlapping frame
  // lifetimes can require several logical slots at once.  Estimating from
  // the physical high-water prevents a large whole-frame request from
  // reserving more than the wasm32 working budget and then trapping during
  // `memory.grow`.
  const layoutPixels = Math.max(1, width * height);
  const physicalScratchFloatsPerPixel = physicalLayout.scratchFloats / layoutPixels;
  const physicalTransientFloatsPerPixel = physicalLayout.transientFloats / layoutPixels;
  const residentBytesPerPixel = componentBytes(componentSize) * 4
    + BYTES_PER_F32 * (7 + physicalScratchFloatsPerPixel + physicalTransientFloatsPerPixel);
  const bandBytesPerPixel = Math.max(
    componentBytes(componentSize) * 4 + BYTES_PER_F32 * 14,
    residentContiguous && hasKnownMemory ? residentBytesPerPixel : 0,
  );
  const legacyHardBudgetBytes = Math.floor((assumedDeviceMemoryGB >= 24 ? 2.5 : 1.5) * 1024 ** 3);
  const hardBudgetBytes = residentContiguous && hasKnownMemory ? budgetBytes : legacyHardBudgetBytes;
  const usableBandBytes = Math.min(budgetBytes * 0.55, hardBudgetBytes / SAFETY_MARGIN);
  let bandHeight = height;
  if (!high) {
    const wholeResidentFits = hasKnownMemory && residentContiguous
      && width * height * residentBytesPerPixel * RESIDENT_LAYOUT_SAFETY_MARGIN <= budgetBytes;
    const conservativeMaximumRows = wholeResidentFits
      ? height
      : Math.floor(usableBandBytes / Math.max(1, width * bandBytesPerPixel)) - alignedOverlap * 2;
    // The conservative 55% working budget can be smaller than one halo plus
    // its overlap.  When a resident physical layout is available, derive a
    // second bound directly from the hard budget so that a legal (possibly
    // sub-halo) core still fits in wasm32 instead of being rejected after the
    // planner has already emitted it.
    const hardFitCoreRows = Math.floor(
      hardBudgetBytes / Math.max(1, width * bandBytesPerPixel * RESIDENT_LAYOUT_SAFETY_MARGIN),
    ) - alignedOverlap * 2;
    const maximumRows = wholeResidentFits
      ? height
      : residentContiguous && hasKnownMemory && hardFitCoreRows > 0
        ? Math.min(conservativeMaximumRows > 0 ? conservativeMaximumRows : hardFitCoreRows, hardFitCoreRows)
        : conservativeMaximumRows;
    // A core smaller than its own halo is pathological: dozens of bands can
    // repeatedly render almost the same rows while making no meaningful
    // progress through the document. Keep Balanced conservative, but require
    // at least one halo-width of new core work per band. If that cannot fit
    // the hard budget, hardBudgetExceeded below rejects the request instead
    // of silently turning a 26MP Apply into an unbounded overlap loop.
    const minimumUsefulCore = Math.min(height, Math.max(MINIMUM_BAND_HEIGHT, alignedOverlap));
    const minimumFittingCore = residentContiguous && hasKnownMemory
      ? Math.min(height, Math.max(phasePeriod, hardFitCoreRows > 0 ? hardFitCoreRows : RESIDENT_MINIMUM_CORE))
      : minimumUsefulCore;
    bandHeight = wholeResidentFits
      ? height
      : Math.max(Math.min(minimumFittingCore, height), Math.min(height, maximumRows));
    bandHeight = Math.max(MINIMUM_BAND_HEIGHT, Math.floor(bandHeight / phasePeriod) * phasePeriod);
    if (bandHeight > height) bandHeight = height;
  }
  const bands = splitBands(width, height, bandHeight, high ? 0 : alignedOverlap);
  const bandPixels = width * Math.min(height, bandHeight + (high ? 0 : alignedOverlap * 2));
  const estimatedBandBytes = Math.ceil(bandPixels * bandBytesPerPixel);
  const hardBudgetExceeded = high
    ? memory.plannedPeakBytes * SAFETY_MARGIN > budgetBytes
    : estimatedBandBytes * SAFETY_MARGIN > hardBudgetBytes;
  const normalizedGraph = graph.map((node) => ({ id: node.id, type: node.type, enabled: node.enabled !== false, params: node.params, mask: node.mask }));
  const graphHash = hashObject(normalizedGraph);
  const backendSegments = Object.freeze({
    [BACKEND_IDS.JS]: buildBackendSegments(descriptors, BACKEND_IDS.JS, 'supported'),
    [BACKEND_IDS.WASM]: buildBackendSegments(descriptors, BACKEND_IDS.WASM, 'supported'),
    [BACKEND_IDS.WASM_SIMD]: buildBackendSegments(descriptors, BACKEND_IDS.WASM_SIMD, 'supported'),
    [BACKEND_IDS.GPU]: buildBackendSegments(descriptors, BACKEND_IDS.GPU, 'supported'),
  });
  const backendCandidates = Object.freeze({
    [BACKEND_IDS.GPU]: buildBackendSegments(descriptors, BACKEND_IDS.GPU, 'planned'),
  });
  const commands = Object.freeze(descriptors.map(({ node, descriptor }, index) => Object.freeze({
    opcode: /** @type {any} */ (STAGE_OPCODES)[node.type] ?? 0,
    index,
    nodeId: node.id,
    nodeType: node.type,
    enabled: node.enabled !== false,
    compositeMode: descriptor.compositeMode,
    transientReads: Object.freeze(descriptor.transientsRead.map((/** @type {string} */ name) => /** @type {any} */ (TRANSIENT_SLOTS)[name] ?? -1)),
    transientWrites: Object.freeze(descriptor.transientsWrite.map((/** @type {string} */ name) => /** @type {any} */ (TRANSIENT_SLOTS)[name] ?? -1)),
    memoryLayout: physicalLayout.bindings[index],
  })));
  const backendOrder = Object.freeze([BACKEND_IDS.WASM_SIMD, BACKEND_IDS.WASM, BACKEND_IDS.JS]);
  const warnings = [];
  if (backendSegments[BACKEND_IDS.WASM].length > 2) warnings.push('fragmentedBackendPlan');
  if (descriptors.some(({ node, descriptor }) => ['defringe', 'bloom', 'highlightProtection'].includes(node.type)
    && descriptor.backends?.[BACKEND_IDS.WASM]?.supported !== true)) warnings.push('v17ResidentCapabilityPending');
  const planData = {
    width, height, fullWidth, fullHeight, previewScale, componentSize, quality,
    memoryMode: high ? 'high' : 'balanced', overlap: high ? 0 : alignedOverlap,
    bandHeight, phasePeriod, graphHash, dependencies, backendSegments, backendCandidates, backendOrder, commands, warnings,
    residentMigrationOrder: RESIDENT_MIGRATION_ORDER,
    residentMemory,
    physicalLayout,
    arenaHighWaterFloats: physicalLayout.scratchFloats,
    transientHighWaterFloats: physicalLayout.transientFloats,
  };
  const planHash = hashObject(planData);
  return Object.freeze({
    width, height, fullWidth, fullHeight, previewScale, componentSize, quality, format,
    graph: Object.freeze(graph), enabled: Object.freeze(enabled),
    graphHash, planHash, dependencies: Object.freeze(dependencies), phasePeriod,
    backendSegments, backendCandidates, backendOrder,
    commands,
    residentMigrationOrder: RESIDENT_MIGRATION_ORDER,
    residentMemory,
    physicalLayout,
    arenaHighWaterFloats: physicalLayout.scratchFloats,
    transientHighWaterFloats: physicalLayout.transientFloats,
    /** @param {number} activeWidth @param {number} activeHeight */
    physicalLayoutFor: (activeWidth, activeHeight) => createPhysicalLayout(
      aliasPlan,
      descriptors,
      Math.max(1, Math.trunc(activeWidth)),
      Math.max(1, Math.trunc(activeHeight)),
    ),
    warnings: Object.freeze(warnings),
    transientSlots: TRANSIENT_SLOTS,
    aliasPlan: Object.freeze({
      intervals: physicalLayout.intervals,
      slots: physicalLayout.slots,
    }),
    backendAbi: Object.freeze({ [BACKEND_IDS.GPU]: GPU_BACKEND_ABI }),
    overlap: high ? 0 : alignedOverlap, bandHeight, bands: Object.freeze(bands),
    memoryMode: high ? 'high' : 'balanced', budgetBytes, hardBudgetBytes,
    reportedDeviceMemoryGB, assumedDeviceMemoryGB,
    safetyMargin: SAFETY_MARGIN, hardBudgetExceeded,
    memory: Object.freeze({ ...memory, estimatedBandBytes }),
  });
}

export { stableStringify, splitBands, deviceBudget };
