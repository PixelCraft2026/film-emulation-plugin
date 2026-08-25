/** Deterministic, host-independent random primitives used by Film Grain. */

const UINT32_SCALE = 1 / 0x1_0000_0000;
const GOLDEN_RATIO = 0x9e3779b9;

/** @param {any} value */
function u32(value) {
  return Number(value) >>> 0;
}

/** MurmurHash3 fmix32 finalizer. */
/** @param {any} value */
export function fmix32(value) {
  let h = u32(value);
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** UTF-8 FNV-1a without relying on TextEncoder in UXP. */
/** @param {any} value */
export function fnv1aUtf8(value) {
  const text = String(value);
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    let cp = text.charCodeAt(i);
    if (cp >= 0xd800 && cp <= 0xdbff) {
      const low = text.charCodeAt(i + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        cp = 0x10000 + ((cp - 0xd800) << 10) + low - 0xdc00;
        i++;
      } else {
        cp = 0xfffd;
      }
    } else if (cp >= 0xdc00 && cp <= 0xdfff) {
      cp = 0xfffd;
    }
    const bytes = cp <= 0x7f
      ? [cp]
      : cp <= 0x7ff
        ? [0xc0 | (cp >>> 6), 0x80 | (cp & 0x3f)]
        : cp <= 0xffff
          ? [0xe0 | (cp >>> 12), 0x80 | ((cp >>> 6) & 0x3f), 0x80 | (cp & 0x3f)]
          : [0xf0 | (cp >>> 18), 0x80 | ((cp >>> 12) & 0x3f), 0x80 | ((cp >>> 6) & 0x3f), 0x80 | (cp & 0x3f)];
    for (const byte of bytes) {
      hash ^= byte;
      hash = Math.imul(hash, 0x01000193);
    }
  }
  return hash >>> 0;
}

/**
 * Hash a complete coordinate tuple.  Every word is mixed in sequence so the
 * JS and Rust implementations can share the exact same low-level contract.
 */
/** @param {any} seed @param {any} nodeHash @param {any} absoluteX @param {any} absoluteY @param {any} scaleIndex @param {any} channelIndex @param {any} [sampleIndex=0] */
export function hash32(seed, nodeHash, absoluteX, absoluteY, scaleIndex, channelIndex, sampleIndex = 0) {
  let h = fmix32(u32(seed) ^ GOLDEN_RATIO);
  const words = [
    u32(nodeHash),
    u32(absoluteX),
    u32(absoluteY),
    u32(scaleIndex),
    u32(channelIndex),
    u32(sampleIndex),
  ];
  for (const word of words) h = fmix32(h ^ word);
  return h >>> 0;
}

/** @param {any} hash */
export function uniformFromHash(hash) {
  return hash * UINT32_SCALE;
}

/** Twelve-uniform zero-mean Gaussian approximation, intentionally no Box-Muller. */
/** @param {any} seed @param {any} nodeHash @param {any} absoluteX @param {any} absoluteY @param {any} scaleIndex @param {any} channelIndex */
export function gaussianApprox(seed, nodeHash, absoluteX, absoluteY, scaleIndex, channelIndex) {
  // The first five tuple words are shared by all twelve samples.  Reusing the
  // mixed prefix preserves hash32 bit-for-bit while avoiding 55 redundant
  // fmix32 calls per output sample (important for the JS fallback).
  let prefix = fmix32(u32(seed) ^ GOLDEN_RATIO);
  prefix = fmix32(prefix ^ u32(nodeHash));
  prefix = fmix32(prefix ^ u32(absoluteX));
  prefix = fmix32(prefix ^ u32(absoluteY));
  prefix = fmix32(prefix ^ u32(scaleIndex));
  const channelPrefix = fmix32(prefix ^ u32(channelIndex));
  let sum = 0;
  for (let sample = 0; sample < 12; sample++) {
    sum = Math.fround(sum + uniformFromHash(fmix32(channelPrefix ^ sample)));
  }
  return Math.fround(sum - 6);
}

/** Deterministic fallback for UXP hosts without Web Crypto. */
/** @param {any} previousSeed @param {any} fingerprint @param {any} nodeId */
export function deriveSeed(previousSeed, fingerprint, nodeId) {
  return fmix32(
    u32(previousSeed) ^
    fnv1aUtf8(String(fingerprint ?? '')) ^
    fnv1aUtf8(String(nodeId ?? '')) ^
    GOLDEN_RATIO,
  );
}

export const SEED_GOLDEN_RATIO = GOLDEN_RATIO;
