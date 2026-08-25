// @ts-nocheck
import {
  resolveSigmaParams,
  lowResScale,
  psfLobesFor,
  normalizeEffectGraph,
  getEffectDefinition,
} from '../core/index.js';
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

/** Graph-aware preflight and row-band plan for the V1.6 renderer. */
export function streamFilmGeometry(width, height, document, options = {}) {
  const graph = normalizeEffectGraph(document?.graph);
  const componentSize = Number(options.componentSize ?? 16);
  const quality = options.quality ?? 'quality';
  const format = document.format;
  const fullWidth = options.fullWidth ?? width;
  const fullHeight = options.fullHeight ?? height;
  const previewScale = options.previewScale ?? 1;
  const enabled = graph.filter((node) => node.enabled !== false);
  const overlap = Math.max(0, ...enabled.map((node) => getEffectDefinition(node.type).supportRadius(
    node.params,
    { fullWidth, fullHeight, previewScale, quality, format },
  )));
  const halation = enabled.find((node) => node.type === 'halation');
  const halationParams = halation ? resolveSigmaParams(halation.params, fullWidth, fullHeight) : null;
  const phaseScale = halationParams
    ? lowResScale(halationParams, halationParams.sigma * Math.max(...halationParams.sigmaRatio))
    : 1;
  const alignedOverlap = Math.ceil(overlap / phaseScale) * phaseScale;
  const baseBytes = estimateHighMemoryBytes(width, height, componentSize);
  // Nodes execute sequentially.  `baseBytes` is already the complete legacy
  // render envelope (I/O, canonical frames and WASM capacity), so adding a
  // later node's whole scratch set double-counts buffers that cease to be live
  // after Halation.  Keep an explicit stage estimate and take the larger peak.
  const sequentialScratchBytes = Math.max(0, ...enabled
    .filter((node) => node.type !== 'halation')
    .map((node) => getEffectDefinition(node.type).estimateMemory({ width, height }, node.params)));
  const pixels = width * height;
  const componentBytes = componentSize === 32 ? 4 : componentSize === 8 ? 1 : 2;
  const ioBytes = pixels * 4 * componentBytes * 2;
  const canonicalAndWasmBytes = pixels * 4 * 10;
  const estimatedStageBytes = Math.ceil(ioBytes + canonicalAndWasmBytes + sequentialScratchBytes);
  const estimatedBytes = Math.max(baseBytes, estimatedStageBytes);
  const deviceMemoryGB = Math.max(0, Number(options.deviceMemoryGB ?? 0));
  const budgetBytes = Math.floor((deviceMemoryGB >= 24 ? 6 : deviceMemoryGB >= 16 ? 4 : 1.5) * 1024 ** 3);
  const hardBudgetBytes = Math.floor((deviceMemoryGB >= 24 ? 2.5 : 1.5) * 1024 ** 3);
  const requestedMode = options.memoryMode ?? 'auto';
  const highMemory = requestedMode === 'high'
    || (requestedMode === 'auto' && estimatedBytes <= budgetBytes * 0.82);
  const minimumBandHeight = 64;
  const bandBytesPerPixel = 4 * 20;
  const safetyMargin = 1.15;
  const usableBandBytes = Math.min(budgetBytes * 0.55, hardBudgetBytes / safetyMargin);
  const maxRowsWithOverlap = Math.max(
    minimumBandHeight + 2 * alignedOverlap,
    Math.floor(usableBandBytes / Math.max(1, width * bandBytesPerPixel)),
  );
  const maxSafeBandHeight = Math.max(minimumBandHeight, maxRowsWithOverlap - 2 * alignedOverlap);
  let bandHeight = Math.min(height, maxSafeBandHeight);
  bandHeight = Math.max(minimumBandHeight, Math.floor(bandHeight / phaseScale) * phaseScale);
  if (highMemory) bandHeight = height;
  const bands = splitBands(width, height, bandHeight, highMemory ? 0 : alignedOverlap);
  const estimatedBandBytes = Math.ceil(width * Math.min(height, bandHeight + alignedOverlap * 2) * bandBytesPerPixel);
  const hardBudgetExceeded = highMemory
    ? estimatedBytes * safetyMargin > budgetBytes
    : estimatedBandBytes * safetyMargin > hardBudgetBytes;
  return {
    document,
    graph,
    params: graph.find((node) => node.type === 'halation')?.params,
    overlap: highMemory ? 0 : alignedOverlap,
    bandHeight,
    bands,
    memoryMode: highMemory ? 'high' : 'balanced',
    estimatedBytes,
    estimatedStageBytes,
    estimatedBandBytes,
    budgetBytes,
    hardBudgetBytes,
    hardBudgetExceeded,
    quality,
    fullWidth,
    fullHeight,
    previewScale,
    phaseScale,
    safetyMargin,
  };
}
