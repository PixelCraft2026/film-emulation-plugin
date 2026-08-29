// @ts-nocheck
/** Host row-band renderer: keeps 24MP 16-bit peak memory below a whole-float-image pipeline. */
import { processTiledWithTrc, processFilmBandWithTrcAsync } from './tileRender.js';
import { readDocumentPixels, encodeDisplayRgbaBuffer, writeDocumentRgbaBuffer } from './imageAccess.js';
import { streamGeometry, streamFilmGeometry } from './streamGeometry.js';
import { normalizeComponentSize } from './bitDepth.js';
import { documentProfileName, resolvePixelTRC } from './colorPipeline.js';
import { BufferArena, FILM_GRAPH_VERSION, createFilmExecutor, createV17ResidentBackend } from '../core/index.js';
export { streamGeometry, streamFilmGeometry } from './streamGeometry.js';
const nowMs = () => globalThis.performance?.now?.() ?? Date.now();

async function yieldRenderControl(signal) {
  if (signal?.aborted) throw new Error('Film render cancelled');
  if (typeof globalThis.setTimeout === 'function') await new Promise((resolve) => globalThis.setTimeout(resolve, 0));
  else await Promise.resolve();
  if (signal?.aborted) throw new Error('Film render cancelled');
}

function addTimings(target, source) {
  if (!source) return;
  for (const [key, value] of Object.entries(source)) target[key] = (target[key] ?? 0) + value;
}

/**
 * Read source bands, render them, quantize directly into one final RGBA buffer, then perform
 * exactly one target putPixels. The Photoshop source layer is read-only throughout.
 */
