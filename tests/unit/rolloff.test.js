import { test } from 'node:test';
import assert from 'node:assert/strict';
import { outputKnee, applyRolloff } from '../../src/io/rolloff.js';

test('output knee is identity below its shoulder and when disabled', () => {
  assert.equal(outputKnee(2, 0), 2);
  assert.equal(outputKnee(-0.5, 1), -0.5);
  assert.equal(outputKnee(0.75, 0.5), 0.75);
});

test('output knee is continuous, monotonic and asymptotic to one', () => {
  for (const rolloff of [0.1, 0.5, 1]) {
    const start = 1 - rolloff / 2;
    assert.ok(Math.abs(outputKnee(start + 1e-7, rolloff) - start) < 1e-6);
    let previous = start;
    for (const value of [start + 0.01, 1, 2, 10, 1e6]) {
      const current = outputKnee(value, rolloff);
      assert.ok(current > previous && current < 1, `${rolloff}: ${value} -> ${current}`);
      previous = current;
    }
  }
});

test('applyRolloff mutates and returns the same buffer', () => {
  const values = new Float32Array([0.2, 0.75, 1, 4]);
  const result = applyRolloff(values, 0.5);
  assert.equal(result, values);
  assert.ok(Math.abs(values[0] - 0.2) < 1e-6);
  assert.equal(values[1], 0.75);
  assert.ok(values[2] < 1 && values[3] < 1 && values[3] > values[2]);
});
