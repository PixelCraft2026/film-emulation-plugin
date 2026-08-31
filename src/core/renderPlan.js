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
const PERSISTENT_FRAME_PLANES = 7; // Frame A + Frame B RGB and immutable alpha.
const WASM32_MAX_BYTES = 0xffffffff;

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
export const RESIDENT_LAYOUT_VERSION = 2;
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

/**
 * Descriptor values are part of the plan contract, not user-facing hints.
 * Reject malformed/non-finite workset metadata instead of silently turning it
 * into a zero-sized allocation or a different geometry.
 * @param {any} value
 * @param {number} fallback
 * @param {string} label
 * @param {{integer?:boolean,min?:number}} [options]
 */
function descriptorNumber(value, fallback, label, options = {}) {
  if (value === undefined || value === null) return fallback;
  const number = Number(value);
  if (!Number.isFinite(number)) throw new RangeError(`Invalid effect workset ${label}: expected a finite number`);
  if (options.integer === true && !Number.isInteger(number)) throw new RangeError(`Invalid effect workset ${label}: expected an integer`);
  if (number < (options.min ?? 0)) throw new RangeError(`Invalid effect workset ${label}: expected >= ${options.min ?? 0}`);
  return number;
}

/** @param {any} value @param {string} label @returns {string[]} */
function descriptorTransientList(value, label) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new TypeError(`Invalid effect workset ${label}: expected an array`);
  return value.map((name) => {
    if (typeof name !== 'string' || !Object.prototype.hasOwnProperty.call(TRANSIENT_SLOTS, name)) {
      throw new RangeError(`Invalid effect workset ${label}: unknown transient ${String(name)}`);
    }
    return name;
  });
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

/** Keep planner cost units aligned with the existing per-node pass counters. */
/** @param {string} type */
function estimatedPassesFor(type) {
  return ({
    defringe: 6,
    halation: 8,
    bloom: 20,
    highlightProtection: 1,
    filmResolution: 8,
    grain: 8,
  })[type] ?? 1;
}

