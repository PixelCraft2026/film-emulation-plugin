import test from 'node:test';
import assert from 'node:assert/strict';
import { createHeavyBlurPlaceholder } from '../../src/io/previewPlaceholder.js';

test('heavy preview placeholder is tiny while retaining the source layout size', () => {
  const width = 320;
  const height = 180;
  const rgb = new Float32Array(width * height * 3).fill(0.5);
  const result = createHeavyBlurPlaceholder({ width, height, rgb });
  assert.equal(result.width, 40);
  assert.equal(result.height, 23);
  assert.equal(result.layoutWidth, width);
  assert.equal(result.layoutHeight, height);
  for (const value of result.rgb) assert.ok(Math.abs(value - 0.5) < 1e-6);
});

test('heavy preview placeholder spreads a compact source over neighbouring samples', () => {
  const width = 80;
  const height = 80;
  const rgb = new Float32Array(width * height * 3);
  const center = ((height / 2) * width + width / 2) * 3;
  rgb[center] = 1;
  rgb[center + 1] = 0.5;
  const result = createHeavyBlurPlaceholder({ width, height, rgb }, { maxEdge: 40, sigma: 2.4 });
  const outCenter = ((result.height / 2) * result.width + result.width / 2) * 3;
  assert.ok(result.rgb[outCenter] > 0);
  assert.ok(result.rgb[outCenter] < 0.25, 'compact detail is strongly defocused');
  assert.ok(result.rgb[outCenter + 3] > 0, 'Gaussian spreads energy to a neighbour');
});
