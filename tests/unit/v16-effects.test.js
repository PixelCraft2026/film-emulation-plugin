import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createHalationParams,
  createFilmResolutionParams,
  createGrainParams,
  createDefaultEffectGraph,
  processFilm,
  processFilmStages,
  filmResolutionTarget,
  filmResolutionSupport,
  grainSupport,
  FORMAT_PROFILES,
  physicalMicronsToPixels,
  fnv1aUtf8,
  hash32,
  gaussianApprox,
  getTRC,
} from '../../src/core/index.js';
import { processTiledFilmWithTrc } from '../../src/io/tileRender.js';
import { streamFilmGeometry } from '../../src/io/streamGeometry.js';
import { renderPreviewIncremental } from '../../src/io/previewRender.js';

const TRC = getTRC('sRGB');

test('V1.6 physical formats and deterministic hash vectors are stable', () => {
  assert.equal(FORMAT_PROFILES.super8.apertureWidthMm, 5.79);
  assert.ok(Math.abs(physicalMicronsToPixels(10, { gauge: '35mm', iso: 250 }, 2490) - 1) < 0.001);
  const nodeHash = fnv1aUtf8('grain-main');
  assert.equal(nodeHash, 2195196770);
  assert.equal(hash32(0x12345678, nodeHash, -7, 19, 2, 1, 0), 0x6f088b72);
  assert.equal(gaussianApprox(0x12345678, nodeHash, -7, 19, 2, 1), -0.5085549354553223);
  const emojiHash = fnv1aUtf8('grain-😀');
  assert.equal(hash32(0xabcdef01, emojiHash, -1, -2, 0, 3, 11), 0x46159d37);
});

test('Film Resolution uses non-negative MTF mixing and preserves alpha/HDR', () => {
  const params = createFilmResolutionParams({ amount: 1.5, response: 1 });
  const target = filmResolutionTarget(params, { gauge: '35mm', iso: 250 }, 2560);
  assert.ok(target.sigmaPx > 0);
  assert.ok(filmResolutionSupport(params, { gauge: '35mm', iso: 250 }, 2560) >= Math.ceil(3 * target.sigmaPx * 2.2));
  const width = 65;
  const rgb = new Float32Array(width * 3);
  rgb.fill(0.18);
  rgb[32 * 3] = 4;
  rgb[32 * 3 + 1] = 4;
  rgb[32 * 3 + 2] = 4;
  const alpha = new Float32Array(width).fill(0.37);
  const result = processFilmStages(
    { width, height: 1, rgb, alpha },
    [{ id: 'film-resolution-main', type: 'filmResolution', enabled: true, params }],
    { fullWidth: 2560, fullHeight: 1, format: { gauge: '35mm', iso: 250 }, quality: 'quality' },
  );
  assert.deepEqual(result.alpha, alpha);
  for (let i = 0; i < result.rgb.length; i++) assert.ok(Number.isFinite(result.rgb[i]) && result.rgb[i] >= 0, `rgb[${i}]`);
  const identity = processFilmStages(
    { width, height: 1, rgb, alpha },
    [{ id: 'film-resolution-main', type: 'filmResolution', enabled: true, params: createFilmResolutionParams({ amount: 0 }) }],
  );
  assert.deepEqual(identity.rgb, rgb);
});

test('Grain is deterministic, alpha-mixed, and neutral-mean corrected', () => {
  const width = 96;
  const height = 64;
  const rgb = new Float32Array(width * height * 3).fill(0.18);
  const alpha = new Float32Array(width * height).fill(1);
  alpha[0] = 0;
  const graph = createDefaultEffectGraph(createHalationParams({ strength: 0 }), 0x12345678).map((node) => {
    if (node.type === 'filmResolution') return { ...node, params: createFilmResolutionParams({ amount: 0 }) };
    if (node.type === 'grain') return { ...node, params: createGrainParams({ amount: 1, seed: 0x12345678 }) };
    return node;
  });
  const context = { width, height, fullWidth: width, fullHeight: height, format: { gauge: '35mm', iso: 250 }, quality: 'quality', seed: 0x12345678 };
  const a = processFilm({ width, height, rgb, alpha }, { graph }, context);
  const b = processFilm({ width, height, rgb, alpha }, { graph }, context);
  assert.deepEqual(a.rgb, b.rgb);
  assert.equal(a.rgb[0], rgb[0], 'alpha zero keeps hidden RGB untouched');
  let mean = 0;
  for (let i = 0; i < width * height; i++) mean += a.rgb[i * 3];
  mean /= width * height - 1;
  assert.ok(Math.abs(mean - 0.18) < 0.001, `mean=${mean}`);
  assert.ok(grainSupport(graph[2].params, context) >= 0);
});

