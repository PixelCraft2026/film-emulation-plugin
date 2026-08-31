/** V1.5 reproducible benchmark: 2 warmups + 10 measured runs by default. */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  createHalationParams,
  createHalationPreset,
  createDefaultEffectGraph,
  createFilmRenderPlan,
  createFilmExecutor,
  createV17ResidentBackend,
  resolveSigmaParams,
  installWasmModule,
  getWasmBackendStatus,
  setWasmExecutionMode,
  processHalation,
} from '../../src/core/index.js';
import { processTiledWithTrc } from '../../src/io/tileRender.js';
import { processFilmBandWithTrcAsync } from '../../src/io/tileRender.js';
import { streamGeometry, streamFilmGeometry } from '../../src/io/streamGeometry.js';
import { renderPreviewIncremental } from '../../src/io/previewRender.js';

const WIDTH = Number(process.env.FILM_BENCH_WIDTH ?? 6000);
const HEIGHT = Number(process.env.FILM_BENCH_HEIGHT ?? 4000);
const WARMUPS = Number(process.env.FILM_BENCH_WARMUPS ?? 2);
const RUNS = Number(process.env.FILM_BENCH_RUNS ?? 10);
const DEVICE_MEMORY_GB = Number(process.env.FILM_BENCH_MEMORY_GB ?? 16);
const SUITE = String(process.env.FILM_BENCH_SUITE ?? 'all');
const FILM_MEMORY_MODE = String(process.env.FILM_BENCH_MEMORY_MODE ?? 'balanced');
const FILM_BACKEND = String(process.env.FILM_BENCH_BACKEND ?? 'scalar');
const ENABLED_NODE = String(process.env.FILM_BENCH_NODE ?? '');
const COMPARE_PROFILER = process.env.FILM_BENCH_COMPARE_PROFILE === '1';
if (!['all', 'legacy', 'v16', 'resident-shipping', 'resident-full', 'preview'].includes(SUITE)) throw new Error(`Unknown FILM_BENCH_SUITE: ${SUITE}`);
if (!['auto', 'balanced', 'high'].includes(FILM_MEMORY_MODE)) throw new Error(`Unknown FILM_BENCH_MEMORY_MODE: ${FILM_MEMORY_MODE}`);
if (!['scalar', 'simd', 'auto'].includes(FILM_BACKEND)) throw new Error(`Unknown FILM_BENCH_BACKEND: ${FILM_BACKEND}`);
const EXECUTION_BACKEND = FILM_BACKEND === 'simd' ? 'wasm-resident-simd'
  : FILM_BACKEND === 'scalar' ? 'wasm-resident' : 'auto';
const LINEAR_TRC = { decode: (value) => value, encode: (value) => value, baseKey: 'sRGB' };
const wasmPath = fileURLToPath(new URL('../../assets/film_core.wasm', import.meta.url));
const wasmSimdPath = fileURLToPath(new URL('../../assets/film_core_simd.wasm', import.meta.url));
if (existsSync(wasmPath)) {
  await installWasmModule(readFileSync(wasmPath), existsSync(wasmSimdPath) ? readFileSync(wasmSimdPath) : null);
  setWasmExecutionMode(EXECUTION_BACKEND);
}

function gitRevision() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

function workingTreeDirty() {
  try {
    return execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim().length > 0;
  } catch {
    return true;
  }
}

function sourceFingerprint() {
  const files = [
    'src/core/wasmBackend.js', 'src/core/film.js', 'src/core/renderPlan.js',
    'src/core/commandBuffer.js', 'src/core/effectRegistry.js', 'src/io/tileRender.js',
    'src/io/previewRender.js', 'native/film_core/src/lib.rs',
    'native/film_core/src/cooperative.rs', 'tests/bench/perf.js', 'package.json',
  ];
  const hash = createHash('sha256');
  for (const file of files) {
    const path = fileURLToPath(new URL(`../../${file}`, import.meta.url));
    hash.update(file).update('\0');
    if (existsSync(path)) hash.update(readFileSync(path));
  }
  return hash.digest('hex');
}

function fileSha256(path) {
  if (!existsSync(path)) return null;
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1))];
}

function memoryMB() {
  const usage = process.memoryUsage();
  return {
    rss: usage.rss / 1048576,
    arrayBuffers: usage.arrayBuffers / 1048576,
  };
}

