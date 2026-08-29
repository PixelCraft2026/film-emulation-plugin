// Graph command-buffer v1.  This module deliberately contains no host or
// WASM dependency: both the JS reference executor and the native adapter use
// the same little-endian layout and validation rules.
import { fnv1aUtf8 } from './seed.js';
import { createHalationParams, resolveSigmaParams, thresholdLinear } from './params.js';

// Kept local to avoid a renderPlan -> effectRegistry -> pipeline ->
// wasmBackend -> commandBuffer initialization cycle.
const STAGE_OPCODES = Object.freeze({
  defringe: 10, vignette: 20, halation: 30, bloom: 40,
  highlightProtection: 50, filmResolution: 60, grain: 70, damage: 80, overscan: 90,
});

export const COMMAND_MAGIC = 0x464c4d47; // ASCII "FLMG"
export const COMMAND_BUFFER_VERSION = 1;
export const EXECUTOR_ABI_VERSION = 1;
export const COMMAND_HEADER_BYTES = 80;
export const NODE_COMMAND_BYTES = 36;

export const COMMAND_ERRORS = Object.freeze({
  OK: 0,
  OK_MORE: 1,
  // Stable EA error vocabulary.  The compatibility aliases below intentionally
  // share the same values so older callers can still classify malformed plans.
  ERR_ABI_VERSION: -1,
  ERR_INVALID_PLAN: -2,
  ERR_UNSUPPORTED_NODE: -3,
  ERR_CAPACITY: -4,
  ERR_NONFINITE_PARAM: -5,
  ERR_NONFINITE_OUTPUT: -6,
  ERR_STALE_HANDLE: -7,
  ERR_CANCELLED: -8,
  ERR_INTERNAL: -9,
  ERR_BAD_MAGIC: -2,
  ERR_BAD_LENGTH: -2,
  ERR_UNSUPPORTED_PLAN: -2,
  ERR_OVERFLOW: -4,
  ERR_NONFINITE: -5,
});

/** @param {number} value */
function u32(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > 0xffffffff) throw new RangeError('u32 out of range');
  return number >>> 0;
}

/** @param {number} value */
function i32(value) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < -0x80000000 || number > 0x7fffffff) throw new RangeError('i32 out of range');
  return number | 0;
}

/** @param {number} value */
function f32(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new TypeError('command value must be finite');
  return number;
}

/** @param {string} value */
function utf8(value) {
  const text = String(value);
  const bytes = [];
  for (let index = 0; index < text.length; index += 1) {
    let codePoint = text.charCodeAt(index);
    if (codePoint >= 0xd800 && codePoint <= 0xdbff) {
      const low = text.charCodeAt(index + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        codePoint = 0x10000 + ((codePoint - 0xd800) << 10) + (low - 0xdc00);
        index += 1;
      } else codePoint = 0xfffd;
    } else if (codePoint >= 0xdc00 && codePoint <= 0xdfff) codePoint = 0xfffd;
    if (codePoint <= 0x7f) bytes.push(codePoint);
    else if (codePoint <= 0x7ff) bytes.push(0xc0 | (codePoint >>> 6), 0x80 | (codePoint & 0x3f));
    else if (codePoint <= 0xffff) bytes.push(0xe0 | (codePoint >>> 12), 0x80 | ((codePoint >>> 6) & 0x3f), 0x80 | (codePoint & 0x3f));
    else bytes.push(0xf0 | (codePoint >>> 18), 0x80 | ((codePoint >>> 12) & 0x3f), 0x80 | ((codePoint >>> 6) & 0x3f), 0x80 | (codePoint & 0x3f));
  }
  return Uint8Array.from(bytes);
}

/** Encode validated params as deterministic typed fields, never as JSON.
 * @param {any} value @param {number[]} bytes
 */