test('Graph renderer is band-height invariant for coordinate-addressed Grain', () => {
  const width = 80;
  const height = 137;
  const rgb = new Float32Array(width * height * 3);
  const alpha = new Float32Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const v = 0.12 + ((i * 1103515245 + 12345) >>> 8) / 0xffffff * 0.5;
    rgb[i * 3] = v;
    rgb[i * 3 + 1] = v;
    rgb[i * 3 + 2] = v;
    alpha[i] = (i % 11) / 10;
  }
  const graph = createDefaultEffectGraph(createHalationParams({ strength: 0 }), 0x9e3779b9).map((node) => {
    if (node.type === 'filmResolution') return { ...node, params: createFilmResolutionParams({ amount: 0 }) };
    if (node.type === 'grain') return { ...node, params: createGrainParams({ seed: 0x9e3779b9 }) };
    return node;
  });
  const document = { format: { gauge: '35mm', iso: 250 }, graph };
  const input = { width, height, rgb, alpha };
  const full = processTiledFilmWithTrc(input, document, TRC, { tileThreshold: Number.MAX_SAFE_INTEGER });
  const tiled = processTiledFilmWithTrc(input, document, TRC, { tileThreshold: 1, bandHeight: 31, overlapPx: 8 });
  let rms = 0;
  for (let i = 0; i < full.rgb.length; i++) {
    const d = full.rgb[i] - tiled.rgb[i];
    rms += d * d;
  }
  rms = Math.sqrt(rms / full.rgb.length);
  assert.ok(rms <= 1e-5, `RMS=${rms}`);
  assert.deepEqual(full.alpha, tiled.alpha);
});

test('Preview node caches reuse MTF blurs and Grain unit fields across amount changes', () => {
  const width = 48;
  const height = 32;
  const rgb = new Float32Array(width * height * 3).fill(0.18);
  const format = { gauge: '35mm', iso: 250 };
  const nodeCaches = {};
  const context = { fullWidth: 2560, fullHeight: 1707, format, quality: 'fast', nodeCaches };
  const resolutionNode = {
    id: 'film-resolution-main',
    type: 'filmResolution',
    enabled: true,
    params: createFilmResolutionParams({ amount: 1 }),
  };
  processFilmStages({ width, height, rgb }, [resolutionNode], context);
  const firstBlur = nodeCaches['film-resolution-main'].resolutionFirstRgb;
  processFilmStages(
    { width, height, rgb },
    [{ ...resolutionNode, params: createFilmResolutionParams({ amount: 0.7 }) }],
    context,
  );
  assert.strictEqual(nodeCaches['film-resolution-main'].resolutionFirstRgb, firstBlur);

  const grainNode = {
    id: 'grain-main',
    type: 'grain',
    enabled: true,
    params: createGrainParams({ amount: 1, mode: 'fast', seed: 0x12345678 }),
  };
  processFilmStages({ width, height, rgb }, [grainNode], context);
  const unitFields = nodeCaches['grain-main'].grainAccums;
  processFilmStages(
    { width, height, rgb },
    [{ ...grainNode, params: createGrainParams({ amount: 0.5, mode: 'fast', seed: 0x12345678 }) }],
    context,
  );
  assert.strictEqual(nodeCaches['grain-main'].grainAccums, unitFields);
});

