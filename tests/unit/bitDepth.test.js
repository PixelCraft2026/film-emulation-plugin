import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeComponentSize, documentComponentSize, clampPhotoshop16 } from '../../src/io/bitDepth.js';

test('Photoshop bit-depth enum strings map to numeric Imaging API component sizes', () => {
  assert.equal(normalizeComponentSize('bitDepth8'), 8);
  assert.equal(normalizeComponentSize('bitDepth16'), 16);
  assert.equal(normalizeComponentSize('bitDepth32'), 32);
  assert.equal(normalizeComponentSize(16), 16);
  assert.equal(documentComponentSize({ bitsPerChannel: 'bitDepth16' }), 16);
});

test('unknown bit depths fail closed instead of entering the Float32 path', () => {
  assert.throws(() => normalizeComponentSize('bitDepth24'), /Unsupported Photoshop component size/);
});

test('Photoshop 16-bit quantization clamps to the reduced 0..32768 range', () => {
  assert.equal(clampPhotoshop16(-1), 0);
  assert.equal(clampPhotoshop16(123.6), 124);
  assert.equal(clampPhotoshop16(32768), 32768);
  assert.equal(clampPhotoshop16(65535), 32768);
});