function encodeValue(value, bytes, key = '') {
  if (typeof value === 'number') {
    if (key === 'seed' && Number.isInteger(value) && value >= 0 && value <= 0xffffffff) {
      bytes.push(6, value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, value >>> 24);
      return;
    }
    bytes.push(1);
    const data = new ArrayBuffer(4);
    new DataView(data).setFloat32(0, f32(value), true);
    bytes.push(...new Uint8Array(data));
    return;
  }
  if (typeof value === 'boolean') {
    bytes.push(2, value ? 1 : 0);
    return;
  }
  if (typeof value === 'string') {
    const data = utf8(value);
    if (data.length > 0xffff) throw new RangeError('command string is too long');
    bytes.push(3, data.length & 0xff, data.length >>> 8, ...data);
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 0xffff) throw new RangeError('command array is too long');
    bytes.push(4, value.length & 0xff, value.length >>> 8);
    for (const item of value) encodeValue(item, bytes);
    return;
  }
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    if (keys.length > 0xffff) throw new RangeError('command object has too many fields');
    bytes.push(5, keys.length & 0xff, keys.length >>> 8);
    for (const key of keys) {
      const hash = fnv1aUtf8(key) >>> 0;
      bytes.push(hash & 0xff, (hash >>> 8) & 0xff, (hash >>> 16) & 0xff, hash >>> 24);
      encodeValue(value[key], bytes, key);
    }
    return;
  }
  throw new TypeError('unsupported command parameter value');
}

/** @param {any} params */
function encodeParams(params) {
  /** @type {number[]} */
  const bytes = [];
  encodeValue(params ?? {}, bytes);
  return Uint8Array.from(bytes);
}

/** @param {string} hash */
function hashParts(hash) {
  const parsed = typeof hash === 'string' ? Number.parseInt(hash, 16) : Number(hash);
  if (!Number.isFinite(parsed)) return [0, 0];
  return [parsed >>> 0, Math.floor(parsed / 0x100000000) >>> 0];
}

/** @param {any} format */
function commandFormatId(format) {
  const gauge = String(format?.gauge ?? '35mm');
  if (gauge === '8mm') return 1;
  if (gauge === '16mm') return 2;
  if (gauge === '65mm') return 4;
  return 3;
}

/** Compile UI/serialized parameters into the canonical physical values the
 * scalar executor consumes.  Halation is the only current node whose stored
 * units depend on the complete document geometry; keeping that conversion in
 * the JS authority avoids a second interpretation of UI units in Rust.
 * @param {any} node @param {any} plan @param {any} context
 */
function commandParams(node, plan, context) {
  if (node?.type === 'grain') {
    return context.quality === 'fast' && node?.params?.mode !== 'fast'
      ? { ...(node?.params ?? {}), mode: 'fast' }
      : (node?.params ?? {});
  }
  if (node?.type !== 'halation') return node?.params ?? {};
  const validated = createHalationParams({
    ...(node.params ?? {}),
    ...(context.forceFast ? { diffusionMode: 'fast' } : {}),
  });
  const resolved = /** @type {any} */ (resolveSigmaParams(
    validated,
    Number(context.fullWidth ?? plan?.fullWidth ?? plan?.width ?? 1),
    Number(context.fullHeight ?? plan?.fullHeight ?? plan?.height ?? 1),
  ));
  return {
    ...resolved,
    threshold: thresholdLinear(resolved.threshold, resolved.thresholdUnits),
    backgroundThreshold: thresholdLinear(resolved.backgroundThreshold, resolved.thresholdUnits),
    thresholdUnits: 'linear',
  };
}