export async function renderDocumentToLayer(doc, sourceLayer, targetLayer, sourceBounds, targetBounds, params, trc, options = {}) {
  const totalStarted = nowMs();
  const timings = { readMs: 0, processMs: 0, quantizeMs: 0, writeMs: 0 };
  const algorithmTimings = {};
  const width = sourceBounds.right - sourceBounds.left;
  const height = sourceBounds.bottom - sourceBounds.top;
  if (targetBounds.right - targetBounds.left !== width || targetBounds.bottom - targetBounds.top !== height) {
    throw new Error('Safe copy bounds do not match source bounds');
  }
  const componentSize = normalizeComponentSize(options.componentSize ?? doc.bitsPerChannel);
  const output = componentSize === 8 ? new Uint8Array(width * height * 4) : componentSize === 16 ? new Uint16Array(width * height * 4) : new Float32Array(width * height * 4);
  const deviceMemoryGB = Number(options.deviceMemoryGB ?? globalThis.navigator?.deviceMemory ?? 0);
  const geometry = streamGeometry(width, height, params, {
    componentSize,
    deviceMemoryGB,
    memoryMode: options.memoryMode ?? 'auto',
  });
  let pixelProfile = '';
  let outputTrc = null;
  for (let bandIndex = 0; bandIndex < geometry.bands.length; bandIndex++) {
    if (options.signal?.aborted) throw new Error('Film render cancelled');
    const band = geometry.bands[bandIndex];
    const bandBounds = {
      left: sourceBounds.left,
      top: sourceBounds.top + band.start,
      right: sourceBounds.right,
      bottom: sourceBounds.top + band.end,
    };
    let started = nowMs();
    const source = await readDocumentPixels(doc, {
      // Native-depth reads preserve the document encoding. Forcing a 16-bit
      // document to componentSize 32 can make Photoshop return Linear Profile
      // pixels, which must not be decoded again as gamma-encoded Rec.2020.
      componentSize,
      layerID: sourceLayer.id,
      layerName: sourceLayer.name,
      bounds: bandBounds,
    });
    timings.readMs += nowMs() - started;
    const sourceTrc = resolvePixelTRC(doc, source.colorProfile);
    const bandProfile = String(source.colorProfile || documentProfileName(doc)).trim();
    if (!outputTrc) {
      outputTrc = sourceTrc;
      pixelProfile = bandProfile;
      console.log(`[film-emulation] Apply pixel profile: "${pixelProfile || 'document default'}" (${sourceTrc.profileKey})`);
    } else if (bandProfile && pixelProfile && bandProfile !== pixelProfile) {
      throw new Error(`Imaging API changed color profile between bands: "${pixelProfile}" vs "${bandProfile}"`);
    }
    started = nowMs();
    const rendered = processTiledWithTrc(source, geometry.params, sourceTrc, {
      tileThreshold: Number.MAX_SAFE_INTEGER,
      // Keep the rendered buffer in the exact profile returned by getPixels.
      // Declaring a different Rec.2020 profile on write makes Photoshop perform
      // another conversion and changes the base image even at strength=0.
      outputTrc: sourceTrc,
      profileTimings: true,
    });
    timings.processMs += nowMs() - started;
    addTimings(algorithmTimings, rendered.timings);
    started = nowMs();
    const encoded = encodeDisplayRgbaBuffer(rendered, componentSize, {
      rolloff: geometry.params.rolloff,
      dither: componentSize !== 32,
      seed: options.seed ?? 0x46534c4d,
      pixelOffset: band.start * width,
    });
    const sourceRow = (band.y0 - band.start) * width * 4;
    const targetRow = band.y0 * width * 4;
    const values = (band.y1 - band.y0) * width * 4;
    output.set(encoded.subarray(sourceRow, sourceRow + values), targetRow);
    timings.quantizeMs += nowMs() - started;
    options.onProgress?.((bandIndex + 1) / geometry.bands.length);
    await yieldRenderControl(options.signal);
  }
  const writeStarted = nowMs();
  await writeDocumentRgbaBuffer(doc, { width, height, buffer: output }, {
    componentSize,
    layerID: targetLayer.id,
    layerName: targetLayer.name,
    bounds: targetBounds,
    // The buffer remains in the document pixel space returned by getPixels.
    // Leave the image-data profile empty so putPixels adopts the target
    // document profile. Some returned labels are not accepted by
    // createImageDataFromBuffer and produce Photoshop error -26120.
    colorProfile: '',
  });
  timings.writeMs = nowMs() - writeStarted;
  timings.totalMs = nowMs() - totalStarted;
  console.log('[film-emulation] Apply timing', {
    memoryMode: geometry.memoryMode,
    bands: geometry.bands.length,
    timings,
    algorithmTimings,
  });
  return {
    width,
    height,
    bands: geometry.bands.length,
    memoryMode: geometry.memoryMode,
    estimatedWorkingBytes: geometry.estimatedBytes,
    outputBytes: output.byteLength,
    colorProfile: pixelProfile,
    timings,
    algorithmTimings,
  };
}

