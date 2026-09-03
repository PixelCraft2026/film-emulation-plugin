import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PNG } from 'pngjs';
import {
  createHalationParams,
  createFilmResolutionParams,
  createGrainParams,
  createBloomParams,
  createDefringeParams,
  createHighlightProtectionParams,
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

test('V1.6 Resolution and Grain are opt-in and disabled nodes are exact identity', () => {
  const graph = createDefaultEffectGraph(createHalationParams({ strength: 0 }), 0x12345678);
  assert.equal(graph.find((node) => node.type === 'filmResolution').enabled, false);
  assert.equal(graph.find((node) => node.type === 'grain').enabled, false);
  const rgb = new Float32Array([2, -0.25, 0.18, 0.4, 0.2, 4]);
  const alpha = new Float32Array([0, 0.63]);
  const result = processFilmStages(
    { width: 2, height: 1, rgb, alpha },
    graph.filter((node) => node.type !== 'halation'),
    { fullWidth: 2, fullHeight: 1, format: { gauge: '35mm', iso: 250 }, quality: 'quality' },
  );
  assert.strictEqual(result.rgb, rgb);
  assert.strictEqual(result.alpha, alpha);
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
    if (node.type === 'filmResolution') return { ...node, enabled: true, params: createFilmResolutionParams({ amount: 0 }) };
    if (node.type === 'grain') return { ...node, enabled: true, params: createGrainParams({ amount: 1, seed: 0x12345678 }) };
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
    if (node.type === 'filmResolution') return { ...node, enabled: true, params: createFilmResolutionParams({ amount: 0 }) };
    if (node.type === 'grain') return { ...node, enabled: true, params: createGrainParams({ seed: 0x9e3779b9 }) };
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
    graph: createDefaultEffectGraph(createHalationParams(), 0x12345678).map((node) => node.type === 'halation' ? node : { ...node, enabled: true }),
  };
  const high = streamFilmGeometry(6000, 4000, document, {
    componentSize: 16,
    deviceMemoryGB: 16,
    quality: 'fast',
  });
  assert.equal(high.memoryMode, 'high');
  const enumDepth = streamFilmGeometry(6000, 4000, document, {
    componentSize: 'bitDepth16',
    deviceMemoryGB: 16,
    memoryMode: 'auto',
  });
  assert.equal(enumDepth.plan.componentSize, 16);
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
  assert.ok(balanced.bandHeight >= balanced.overlap, 'each Balanced band advances by at least one halo width');
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
      if (node.type === 'filmResolution') return { ...node, enabled: true, params: createFilmResolutionParams({ amount: 0.5 + iteration * 0.08, response: 1 }) };
      if (node.type === 'grain') return { ...node, enabled: true, params: createGrainParams({ amount: 0.4 + iteration * 0.1, mode: 'fast', seed: 0x12345678 }) };
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

test('100% preview renders a padded native tile but publishes only the point-to-point crop', async () => {
  const width = 10;
  const height = 8;
  const rgb = new Float32Array(width * height * 3);
  const alpha = new Float32Array(width * height).fill(1);
  for (let i = 0; i < width * height; i++) {
    const value = 0.05 + i / 200;
    rgb[i * 3] = value;
    rgb[i * 3 + 1] = value;
    rgb[i * 3 + 2] = value;
  }
  const graph = createDefaultEffectGraph(createHalationParams({ strength: 0 }), 0x12345678).map((node) => {
    if (node.type === 'filmResolution') return { ...node, params: createFilmResolutionParams({ amount: 0 }) };
    if (node.type === 'grain') return { ...node, params: createGrainParams({ amount: 0, seed: 0x12345678 }) };
    return node;
  });
  const source = {
    display: { width, height, rgb, alpha },
    effect: { width, height, rgb, alpha },
    cacheKey: 'native-inspection-tile',
    originX: 123,
    originY: 456,
    previewScale: 1,
    effectPreviewScale: 1,
    outputCrop: { x: 2, y: 1, width: 4, height: 3 },
  };
  const trc = { display: TRC, effect: TRC };
  const result = await renderPreviewIncremental(
    { width: 3000, height: 2000 },
    { format: { gauge: '35mm', iso: 250 }, graph },
    trc,
    null,
    source,
    { returnDataUrl: false },
  );
  assert.equal(result.width, 4);
  assert.equal(result.height, 3);
  assert.equal(result.cache.graphResult.width, width, 'effect support tile remains padded in cache');
  const decoded = PNG.sync.read(Buffer.from(result.png));
  assert.equal(decoded.width, 4);
  assert.equal(decoded.height, 3);
  const sourcePixel = (1 * width + 2) * 3;
  assert.ok(Math.abs(decoded.data[0] - Math.round(rgb[sourcePixel] * 255)) <= 1);
});

test('100% preview keeps the Photoshop color-managed Source as its visible base', async () => {
  const width = 6;
  const height = 4;
  const displayRgb = new Float32Array(width * height * 3);
  const nativeRgb = new Float32Array(width * height * 3);
  const alpha = new Float32Array(width * height).fill(1);
  for (let i = 0; i < width * height; i++) {
    displayRgb[i * 3] = 0.62;
    displayRgb[i * 3 + 1] = 0.48;
    displayRgb[i * 3 + 2] = 0.31;
    // Deliberately different native-profile numeric values. They may feed
    // Halation extraction, but must not replace the visible sRGB base.
    nativeRgb[i * 3] = 0.18;
    nativeRgb[i * 3 + 1] = 0.12;
    nativeRgb[i * 3 + 2] = 0.07;
  }
  const graph = createDefaultEffectGraph(createHalationParams({ strength: 0 }), 0x12345678);
  const source = {
    display: { width, height, rgb: displayRgb, alpha },
    effect: { width, height, rgb: nativeRgb, alpha },
    cacheKey: 'native-color-managed-base',
    previewScale: 1,
    effectPreviewScale: 1,
  };
  const nativeTrc = { decode: (value) => value, encode: (value) => value, baseKey: 'sRGB' };
  const result = await renderPreviewIncremental(
    { width: 2400, height: 1600 },
    { format: { gauge: '35mm', iso: 250 }, graph },
    { display: TRC, effect: nativeTrc },
    null,
    source,
    { returnDataUrl: false },
  );
  const decoded = PNG.sync.read(Buffer.from(result.png));
  assert.ok(Math.abs(decoded.data[0] - Math.round(displayRgb[0] * 255)) <= 1);
  assert.ok(Math.abs(decoded.data[1] - Math.round(displayRgb[1] * 255)) <= 1);
  assert.ok(Math.abs(decoded.data[2] - Math.round(displayRgb[2] * 255)) <= 1);
});

test('32-bit preview maps canonical HDR to an SDR PNG without changing render samples', async () => {
  const width = 2;
  const height = 1;
  const rgb = new Float32Array([
    0.18, 0.18, 0.18,
    4, 2, 1,
  ]);
  const alpha = new Float32Array([1, 1]);
  const graph = createDefaultEffectGraph(createHalationParams({ strength: 0 }), 0x12345678);
  const linearTrc = { decode: (value) => value, encode: (value) => value, baseKey: 'sRGB' };
  const result = await renderPreviewIncremental(
    { width, height, bitsPerChannel: 32 },
    { format: { gauge: '35mm', iso: 250 }, graph },
    { display: linearTrc, effect: linearTrc },
    null,
    {
      display: { width, height, rgb, alpha, componentSize: 32 },
      effect: { width, height, rgb, alpha, componentSize: 32 },
      cacheKey: 'hdr-to-sdr-panel',
      previewScale: 1,
      effectPreviewScale: 1,
    },
    { returnDataUrl: false },
  );
  const decoded = PNG.sync.read(Buffer.from(result.png));
  assert.ok(decoded.data[0] > 90 && decoded.data[0] < 140, `18% linear gray remains visible (${decoded.data[0]})`);
  assert.equal(decoded.data[4], 255, 'scene peak maps to SDR white');
  assert.ok(decoded.data[5] > decoded.data[6] && decoded.data[6] > 0, 'HDR channel ordering remains intact');
  assert.deepEqual(result.cache.graphResult.rgb, rgb, 'panel tone mapping does not alter canonical Preview/Apply samples');
});

test('100% Grain preview transfers the Apply-native gain onto the color-managed base', async () => {
  const width = 36;
  const height = 28;
  const rgb = new Float32Array(width * height * 3);
  const alpha = new Float32Array(width * height).fill(1);
  const nativeRgb = new Float32Array(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    const value = 0.08 + ((i * 37) % 101) / 180;
    rgb[i * 3] = value;
    rgb[i * 3 + 1] = value * 0.92;
    rgb[i * 3 + 2] = value * 0.81;
    nativeRgb[i * 3] = value * 0.42;
    nativeRgb[i * 3 + 1] = value * 0.37;
    nativeRgb[i * 3 + 2] = value * 0.29;
  }
  const graph = createDefaultEffectGraph(createHalationParams({ strength: 0 }), 0x9e3779b9)
    .map((node) => node.type === 'grain'
      ? {
        ...node,
        enabled: true,
        params: createGrainParams({ amount: 1.2, mode: 'analogue', seed: 0x9e3779b9 }),
      }
      : node);
  const source = {
    display: { width, height, rgb, alpha },
    effect: { width, height, rgb: nativeRgb, alpha },
    cacheKey: 'native-quality-grain',
    originX: 211,
    originY: 97,
    previewScale: 1,
    effectPreviewScale: 1,
    pixelRatio: 1.5,
  };
  const identityTrc = { decode: (value) => value, encode: (value) => value, baseKey: 'sRGB' };
  const document = { width: 2400, height: 1600 };
  const format = { gauge: '35mm', iso: 800 };
  const result = await renderPreviewIncremental(
    document,
    { format, graph },
    { display: identityTrc, effect: identityTrc },
    null,
    source,
    { returnDataUrl: false },
  );
  const resolutionNodes = graph.filter((node) => node.type === 'filmResolution');
  const grainNodes = graph.filter((node) => node.type === 'grain');
  const context = {
    width,
    height,
    fullWidth: document.width,
    fullHeight: document.height,
    originX: source.originX,
    originY: source.originY,
    previewScale: 1,
    format,
    quality: 'quality',
    seed: 0x9e3779b9,
  };
  const displayBeforeGrain = processFilmStages(
    { width, height, rgb, alpha },
    resolutionNodes,
    context,
  );
  const nativeBeforeGrain = processFilmStages(
    { width, height, rgb: nativeRgb, alpha },
    resolutionNodes,
    context,
  );
  const nativeGrained = processFilmStages(
    nativeBeforeGrain,
    grainNodes,
    context,
  );
  let rms = 0;
  for (let i = 0; i < displayBeforeGrain.rgb.length; i++) {
    const nativeBase = nativeBeforeGrain.rgb[i];
    const fullStrength = nativeBase === 0
      ? displayBeforeGrain.rgb[i]
      : displayBeforeGrain.rgb[i] * (nativeGrained.rgb[i] / nativeBase);
    const expected = displayBeforeGrain.rgb[i] + (fullStrength - displayBeforeGrain.rgb[i]) / source.pixelRatio;
    const delta = result.cache.graphResult.rgb[i] - expected;
    rms += delta * delta;
  }
  rms = Math.sqrt(rms / displayBeforeGrain.rgb.length);
  assert.ok(rms <= 1e-7, `native-gain preview/apply Grain RMS=${rms}`);

  // The old path recomputed the density envelope from the display pixels.
  // Deliberately different native values must therefore produce a measurable
  // result change while leaving the display baseline ICC-managed.
  const oldDisplayPath = processFilmStages(
    { width, height, rgb, alpha },
    grainNodes,
    {
      ...context,
    },
  );
  let oldPathRms = 0;
  for (let i = 0; i < oldDisplayPath.rgb.length; i++) {
    const delta = result.cache.graphResult.rgb[i] - oldDisplayPath.rgb[i];
    oldPathRms += delta * delta;
  }
  oldPathRms = Math.sqrt(oldPathRms / oldDisplayPath.rgb.length);
  assert.ok(oldPathRms > 1e-4, `regression fixture must distinguish the old display-based Grain path (${oldPathRms})`);
});

test('100% Grain tile matches the same region of a full-frame Apply render', async () => {
  const width = 52;
  const height = 40;
  const rgb = new Float32Array(width * height * 3);
  const alpha = new Float32Array(width * height).fill(1);
  for (let i = 0; i < width * height; i++) {
    const value = 0.06 + ((i * 53) % 137) / 220;
    rgb[i * 3] = value;
    rgb[i * 3 + 1] = value * 0.88;
    rgb[i * 3 + 2] = value * 0.73;
  }
  const graph = createDefaultEffectGraph(createHalationParams({ strength: 0 }), 0x6a09e667)
    .map((node) => node.type === 'grain'
      ? { ...node, enabled: true, params: createGrainParams({ amount: 1.1, mode: 'analogue', seed: 0x6a09e667 }) }
      : node);
  const document = { format: { gauge: '35mm', iso: 800 }, graph };
  const linearTrc = { decode: (value) => value, encode: (value) => value, baseKey: 'sRGB' };
  const applied = processTiledFilmWithTrc(
    { width, height, rgb, alpha },
    document,
    linearTrc,
    { tileThreshold: Number.MAX_SAFE_INTEGER, quality: 'quality', fullWidth: width, fullHeight: height },
  );
  const crop = { x: 13, y: 9, width: 24, height: 18 };
  const tileRgb = new Float32Array(crop.width * crop.height * 3);
  const tileAlpha = new Float32Array(crop.width * crop.height);
  for (let y = 0; y < crop.height; y++) {
    for (let x = 0; x < crop.width; x++) {
      const sourcePixel = (crop.y + y) * width + crop.x + x;
      const tilePixel = y * crop.width + x;
      tileRgb.set(rgb.subarray(sourcePixel * 3, sourcePixel * 3 + 3), tilePixel * 3);
      tileAlpha[tilePixel] = alpha[sourcePixel];
    }
  }
  const preview = await renderPreviewIncremental(
    { width, height },
    document,
    { display: linearTrc, effect: linearTrc },
    null,
    {
      display: { width: crop.width, height: crop.height, rgb: tileRgb, alpha: tileAlpha },
      effect: { width: crop.width, height: crop.height, rgb: tileRgb, alpha: tileAlpha },
      cacheKey: 'grain-apply-region',
      originX: crop.x,
      originY: crop.y,
      previewScale: 1,
      effectPreviewScale: 1,
    },
    { returnDataUrl: false },
  );
  let rms = 0;
  for (let y = 0; y < crop.height; y++) {
    for (let x = 0; x < crop.width; x++) {
      const appliedPixel = ((crop.y + y) * width + crop.x + x) * 3;
      const previewPixel = (y * crop.width + x) * 3;
      for (let channel = 0; channel < 3; channel++) {
        const delta = preview.cache.graphResult.rgb[previewPixel + channel] - applied.rgb[appliedPixel + channel];
        rms += delta * delta;
      }
    }
  }
  rms = Math.sqrt(rms / (crop.width * crop.height * 3));
  assert.ok(rms <= 1e-5, `100% preview/full Apply Grain RMS=${rms}`);
});

test('Apply output-row cropping encodes only the band core without changing samples', () => {
  const width = 29;
  const height = 23;
  const rgb = new Float32Array(width * height * 3);
  const alpha = new Float32Array(width * height);
  for (let i = 0; i < width * height; i++) {
    rgb[i * 3] = 0.02 + (i % 17) / 31;
    rgb[i * 3 + 1] = 0.04 + (i % 13) / 29;
    rgb[i * 3 + 2] = 0.01 + (i % 19) / 37;
    alpha[i] = (i % 11) / 10;
  }
  const graph = createDefaultEffectGraph(createHalationParams({ strength: 0 }), 7);
  const document = { format: { gauge: '35mm', iso: 250 }, graph };
  const linearTrc = { decode: (value) => value, encode: (value) => value, baseKey: 'sRGB' };
  const full = processTiledFilmWithTrc(
    { width, height, rgb, alpha },
    document,
    linearTrc,
    { tileThreshold: Number.MAX_SAFE_INTEGER, fullWidth: width, fullHeight: height },
  );
  const start = 6;
  const end = 18;
  const core = processTiledFilmWithTrc(
    { width, height, rgb, alpha },
    document,
    linearTrc,
    { tileThreshold: Number.MAX_SAFE_INTEGER, fullWidth: width, fullHeight: height, outputRows: { start, end } },
  );
  assert.equal(core.width, width);
  assert.equal(core.height, end - start);
  assert.deepEqual(core.rgb, full.rgb.slice(start * width * 3, end * width * 3));
  assert.deepEqual(core.alpha, full.alpha.slice(start * width, end * width));
});

test('100% Bloom is evaluated once and reused when only Grain parameters change', async () => {
  const width = 36;
  const height = 28;
  const displayRgb = new Float32Array(width * height * 3);
  const nativeRgb = new Float32Array(width * height * 3);
  const alpha = new Float32Array(width * height).fill(1);
  for (let i = 0; i < width * height; i++) {
    const base = 0.05 + (i % 23) / 37;
    displayRgb[i * 3] = base;
    displayRgb[i * 3 + 1] = base * 0.9;
    displayRgb[i * 3 + 2] = base * 0.75;
    nativeRgb[i * 3] = base * 1.08;
    nativeRgb[i * 3 + 1] = base * 0.94;
    nativeRgb[i * 3 + 2] = base * 0.8;
  }
  const makeDocument = (amount) => ({
    format: { gauge: '35mm', iso: 500 },
    graph: createDefaultEffectGraph(createHalationParams({ strength: 0 }), 0x12345678).map((node) => {
      if (node.type === 'bloom') return { ...node, enabled: true, params: createBloomParams({ radius: 0.5, amplify: 0.7 }) };
      if (node.type === 'grain') return { ...node, enabled: true, params: createGrainParams({ amount, seed: 0x12345678 }) };
      return node;
    }),
  });
  const linearTrc = { decode: (value) => value, encode: (value) => value, baseKey: 'sRGB' };
  const source = {
    display: { width, height, rgb: displayRgb, alpha },
    effect: { width, height, rgb: nativeRgb, alpha },
    cacheKey: 'native-bloom-grain-cache',
    previewScale: 1,
    effectPreviewScale: 1,
    originX: 0,
    originY: 0,
  };
  const first = await renderPreviewIncremental(
    { width, height },
    makeDocument(0.45),
    { display: linearTrc, effect: linearTrc },
    null,
    source,
    { returnDataUrl: false },
  );
  const cachedPreGrain = first.cache.nativeBeforeGrain;
  const firstOutput = new Float32Array(first.cache.graphResult.rgb);
  assert.ok(cachedPreGrain);
  assert.equal(first.cache.graphResult.stats.nodes.filter((node) => node.type === 'bloom').length, 1);
  const second = await renderPreviewIncremental(
    { width, height },
    makeDocument(1.15),
    { display: linearTrc, effect: linearTrc },
    first.cache,
    source,
    { returnDataUrl: false },
  );
  assert.equal(second.cache.nativeBeforeGrain, cachedPreGrain, 'unchanged Bloom/HP prefix is reused');
  assert.equal(second.cache.graphResult.stats.nodes.filter((node) => node.type === 'bloom').length, 1);
  assert.notDeepEqual(second.cache.graphResult.rgb, firstOutput);
});

test('100% V1.7 Defringe → Bloom → HP preview matches Apply canonical output', async () => {
  const width = 47;
  const height = 35;
  const rgb = new Float32Array(width * height * 3);
  const alpha = new Float32Array(width * height).fill(1);
  for (let i = 0; i < width * height; i += 1) {
    const value = 0.03 + ((i * 43) % 113) / 90;
    rgb[i * 3] = value * (i % 17 === 0 ? 1.7 : 1);
    rgb[i * 3 + 1] = value * 0.82;
    rgb[i * 3 + 2] = value * 0.68;
  }
  const graph = createDefaultEffectGraph(createHalationParams({ strength: 0 }), 0x12345678).map((node) => {
    if (node.type === 'defringe') return { ...node, enabled: true, params: createDefringeParams({ amount: 0.8, radiusPx: 1.5 }) };
    if (node.type === 'bloom') return { ...node, enabled: true, params: createBloomParams({ thresholdEV: -1, radius: 0.8, amplify: 0.75, saveLights: 0.25 }) };
    if (node.type === 'highlightProtection') return { ...node, enabled: true, params: createHighlightProtectionParams({ amount: 0.65, thresholdEV: 1 }) };
    return node;
  });
  const document = { format: { gauge: '35mm', iso: 250 }, graph };
  const linearTrc = { decode: (value) => value, encode: (value) => value, baseKey: 'sRGB' };
  const applied = processTiledFilmWithTrc(
    { width, height, rgb, alpha },
    document,
    linearTrc,
    { tileThreshold: Number.MAX_SAFE_INTEGER, quality: 'quality', fullWidth: width, fullHeight: height },
  );
  const preview = await renderPreviewIncremental(
    { width, height },
    document,
    { display: linearTrc, effect: linearTrc },
    null,
    {
      display: { width, height, rgb, alpha },
      effect: { width, height, rgb, alpha },
      cacheKey: 'v17-preview-apply',
      originX: 0,
      originY: 0,
      previewScale: 1,
      effectPreviewScale: 1,
    },
    { returnDataUrl: false },
  );
  let squaredError = 0;
  let maxDiff = 0;
  for (let i = 0; i < applied.rgb.length; i += 1) {
    const delta = preview.cache.graphResult.rgb[i] - applied.rgb[i];
    squaredError += delta * delta;
    maxDiff = Math.max(maxDiff, Math.abs(delta));
  }
  const rms = Math.sqrt(squaredError / applied.rgb.length);
  assert.ok(rms <= 1e-4, `V1.7 Preview/Apply RMS=${rms}`);
  assert.ok(maxDiff <= 1e-3, `V1.7 Preview/Apply max=${maxDiff}`);
  assert.equal(preview.cache.graphResult.alpha, alpha);
});
