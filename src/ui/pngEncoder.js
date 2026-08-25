// @ts-nocheck
/**
 * ui/pngEncoder — 最小 PNG 编码器（零依赖，UXP 环境可用）。
 * 输出 RGBA 8-bit PNG，IDAT 用 zlib stored（无压缩）deflate 块。
 * 用途：预览图 → data URL 供 sp-image 显示（UXP 无 canvas/内置编码）。
 */

function adler32(data) {
  let a = 1;
  let b = 0;
  // 5552 is the largest safe Adler-32 block for 32-bit accumulators.  Taking
  // the modulo once per block is much faster in UXP than once per byte.
  for (let offset = 0; offset < data.length; offset += 5552) {
    const end = Math.min(data.length, offset + 5552);
    for (let i = offset; i < end; i++) {
      a += data[i];
      b += a;
    }
    a %= 65521;
    b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let value = i;
    for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (0xedb88320 & -(value & 1));
    table[i] = value >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) c = CRC32_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (~c) >>> 0;
}

/** PNG chunk types are exactly four ASCII letters; avoid unavailable UXP TextEncoder. */
function chunkTypeBytes(type) {
  if (typeof type !== 'string' || type.length !== 4) {
    throw new TypeError('PNG chunk type must contain exactly four ASCII letters');
  }
  const bytes = new Uint8Array(4);
  for (let i = 0; i < 4; i++) {
    const code = type.charCodeAt(i);
    const isAsciiLetter = (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
    if (!isAsciiLetter) throw new TypeError('PNG chunk type must contain only ASCII letters');
    bytes[i] = code;
  }
  return bytes;
}

function chunk(type, data) {
  const len = new Uint8Array(4);
  new DataView(len.buffer).setUint32(0, data.length);
  const typeBytes = chunkTypeBytes(type);
  const crcBuf = new Uint8Array(typeBytes.length + data.length);
  crcBuf.set(typeBytes, 0);
  crcBuf.set(data, typeBytes.length);
  const crc = new Uint8Array(4);
  new DataView(crc.buffer).setUint32(0, crc32(crcBuf));
  const out = new Uint8Array(4 + typeBytes.length + data.length + 4);
  out.set(len, 0);
  out.set(typeBytes, 4);
  out.set(data, 8);
  out.set(crc, 4 + typeBytes.length + data.length);
  return out;
}

/** zlib stored（无压缩）deflate 数据。 */
function zlibStore(raw) {
  const header = new Uint8Array([0x78, 0x01]); // CMF/FLG：deflate, 无字典
  const adler = new Uint8Array(4);
  new DataView(adler.buffer).setUint32(0, adler32(raw));
  const blockCount = Math.ceil(raw.length / 65535);
  const out = new Uint8Array(2 + raw.length + blockCount * 5 + 4);
  out.set(header, 0);
  let target = 2;
  for (let off = 0; off < raw.length; off += 65535) {
    const n = Math.min(65535, raw.length - off);
    out[target] = off + n >= raw.length ? 1 : 0; // BFINAL
    out[target + 1] = n & 0xff;
    out[target + 2] = (n >> 8) & 0xff;
    out[target + 3] = (~n) & 0xff;
    out[target + 4] = ((~n) >> 8) & 0xff;
    out.set(raw.subarray(off, off + n), target + 5);
    target += 5 + n;
  }
  out.set(adler, target);
  return out;
}

function encodePNGChannels(width, height, pixels, components) {
  if (components !== 3 && components !== 4) throw new RangeError('PNG components must be RGB or RGBA');
  if (pixels.length !== width * height * components) throw new RangeError('PNG pixel buffer length does not match dimensions');
  const sig = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  ihdr[8] = 8;
  ihdr[9] = components === 4 ? 6 : 2;
  const rowBytes = width * components;
  const raw = new Uint8Array(height * (rowBytes + 1));
  for (let y = 0; y < height; y++) raw.set(pixels.subarray(y * rowBytes, (y + 1) * rowBytes), y * (rowBytes + 1) + 1);
  const idat = zlibStore(raw);
  const parts = [sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', new Uint8Array(0))];
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/**
 * 编码 RGBA 图像为 PNG 字节。
 * @param {number} width
 * @param {number} height
 * @param {Uint8Array} rgba 长度 width*height*4
 * @returns {Uint8Array} PNG 文件字节
 */
export function encodePNG(width, height, rgba) {
  return encodePNGChannels(width, height, rgba, 4);
}

/** RGBA Float32Array（0..1 显示编码）→ PNG bytes。 */
export function floatRgbaToPng(width, height, rgba) {
  const bytes = new Uint8Array(width * height * 4);
  for (let i = 0; i < bytes.length; i++) {
    const v = Math.round(rgba[i] * 255);
    bytes[i] = v < 0 ? 0 : v > 255 ? 255 : v;
  }
  return encodePNG(width, height, bytes);
}

/** Linear array of display-encoded RGB plus optional straight alpha -> PNG. */
export function floatRgbToPng(width, height, rgb, alpha) {
  const pixels = width * height;
  if (rgb.length !== pixels * 3) throw new RangeError('RGB preview buffer length does not match dimensions');
  if (alpha && alpha.length !== pixels) throw new RangeError('Alpha preview buffer length does not match dimensions');
  let components = 3;
  if (alpha) {
    for (let i = 0; i < pixels; i++) {
      if (alpha[i] < 1) {
        components = 4;
        break;
      }
    }
  }
  const bytes = new Uint8Array(pixels * components);
  const toByte = (value) => {
    const rounded = Math.round(value * 255);
    return rounded < 0 ? 0 : rounded > 255 ? 255 : rounded;
  };
  for (let i = 0; i < pixels; i++) {
    const source = i * 3;
    const target = i * components;
    bytes[target] = toByte(rgb[source]);
    bytes[target + 1] = toByte(rgb[source + 1]);
    bytes[target + 2] = toByte(rgb[source + 2]);
    if (components === 4) bytes[target + 3] = toByte(alpha[i]);
  }
  return encodePNGChannels(width, height, bytes, components);
}

/** PNG bytes → data URL（sp-image src）。 */
export function pngToDataUrl(bytes) {
  // UXP 无 btoa；逐字节手工 base64
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const chunks = [];
  for (let start = 0; start < bytes.length; start += 12288) {
    const end = Math.min(bytes.length, start + 12288);
    let out = '';
    for (let i = start; i < end; i += 3) {
      const b0 = bytes[i];
      const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
      const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
      out += chars[b0 >> 2];
      out += chars[((b0 & 3) << 4) | (b1 >> 4)];
      out += i + 1 < bytes.length ? chars[((b1 & 15) << 2) | (b2 >> 6)] : '=';
      out += i + 2 < bytes.length ? chars[b2 & 63] : '=';
    }
    chunks.push(out);
  }
  return `data:image/png;base64,${chunks.join('')}`;
}
