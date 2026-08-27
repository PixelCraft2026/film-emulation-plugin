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
  resolveSigmaParams,
  installWasmModule,
  getWasmBackendStatus,
  processHalation,
} from '../../src/core/index.js';
import { processTiledWithTrc } from '../../src/io/tileRender.js';
import { processTiledFilmWithTrc } from '../../src/io/tileRender.js';
import { streamGeometry, streamFilmGeometry } from '../../src/io/streamGeometry.js';
import { renderPreviewIncremental } from '../../src/io/previewRender.js';

const WIDTH = 6000;
const HEIGHT = 4000;
const WARMUPS = Number(process.env.FILM_BENCH_WARMUPS ?? 2);
const RUNS = Number(process.env.FILM_BENCH_RUNS ?? 10);
const DEVICE_MEMORY_GB = Number(process.env.FILM_BENCH_MEMORY_GB ?? 16);
const SUITE = String(process.env.FILM_BENCH_SUITE ?? 'all');
if (!['all', 'legacy', 'v16'].includes(SUITE)) throw new Error(`Unknown FILM_BENCH_SUITE: ${SUITE}`);
const LINEAR_TRC = { decode: (value) => value, encode: (value) => value, baseKey: 'sRGB' };
const wasmPath = fileURLToPath(new URL('../../assets/film_core.wasm', import.meta.url));
if (existsSync(wasmPath)) await installWasmModule(readFileSync(wasmPath));

function gitRevision() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

function wasmSha256() {
  if (!existsSync(wasmPath)) return null;
  return createHash('sha256').update(readFileSync(wasmPath)).digest('hex');
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
  graph: defaultGraphDocument.graph.map((node) => ({ ...node, enabled: true })),
};

function renderFilm24MP(document = shippingGraphDocument) {
  const geometry = streamFilmGeometry(WIDTH, HEIGHT, document, {
    componentSize: 16,
    deviceMemoryGB: DEVICE_MEMORY_GB,
    memoryMode: 'balanced',
    quality: 'quality',
  });
  let checksum = 0;
  let peak = memoryMB();
  const nodeTimings = {};
  const stageTimings = {};
  const copies = { inputBytes: 0, outputBytes: 0, count: 0 };
  const passes = { fullPixelPasses: 0, perNode: {} };
  let fallback = null;
  for (const band of geometry.bands) {
    const source = makeBand(WIDTH, band.start, band.end);
    const result = processTiledFilmWithTrc(source, document, LINEAR_TRC, {
      tileThreshold: Number.MAX_SAFE_INTEGER,
      fullWidth: WIDTH,
      fullHeight: HEIGHT,
      originY: band.start,
      quality: 'quality',
      seed: 0x12345678,
      renderPlan: geometry.plan,
      bandHeight: geometry.bandHeight,
      overlapPx: geometry.overlap,
      memoryMode: geometry.memoryMode,
      componentSize: 16,
      profileTimings: true,
    });
    for (const node of result.stats?.nodes ?? []) {
      nodeTimings[node.type] = (nodeTimings[node.type] ?? 0) + node.elapsedMs;
    }
    for (const [stage, value] of Object.entries(result.stats?.timings?.perStage ?? {})) stageTimings[stage] = (stageTimings[stage] ?? 0) + value;
    copies.inputBytes += result.stats?.copies?.inputBytes ?? 0;
    copies.outputBytes += result.stats?.copies?.outputBytes ?? 0;
    copies.count += result.stats?.copies?.count ?? 0;
    passes.fullPixelPasses += result.stats?.passes?.fullPixelPasses ?? 0;
    for (const [id, value] of Object.entries(result.stats?.passes?.perNode ?? {})) passes.perNode[id] = (passes.perNode[id] ?? 0) + value;
    if (result.stats?.fallback) fallback = result.stats.fallback;
    const firstSampleY = band.y0 + ((17 - (band.y0 % 17)) % 17);
    for (let absoluteY = firstSampleY; absoluteY < band.y1; absoluteY += 17) {
      const y = absoluteY - band.start;
      const p = (y * WIDTH + ((absoluteY * 101) % WIDTH)) * 3;
      checksum = (checksum + Math.round(result.rgb[p] * 1e6)) >>> 0;
    }
    const current = memoryMB();
    peak = { rss: Math.max(peak.rss, current.rss), arrayBuffers: Math.max(peak.arrayBuffers, current.arrayBuffers) };
  }
  return {
    checksum,
    peak,
    bands: geometry.bands.length,
    memoryMode: geometry.memoryMode,
    nodeTimings,
    graphHash: geometry.graphHash,
    planHash: geometry.planHash,
    copies,
    passes,
    stageTimings,
    fallback,
    stats: { copies, passes, timings: { perStage: stageTimings }, fallback },
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
  const result = await renderPreviewIncremental(
    { width: WIDTH, height: HEIGHT },
    fullGraphDocument,
    { display: LINEAR_TRC, effect: LINEAR_TRC },
    previewCache,
    previewSource,
    { returnDataUrl: false },
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
  return { checksum: result.cache.graphResult.rgb[0], bands: 1, memoryMode: 'n/a', graphHash: previewPlan.graphHash, planHash: previewPlan.planHash };
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
    total: summary.p50Ms,
    read: 0,
    process: summary.p50Ms,
    quantize: 0,
    write: 0,
    perNode: Object.fromEntries(Object.entries(nodeSamples).map(([type, values]) => [type, percentile(values, 0.5)])),
    perStage: lastStats.timings?.perStage ?? lastStats.stageTimings ?? {},
  };
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
  wasmSha256: wasmSha256(),
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
    memoryMode: 'balanced',
    deviceMemoryGB: DEVICE_MEMORY_GB,
    graphFixtures: ['v16-shipping-default', 'v16-full'],
  },
};
if (SUITE === 'all' || SUITE === 'legacy') {
  report.apply24MP = await measure('24MP streamed fast', () => render24MP(defaultParams));
  report.preview1024 = await measure('1024px preview fast', () => renderPreview(previewParams));
}
if (SUITE === 'all' || SUITE === 'v16') {
  report.v16ShippingDefault = await measure('24MP V1.6 shipping-default Quality Balanced', () => renderFilm24MP(shippingGraphDocument));
  report.v16Full = await measure('24MP V1.6 full Quality Balanced', () => renderFilm24MP(fullGraphDocument));
  report.v16Preview1024Cached = await measure('1024px V1.6 full cached preview', renderFilmPreview);
}

report.backendFinal = getWasmBackendStatus();

const out = process.env.FILM_BENCH_OUTPUT || fileURLToPath(new URL('../performance-data.json', import.meta.url));
writeFileSync(out, JSON.stringify(report, null, 2) + '\n', 'utf8');
console.log(`report: ${typeof out === 'string' ? out : out.pathname}`);
