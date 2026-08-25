import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHalationPreset, extractHighlights } from '../../src/core/index.js';
import {
  PREVIEW_MAX_EDGE,
  PREVIEW_EFFECT_MAX_EDGE,
  downsampleBox,
  downsampleExtractedFields,
} from '../../src/io/preview.js';

test('preview uses a higher-resolution effect proxy than its display base', () => {
  assert.equal(PREVIEW_MAX_EDGE, 1024);
  assert.equal(PREVIEW_EFFECT_MAX_EDGE, 2048);
  assert.ok(PREVIEW_EFFECT_MAX_EDGE > PREVIEW_MAX_EDGE);
});

test('extract-before-downsample preserves a sub-preview highlight source', () => {
  const width = 4;
  const height = 4;
  const rgb = new Float32Array(width * height * 3);
  const center = (1 * width + 1) * 3;
  rgb[center] = 1;
  rgb[center + 1] = 1;
  rgb[center + 2] = 1;
  const p = createHalationPreset('tungsten-800');

  const averagedRgb = downsampleBox(rgb, width, height, 1, 1);
  const lateExtract = extractHighlights(
    { width: 1, height: 1, rgb: averagedRgb },
    p,
    { extraction: p.extraction, spillMix: p.spillMix },
  );
  assert.equal(lateExtract.W[0], 0, 'RGB-first 1024-style reduction loses the small highlight');

  const highExtract = extractHighlights(
    { width, height, rgb },
    p,
    { extraction: p.extraction, spillMix: p.spillMix },
  );
  const reduced = downsampleExtractedFields(highExtract, width, height, 1, 1);
  assert.ok(reduced.W[0] > 0, 'high-resolution extraction preserves source energy before reduction');
  assert.ok(Math.abs(reduced.U[0] - highExtract.U[1 * width + 1]) < 1e-6, 'strong-source classification is energy weighted');
});

test('preview reduction preserves compact-emitter authorization by area maximum', () => {
  const width = 8;
  const height = 8;
  const rgb = new Float32Array(width * height * 3).fill(0.04);
  const center = (3 * width + 3) * 3;
  rgb[center] = rgb[center + 1] = rgb[center + 2] = 1;
  const p = { ...createHalationPreset('standard'), sigmaUnits: 'pixels', sigma: 2 };
  const high = extractHighlights({ width, height, rgb }, p, { extraction: p.extraction, spillMix: p.spillMix });
  assert.ok(high.K && high.K.some((value) => value > 0), 'protected source expansion produces authorization support');
  const reduced = downsampleExtractedFields(high, width, height, 1, 1);
  assert.equal(reduced.K[0], Math.max(...high.K), 'isolated emitter support is not diluted by area averaging');
});