function makeBand(width, start, end) {
  const height = end - start;
  const rgb = new Float32Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    const gy = start + y;
    for (let x = 0; x < width; x++) {
      const i = gy * width + x;
      const p = (y * width + x) * 3;
      const value = (((i * 2654435761) >>> 8) / 0xffffff) * 0.05;
      rgb[p] = value;
      rgb[p + 1] = value * 0.9;
      rgb[p + 2] = value * 0.8;
    }
  }
  for (let k = 0; k < 200; k++) {
    const x = (k * 137) % width;
    const gy = (k * 229) % HEIGHT;
    if (gy < start || gy >= end) continue;
    const p = ((gy - start) * width + x) * 3;
    rgb[p] = 2;
    rgb[p + 1] = 1.5;
    rgb[p + 2] = 1;
  }
  return { width, height, rgb };
}

function render24MP(params) {
  const geometry = streamGeometry(WIDTH, HEIGHT, params, {
    componentSize: 16,
    deviceMemoryGB: DEVICE_MEMORY_GB,
    memoryMode: 'auto',
  });
  let checksum = 0;
  let peak = memoryMB();
  for (const band of geometry.bands) {
    const source = makeBand(WIDTH, band.start, band.end);
    const result = processTiledWithTrc(source, geometry.params, LINEAR_TRC, { tileThreshold: Number.MAX_SAFE_INTEGER });
    const firstSampleY = band.y0 + ((17 - (band.y0 % 17)) % 17);
    for (let absoluteY = firstSampleY; absoluteY < band.y1; absoluteY += 17) {
      const y = absoluteY - band.start;
      const p = (y * WIDTH + ((absoluteY * 101) % WIDTH)) * 3;
      checksum = (checksum + Math.round(result.rgb[p] * 1e6)) >>> 0;
    }
    const current = memoryMB();
    peak = { rss: Math.max(peak.rss, current.rss), arrayBuffers: Math.max(peak.arrayBuffers, current.arrayBuffers) };
  }
  return { checksum, peak, bands: geometry.bands.length, memoryMode: geometry.memoryMode };
}

function renderPreview(params) {
  const width = 1024;
  const height = 683;
  const source = makeBand(width, 0, height);
  const result = processHalation(source, params);
  return result.rgb[0];
}

const defaultGraphDocument = {
  format: { gauge: '35mm', iso: 250 },
  graph: createDefaultEffectGraph(createHalationPreset('tungsten-800'), 0x12345678),
};

// V1.6 closure fixtures are explicit.  The historical benchmark accidentally
// called the opt-in graph a "full" graph while Resolution and Grain were
// disabled by default, making reports incomparable across revisions.
const shippingGraphDocument = defaultGraphDocument;
const fullGraphDocument = {
  ...defaultGraphDocument,
  graph: defaultGraphDocument.graph.map((node) => ({ ...node, enabled: !ENABLED_NODE || node.type === ENABLED_NODE })),
};

