// tests/unit/pngEncoder.test.js — UXP-safe, dependency-free preview PNG encoding.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PNG } from 'pngjs';
import { encodePNG, floatRgbaToPng, pngToDataUrl } from '../../src/ui/pngEncoder.js';

function asciiAt(bytes, offset, length) {
  let value = '';
  for (let i = 0; i < length; i++) value += String.fromCharCode(bytes[offset + i]);
  return value;
}

test('encodePNG works when the UXP runtime has no TextEncoder global', () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'TextEncoder');
  try {
    Object.defineProperty(globalThis, 'TextEncoder', {
      value: undefined,
      configurable: true,
      writable: true,
    });
    const png = encodePNG(1, 1, new Uint8Array([255, 64, 0, 128]));
    assert.deepEqual(Array.from(png.subarray(0, 8)), [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    assert.equal(asciiAt(png, 12, 4), 'IHDR');
    const decoded = PNG.sync.read(Buffer.from(png));
    assert.equal(decoded.width, 1);
    assert.equal(decoded.height, 1);
    assert.deepEqual(Array.from(decoded.data), [255, 64, 0, 128]);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'TextEncoder', descriptor);
    else delete globalThis.TextEncoder;
  }
});

test('float preview conversion clamps channels and produces a PNG data URL', () => {
  const png = floatRgbaToPng(1, 1, new Float32Array([-1, 0.5, 2, 1]));
  const url = pngToDataUrl(png);
  assert.match(url, /^data:image\/png;base64,/);
  assert.ok(url.length > 50);
});
