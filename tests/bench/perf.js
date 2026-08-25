/** V1.5 reproducible benchmark: 2 warmups + 10 measured runs by default. */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  createHalationParams,
  createHalationPreset,
  createDefaultEffectGraph,
  resolveSigmaParams,
  installWasmModule,
  getWasmBackendStatus,
  processHalation,
} from '../../src/core/index.js';
import { processTiledWithTrc } from '../../src/io/tileRender.js';
import { processTiledFilmWithTrc } from '../../src/io/tileRender.js';
import { streamGeometry, streamFilmGeometry } from '../../src/io/streamGeometry.js';

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

function renderFilm24MP() {
  const geometry = streamFilmGeometry(WIDTH, HEIGHT, defaultGraphDocument, {
    componentSize: 16,
    deviceMemoryGB: DEVICE_MEMORY_GB,
    memoryMode: 'auto',
    quality: 'fast',
  });
  let checksum = 0;
  let peak = memoryMB();
  const nodeTimings = {};
  for (const band of geometry.bands) {
    const source = makeBand(WIDTH, band.start, band.end);
    const result = processTiledFilmWithTrc(source, defaultGraphDocument, LINEAR_TRC, {
      tileThreshold: Number.MAX_SAFE_INTEGER,
      fullWidth: WIDTH,
      fullHeight: HEIGHT,
      originY: band.start,
      quality: 'fast',
      seed: 0x12345678,
    });
    for (const node of result.stats?.nodes ?? []) {
      nodeTimings[node.type] = (nodeTimings[node.type] ?? 0) + node.elapsedMs;
    }
    const firstSampleY = band.y0 + ((17 - (band.y0 % 17)) % 17);
    for (let absoluteY = firstSampleY; absoluteY < band.y1; absoluteY += 17) {
      const y = absoluteY - band.start;
      const p = (y * WIDTH + ((absoluteY * 101) % WIDTH)) * 3;
      checksum = (checksum + Math.round(result.rgb[p] * 1e6)) >>> 0;
    }
    const current = memoryMB();
    peak = { rss: Math.max(peak.rss, current.rss), arrayBuffers: Math.max(peak.arrayBuffers, current.arrayBuffers) };
  }
  return { checksum, peak, bands: geometry.bands.length, memoryMode: geometry.memoryMode, nodeTimings };
}

function renderFilmPreview() {
  const width = 1024;
  const height = 683;
  const source = makeBand(width, 0, height);
  const result = processTiledFilmWithTrc(source, defaultGraphDocument, LINEAR_TRC, {
    tileThreshold: Number.MAX_SAFE_INTEGER,
    fullWidth: WIDTH,
    fullHeight: HEIGHT,
    previewScale: width / WIDTH,
    quality: 'fast',
    seed: 0x12345678,
  });
  return result.rgb[0];
}

async function measure(label, render, warmups = WARMUPS, runs = RUNS) {
  for (let i = 0; i < warmups; i++) render();
  const timings = [];
  let peak = { rss: 0, arrayBuffers: 0 };
  let checksum = 0;
  let bands = 1;
  let memoryMode = 'n/a';
  const nodeSamples = {};
  for (let i = 0; i < runs; i++) {
    if (global.gc) global.gc();
    const started = performance.now();
    const result = render();
    timings.push(performance.now() - started);
    checksum = typeof result === 'number' ? result : result.checksum;
    bands = typeof result === 'number' ? 1 : result.bands;
    memoryMode = typeof result === 'number' ? 'n/a' : result.memoryMode;
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
    nodeTimingsMs: Object.fromEntries(Object.entries(nodeSamples).map(([type, values]) => [type, {
      samples: values.map((value) => Math.round(value * 10) / 10),
      p50: Math.round(percentile(values, 0.5) * 10) / 10,
      p95: Math.round(percentile(values, 0.95) * 10) / 10,
    }])),
  };
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
  backend: getWasmBackendStatus(),
  protocol: { warmups: WARMUPS, runs: RUNS, size: `${WIDTH}x${HEIGHT}`, componentSize: 16, deviceMemoryGB: DEVICE_MEMORY_GB },
};
if (SUITE === 'all' || SUITE === 'legacy') {
  report.apply24MP = await measure('24MP streamed fast', () => render24MP(defaultParams));
  report.preview1024 = await measure('1024px preview fast', () => renderPreview(previewParams));
}
if (SUITE === 'all' || SUITE === 'v16') {
  report.v16Apply24MP = await measure('24MP V1.6 graph fast', renderFilm24MP);
  report.v16Preview1024 = await measure('1024px V1.6 graph fast', renderFilmPreview);
}

const out = process.env.FILM_BENCH_OUTPUT || fileURLToPath(new URL('../performance-data.json', import.meta.url));
writeFileSync(out, JSON.stringify(report, null, 2) + '\n', 'utf8');
console.log(`report: ${typeof out === 'string' ? out : out.pathname}`);