async function renderFilm24MP(document = shippingGraphDocument) {
  const geometry = streamFilmGeometry(WIDTH, HEIGHT, document, {
    componentSize: 16,
    deviceMemoryGB: DEVICE_MEMORY_GB,
    memoryMode: FILM_MEMORY_MODE,
    quality: 'quality',
  });
  let checksum = 0;
  let peak = memoryMB();
  const nodeTimings = {};
  const nodeTimingsById = {};
  const stageTimings = {};
  let processTimeMs = 0;
  const residentWork = { pixelVisits: 0, pixelsRead: 0, pixelsWritten: 0, convolutionTaps: 0, downsamplePixels: 0, upsamplePixels: 0 };
  const residentStepLatency = { count: 0, total: 0, max: 0, samples: [] };
  const collectResidentStepSamples = process.env.FILM_BENCH_PROFILE !== '0' && process.env.FILM_BENCH_COLLECT_STEP_SAMPLES !== '0';
  const residentScheduler = {};
  const copies = { inputBytes: 0, outputBytes: 0, count: 0 };
  const passes = { fullPixelPasses: 0, perNode: {} };
  let fallback = null;
  let selectedBackend = null;
  let selectedBackendVariant = null;
  const segmentStats = {};
  const resident = createV17ResidentBackend(geometry.plan);
  if (!resident && FILM_BACKEND !== 'auto') throw new Error(`Requested ${FILM_BACKEND} resident backend is unavailable`);
  const executor = createFilmExecutor(geometry.plan, { backend: EXECUTION_BACKEND, residentBackend: resident });
  const segmented = geometry.executionMode === 'resident-segmented' && resident?.supportsSegmented?.(geometry.plan);
  try {
    const workBands = segmented
      ? [{ start: 0, end: HEIGHT, y0: 0, y1: HEIGHT }]
      : geometry.bands;
    for (const band of workBands) {
      const source = makeBand(WIDTH, band.start, band.end);
      const result = segmented
        ? await executor.renderAsync(source, document, {
          fullWidth: WIDTH,
          fullHeight: HEIGHT,
          originY: 0,
          quality: 'quality',
          seed: 0x12345678,
          intent: 'apply',
          profileResident: process.env.FILM_BENCH_PROFILE !== '0',
          collectStepSamples: process.env.FILM_BENCH_COLLECT_STEP_SAMPLES !== '0',
          onResidentStep: collectResidentStepSamples ? (snapshot) => residentStepLatency.samples.push(Number(snapshot?.elapsedMs ?? 0)) : undefined,
        })
        : await processFilmBandWithTrcAsync(source, document, LINEAR_TRC, {
        fullWidth: WIDTH,
        fullHeight: HEIGHT,
        originY: band.start,
        quality: 'quality',
        seed: 0x12345678,
        renderPlan: geometry.plan,
        memoryMode: geometry.memoryMode,
        componentSize: 16,
        profileTimings: true,
        profileResident: process.env.FILM_BENCH_PROFILE !== '0',
        collectStepSamples: process.env.FILM_BENCH_COLLECT_STEP_SAMPLES !== '0',
        onResidentStep: collectResidentStepSamples ? (snapshot) => residentStepLatency.samples.push(Number(snapshot?.elapsedMs ?? 0)) : undefined,
        executor,
        backend: EXECUTION_BACKEND,
        outputRows: { start: band.y0 - band.start, end: band.y1 - band.start },
        intent: 'apply',
        yieldIntervalMs: 50,
        });
      selectedBackend = result.stats?.backend ?? selectedBackend;
      selectedBackendVariant = result.stats?.backendVariant ?? selectedBackendVariant;
    for (const node of result.stats?.nodes ?? []) {
      nodeTimings[node.type] = (nodeTimings[node.type] ?? 0) + node.elapsedMs;
      nodeTimingsById[node.id] = (nodeTimingsById[node.id] ?? 0) + node.elapsedMs;
    }
    for (const [stage, value] of Object.entries(result.stats?.timings?.perStage ?? {})) stageTimings[stage] = (stageTimings[stage] ?? 0) + value;
    processTimeMs += Number(result.stats?.timings?.process ?? result.stats?.timings?.total ?? 0);
    for (const key of Object.keys(residentWork)) if (key !== 'samples') residentWork[key] += Number(result.stats?.scheduler?.work?.[key] ?? 0);
    const latency = result.stats?.scheduler?.stepLatencyMs;
    if (result.stats?.scheduler) Object.assign(residentScheduler, result.stats.scheduler);
    // The profiler-off protocol intentionally skips per-step counter queries,
    // but SIMD qualification still needs a read-only end-of-request capacity
    // audit so an apparent speedup cannot hide unexpected growth.
    const residentDiagnostics = resident?.stats?.();
    if (residentDiagnostics) Object.assign(residentScheduler, {
      plannedArenaFloats: residentDiagnostics.plannedArenaFloats,
      actualArenaFloats: residentDiagnostics.actualArenaFloats,
      plannedTransientFloats: residentDiagnostics.plannedTransientFloats,
      actualTransientFloats: residentDiagnostics.actualTransientFloats,
      allocationCount: residentDiagnostics.allocationCount,
      memoryGeneration: residentDiagnostics.memoryGeneration,
    });
    if (latency) {
      residentStepLatency.count += Number(latency.count ?? 0);
      residentStepLatency.total += Number(latency.total ?? 0);
      residentStepLatency.max = Math.max(residentStepLatency.max, Number(latency.max ?? 0));
    }
    copies.inputBytes += result.stats?.copies?.inputBytes ?? 0;
    copies.outputBytes += result.stats?.copies?.outputBytes ?? 0;
    copies.count += result.stats?.copies?.count ?? 0;
    passes.fullPixelPasses += result.stats?.passes?.fullPixelPasses ?? 0;
    for (const [id, value] of Object.entries(result.stats?.passes?.perNode ?? {})) passes.perNode[id] = (passes.perNode[id] ?? 0) + value;
    if (result.stats?.fallback) fallback = result.stats.fallback;
      for (const [id, value] of Object.entries(result.stats?.segments ?? {})) segmentStats[id] = {
        ...(segmentStats[id] ?? {}),
        ...value,
      };
      const firstSampleY = band.y0 + ((17 - (band.y0 % 17)) % 17);
      for (let absoluteY = firstSampleY; absoluteY < band.y1; absoluteY += 17) {
        const y = absoluteY - band.y0;
        const p = (y * WIDTH + ((absoluteY * 101) % WIDTH)) * 3;
        checksum = (checksum + Math.round(result.rgb[p] * 1e6)) >>> 0;
      }
      const current = memoryMB();
      peak = { rss: Math.max(peak.rss, current.rss), arrayBuffers: Math.max(peak.arrayBuffers, current.arrayBuffers) };
    }
  } finally {
    executor.dispose();
  }
  const bandInputPixels = segmented
    ? Object.values(segmentStats).reduce((sum, segment) => sum + Number(segment.inputPixels ?? 0), 0)
    : geometry.bands.reduce((sum, band) => sum + WIDTH * Math.max(0, band.end - band.start), 0);
  return {
    checksum,
    peak,
    bands: geometry.bands.length,
    memoryMode: geometry.memoryMode,
    nodeTimings,
    graphHash: geometry.graphHash,
    planHash: geometry.planHash,
    execution: geometry.plan.execution,
    copies,
    passes,
    stageTimings,
    segmentStats,
    executionMode: geometry.executionMode,
    fallback,
    backend: selectedBackend,
    backendVariant: selectedBackendVariant,
    stats: { backend: selectedBackend, backendVariant: selectedBackendVariant, copies, passes, timings: { total: processTimeMs, process: processTimeMs, perNode: nodeTimingsById, perStage: stageTimings }, scheduler: { ...residentScheduler, work: residentWork, stepLatencyMs: { count: residentStepLatency.count, total: residentStepLatency.total, max: residentStepLatency.max, p50: percentile(residentStepLatency.samples, 0.5), p95: percentile(residentStepLatency.samples, 0.95) } }, bandInputPixels, fallback },
    residentWork,
    residentStepLatency: { count: residentStepLatency.count, total: residentStepLatency.total, max: residentStepLatency.max, p50: percentile(residentStepLatency.samples, 0.5), p95: percentile(residentStepLatency.samples, 0.95) },
    bandInputPixels,
  };
}