/** @param {any} plan @param {any} [context] */
export function createGraphCommandBuffer(plan, context = {}) {
  const commands = Array.isArray(plan?.commands)
    ? plan.commands
    : (plan?.enabled ?? []).map((/** @type {any} */ node, /** @type {number} */ index) => ({
        opcode: /** @type {any} */ (STAGE_OPCODES)[node.type] ?? 0,
        index,
        nodeId: node.id,
        nodeType: node.type,
        compositeMode: 'replacement',
        transientReads: [],
        transientWrites: [],
      }));
  if (commands.length > 0xffff) throw new RangeError('too many graph commands');
  const records = [];
  let paramsBytes = 0;
  let frameSlot = 0;
  for (const command of commands) {
    const node = (plan.enabled ?? []).find((/** @type {any} */ candidate) => candidate.id === command.nodeId);
    const inputSlot = frameSlot;
    // HP consumes Bloom's base frame.  Writing into the current frame is safe
    // pointwise and prevents ping-pong from overwriting that live base.
    const outputSlot = command.nodeType === 'highlightProtection' ? inputSlot : 1 - inputSlot;
    frameSlot = outputSlot;
    // Layout bindings are internal command metadata.  They are encoded in the
    // typed parameter object so the fixed v1 node record stays ABI-compatible;
    // native begin() validates the envelope and prepared nodes resolve these
    // offsets once, before the hot step loop.
    const binding = command.memoryLayout ?? plan?.physicalLayout?.bindings?.[records.length] ?? null;
    const encoded = encodeParams({
      ...commandParams(node, plan, context),
      mask: node?.mask ?? null,
      memoryLayout: binding ? {
        layoutHash: binding.layoutHash ?? plan?.physicalLayout?.layoutHash ?? null,
        nodeIndex: binding.nodeIndex,
        inputFrame: binding.inputFrame,
        outputFrame: binding.outputFrame,
        buffers: binding.buffers.map((/** @type {any} */ item) => ({
          alias: item.alias,
          slot: item.slot,
          offsetFloats: item.offsetFloats,
          lengthFloats: item.lengthFloats,
          inPlaceSafe: item.inPlaceSafe,
        })),
        transientReads: binding.transientReads,
        transientWrites: binding.transientWrites,
      } : null,
    });
    records.push({ command, encoded, paramsOffset: paramsBytes, inputSlot, outputSlot });
    paramsBytes += encoded.length;
    if (!Number.isSafeInteger(paramsBytes)) throw new RangeError('command params overflow');
  }
  const nodeTableOffset = COMMAND_HEADER_BYTES;
  const paramsOffset = nodeTableOffset + records.length * NODE_COMMAND_BYTES;
  const totalBytes = paramsOffset + paramsBytes;
  if (!Number.isSafeInteger(totalBytes) || totalBytes > 0xffffffff) throw new RangeError('command buffer overflow');
  const buffer = new ArrayBuffer(totalBytes);
  const view = new DataView(buffer);
  view.setUint32(0, COMMAND_MAGIC, true);
  view.setUint16(4, COMMAND_BUFFER_VERSION, true);
  view.setUint16(6, COMMAND_HEADER_BYTES, true);
  view.setUint32(8, u32(context.executorAbiVersion ?? EXECUTOR_ABI_VERSION), true);
  const [hashLo, hashHi] = hashParts(plan?.planHash ?? 0);
  view.setUint32(12, hashLo, true);
  view.setUint32(16, hashHi, true);
  // A RenderPlan describes the complete request, while one command executes
  // the current resident band. The active frame geometry must therefore win.
  view.setUint32(20, u32(context.width ?? plan?.width), true);
  view.setUint32(24, u32(context.height ?? plan?.height), true);
  view.setUint32(28, u32(plan?.fullWidth ?? context.fullWidth ?? plan?.width ?? context.width), true);
  view.setUint32(32, u32(plan?.fullHeight ?? context.fullHeight ?? plan?.height ?? context.height), true);
  view.setInt32(36, i32(context.originX ?? 0), true);
  view.setInt32(40, i32(context.originY ?? 0), true);
  view.setFloat32(44, f32(context.previewScale ?? plan?.previewScale ?? 1), true);
  view.setUint32(48, context.quality === 'fast' ? 0 : 1, true);
  view.setUint32(52, u32(context.effectiveSeed ?? context.seed ?? 0), true);
  const format = context.format ?? plan?.format;
  view.setUint32(56, u32(context.formatId ?? commandFormatId(format)), true);
  view.setUint32(60, u32(context.iso ?? format?.iso ?? 250), true);
  view.setUint32(64, records.length, true);
  view.setUint32(68, nodeTableOffset, true);
  view.setUint32(72, paramsOffset, true);
  view.setUint32(76, paramsBytes, true);
  records.forEach(({ command, encoded, paramsOffset: relative, inputSlot, outputSlot }, index) => {
    const offset = nodeTableOffset + index * NODE_COMMAND_BYTES;
    view.setUint16(offset, u32(command.opcode) & 0xffff, true);
    view.setUint16(offset + 2, 1, true);
    view.setUint32(offset + 4, u32(command.flags ?? 0), true);
    view.setUint32(offset + 8, fnv1aUtf8(String(command.nodeId ?? '')) >>> 0, true);
    view.setUint32(offset + 12, u32(command.inputSlot ?? inputSlot), true);
    view.setUint32(offset + 16, u32(command.outputSlot ?? outputSlot), true);
    view.setUint32(offset + 20, paramsOffset + relative, true);
    view.setUint32(offset + 24, encoded.length, true);
    let readMask = 0;
    for (const slot of command.transientReads ?? []) if (slot >= 0 && slot < 32) readMask |= (1 << slot);
    let writeMask = 0;
    for (const slot of command.transientWrites ?? []) if (slot >= 0 && slot < 32) writeMask |= (1 << slot);
    view.setUint32(offset + 28, readMask >>> 0, true);
    view.setUint32(offset + 32, writeMask >>> 0, true);
    new Uint8Array(buffer, paramsOffset + relative, encoded.length).set(encoded);
  });
  return new Uint8Array(buffer);
}

