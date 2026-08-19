/** Pure output shoulder used before 8/16-bit quantization and PNG preview. */

/**
 * Compress highlights toward 1 with a C1-continuous knee.
 * rolloff=0 is identity; rolloff>0 starts the shoulder at 1-rolloff/2.
 * @param {number} value
 * @param {number} rolloff
 */
export function outputKnee(value, rolloff) {
  if (rolloff <= 0 || value <= 0) return value;
  const start = 1 - 0.5 * Math.min(1, rolloff);
  if (value <= start) return value;
  const span = Math.max(1e-6, 1 - start);
  const x = (value - start) / span;
  return start + span * (x / (1 + x));
}

/**
 * Apply the same shoulder in place.
 * @param {Float32Array} rgb
 * @param {number} rolloff
 */
export function applyRolloff(rgb, rolloff) {
  if (!(rolloff > 0)) return rgb;
  for (let i = 0; i < rgb.length; i++) rgb[i] = outputKnee(rgb[i], rolloff);
  return rgb;
}