const previewNodeCaches = {};
const previewSource = (() => {
  const display = makeBand(1024, 0, 683);
  return {
    display: { ...display, cacheKey: 'bench-v16-preview' },
    effect: { ...display, cacheKey: 'bench-v16-preview-effect' },
    cacheKey: 'bench-v16-preview',
    originX: 0,
    originY: 0,
    previewScale: 1024 / WIDTH,
    effectPreviewScale: 1024 / WIDTH,
  };
})();
let previewCache = null;

async function renderFilmPreview() {
  const width = 1024;
  const height = 683;
  const stepSamples = [];
  const result = await renderPreviewIncremental(
    { width: WIDTH, height: HEIGHT },
    fullGraphDocument,
    { display: LINEAR_TRC, effect: LINEAR_TRC },
    previewCache,
    previewSource,
    {
      returnDataUrl: false,
      profileResident: process.env.FILM_BENCH_PROFILE !== '0',
      collectStepSamples: process.env.FILM_BENCH_COLLECT_STEP_SAMPLES !== '0',
      onResidentStep: process.env.FILM_BENCH_PROFILE !== '0'
        ? (snapshot) => stepSamples.push(Number(snapshot?.elapsedMs ?? 0))
        : undefined,
    },
  );
  previewCache = result.cache;
  const previewPlan = createFilmRenderPlan({
    width,
    height,
    fullWidth: WIDTH,
    fullHeight: HEIGHT,
    previewScale: width / WIDTH,
    quality: 'fast',
    graph: fullGraphDocument.graph,
    format: fullGraphDocument.format,
    memoryMode: 'balanced',
  });
  const total = stepSamples.reduce((sum, value) => sum + value, 0);
  return {
    checksum: result.cache.graphResult.rgb[0],
    bands: 1,
    memoryMode: 'n/a',
    graphHash: previewPlan.graphHash,
    planHash: previewPlan.planHash,
    stats: {
      timings: { total: result.ms, process: result.ms, perNode: {}, perStage: {} },
      scheduler: {
        stepLatencyMs: {
          count: stepSamples.length,
          total,
          max: stepSamples.length ? Math.max(...stepSamples) : 0,
          p50: percentile(stepSamples, 0.5),
          p95: percentile(stepSamples, 0.95),
        },
        work: { pixelVisits: 0, pixelsRead: 0, pixelsWritten: 0, convolutionTaps: 0, downsamplePixels: 0, upsamplePixels: 0 },
      },
    },
  };
}

