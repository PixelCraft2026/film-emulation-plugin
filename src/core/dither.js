/** Deterministic 64×64 blue-noise-shaped rank tile for 8/16-bit quantization. */
const SIZE = 64;
const MASK = SIZE - 1;

/** @param {number} x @param {number} y */
function hash01(x, y) {
  let value = Math.imul(x + 0x51ed270b, 0x85ebca6b) ^ Math.imul(y + 0x68bc21eb, 0xc2b2ae35);
  value ^= value >>> 16;
  value = Math.imul(value, 0x7feb352d);
  value ^= value >>> 15;
  return (value >>> 0) / 0x100000000;
}

function buildTile() {
  const scored = [];
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      let neighbours = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          neighbours += hash01((x + dx) & MASK, (y + dy) & MASK);
        }
      }
      scored.push({ index: y * SIZE + x, score: hash01(x, y) - neighbours / 8 });
    }
  }
  scored.sort((a, b) => a.score - b.score || a.index - b.index);
  const tile = new Float32Array(SIZE * SIZE);
  for (let rank = 0; rank < scored.length; rank++) {
    tile[scored[rank].index] = (rank + 0.5) / scored.length - 0.5;
  }
  return tile;
}

const TILE = buildTile();

/**
 * Return deterministic, zero-mean noise in [-0.5, 0.5) LSB.
 * @param {number} index Absolute pixel index.
 * @param {number} width Full output width.
 * @param {number} [channel]
 * @param {number} [seed]
 */
export function blueNoise(index, width, channel = 0, seed = 0x46534c4d) {
  const safeWidth = Math.max(1, Math.floor(width));
  const x0 = index % safeWidth;
  const y0 = Math.floor(index / safeWidth);
  const sx = (seed ^ Math.imul(channel + 1, 0x9e3779b1)) >>> 0;
  const sy = ((seed >>> 8) ^ Math.imul(channel + 3, 0x85ebca6b)) >>> 0;
  // Channel-dependent rotation and offsets avoid correlated RGB quantization.
  const x = channel === 1 ? y0 : channel === 2 ? x0 + y0 : x0;
  const y = channel === 1 ? -x0 : channel === 2 ? y0 - x0 : y0;
  return TILE[((y + sy) & MASK) * SIZE + ((x + sx) & MASK)];
}

export const BLUE_NOISE_SIZE = SIZE;
