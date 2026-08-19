// @ts-nocheck
/**
 * ui/pngEncoder — 最小 PNG 编码器（零依赖，UXP 环境可用）。
 * 输出 RGBA 8-bit PNG，IDAT 用 zlib stored（无压缩）deflate 块。
 * 用途：预览图 → data URL 供 sp-image 显示（UXP 无 canvas/内置编码）。
 */

function adler32(data) {
  let a = 1;
  let b = 0;
  for (let i = 0; i < data.length; i++) {
    a = (a + data[i]) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
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
  const blocks = [];
  for (let off = 0; off < raw.length; off += 65535) {
    const n = Math.min(65535, raw.length - off);
    const b = new Uint8Array(5 + n);
    b[0] = off + n >= raw.length ? 1 : 0; // BFINAL
    b[1] = n & 0xff;
    b[2] = (n >> 8) & 0xff;
    b[3] = (~n) & 0xff;
    b[4] = ((~n) >> 8) & 0xff;
    b.set(raw.subarray(off, off + n), 5);
    blocks.push(b);
  }
  const total = 2 + blocks.reduce((s, b) => s + b.length, 0) + 4;
  const out = new Uint8Array(total);
  out.set(header, 0);
  let p = 2;
  for (const b of blocks) {
    out.set(b, p);
    p += b.length;
  }
  out.set(adler, p);
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
  const sig = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  // 每行前置 filter 0
  const raw = new Uint8Array(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
  }

  const idat = zlibStore(raw);
  const parts = [sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', new Uint8Array(0))];
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let p = 0;
  for (const part of parts) {
    out.set(part, p);
    p += part.length;
  }
  return out;
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

/** PNG bytes → data URL（sp-image src）。 */
export function pngToDataUrl(bytes) {
  // UXP 无 btoa；逐字节手工 base64
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out += chars[b0 >> 2];
    out += chars[((b0 & 3) << 4) | (b1 >> 4)];
    out += i + 1 < bytes.length ? chars[((b1 & 15) << 2) | (b2 >> 6)] : '=';
    out += i + 2 < bytes.length ? chars[b2 & 63] : '=';
  }
  return `data:image/png;base64,${out}`;
}