async function renderFilmPreviewUncached() {
  previewCache = null;
  return renderFilmPreview();
}

async function measure(label, render, warmups = WARMUPS, runs = RUNS) {
  for (let i = 0; i < warmups; i++) await render();
  const timings = [];
  let peak = { rss: 0, arrayBuffers: 0 };
  let checksum = 0;
  let bands = 1;
  let memoryMode = 'n/a';
  let graphHash = null;
  let planHash = null;
  let backend = null;
  let backendVariant = null;
  let executionMode = null;
  let executionPlan = null;
  let segmentStats = null;
  const nodeSamples = {};
  const statsSamples = [];
  for (let i = 0; i < runs; i++) {
    if (global.gc) global.gc();
    const started = performance.now();
    const result = await render();
    timings.push(performance.now() - started);
    checksum = typeof result === 'number' ? result : result.checksum;
    bands = typeof result === 'number' ? 1 : result.bands;
    memoryMode = typeof result === 'number' ? 'n/a' : result.memoryMode;
    graphHash = typeof result === 'number' ? graphHash : result.graphHash ?? graphHash;
    planHash = typeof result === 'number' ? planHash : result.planHash ?? planHash;
    backend = typeof result === 'number' ? backend : result.backend ?? result.stats?.backend ?? backend;
    backendVariant = typeof result === 'number' ? backendVariant : result.backendVariant ?? result.stats?.backendVariant ?? backendVariant;
    executionMode = typeof result === 'number' ? executionMode : result.executionMode ?? result.stats?.executionMode ?? executionMode;
    executionPlan = typeof result === 'number' ? executionPlan : result.execution ?? executionPlan;
    segmentStats = typeof result === 'number' ? segmentStats : result.segmentStats ?? result.stats?.segments ?? segmentStats;
    const renderStats = result?.renderStats ?? result?.stats ?? null;
    if (renderStats) statsSamples.push(renderStats);
    for (const [type, value] of Object.entries(result?.nodeTimings ?? {})) {
      (nodeSamples[type] ??= []).push(value);
    }
    if (result.peak) peak = { rss: Math.max(peak.rss, result.peak.rss), arrayBuffers: Math.max(peak.arrayBuffers, result.peak.arrayBuffers) };
  }
  const summary = {
    label,
    warmups,
    runs,
    samplesMs: timings.map((value) => Math.round(value * 10) / 10),
    p50Ms: Math.round(percentile(timings, 0.5) * 10) / 10,
    p95Ms: Math.round(percentile(timings, 0.95) * 10) / 10,
    peakRssMB: Math.round(peak.rss * 10) / 10,
    peakArrayBuffersMB: Math.round(peak.arrayBuffers * 10) / 10,
    checksum,
    bands,
    memoryMode,
    graphHash,
    planHash,
    backend,
    backendVariant,
    executionMode,
    execution: executionPlan,
    segments: segmentStats,
    nodeTimingsMs: Object.fromEntries(Object.entries(nodeSamples).map(([type, values]) => [type, {
      samples: values.map((value) => Math.round(value * 10) / 10),
      p50: Math.round(percentile(values, 0.5) * 10) / 10,
      p95: Math.round(percentile(values, 0.95) * 10) / 10,
      }])),
  };
  const lastStats = statsSamples.at(-1) ?? {};
  summary.copies = lastStats.copies ?? { inputBytes: 0, outputBytes: 0, count: 0 };
  summary.passes = lastStats.passes ?? { fullPixelPasses: 0, perNode: {} };
  summary.timings = {
    total: lastStats.timings?.total ?? summary.p50Ms,
    read: 0,
    process: lastStats.timings?.process ?? summary.p50Ms,
    quantize: 0,
    write: 0,
    perNode: lastStats.timings?.perNode ?? Object.fromEntries(Object.entries(nodeSamples).map(([type, values]) => [type, percentile(values, 0.5)])),
    perStage: lastStats.timings?.perStage ?? lastStats.stageTimings ?? {},
  };
  const lastResultStats = statsSamples.at(-1) ?? {};
  const finalPixels = WIDTH * HEIGHT;
  const work = lastResultStats.scheduler?.work ?? {};
  summary.scheduler = lastResultStats.scheduler ?? null;
  summary.bandInputAmplification = typeof lastResultStats.bandInputPixels === 'number'
    ? lastResultStats.bandInputPixels / finalPixels
    : null;
  summary.pixelVisitFactor = typeof work.pixelVisits === 'number' ? work.pixelVisits / finalPixels : null;
  summary.fallback = lastStats.fallback ?? null;
  console.log(`${label}: P50=${summary.p50Ms}ms P95=${summary.p95Ms}ms peakRSS=${summary.peakRssMB}MB`);
  return summary;
}

