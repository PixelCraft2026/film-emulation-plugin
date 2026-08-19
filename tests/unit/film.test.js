import { test } from 'node:test';
import assert from 'node:assert/strict';
import { processFilm, createHalationParams, ENGINE_VERSION, EFFECT_ORDER } from '../../src/core/index.js';

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
    () => processFilm(input, { graph: [{ id: 'g', type: 'grain', enabled: true, params: {} }] }),
    /not available/,
  );
  const controller = new AbortController();
  controller.abort();
  assert.throws(() => processFilm(input, { graph: [] }, { signal: controller.signal }), /cancelled/);
  assert.deepEqual(EFFECT_ORDER.slice(0, 3), ['defringe', 'vignette', 'halation']);
});
