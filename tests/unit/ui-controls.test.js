import test from 'node:test';
import assert from 'node:assert/strict';
import { sliderPositionToUnit, sliderUnitToPosition } from '../../src/ui/controls.js';

test('nonlinear slider mappings round-trip parameter coordinates', () => {
  for (const curve of ['linear', 'fine-min', 'fine-max']) {
    for (const unit of [0, 0.01, 0.1, 0.25, 0.5, 0.9, 0.99, 1]) {
      const position = sliderUnitToPosition(unit, curve, 2.2);
      const restored = sliderPositionToUnit(position, curve, 2.2);
      assert.ok(Math.abs(restored - unit) < 1e-12, `${curve} failed at ${unit}`);
    }
  }
});

test('sigma mapping gives the left edge finer control than a linear slider', () => {
  const smallMove = 0.05;
  assert.ok(sliderPositionToUnit(smallMove, 'fine-min', 2.2) < smallMove * 0.1);
  assert.equal(sliderPositionToUnit(0, 'fine-min', 2.2), 0);
  assert.equal(sliderPositionToUnit(1, 'fine-min', 2.2), 1);
});

test('threshold mapping gives the right edge finer control than a linear slider', () => {
  const position = 0.95;
  const remainingParameterRange = 1 - sliderPositionToUnit(position, 'fine-max', 2.2);
  assert.ok(remainingParameterRange < (1 - position) * 0.1);
  assert.equal(sliderPositionToUnit(0, 'fine-max', 2.2), 0);
  assert.equal(sliderPositionToUnit(1, 'fine-max', 2.2), 1);
});