test('Maximum Grain controls keep HDR and negative Float32 samples finite', () => {
  const width = 32;
  const height = 24;
  const rgb = new Float32Array(width * height * 3);
  for (let i = 0; i < rgb.length; i += 3) {
    rgb[i] = 10000;
    rgb[i + 1] = i % 2 ? -0.25 : 0.18;
    rgb[i + 2] = 4;
  }
  const result = processFilmStages(
    { width, height, rgb },
    [{
      id: 'grain-main',
      type: 'grain',
      enabled: true,
      params: createGrainParams({ amount: 2, size: 2, roughness: 1, chroma: 1, mode: 'fast', seed: 0xffffffff }),
    }],
    { fullWidth: 2048, fullHeight: 1536, format: { gauge: '8mm', iso: 3200 }, quality: 'fast' },
  );
  for (let i = 0; i < result.rgb.length; i++) assert.ok(Number.isFinite(result.rgb[i]), `rgb[${i}]`);
});

test('V1.6 24MP uses safe High memory on 16GB and aligned bands on unknown hosts', () => {
  const document = {
    format: { gauge: '35mm', iso: 250 },
    graph: createDefaultEffectGraph(createHalationParams(), 0x12345678),
  };
  const high = streamFilmGeometry(6000, 4000, document, {
    componentSize: 16,
    deviceMemoryGB: 16,
    quality: 'fast',
  });
  assert.equal(high.memoryMode, 'high');
  assert.equal(high.bands.length, 1);
  assert.equal(high.overlap, 0);
  assert.ok(high.estimatedBytes * high.safetyMargin <= high.budgetBytes);

  const balanced = streamFilmGeometry(6000, 4000, document, {
    componentSize: 16,
    deviceMemoryGB: 0,
    quality: 'fast',
  });
  assert.equal(balanced.memoryMode, 'balanced');
  assert.ok(balanced.bands.length > 1);
  assert.equal(balanced.bandHeight % balanced.phaseScale, 0);
  assert.equal(balanced.overlap % balanced.phaseScale, 0);
  assert.ok(balanced.estimatedBandBytes * balanced.safetyMargin <= balanced.hardBudgetBytes);
});

test('Repeated Resolution and Grain preview adjustments remain finite and cancellable', async () => {
  const width = 64;
  const height = 40;
  const rgb = new Float32Array(width * height * 3);
  const alpha = new Float32Array(width * height).fill(1);
  for (let i = 0; i < width * height; i++) {
    const value = 0.04 + (i % width) / width;
    rgb[i * 3] = value;
    rgb[i * 3 + 1] = value * 0.9;
    rgb[i * 3 + 2] = value * 0.8;
  }
  const source = {
    display: { width, height, rgb, alpha, cacheKey: 'repeat-preview' },
    effect: { width, height, rgb, alpha },
    cacheKey: 'repeat-preview',
    originX: 0,
    originY: 0,
  };
  const trc = { display: { decode: (v) => v, encode: (v) => v, baseKey: 'sRGB' }, effect: { decode: (v) => v, encode: (v) => v, baseKey: 'sRGB' } };
  const doc = { width: 2560, height: 1600 };
  let cache = null;
  for (let iteration = 0; iteration < 10; iteration++) {
    const graph = createDefaultEffectGraph(createHalationParams({ strength: 0 }), 0x12345678).map((node) => {
      if (node.type === 'filmResolution') return { ...node, params: createFilmResolutionParams({ amount: 0.5 + iteration * 0.08, response: 1 }) };
      if (node.type === 'grain') return { ...node, params: createGrainParams({ amount: 0.4 + iteration * 0.1, mode: 'fast', seed: 0x12345678 }) };
      return node;
    });
    const result = await renderPreviewIncremental(doc, { format: { gauge: '35mm', iso: 250 }, graph }, trc, cache, source);
    assert.match(result.dataUrl, /^data:image\/png;base64,/);
    for (const value of result.cache.graphResult.rgb) assert.ok(Number.isFinite(value));
    cache = result.cache;
  }
  const binaryResult = await renderPreviewIncremental(
    doc,
    { format: { gauge: '35mm', iso: 250 }, graph: createDefaultEffectGraph(createHalationParams({ strength: 0 })) },
    trc,
    null,
    source,
    { returnDataUrl: false },
  );
  assert.equal(binaryResult.dataUrl, null);
  assert.deepEqual(Array.from(binaryResult.png.subarray(0, 8)), [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    renderPreviewIncremental(doc, { format: { gauge: '35mm', iso: 250 }, graph: createDefaultEffectGraph(createHalationParams({ strength: 0 })) }, trc, cache, source, { signal: controller.signal }),
    /cancelled/,
  );
});
