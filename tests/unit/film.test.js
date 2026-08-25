import { test } from 'node:test';
import assert from 'node:assert/strict';
import { processFilm, processHalation, createHalationParams, ENGINE_VERSION, EFFECT_ORDER } from '../../src/core/index.js';

test('processFilm executes schema-v2 halation graph and preserves alpha', () => {
  const width = 8;
  const height = 8;
  const rgb = new Float32Array(width * height * 3).fill(0.2);
  const alpha = new Float32Array(width * height).fill(0.5);
  const document = {
    graph: [{ id: 'h1', type: 'halation', enabled: true, params: createHalationParams({ strength: 0 }) }],
  };
  const result = processFilm({ width, height, rgb, alpha }, document, {
    width,
    height,
    quality: 'fast',
    seed: 42,
  });
  assert.deepEqual(result.rgb, rgb);
  assert.deepEqual(result.alpha, alpha);
  assert.equal(result.stats.engineVersion, ENGINE_VERSION);
  assert.equal(result.stats.seed, 42);
  assert.equal(result.stats.nodes[0].type, 'halation');
});

test('processFilm rejects unavailable future nodes and cancellation', () => {
  const input = { width: 1, height: 1, rgb: new Float32Array(3) };
  assert.throws(
    () => processFilm(input, { graph: [{ id: 'g', type: 'bloom', enabled: true, params: {} }] }),
    /not available/,
  );
  const controller = new AbortController();
  controller.abort();
  assert.throws(() => processFilm(input, { graph: [] }, { signal: controller.signal }), /cancelled/);
  assert.deepEqual(EFFECT_ORDER.slice(0, 3), ['defringe', 'vignette', 'halation']);
});

test('graph-wide MTF quality does not override the serialized Halation diffusion mode', () => {
  const width = 19;
  const height = 13;
  const rgb = new Float32Array(width * height * 3).fill(0.03);
  const center = (6 * width + 9) * 3;
  rgb[center] = 2;
  rgb[center + 1] = 1.4;
  rgb[center + 2] = 0.8;
  const params = createHalationParams({ strength: 63, sigma: 3.5, diffusionMode: 'fast' });
  const direct = processHalation({ width, height, rgb }, params);
  const graph = processFilm(
    { width, height, rgb },
    { graph: [{ id: 'halation-main', type: 'halation', enabled: true, params }] },
    { fullWidth: width, fullHeight: height, quality: 'quality' },
  );
  assert.deepEqual(graph.rgb, direct.rgb);
});
