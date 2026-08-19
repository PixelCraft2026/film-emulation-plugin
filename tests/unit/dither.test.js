import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blueNoise, BLUE_NOISE_SIZE } from '../../src/core/index.js';

test('blue noise tile is deterministic, bounded and zero mean', () => {
  const values = [];
  for (let i = 0; i < BLUE_NOISE_SIZE * BLUE_NOISE_SIZE; i++) {
    const a = blueNoise(i, BLUE_NOISE_SIZE, 0, 12345);
    assert.equal(a, blueNoise(i, BLUE_NOISE_SIZE, 0, 12345));
    assert.ok(a >= -0.5 && a < 0.5, `noise ${a}`);
    values.push(a);
  }
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  assert.ok(Math.abs(mean) < 1e-8, `mean=${mean}`);
  assert.notDeepEqual(
    values.slice(0, 64),
    Array.from({ length: 64 }, (_, i) => blueNoise(i, 64, 1, 12345)),
    'RGB channels use decorrelated tile transforms',
  );
});