/** @param {any} node @param {any} context */
function descriptorFor(node, context) {
  const definition = getEffectDefinition(node.type);
  if (!definition) throw new Error(`Unknown effect node type: ${String(node.type)}`);
  const rawDescriptor = definition.describeWorkset
    ? definition.describeWorkset(node.params, context)
    : {};
  if (!rawDescriptor || typeof rawDescriptor !== 'object' || Array.isArray(rawDescriptor)) {
    throw new TypeError(`Invalid effect workset descriptor for ${node.id}`);
  }
  const descriptor = rawDescriptor;
  if (descriptor.identity !== undefined && typeof descriptor.identity !== 'boolean') {
    throw new TypeError(`Invalid effect workset identity for ${node.id}`);
  }
  const identity = descriptor.identity === true;
  const sourceRadius = descriptorNumber(
    descriptor.sourceRadius ?? definition.supportRadius?.(node.params, context) ?? 0,
    0,
    `${node.id}.sourceRadius`,
  );
  const generatedFieldRadius = descriptorNumber(descriptor.generatedFieldRadius, 0, `${node.id}.generatedFieldRadius`);
  const phasePeriod = descriptorNumber(descriptor.phasePeriod, 1, `${node.id}.phasePeriod`, { integer: true, min: 1 });
  const spatial = descriptor.spatialDependency;
  if (spatial !== undefined && spatial !== null && (typeof spatial !== 'object' || Array.isArray(spatial))) {
    throw new TypeError(`Invalid effect workset spatialDependency for ${node.id}`);
  }
  const spatialInputHalo = descriptorNumber(
    spatial?.inputHalo ?? sourceRadius,
    0,
    `${node.id}.spatialDependency.inputHalo`,
  );
  const spatialGeneratedFieldHalo = descriptorNumber(
    spatial?.generatedFieldHalo ?? generatedFieldRadius,
    0,
    `${node.id}.spatialDependency.generatedFieldHalo`,
  );
  const spatialPhasePeriod = descriptorNumber(
    spatial?.phasePeriod ?? phasePeriod,
    1,
    `${node.id}.spatialDependency.phasePeriod`,
    { integer: true, min: 1 },
  );
  const transientsRead = descriptorTransientList(descriptor.transientsRead, `${node.id}.transientsRead`);
  const transientsWrite = descriptorTransientList(descriptor.transientsWrite, `${node.id}.transientsWrite`);
  if (descriptor.buffers !== undefined && descriptor.buffers !== null && !Array.isArray(descriptor.buffers)) {
    throw new TypeError(`Invalid effect workset ${node.id}.buffers: expected an array`);
  }
  const backends = normalizeBackendCapabilities(descriptor);
  return {
    // Identity effects are logical aliases. They intentionally do not carry
    // their nominal support radius or declared workset into the physical plan.
    sourceRadius: identity ? 0 : sourceRadius,
    generatedFieldRadius: identity ? 0 : generatedFieldRadius,
    phasePeriod: identity ? 1 : phasePeriod,
    // Identity effects remain in the logical segment for cursor/stat
    // accounting, but contribute no physical work or halo.
    estimatedPasses: identity
      ? 0
      : descriptorNumber(descriptor.estimatedPasses, estimatedPassesFor(node.type), `${node.id}.estimatedPasses`, { min: 0 }),
    spatialDependency: Object.freeze({
      inputHalo: identity ? 0 : spatialInputHalo,
      generatedFieldHalo: identity ? 0 : spatialGeneratedFieldHalo,
      phasePeriod: identity ? 1 : spatialPhasePeriod,
    }),
    buffers: Object.freeze(identity ? [] : (Array.isArray(descriptor.buffers) ? descriptor.buffers : []).map((/** @type {any} */ buffer) => {
      if (!buffer || typeof buffer !== 'object' || Array.isArray(buffer)) {
        throw new TypeError(`Invalid effect workset buffer for ${node.id}`);
      }
      const name = String(buffer.name ?? `${node.id}:buffer`);
      const kind = String(buffer.kind ?? 'scratch');
      if (!['plane', 'scratch', 'transient'].includes(kind)) {
        throw new RangeError(`Invalid effect workset ${node.id}.buffer.kind: ${kind}`);
      }
      const alias = String(buffer.alias ?? name);
      if (!alias) throw new RangeError(`Invalid effect workset ${node.id}.buffer.alias`);
      return Object.freeze({
        ...buffer,
        name,
        kind,
        scale: descriptorNumber(buffer.scale, 1, `${node.id}.buffer.${name}.scale`, { min: Number.MIN_VALUE }),
        lifetime: buffer.lifetime ?? 'node',
        alias,
        alignment: descriptorNumber(buffer.alignment, RESIDENT_LAYOUT_ALIGNMENT_FLOATS, `${node.id}.buffer.${name}.alignment`, { integer: true, min: 1 }),
        channels: descriptorNumber(buffer.channels, 1, `${node.id}.buffer.${name}.channels`, { integer: true, min: 1 }),
        factor: descriptorNumber(buffer.factor, 1, `${node.id}.buffer.${name}.factor`, { min: Number.MIN_VALUE }),
        inPlaceSafe: buffer.inPlaceSafe === true || node.type === 'highlightProtection',
      });
    })),
    compositeMode: descriptor.compositeMode ?? definition.compositeMode ?? 'replacement',
    transientsRead: Object.freeze(identity ? [] : transientsRead),
    transientsWrite: Object.freeze(identity ? [] : transientsWrite),
    residentArenaPlanes: identity ? 0 : descriptorNumber(descriptor.residentArenaPlanes, 0, `${node.id}.residentArenaPlanes`, { integer: true, min: 0 }),
    residentTransientPlanes: identity ? 0 : descriptorNumber(descriptor.residentTransientPlanes, 0, `${node.id}.residentTransientPlanes`, { integer: true, min: 0 }),
    wasm: descriptor.wasm ?? { supported: false },
    backends,
    identity,
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
      residentArenaPlanes: descriptor.residentArenaPlanes,
      residentScratchFloats: alignUp(pixelCount * descriptor.residentArenaPlanes, RESIDENT_LAYOUT_ALIGNMENT_FLOATS),
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

/**
 * Compile graph-global worksets into deterministic spatial segments.  A
 * segment boundary is removed whenever a transient written by an earlier
 * node is consumed by a later node; this keeps producer/consumer lifetimes
 * intact without allowing generated-field padding to propagate upstream.
 * @param {Array<{node:any,descriptor:any}>} items
 * @param {number} width
 * @param {number} height
 * @param {number|number[]} bandHeight
 * @param {number} fullWidth
 * @param {number} fullHeight
 * @param {number} previewScale
 * @param {'fast'|'quality'} quality
 * @param {any} format
 * @returns {any[]}
 */
function compileSpatialSegments(items, width, height, bandHeight, fullWidth, fullHeight, previewScale, quality, format) {
  const active = items
    .map(({ descriptor }, index) => ({ descriptor, index }))
    .filter(({ descriptor }) => descriptor.identity !== true);
  if (!active.length) return [];

  // Every non-identity node is initially isolated.  Transient edges then
  // remove cuts between their producer and nearest consumer.
  const cuts = new Set(active.slice(0, -1).map(({ index }) => index));
  const activeIndexes = active.map(({ index }) => index);
  const activeOrdinal = new Map(activeIndexes.map((index, ordinal) => [index, ordinal]));
  for (const { index: producerIndex, descriptor: producer } of active) {
    for (const alias of producer.transientsWrite ?? []) {
      const consumer = active.find(({ index, descriptor }) => index > producerIndex && descriptor.transientsRead?.includes(alias));
      if (!consumer) continue;
      const producerOrdinal = activeOrdinal.get(producerIndex) ?? 0;
      const consumerOrdinal = activeOrdinal.get(consumer.index) ?? producerOrdinal;
      for (let ordinal = producerOrdinal; ordinal < consumerOrdinal; ordinal += 1) cuts.delete(activeIndexes[ordinal]);
    }
  }

  const ranges = [];
  let start = activeIndexes[0];
  for (let ordinal = 0; ordinal < activeIndexes.length - 1; ordinal += 1) {
    const boundary = activeIndexes[ordinal];
    if (cuts.has(boundary)) {
      ranges.push([start, boundary]);
      // Ranges are graph-contiguous, not merely active-node contiguous: an
      // identity node between two physical effects remains attached to the
      // following segment for alias/stat accounting without adding cost.
      start = boundary + 1;
    }
  }
  ranges.push([start, activeIndexes[activeIndexes.length - 1]]);
  // Keep leading/trailing identity commands attached to the nearest physical
  // segment so cursor/step telemetry still accounts for the complete enabled
  // graph without assigning them any halo or cost.
  ranges[0][0] = 0;
  ranges[ranges.length - 1][1] = items.length - 1;

  return ranges.map(([nodeStart, nodeEnd], index) => {
    const segmentItems = items.slice(nodeStart, nodeEnd + 1);
    let downstreamInputHalo = 0;
    let inputHalo = 0;
    let generatedFieldHalo = 0;
    let phasePeriod = 1;
    for (let itemIndex = segmentItems.length - 1; itemIndex >= 0; itemIndex -= 1) {
      const dependency = segmentItems[itemIndex].descriptor.spatialDependency ?? segmentItems[itemIndex].descriptor;
      if (segmentItems[itemIndex].descriptor.identity === true) continue;
      const localInputHalo = Math.max(0, Number(dependency.inputHalo ?? segmentItems[itemIndex].descriptor.sourceRadius ?? 0));
      inputHalo = Math.max(inputHalo, Math.ceil(localInputHalo + downstreamInputHalo));
      downstreamInputHalo += localInputHalo;
      generatedFieldHalo = Math.max(generatedFieldHalo, Math.ceil(Number(dependency.generatedFieldHalo ?? segmentItems[itemIndex].descriptor.generatedFieldRadius ?? 0)));
      phasePeriod = lcm(phasePeriod, Math.max(1, Math.trunc(dependency.phasePeriod ?? segmentItems[itemIndex].descriptor.phasePeriod ?? 1)));
    }
    const alignedInputHalo = Math.ceil(inputHalo / phasePeriod) * phasePeriod;
    const requestedBandHeight = Array.isArray(bandHeight) ? bandHeight[index] : bandHeight;
    const numericBandHeight = Math.max(1, Math.min(height, Math.trunc(Number(requestedBandHeight) || 1)));
    const localBandHeight = numericBandHeight >= height
      ? height
      : Math.max(1, Math.floor(numericBandHeight / phasePeriod) * phasePeriod);
    const segmentBands = splitBands(width, height, localBandHeight, alignedInputHalo);
    const aliasPlan = planArenaAliases(segmentItems);
    // Generated fields (notably Grain) may need coordinate-addressed padding
    // inside the scratch arena, but that padding must never become upstream
    // input halo.  Reserve it in the local physical geometry only.
    const scratchHeight = Math.max(
      1,
      localBandHeight + alignedInputHalo * 2 + generatedFieldHalo * 2,
    );
    const physicalLayout = createPhysicalLayout(aliasPlan, segmentItems, width, scratchHeight);
    const nodeIds = segmentItems.map(({ node }) => node.id);
    const transients = Object.freeze({
      reads: Object.freeze([...new Set(segmentItems.flatMap(({ descriptor }) => descriptor.transientsRead ?? []))]),
      writes: Object.freeze([...new Set(segmentItems.flatMap(({ descriptor }) => descriptor.transientsWrite ?? []))]),
    });
    const estimatedPasses = segmentItems.reduce((sum, { descriptor }) => sum + Math.max(0, Number(descriptor.estimatedPasses ?? 1)), 0);
    const inputPixels = segmentBands.reduce((sum, band) => sum + width * Math.max(0, band.end - band.start), 0);
    const corePixels = segmentBands.reduce((sum, band) => sum + width * Math.max(0, band.y1 - band.y0), 0);
    // Materialization consists of copying the halo-complete RGB/alpha input
    // window into the local frame and committing the valid RGB core back into
    // the pending full-frame slot.  Keep both directions in the plan traffic
    // estimate so segment telemetry can be reconciled with the native copy
    // counters instead of reporting only the final core write.
    const materializationBytes = (
      inputPixels * 4 + corePixels * 3
    ) * Float32Array.BYTES_PER_ELEMENT;
    const segmentHash = hashObject({
      index, nodeStart, nodeEnd, nodeIds, inputHalo: alignedInputHalo,
      generatedFieldHalo, phasePeriod, bands: segmentBands,
      layoutHash: physicalLayout.layoutHash, transients,
    });
    return Object.freeze({
      index,
      segmentHash,
      nodeStart,
      nodeEnd,
      nodeIds: Object.freeze(nodeIds),
      nodeTypes: Object.freeze(segmentItems.map(({ node }) => node.type)),
      inputHalo: alignedInputHalo,
      generatedFieldHalo,
      phasePeriod,
      bandHeight: localBandHeight,
      bands: Object.freeze(segmentBands),
      physicalLayout,
      transients,
      estimatedCost: Object.freeze({
        estimatedKernelPixelVisits: inputPixels * Math.max(1, estimatedPasses),
        estimatedPasses,
        inputPixels,
        corePixels,
        materializationBytes,
        trafficBytes: materializationBytes,
        bandCount: segmentBands.length,
      }),
      memory: Object.freeze({
        scratchFloats: physicalLayout.residentScratchFloats,
        transientFloats: physicalLayout.transientFloats,
      }),
      fullWidth,
      fullHeight,
      previewScale,
      quality,
      format,
    });
  });
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
 * Select the PF-10 execution mode from a checked, deterministic cost model.
 * Host canonical input is included because an Apply request must be restartable
 * from the source if a resident segment fails after an earlier commit.
 * @param {any[]} segments
 * @param {any} physicalLayout
 * @param {number} width
 * @param {number} height
 * @param {number} componentSize
 * @param {number} budgetBytes
 * @param {boolean} residentContiguous
 * @returns {any}
 */
function chooseExecutionPlan(segments, physicalLayout, width, height, componentSize, budgetBytes, residentContiguous) {
  const pixels = width * height;
  const persistentFrameBytes = pixels * PERSISTENT_FRAME_PLANES * BYTES_PER_F32;
  const hostCanonicalBytes = pixels * 4 * BYTES_PER_F32;
  const hostOutputBytes = pixels * 4 * componentBytes(componentSize);
  const commandBytes = segments.reduce((sum, segment) => sum + 64 + Math.max(1, segment.nodeIds?.length ?? 1) * 512, 0);
  const maxSegmentRows = Math.max(1, ...segments.flatMap((segment) => (segment.bands ?? []).map((/** @type {any} */ band) => Math.max(0, band.end - band.start))));
  const maxUploadRows = Math.max(1, ...segments.flatMap((segment) => (segment.bands ?? []).map((/** @type {any} */ band) => Math.max(0, band.y1 - band.y0))));
  const hostReadBytes = width * maxUploadRows * 4 * componentBytes(componentSize);
  // A segment keeps two local RGB frames plus one local alpha plane while a
  // band is executing.  The first RGB/alpha pair doubles as the upload
  // staging view, so this single 7-plane term accounts for both staging and
  // local materialization without double-counting another host buffer.
  const stagingBytes = width * maxSegmentRows * PERSISTENT_FRAME_PLANES * BYTES_PER_F32;
  const commonFixedBytes = persistentFrameBytes + hostCanonicalBytes + hostOutputBytes + hostReadBytes + commandBytes;
  const fixedBytes = commonFixedBytes + stagingBytes;
  const wasmLimit = WASM32_MAX_BYTES;
  /** @param {string} mode @param {number} peakBytes @param {number} kernelPixelVisits @param {number} trafficBytes @param {number} bandCount @param {boolean} valid @param {string} reason */
  const candidate = (mode, peakBytes, kernelPixelVisits, trafficBytes, bandCount, valid, reason) => ({
    mode,
    valid,
    reason,
    estimatedPeakBytes: Math.ceil(peakBytes),
    estimatedKernelPixelVisits: Math.ceil(kernelPixelVisits),
    trafficBytes: Math.ceil(trafficBytes),
    bandCount,
  });

  const wholeKernelVisits = pixels * Math.max(1, segments.reduce((sum, segment) => sum + Number(segment.estimatedCost?.estimatedPasses ?? 1), 0));
  const wholeResidentBytes = persistentFrameBytes + Math.max(0, Number(physicalLayout?.scratchFloats ?? 0) * BYTES_PER_F32)
    + Math.max(0, Number(physicalLayout?.transientFloats ?? 0) * BYTES_PER_F32);
  // Whole-frame reuses its full resident input frames for upload and needs no
  // segment-local seven-plane staging frame.  Scratch capacity belongs in the
  // peak model, not the traffic tie-breaker: treating reserved bytes as copy
  // traffic incorrectly made a safe Preview choose five segment commits.
  const wholePeak = commonFixedBytes + wholeResidentBytes - persistentFrameBytes;
  const wholeWasmPeak = wholeResidentBytes;
  const wholeTraffic = persistentFrameBytes;
  const whole = candidate(
    'whole-frame',
    wholePeak,
    wholeKernelVisits,
    wholeTraffic,
    1,
    residentContiguous && wholePeak * SAFETY_MARGIN <= budgetBytes && wholeWasmPeak * RESIDENT_LAYOUT_SAFETY_MARGIN <= wasmLimit,
    residentContiguous ? 'whole-frame resident layout' : 'resident capability unavailable',
  );

  const segmentKernelVisits = segments.reduce((sum, segment) => sum + Number(segment.estimatedCost?.estimatedKernelPixelVisits ?? 0), 0);
  const segmentMaterialization = segments.reduce((sum, segment) => sum + Number(segment.estimatedCost?.materializationBytes ?? 0), 0);
  // reserveSegmented takes independent maxima for arena and transient
  // capacity.  Those maxima may belong to different segments, so taking the
  // maximum of each segment's sum would under-report the actual reservation.
  const segmentArenaBytes = segments.reduce((max, segment) => Math.max(max,
    Number(segment.memory?.scratchFloats ?? 0) * BYTES_PER_F32), 0);
  const segmentTransientBytes = segments.reduce((max, segment) => Math.max(max,
    Number(segment.memory?.transientFloats ?? 0) * BYTES_PER_F32), 0);
  const segmentScratch = segmentArenaBytes + segmentTransientBytes;
  const segmentPeak = fixedBytes + segmentScratch;
  // The segmented native session owns both full persistent frames and the
  // largest local band frame/staging envelope at the same time.  Keep the
  // Wasm32 safety check honest; omitting the local seven-plane frame lets a
  // seemingly legal large-core plan approach the 4 GiB ceiling without the
  // required 1.70 reserve margin.
  const segmentWasmPeak = persistentFrameBytes + stagingBytes + segmentScratch + commandBytes;
  const segmentTraffic = persistentFrameBytes + segmentMaterialization;
  const segmented = candidate(
    'resident-segmented',
    segmentPeak,
    segmentKernelVisits,
    segmentTraffic,
    segments.reduce((sum, segment) => sum + Number(segment.bands?.length ?? 0), 0),
    residentContiguous && segments.length > 0 && segmentPeak * SAFETY_MARGIN <= budgetBytes && segmentWasmPeak * RESIDENT_LAYOUT_SAFETY_MARGIN <= wasmLimit,
    residentContiguous ? 'segment-local frame materialization' : 'resident capability unavailable',
  );

  const legacy = candidate(
    'legacy-banded',
    Math.max(hostOutputBytes, Number(physicalLayout?.residentScratchFloats ?? 0) * BYTES_PER_F32),
    wholeKernelVisits,
    Math.max(0, Number(physicalLayout?.transientFloats ?? 0) * BYTES_PER_F32),
    Math.max(1, segments.reduce((sum, segment) => sum + Number(segment.bands?.length ?? 0), 0)),
    true,
    'compatibility fallback',
  );
  const valid = [whole, segmented].filter((entry) => entry.valid);
  valid.sort((a, b) => a.estimatedKernelPixelVisits - b.estimatedKernelPixelVisits
    || a.trafficBytes - b.trafficBytes
    || a.bandCount - b.bandCount
    || ['whole-frame', 'resident-segmented', 'legacy-banded'].indexOf(a.mode) - ['whole-frame', 'resident-segmented', 'legacy-banded'].indexOf(b.mode));
  const selected = valid[0] ?? legacy;
  return Object.freeze({
    mode: selected.mode,
    selected,
    candidates: Object.freeze({ wholeFrame: Object.freeze(whole), residentSegmented: Object.freeze(segmented), legacyBanded: Object.freeze(legacy) }),
    persistentFrameBytes,
    fixedBytes,
    hostReadBytes,
    commandBytes,
    stagingBytes,
    wasmLimit,
  });
}

/** Grow segment cores independently while the single PF-10 reserve remains
 * legal.  Growth is deliberately incremental so high-benefit wide-halo
 * segments compete for the shared staging/scratch envelope before zero-halo
 * segments consume it merely to reduce scheduler calls.
 * @param {any[]} items
 * @param {any[]} initialSegments
 * @param {any} initialExecution
 * @param {number} width
 * @param {number} height
 * @param {number} fullWidth
 * @param {number} fullHeight
 * @param {number} previewScale
 * @param {'fast'|'quality'} quality
 * @param {any} format
 * @param {any} physicalLayout
 * @param {number} componentSize
 * @param {number} budgetBytes
 * @param {boolean} residentContiguous
 * @returns {{segments:any[],execution:any}}
 */
function optimizeSpatialSegmentBands(
  items,
  initialSegments,
  initialExecution,
  width,
  height,
  fullWidth,
  fullHeight,
  previewScale,
  quality,
  format,
  physicalLayout,
  componentSize,
  budgetBytes,
  residentContiguous,
) {
  let segments = initialSegments;
  let execution = initialExecution;
  if (!residentContiguous || !execution.candidates.residentSegmented.valid || !segments.length) {
    return { segments, execution };
  }
  let bandHeights = segments.map((segment) => segment.bandHeight);
  const maxIterations = Math.max(1, segments.length * 8);
  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    const currentCandidate = execution.candidates.residentSegmented;
    const candidates = [];
    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index];
      if (segment.bandHeight >= height) continue;
      const phase = Math.max(1, Math.trunc(Number(segment.phasePeriod) || 1));
      const doubled = Math.min(height, segment.bandHeight * 2);
      const nextBandHeight = doubled >= height
        ? height
        : Math.max(segment.bandHeight + phase, Math.floor(doubled / phase) * phase);
      if (nextBandHeight <= segment.bandHeight) continue;
      const candidateBandHeights = bandHeights.slice();
      candidateBandHeights[index] = nextBandHeight;
      const candidateSegments = compileSpatialSegments(
        items,
        width,
        height,
        candidateBandHeights,
        fullWidth,
        fullHeight,
        previewScale,
        quality,
        format,
      );
      const candidateExecution = chooseExecutionPlan(
        candidateSegments,
        physicalLayout,
        width,
        height,
        componentSize,
        budgetBytes,
        residentContiguous,
      );
      const residentCandidate = candidateExecution.candidates.residentSegmented;
      if (!residentCandidate.valid) continue;
      const visitReduction = currentCandidate.estimatedKernelPixelVisits - residentCandidate.estimatedKernelPixelVisits;
      const trafficReduction = currentCandidate.trafficBytes - residentCandidate.trafficBytes;
      const bandReduction = currentCandidate.bandCount - residentCandidate.bandCount;
      if (visitReduction <= 0 && trafficReduction <= 0 && bandReduction <= 0) continue;
      candidates.push({
        index,
        nextBandHeight,
        segments: candidateSegments,
        execution: candidateExecution,
        visitReduction,
        trafficReduction,
        bandReduction,
        peakIncrease: residentCandidate.estimatedPeakBytes - currentCandidate.estimatedPeakBytes,
      });
    }
    if (!candidates.length) break;
    candidates.sort((a, b) => b.visitReduction - a.visitReduction
      || b.trafficReduction - a.trafficReduction
      || b.bandReduction - a.bandReduction
      || a.peakIncrease - b.peakIncrease
      || a.index - b.index);
    const selected = candidates[0];
    bandHeights = selected.segments.map((segment) => segment.bandHeight);
    segments = selected.segments;
    execution = selected.execution;
  }
  return { segments, execution };
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
  if (!Number.isSafeInteger(fullWidth) || fullWidth <= 0 || !Number.isSafeInteger(fullHeight) || fullHeight <= 0) {
    throw new RangeError('createFilmRenderPlan requires positive integer fullWidth and fullHeight');
  }
  if (!Number.isFinite(previewScale) || previewScale <= 0) {
    throw new RangeError('createFilmRenderPlan requires a finite positive previewScale');
  }
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
      spatialDependency: descriptor.spatialDependency,
      estimatedPasses: descriptor.estimatedPasses,
      identity: descriptor.identity,
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
  const uploadBands = splitBands(width, height, Math.max(1, bandHeight), 0);
  const bandPixels = width * Math.min(height, bandHeight + (high ? 0 : alignedOverlap * 2));
  const estimatedBandBytes = Math.ceil(bandPixels * bandBytesPerPixel);
  // PF-9 segments have their own scratch envelope.  When a known host has
  // room beyond the legacy balanced band, use a larger local core to avoid
  // paying the same halo materialization once per graph-wide band.  The
  // legacy `bands` view remains unchanged for compatibility; only the PF-10
  // resident geometry uses this bounded multiplier.
  const spatialBandMultiplier = !high && residentContiguous && hasKnownMemory
    ? (assumedDeviceMemoryGB >= 24 ? 4 : 2)
    : 1;
  const spatialBandHeight = Math.min(
    height,
    Math.max(1, Math.floor((Math.max(1, high ? Math.min(height, Math.max(MINIMUM_BAND_HEIGHT, 256)) : bandHeight) * spatialBandMultiplier) / phasePeriod) * phasePeriod),
  );
  let spatialSegments = compileSpatialSegments(
    descriptors,
    width,
    height,
    // An explicit High request keeps the legacy whole-image compatibility
    // view, while PF-10 may still choose local segment bands if the new
    // persistent-frame working set is too large for one resident call.
    spatialBandHeight,
    fullWidth,
    fullHeight,
    previewScale,
    quality,
    format,
  );
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
  let execution = chooseExecutionPlan(
    spatialSegments,
    physicalLayout,
    width,
    height,
    componentSize,
    budgetBytes,
    residentContiguous,
  );
  // A single enabled wide-halo node can make the legacy balanced planner
  // choose a whole-height band even though PF-10 needs a smaller local
  // envelope.  Shrink only the PF-10 segment geometry until its checked peak
  // fits the host/Wasm margins; the compatibility `bands` view is untouched.
  let retryBandHeight = spatialBandHeight;
  while (!execution.candidates.residentSegmented.valid
    && retryBandHeight > Math.max(phasePeriod, MINIMUM_BAND_HEIGHT)
    && residentContiguous) {
    retryBandHeight = Math.max(
      phasePeriod,
      Math.floor((retryBandHeight / 2) / phasePeriod) * phasePeriod,
    );
    spatialSegments = compileSpatialSegments(
      descriptors,
      width,
      height,
      retryBandHeight,
      fullWidth,
      fullHeight,
      previewScale,
      quality,
      format,
    );
    execution = chooseExecutionPlan(
      spatialSegments,
      physicalLayout,
      width,
      height,
      componentSize,
      budgetBytes,
      residentContiguous,
    );
  }
  const optimizedSpatialPlan = optimizeSpatialSegmentBands(
    descriptors,
    spatialSegments,
    execution,
    width,
    height,
    fullWidth,
    fullHeight,
    previewScale,
    quality,
    format,
    physicalLayout,
    componentSize,
    budgetBytes,
    residentContiguous,
  );
  spatialSegments = optimizedSpatialPlan.segments;
  execution = optimizedSpatialPlan.execution;
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
    bandHeight, phasePeriod, graphHash, dependencies, bands, uploadBands, spatialSegments, execution, backendSegments, backendCandidates, backendOrder, commands, warnings,
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
    spatialSegments: Object.freeze(spatialSegments),
    execution: Object.freeze(execution),
    executionMode: execution.mode,
    uploadBands: Object.freeze(uploadBands),
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
