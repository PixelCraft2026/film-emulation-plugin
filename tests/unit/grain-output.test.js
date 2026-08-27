import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGrainParams, processFilmStages, processGrain } from '../../src/core/index.js';
import { encodeDisplayRgbaBuffer } from '../../src/io/imageAccess.js';

const WIDTH = 128;
const HEIGHT = 96;
const FORMAT = { gauge: '35mm', iso: 250 };
const CONTEXT = {
  fullWidth: 2490,
  fullHeight: 1660,
  originX: 137,
  originY: 83,
  previewScale: 1,
  format: FORMAT,
  quality: 'quality',
  nodeId: 'grain-main',
};

/** @param {[number, number, number]} color */
function uniformInput(color) {
  const rgb = new Float32Array(WIDTH * HEIGHT * 3);
  for (let i = 0; i < WIDTH * HEIGHT; i++) rgb.set(color, i * 3);
  return { width: WIDTH, height: HEIGHT, rgb };
}

/** @param {Float32Array} actual @param {Float32Array} source @param {number} channel */
function channelRms(actual, source, channel = 0) {
  let sum = 0;
  const pixels = source.length / 3;
  for (let i = 0; i < pixels; i++) {
    const delta = actual[i * 3 + channel] - source[i * 3 + channel];
    sum += delta * delta;
  }
  return Math.sqrt(sum / pixels);
}

test('chroma zero skips independent fields and cache hits generate no fields', () => {
  const input = uniformInput([0.18, 0.18, 0.18]);
  const params = createGrainParams({ chroma: 0, mode: 'analogue', seed: 0x12345678 });
  const sharedOnly = processGrain(input, params, CONTEXT);
  assert.equal(sharedOnly.stats.sharedFieldsGenerated, 3);
  assert.equal(sharedOnly.stats.independentFieldsGenerated, 0);
  assert.equal(sharedOnly.stats.fieldsGenerated, 3);
  for (let i = 0; i < WIDTH * HEIGHT; i++) {
    assert.equal(sharedOnly.rgb[i * 3], sharedOnly.rgb[i * 3 + 1]);
    assert.equal(sharedOnly.rgb[i * 3], sharedOnly.rgb[i * 3 + 2]);
  }

  const chromatic = processGrain(
    input,
    createGrainParams({ chroma: 1, mode: 'analogue', seed: 0x12345678 }),
    CONTEXT,
  );
  assert.equal(chromatic.stats.sharedFieldsGenerated, 3);
  assert.equal(chromatic.stats.independentFieldsGenerated, 9);
  assert.equal(chromatic.stats.fieldsGenerated, 12);

  const graphResult = processFilmStages(
    input,
    [{ id: 'grain-main', type: 'grain', enabled: true, params }],
    CONTEXT,
  );
  assert.equal(graphResult.stats.nodes[0].fieldsGenerated, 3);
  assert.equal(graphResult.stats.nodes[0].sharedFieldsGenerated, 3);
  assert.equal(graphResult.stats.nodes[0].independentFieldsGenerated, 0);

  const cache = {};
  const cachedContext = { ...CONTEXT, cache };
  const first = processGrain(input, params, cachedContext);
  const second = processGrain(input, params, cachedContext);
  assert.equal(first.stats.cacheHit, false);
  assert.equal(second.stats.cacheHit, true);
  assert.equal(second.stats.fieldsGenerated, 0);
  assert.deepEqual(second.rgb, first.rgb);
});

test('negative Grain envelope falls in highlights while absolute excursions still grow', () => {
  const params = createGrainParams({ chroma: 0, mode: 'analogue', seed: 0x9e3779b9 });
  const samples = [0.01, 0.12, 0.99].map((level) => {
    const input = uniformInput([level, level, level]);
    const result = processGrain(input, params, CONTEXT);
    const absoluteRms = channelRms(result.rgb, input.rgb);
    return { level, absoluteRms, relativeRms: absoluteRms / level };
  });
  assert.ok(samples[1].relativeRms > samples[2].relativeRms, JSON.stringify(samples));
  assert.ok(samples[1].absoluteRms > samples[0].absoluteRms, JSON.stringify(samples));
  assert.ok(samples[2].absoluteRms > samples[1].absoluteRms, JSON.stringify(samples));
});

test('neutral shared Grain preserves saturated RGB ratios before output quantization', () => {
  const input = uniformInput([0.02, 0.04, 0.8]);
  const result = processGrain(
    input,
    createGrainParams({ chroma: 0, mode: 'analogue', seed: 0x6a09e667 }),
    CONTEXT,
  );
  for (let i = 0; i < WIDTH * HEIGHT; i++) {
    const p = i * 3;
    assert.ok(Math.abs(result.rgb[p + 1] / result.rgb[p] - 2) <= 2e-6);
    assert.ok(Math.abs(result.rgb[p + 2] / result.rgb[p] - 40) <= 4e-5);
  }
});

test('integer output hard-clips highlight Grain while 32-bit and output rolloff retain headroom', () => {
  const input = uniformInput([0.99, 0.99, 0.99]);
  const result = processGrain(
    input,
    createGrainParams({ amount: 2, chroma: 0, mode: 'analogue', seed: 0xbb67ae85 }),
    { ...CONTEXT, format: { gauge: '35mm', iso: 800 } },
  );
  assert.ok(result.rgb.some((value) => value > 1), 'fixture must contain positive highlight excursions');
  assert.ok(result.rgb.some((value) => value < 0.99), 'fixture must contain negative highlight excursions');

  const image = { width: WIDTH, height: HEIGHT, rgb: result.rgb };
  const float32 = encodeDisplayRgbaBuffer(image, 32, { rolloff: 0, dither: false });
  const hard8 = encodeDisplayRgbaBuffer(image, 8, { rolloff: 0, dither: false });
  const hard16 = encodeDisplayRgbaBuffer(image, 16, { rolloff: 0, dither: false });
  const soft16 = encodeDisplayRgbaBuffer(image, 16, { rolloff: 0.5, dither: false });

  assert.ok(float32.some((value, index) => index % 4 !== 3 && value > 1));
  assert.ok(hard8.some((value, index) => index % 4 !== 3 && value === 255));
  assert.ok(hard16.some((value, index) => index % 4 !== 3 && value === 32768));
  assert.equal(soft16.some((value, index) => index % 4 !== 3 && value === 32768), false);
});
