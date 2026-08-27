// @ts-check
/**
 * Deterministic typed-array arena used by the V1.6 planner and executors.
 *
 * The arena deliberately owns only Float32Array storage.  Host pixel buffers
 * and WASM linear memory have different lifetimes and are reported separately
 * by RenderPlan/RenderStats.  A slot can be reused only after release(), and
 * acquire() never clears a reused slot; callers must initialise every sample
 * before reading it.
 */

/** @param {any} length */
function normalizeLength(length) {
  const value = Number(length);
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`BufferArena length must be a non-negative integer, got ${length}`);
  return value;
}

export class BufferArena {
  /** @param {any} [options] */
  constructor(options = {}) {
    /** @type {boolean} */
    this.debug = options.debug === true;
    /** @type {any[]} */
    this.slots = [];
    this.active = new Map();
    this.nextId = 1;
    this.peakBytes = 0;
    this.allocatedBytes = 0;
    this.reusedCount = 0;
    this.allocCount = 0;
  }

  /** @param {number} length @param {string} [tag] */
  acquire(length, tag = 'anonymous') {
    const wanted = normalizeLength(length);
    let slot = this.slots.find((candidate) => !candidate.inUse && candidate.length >= wanted);
    if (slot) {
      slot.inUse = true;
      slot.tag = String(tag);
      this.reusedCount += 1;
    } else {
      slot = {
        id: this.nextId++,
        generation: 0,
        length: wanted,
        bytes: wanted * Float32Array.BYTES_PER_ELEMENT,
        array: new Float32Array(wanted),
        inUse: true,
        tag: String(tag),
      };
      this.slots.push(slot);
      this.allocatedBytes += slot.bytes;
      this.peakBytes = Math.max(this.peakBytes, this.allocatedBytes);
      this.allocCount += 1;
    }
    slot.generation += 1;
    const currentHandle = Object.freeze({ id: slot.id, generation: slot.generation, length: wanted, tag: slot.tag });
    this.active.set(currentHandle.id, slot);
    return { handle: currentHandle, array: slot.array.subarray(0, wanted) };
  }

  /** @param {{id:number,generation:number}} handle */
  release(handle) {
    const slot = handle && this.active.get(handle.id);
    if (!slot || slot.generation !== handle.generation) throw new Error('BufferArena release received an unknown or already released handle');
    slot.inUse = false;
    slot.tag = '';
    this.active.delete(handle.id);
  }

  /** Release every live handle; useful on cancellation/error paths. */
  reset() {
    for (const slot of this.slots) slot.inUse = false;
    this.active.clear();
  }

  dispose() {
    this.reset();
    this.slots.length = 0;
    this.allocatedBytes = 0;
    this.peakBytes = 0;
  }

  stats() {
    return Object.freeze({
      allocatedBytes: this.allocatedBytes,
      peakBytes: this.peakBytes,
      slotCount: this.slots.length,
      activeCount: this.active.size,
      allocCount: this.allocCount,
      reusedCount: this.reusedCount,
    });
  }
}

/** Allocate through a request arena when one is present. */
/** @param {any} context @param {number} length @param {string} [tag] */
export function allocateF32(context, length, tag) {
  if (context?.arena instanceof BufferArena) return context.arena.acquire(length, tag).array;
  return new Float32Array(normalizeLength(length));
}

/** Return an explicit ownership token for scratch buffers. */
/** @param {any} context @param {number} length @param {string} [tag] */
export function acquireF32(context, length, tag) {
  if (context?.arena instanceof BufferArena) return context.arena.acquire(length, tag);
  return { handle: null, array: new Float32Array(normalizeLength(length)) };
}

/** @param {any} context @param {{handle:any}|null|undefined} token */
export function releaseF32(context, token) {
  if (token?.handle && context?.arena instanceof BufferArena) context.arena.release(token.handle);
}