const presetParams = createHalationPreset('tungsten-800');
const defaultParams = createHalationParams({
  ...resolveSigmaParams(presetParams, WIDTH, HEIGHT),
  diffusionMode: 'fast',
});
const previewParams = createHalationParams({ ...defaultParams, sigma: defaultParams.sigma * (1024 / WIDTH) });
/** @type {any} */
const report = {
  generatedAt: new Date().toISOString(),
  node: process.version,
  platform: `${process.platform}-${process.arch}`,
  cpu: process.env.PROCESSOR_IDENTIFIER ?? 'unknown',
  gitRevision: gitRevision(),
  workingTreeDirty: workingTreeDirty(),
  sourceFingerprint: sourceFingerprint(),
  wasmSha256: fileSha256(wasmPath),
  wasmSimdSha256: fileSha256(wasmSimdPath),
  backend: getWasmBackendStatus(),
  protocol: {
    warmups: WARMUPS,
    runs: RUNS,
    size: `${WIDTH}x${HEIGHT}`,
    width: WIDTH,
    height: HEIGHT,
    componentSize: 16,
    profile: 'sRGB',
    quality: 'quality',
    memoryMode: FILM_MEMORY_MODE,
    deviceMemoryGB: DEVICE_MEMORY_GB,
    backend: FILM_BACKEND,
    profileResident: process.env.FILM_BENCH_PROFILE !== '0',
    collectStepSamples: process.env.FILM_BENCH_COLLECT_STEP_SAMPLES !== '0',
    graphFixtures: ['v16-shipping-default', 'v16-full'],
  },
};
if (SUITE === 'all' || SUITE === 'legacy') {
  report.apply24MP = await measure('24MP streamed fast', () => render24MP(defaultParams));
  report.preview1024 = await measure('1024px preview fast', () => renderPreview(previewParams));
}
if (['all', 'v16', 'resident-shipping', 'resident-full'].includes(SUITE)) {
  const memoryLabel = FILM_MEMORY_MODE[0].toUpperCase() + FILM_MEMORY_MODE.slice(1);
  if (SUITE !== 'resident-full') report.v16ShippingDefault = await measure(`24MP V1.7 resident shipping-default Quality ${memoryLabel}`, () => renderFilm24MP(shippingGraphDocument));
  if (SUITE !== 'resident-shipping') report.v16Full = await measure(`${WIDTH}x${HEIGHT} V1.7 resident ${ENABLED_NODE || 'full'} Quality ${memoryLabel}`, () => renderFilm24MP(fullGraphDocument));
}
if (COMPARE_PROFILER && report.v16Full) {
  const previousProfile = process.env.FILM_BENCH_PROFILE;
  const previousSamples = process.env.FILM_BENCH_COLLECT_STEP_SAMPLES;
  process.env.FILM_BENCH_PROFILE = '0';
  process.env.FILM_BENCH_COLLECT_STEP_SAMPLES = '0';
  try {
    report.profilerOffV16Full = await measure(`${WIDTH}x${HEIGHT} V1.7 resident full Quality ${FILM_MEMORY_MODE} profiler-off`, () => renderFilm24MP(fullGraphDocument));
  } finally {
    if (previousProfile === undefined) delete process.env.FILM_BENCH_PROFILE; else process.env.FILM_BENCH_PROFILE = previousProfile;
    if (previousSamples === undefined) delete process.env.FILM_BENCH_COLLECT_STEP_SAMPLES; else process.env.FILM_BENCH_COLLECT_STEP_SAMPLES = previousSamples;
  }
  report.profilerOverhead = {
    p50Percent: 100 * (report.v16Full.p50Ms - report.profilerOffV16Full.p50Ms) / Math.max(1, report.profilerOffV16Full.p50Ms),
    p95Percent: 100 * (report.v16Full.p95Ms - report.profilerOffV16Full.p95Ms) / Math.max(1, report.profilerOffV16Full.p95Ms),
    protocol: 'same-process full graph, identical 24MP 2+10 protocol',
  };
}
if (SUITE === 'all' || SUITE === 'v16' || SUITE === 'preview') {
  report.v16Preview1024Uncached = await measure('1024px V1.7 full uncached preview', renderFilmPreviewUncached);
  report.v16Preview1024Cached = await measure('1024px V1.7 full cached preview', renderFilmPreview);
}

