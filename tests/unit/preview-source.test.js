import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHalationPreset, extractHighlights } from '../../src/core/index.js';
import {
  PREVIEW_MAX_EDGE,
  PREVIEW_EFFECT_MAX_EDGE,
  cropInterleavedRgb,
  cropPreviewPlane,
  downsampleBox,
  downsampleExtractedFields,
  inspectionReadBounds,
  inspectionVisibleBounds,
} from '../../src/io/preview.js';
import {
  defaultPreviewModeForDomain,
  displayScaleForPreview,
  inspectionCssSize,
  inspectionImageLayout,
  inspectionViewportForCss,
  normalizePreviewPixelRatio,
} from '../../src/ui/previewMode.js';

test('preview uses a higher-resolution effect proxy than its display base', () => {
  assert.equal(PREVIEW_MAX_EDGE, 1024);
  assert.equal(PREVIEW_EFFECT_MAX_EDGE, 2048);
  assert.ok(PREVIEW_EFFECT_MAX_EDGE > PREVIEW_MAX_EDGE);
});

test('preview domains choose the requested default inspection mode', () => {
  assert.equal(defaultPreviewModeForDomain('halation'), 'fit');
  assert.equal(defaultPreviewModeForDomain('resolution'), 'actual');
  assert.equal(defaultPreviewModeForDomain('grain'), 'actual');
});

test('100% inspection compensates CSS pixels for the host device pixel ratio', () => {
  assert.equal(normalizePreviewPixelRatio(undefined), 1);
  assert.equal(normalizePreviewPixelRatio(0), 1);
  const viewport = inspectionViewportForCss(480, 520, 1.25);
  assert.deepEqual(viewport, { width: 600, height: 650, pixelRatio: 1.25 });
  assert.deepEqual(inspectionCssSize(viewport.width, viewport.height, viewport.pixelRatio), {
    width: 480,
    height: 520,
  });
  assert.deepEqual(inspectionImageLayout(viewport.width, viewport.height, viewport.pixelRatio), {
    width: 480,
    height: 520,
    objectFit: 'fill',
  });
});

test('100% inspection uses Photoshop display scale when UXP incorrectly reports one', () => {
  const displays = [
    { scaleFactor: 1, isPrimary: false },
    { scaleFactor: 1.5, isPrimary: true },
  ];
  assert.equal(displayScaleForPreview(displays, 1), 1.5);
  assert.equal(displayScaleForPreview(displays, 2), 2, 'a trustworthy per-panel UXP ratio wins');
  assert.equal(displayScaleForPreview([], 1), 1);
});

test('100% inspection starts centered and clamps panning to layer bounds', () => {
  const outer = { left: 100, top: 50, right: 1100, bottom: 650 };
  const centered = inspectionVisibleBounds(outer, {}, { width: 400, height: 300 });
  assert.deepEqual(centered, {
    left: 400, top: 200, right: 800, bottom: 500,
    centerX: 600, centerY: 350, width: 400, height: 300,
  });
  const corner = inspectionVisibleBounds(outer, { x: -999, y: 9999 }, { width: 400, height: 300 });
  assert.deepEqual(corner, {
    left: 100, top: 350, right: 500, bottom: 650,
    centerX: 300, centerY: 500, width: 400, height: 300,
  });
});

test('100% inspection expands graph support and crops RGB/alpha without resampling', () => {
  const visible = { left: 100, top: 80, right: 104, bottom: 83, width: 4, height: 3 };
  assert.deepEqual(
    inspectionReadBounds(visible, { left: 98, top: 79, right: 106, bottom: 85 }, 3),
    { left: 98, top: 79, right: 106, bottom: 85 },
  );
  const width = 4;
  const height = 3;
  const rgb = new Float32Array(width * height * 3);
  const alpha = new Float32Array(width * height);
  for (let i = 0; i < width * height; i++) {
    rgb[i * 3] = i;
    rgb[i * 3 + 1] = i + 0.25;
    rgb[i * 3 + 2] = i + 0.5;
    alpha[i] = i / 12;
  }
  const crop = { x: 1, y: 1, width: 2, height: 2 };
  assert.deepEqual(Array.from(cropInterleavedRgb(rgb, width, height, crop)), [
    5, 5.25, 5.5, 6, 6.25, 6.5,
    9, 9.25, 9.5, 10, 10.25, 10.5,
  ]);
  const alphaCrop = cropPreviewPlane(alpha, width, height, crop);
  const expectedAlpha = [5 / 12, 6 / 12, 9 / 12, 10 / 12];
  for (let i = 0; i < expectedAlpha.length; i++) assert.ok(Math.abs(alphaCrop[i] - expectedAlpha[i]) < 1e-6);
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
