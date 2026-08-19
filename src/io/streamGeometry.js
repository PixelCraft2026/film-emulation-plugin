// @ts-nocheck
import { resolveSigmaParams, lowResScale, psfLobesFor } from '../core/index.js';
import { splitBands } from './tiles.js';

/** Pure row-band geometry shared by UXP rendering and Node benchmarks. */
export function streamGeometry(width, height, params) {
  const resolved = resolveSigmaParams(params, width, height);
  const maxRatio = Math.max(...resolved.sigmaRatio);
  const [, tail] = psfLobesFor(resolved);
  const localSigma = resolved.sigma * maxRatio * tail.sigmaRatio;
  const globalSigma = resolved.globalDiffusion > 0 ? Math.max(12, resolved.sigma * 4) : 0;
  const support = Math.max(localSigma, globalSigma);
  const scale = lowResScale(resolved, resolved.sigma * maxRatio);
  const rawOverlap = Math.max(35, Math.ceil(5 * support));
  const overlap = scale > 1 ? Math.ceil(rawOverlap / scale) * scale : rawOverlap;
  const rawBand = Math.max(384, overlap * 2);
  const bandHeight = scale > 1 ? Math.ceil(rawBand / scale) * scale : rawBand;
  return { params: resolved, overlap, bandHeight, bands: splitBands(width, height, bandHeight, overlap) };
}
