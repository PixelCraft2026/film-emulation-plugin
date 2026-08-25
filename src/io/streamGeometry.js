// @ts-nocheck
import { resolveSigmaParams, lowResScale, psfLobesFor } from '../core/index.js';
import { splitBands } from './tiles.js';

/** Conservative peak working-set estimate for the full-image JS/WASM pipeline. */
export function estimateHighMemoryBytes(width, height, componentSize = 16) {
  const bytesPerPixel = componentSize === 32 ? 152 : componentSize === 8 ? 132 : 136;
  return Math.ceil(width * height * bytesPerPixel);
}

/** Pure row-band geometry shared by UXP rendering and Node benchmarks. */
export function streamGeometry(width, height, params, options = {}) {
  const resolved = resolveSigmaParams(params, width, height);
  const maxRatio = Math.max(...resolved.sigmaRatio);
  const lobes = psfLobesFor(resolved, 'red');
  const tail = lobes[lobes.length - 1];
  const localSigma = resolved.sigma * maxRatio * tail.sigmaRatio;
  const growSigma = resolved.sourceExpansion > 0
    ? resolved.sigma * (0.45 + 0.85 * resolved.sourceExpansion)
    : 0;
  const globalSigma = resolved.globalDiffusion > 0 ? Math.max(12, resolved.sigma * 4) : 0;
  const support = Math.max(localSigma, globalSigma, growSigma);
  const scale = lowResScale(resolved, resolved.sigma * maxRatio);
  const rawOverlap = Math.max(35, Math.ceil(5 * support));
  const overlap = scale > 1 ? Math.ceil(rawOverlap / scale) * scale : rawOverlap;
  const rawBand = Math.max(384, overlap * 2);
  const bandHeight = scale > 1 ? Math.ceil(rawBand / scale) * scale : rawBand;
  const componentSize = Number(options.componentSize ?? 16);
  const estimatedBytes = estimateHighMemoryBytes(width, height, componentSize);
  const deviceMemoryGB = Math.max(0, Number(options.deviceMemoryGB ?? 0));
  // navigator.deviceMemory is not guaranteed in UXP. Unknown-memory hosts receive a
  // conservative 1.5GB budget, still allowing common 8MP files to avoid redundant bands.
  const budgetBytes = Math.floor((deviceMemoryGB >= 24 ? 6 : deviceMemoryGB >= 16 ? 4 : 1.5) * 1024 ** 3);
  const requestedMode = options.memoryMode ?? 'auto';
  const highMemory = requestedMode === 'high'
    || (requestedMode === 'auto' && estimatedBytes <= budgetBytes * 0.82);
  if (highMemory) {
    return {
      params: resolved,
      overlap: 0,
      bandHeight: height,
      bands: splitBands(width, height, height, 0),
      memoryMode: 'high',
      estimatedBytes,
      budgetBytes,
    };
  }
  return {
    params: resolved,
    overlap,
    bandHeight,
    bands: splitBands(width, height, bandHeight, overlap),
    memoryMode: 'balanced',
    estimatedBytes,
    budgetBytes,
  };
}