/** V1.6 graph-aware Apply path. It keeps the one-final-putPixels invariant. */
export async function renderFilmDocumentToLayer(doc, sourceLayer, targetLayer, sourceBounds, targetBounds, document, trc, options = {}) {
  const totalStarted = nowMs();
  const timings = { readMs: 0, processMs: 0, quantizeMs: 0, writeMs: 0 };
  const algorithmTimings = {};
  const renderStats = {
    planHash: null,
    graphHash: null,
    backend: options.backend ?? 'auto',
    memory: null,
    copies: { inputBytes: 0, outputBytes: 0, count: 0 },
    passes: { fullPixelPasses: 0, perNode: {} },
    timings: { total: 0, read: 0, process: 0, quantize: 0, write: 0, perNode: {}, perStage: {} },
    fallback: null,
  };
  const width = sourceBounds.right - sourceBounds.left;
  const height = sourceBounds.bottom - sourceBounds.top;
  const fullWidth = Number(doc.width ?? width);
  const fullHeight = Number(doc.height ?? height);
  if (targetBounds.right - targetBounds.left !== width || targetBounds.bottom - targetBounds.top !== height) throw new Error('Safe copy bounds do not match source bounds');
  const componentSize = normalizeComponentSize(options.componentSize ?? doc.bitsPerChannel);
  const output = componentSize === 8 ? new Uint8Array(width * height * 4) : componentSize === 16 ? new Uint16Array(width * height * 4) : new Float32Array(width * height * 4);
  const geometry = streamFilmGeometry(width, height, document, {
    componentSize,
    fullWidth,
    fullHeight,
    deviceMemoryGB: Number(options.deviceMemoryGB ?? globalThis.navigator?.deviceMemory ?? 0),
    memoryMode: options.memoryMode ?? 'auto',
    quality: options.quality ?? 'quality',
  });
  if (geometry.hardBudgetExceeded) throw new Error(`Film render exceeds the ${Math.round(geometry.hardBudgetBytes / 1024 ** 3)} GiB hard memory budget; reduce document size or choose a lower-memory mode.`);
  let pixelProfile = '';
  let outputTrc = null;
  const arena = options.arena ?? new BufferArena({ debug: options.debugArena === true });
  const ownsArena = !options.arena;
  const residentBackend = options.residentBackend ?? createV17ResidentBackend(geometry.plan);
  const executor = options.executor ?? createFilmExecutor(geometry.plan, {
    arena,
    backend: options.backend ?? 'auto',
    residentBackend,
    gpuBackend: options.gpuBackend,
    allowExperimentalGpu: options.allowExperimentalGpu === true,
    debug: options.debugArena === true,
  });
  const ownsExecutor = !options.executor;
  const seed = options.seed ?? document.graph.find((node) => node.type === 'grain')?.params.seed ?? 0;
  const halation = document.graph.find((node) => node.type === 'halation');
  try {
    for (let bandIndex = 0; bandIndex < geometry.bands.length; bandIndex++) {
    if (options.signal?.aborted) throw new Error('Film render cancelled');
    const band = geometry.bands[bandIndex];
    const bandBounds = { left: sourceBounds.left, top: sourceBounds.top + band.start, right: sourceBounds.right, bottom: sourceBounds.top + band.end };
    let started = nowMs();
    const source = await readDocumentPixels(doc, { componentSize, layerID: sourceLayer.id, layerName: sourceLayer.name, bounds: bandBounds });
    timings.readMs += nowMs() - started;
    const sourceTrc = resolvePixelTRC(doc, source.colorProfile);
    const bandProfile = String(source.colorProfile || documentProfileName(doc)).trim();
    if (!outputTrc) { outputTrc = sourceTrc; pixelProfile = bandProfile; }
    else if (bandProfile && pixelProfile && bandProfile !== pixelProfile) throw new Error(`Imaging API changed color profile between bands: "${pixelProfile}" vs "${bandProfile}"`);
    started = nowMs();
    const rendered = await processFilmBandWithTrcAsync(source, document, sourceTrc, {
      tileThreshold: Number.MAX_SAFE_INTEGER,
      outputTrc: sourceTrc,
      fullWidth,
      fullHeight,
      originX: sourceBounds.left,
      originY: sourceBounds.top + band.start,
      quality: geometry.quality,
      seed,
      signal: options.signal,
      profileTimings: true,
      renderPlan: geometry.plan,
      backend: options.backend ?? 'auto',
      memoryMode: geometry.memoryMode,
      deviceMemoryGB: Number(options.deviceMemoryGB ?? globalThis.navigator?.deviceMemory ?? 0),
      componentSize,
      arena,
      executor,
      outputRows: {
        start: band.y0 - band.start,
        end: band.y1 - band.start,
      },
      intent: 'apply',
      yieldIntervalMs: 50,
    });
    const stats = rendered.stats;
    if (stats) {
      renderStats.engineVersion = stats.engineVersion ?? renderStats.engineVersion;
      renderStats.planHash = stats.planHash ?? renderStats.planHash;
      renderStats.graphHash = stats.graphHash ?? renderStats.graphHash;
      renderStats.backend = stats.backend ?? renderStats.backend;
      renderStats.memory = stats.memory ?? renderStats.memory;
      renderStats.copies.inputBytes += stats.copies?.inputBytes ?? 0;
      renderStats.copies.outputBytes += stats.copies?.outputBytes ?? 0;
      renderStats.copies.count += stats.copies?.count ?? 0;
      renderStats.passes.fullPixelPasses += stats.passes?.fullPixelPasses ?? 0;
      for (const [id, value] of Object.entries(stats.passes?.perNode ?? {})) renderStats.passes.perNode[id] = (renderStats.passes.perNode[id] ?? 0) + value;
      for (const [id, value] of Object.entries(stats.timings?.perNode ?? {})) renderStats.timings.perNode[id] = (renderStats.timings.perNode[id] ?? 0) + value;
      for (const [stage, value] of Object.entries(stats.timings?.perStage ?? {})) renderStats.timings.perStage[stage] = (renderStats.timings.perStage[stage] ?? 0) + value;
      if (stats.fallback) renderStats.fallback = stats.fallback;
    }
    timings.processMs += nowMs() - started;
    addTimings(algorithmTimings, rendered.timings);
    started = nowMs();
    const encoded = encodeDisplayRgbaBuffer(rendered, componentSize, {
      rolloff: halation?.params?.rolloff ?? 0,
      dither: componentSize !== 32,
      seed: options.seed ?? 0x46534c4d,
      pixelOffset: band.y0 * width,
    });
    const targetRow = band.y0 * width * 4;
    const values = (band.y1 - band.y0) * width * 4;
    output.set(encoded.subarray(0, values), targetRow);
    timings.quantizeMs += nowMs() - started;
    options.onProgress?.((bandIndex + 1) / geometry.bands.length);
    await yieldRenderControl(options.signal);
    }
    const writeStarted = nowMs();
    await writeDocumentRgbaBuffer(doc, { width, height, buffer: output }, { componentSize, layerID: targetLayer.id, layerName: targetLayer.name, bounds: targetBounds, colorProfile: '' });
    timings.writeMs = nowMs() - writeStarted;
    timings.totalMs = nowMs() - totalStarted;
  renderStats.timings.total = timings.totalMs;
  renderStats.timings.read = timings.readMs;
  renderStats.timings.process = timings.processMs;
  renderStats.timings.quantize = timings.quantizeMs;
  renderStats.timings.write = timings.writeMs;
    renderStats.memory = renderStats.memory
      ? { ...renderStats.memory, actualPeakBytes: arena.stats().peakBytes }
      : { actualPeakBytes: arena.stats().peakBytes };
    renderStats.timings.perStage = {
      ...renderStats.timings.perStage,
      readMs: timings.readMs,
      processMs: timings.processMs,
      quantizeMs: timings.quantizeMs,
      writeMs: timings.writeMs,
    };
    const arenaStats = arena.stats();
    return {
    width,
    height,
    bands: geometry.bands.length,
    memoryMode: geometry.memoryMode,
    estimatedWorkingBytes: geometry.estimatedBytes,
    estimatedBandBytes: geometry.estimatedBandBytes,
    outputBytes: output.byteLength,
    colorProfile: pixelProfile,
    timings,
    algorithmTimings,
    renderStats: { ...renderStats, memory: renderStats.memory ? { ...renderStats.memory, actualPeakBytes: arenaStats.peakBytes } : { actualPeakBytes: arenaStats.peakBytes } },
    graphStats: {
      engineVersion: renderStats.engineVersion ?? FILM_GRAPH_VERSION,
      seed,
      planHash: geometry.planHash,
      graphHash: geometry.graphHash,
      nodes: document.graph.map((node) => ({ id: node.id, type: node.type })),
    },
    };
  } finally {
    if (ownsExecutor) executor.dispose();
    if (ownsArena) arena.dispose();
  }
}