const hotspotSource = report.v16Full ?? report.v16ShippingDefault;
if (hotspotSource) {
  const stages = Object.entries(hotspotSource.timings?.perStage ?? {})
    .filter(([name]) => !name.startsWith('resident.'))
    .sort((a, b) => Number(b[1]) - Number(a[1]));
  report.pf8HotspotDecision = {
    topFiveNodePhases: stages.slice(0, 5).map(([phase, elapsedMs]) => ({ phase, elapsedMs })),
    stageShare: Object.fromEntries(stages.map(([phase, elapsedMs]) => [phase, Number(elapsedMs) / Math.max(1, Number(hotspotSource.timings?.process ?? hotspotSource.p50Ms))])),
    memoryTraffic: hotspotSource.scheduler?.work ?? null,
    bandInputAmplification: hotspotSource.bandInputAmplification ?? null,
    pixelVisitFactor: hotspotSource.pixelVisitFactor ?? null,
    stepLatencyMs: hotspotSource.scheduler?.stepLatencyMs ?? null,
    recommendedPf9Segments: [
      ['defringe-main'],
      ['halation-main'],
      ['bloom-main', 'highlight-protection-main'],
      ['film-resolution-main'],
      ['grain-main'],
    ],
    recommendation: `Start PF-9 with Defringe | Halation | Bloom + Highlight Protection | Film Resolution | Grain. Preserve the Bloom transient pair and isolate Grain's generated-field halo; band amplification ${Number(hotspotSource.bandInputAmplification ?? 0).toFixed(2)}x shows that PF-10 core materialization is still required. No planner change is applied in PF-8.`,
  };
  report.pf10Decision = {
    executionMode: hotspotSource.executionMode ?? null,
    execution: hotspotSource.execution ?? null,
    segments: hotspotSource.segments ?? null,
    bandInputAmplification: hotspotSource.bandInputAmplification ?? null,
    pixelVisitFactor: hotspotSource.pixelVisitFactor ?? null,
    stepLatencyMs: hotspotSource.scheduler?.stepLatencyMs ?? null,
    recommendation: 'PF-9/PF-10 segmented execution is enabled for the selected resident plan. Re-run the formal 24MP 2+10 gate and Photoshop UDT matrix before starting PF-11; no algorithm or planner changes are included here.',
  };
}

report.backendFinal = getWasmBackendStatus();

const out = process.env.FILM_BENCH_OUTPUT || fileURLToPath(new URL('../performance-data.json', import.meta.url));
writeFileSync(out, JSON.stringify(report, null, 2) + '\n', 'utf8');
console.log(`report: ${typeof out === 'string' ? out : out.pathname}`);