/** @param {Uint8Array|ArrayBuffer} bytes @returns {any} */
export function validateGraphCommandBuffer(bytes) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (data.byteLength < COMMAND_HEADER_BYTES) throw new RangeError(`command error ${COMMAND_ERRORS.ERR_BAD_LENGTH}`);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (view.getUint32(0, true) !== COMMAND_MAGIC) throw new Error(`command error ${COMMAND_ERRORS.ERR_INVALID_PLAN}`);
  if (view.getUint16(4, true) !== COMMAND_BUFFER_VERSION || view.getUint16(6, true) !== COMMAND_HEADER_BYTES) throw new Error(`command error ${COMMAND_ERRORS.ERR_INVALID_PLAN}`);
  if (view.getUint32(8, true) !== EXECUTOR_ABI_VERSION) throw new Error(`command error ${COMMAND_ERRORS.ERR_ABI_VERSION}`);
  const nodeCount = view.getUint32(64, true);
  const nodeOffset = view.getUint32(68, true);
  const paramsOffset = view.getUint32(72, true);
  const paramsBytes = view.getUint32(76, true);
  /** @param {number} offset @param {number} length */
  const checked = (offset, length) => Number.isSafeInteger(offset) && Number.isSafeInteger(length) && offset >= 0 && length >= 0 && offset <= data.byteLength && length <= data.byteLength - offset;
  if (nodeCount > 0xffff || nodeOffset !== COMMAND_HEADER_BYTES) throw new Error(`command error ${COMMAND_ERRORS.ERR_INVALID_PLAN}`);
  const nodeBytes = nodeCount * NODE_COMMAND_BYTES;
  const nodeEnd = nodeOffset + nodeBytes;
  if (!Number.isSafeInteger(nodeEnd) || paramsOffset < nodeEnd || !checked(nodeOffset, nodeBytes) || !checked(paramsOffset, paramsBytes)) throw new RangeError(`command error ${COMMAND_ERRORS.ERR_CAPACITY}`);
  if (view.getUint32(48, true) > 1 || view.getUint32(56, true) > 4) throw new Error(`command error ${COMMAND_ERRORS.ERR_INVALID_PLAN}`);
  const nodes = [];
  for (let index = 0; index < nodeCount; index += 1) {
    const offset = nodeOffset + index * NODE_COMMAND_BYTES;
    const opcode = view.getUint16(offset, true);
    const recordVersion = view.getUint16(offset + 2, true);
    const recordParamsOffset = view.getUint32(offset + 20, true);
    const recordParamsBytes = view.getUint32(offset + 24, true);
    const flags = view.getUint32(offset + 4, true);
    const inputSlot = view.getUint32(offset + 12, true);
    const outputSlot = view.getUint32(offset + 16, true);
    const transientReadMask = view.getUint32(offset + 28, true);
    const transientWriteMask = view.getUint32(offset + 32, true);
    if (!(/** @type {number[]} */ (Object.values(STAGE_OPCODES))).includes(opcode) || recordVersion !== 1) throw new Error(`command error ${COMMAND_ERRORS.ERR_UNSUPPORTED_NODE}`);
    if (flags !== 0 || inputSlot > 1 || outputSlot > 1) throw new Error(`command error ${COMMAND_ERRORS.ERR_INVALID_PLAN}`);
    if ((transientReadMask & ~0x0f) !== 0 || (transientWriteMask & ~0x0f) !== 0) throw new Error(`command error ${COMMAND_ERRORS.ERR_INVALID_PLAN}`);
    if (opcode === STAGE_OPCODES.bloom) {
      if (transientReadMask !== 0 || transientWriteMask !== 0x03 || inputSlot === outputSlot) throw new Error(`command error ${COMMAND_ERRORS.ERR_INVALID_PLAN}`);
    } else if (opcode === STAGE_OPCODES.highlightProtection) {
      if (transientReadMask !== 0x03 || transientWriteMask !== 0 || inputSlot !== outputSlot) throw new Error(`command error ${COMMAND_ERRORS.ERR_INVALID_PLAN}`);
    } else if (transientReadMask !== 0 || transientWriteMask !== 0 || inputSlot === outputSlot) {
      throw new Error(`command error ${COMMAND_ERRORS.ERR_INVALID_PLAN}`);
    }
    if (recordParamsOffset < paramsOffset || recordParamsOffset + recordParamsBytes > paramsOffset + paramsBytes || !checked(recordParamsOffset, recordParamsBytes)) throw new RangeError(`command error ${COMMAND_ERRORS.ERR_CAPACITY}`);
    nodes.push({ opcode, recordVersion, flags, nodeIdHash: view.getUint32(offset + 8, true), inputSlot, outputSlot, paramsOffset: recordParamsOffset, paramsBytes: recordParamsBytes, transientReadMask, transientWriteMask });
  }
  if (!Number.isFinite(view.getFloat32(44, true)) || view.getFloat32(44, true) <= 0) throw new Error(`command error ${COMMAND_ERRORS.ERR_NONFINITE_PARAM}`);
  return { header: { magic: COMMAND_MAGIC, commandVersion: COMMAND_BUFFER_VERSION, headerBytes: COMMAND_HEADER_BYTES, executorAbiVersion: view.getUint32(8, true), planHashLo: view.getUint32(12, true), planHashHi: view.getUint32(16, true), width: view.getUint32(20, true), height: view.getUint32(24, true), fullWidth: view.getUint32(28, true), fullHeight: view.getUint32(32, true), originX: view.getInt32(36, true), originY: view.getInt32(40, true), previewScale: view.getFloat32(44, true), quality: view.getUint32(48, true), effectiveSeed: view.getUint32(52, true), formatId: view.getUint32(56, true), iso: view.getUint32(60, true), nodeCount, nodeTableOffset: nodeOffset, paramsOffset, paramsBytes }, nodes };
}

export { encodeParams };
