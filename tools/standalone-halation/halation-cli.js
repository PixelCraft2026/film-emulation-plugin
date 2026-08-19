// @ts-nocheck
/**
 * halation-cli — 独立胶片光晕（halation）批量处理程序（脱离 Photoshop 运行）。
 *
 * 用途：快速验证 core/ 核心图像算法的视觉效果。把本文件（连同 run.bat）放进
 * 一个图片文件夹，双击 run.bat 即可把该文件夹中的所有 JPG/PNG 图片处理成
 * halation 效果，并重命名保存（`<原名>_halation.<ext>`），不覆盖原图。
 *
 * 用法：
 *   node halation-cli.js                # 处理本文件所在目录的全部图片
 *   node halation-cli.js a.jpg b.png    # 只处理指定图片
 *   node halation-cli.js --strength 60  # 调整强度（0-100，默认 80）
 *
 * 色彩假设：输入图片按 sRGB 8-bit 处理（JPEG/PNG 照片的标准假设）——
 * 线性化 → 核心算法 → 编码回 sRGB。与插件对 8-bit 文档的路径一致。
 */
import path from 'node:path';
import fs from 'node:fs';
import pngjs from 'pngjs';
import jpeg from 'jpeg-js';
import { createHalationParams, getTRC } from '../../src/core/index.js';
import { processTiledWithTrc } from '../../src/io/tileRender.js';

const { PNG } = pngjs;
const TRC = getTRC('sRGB'); // decode/encode（processTiledWithTrc 带内使用）

const SUPPORTED = new Set(['.jpg', '.jpeg', '.png']);
const IMG_EXTS = ['jpg', 'jpeg', 'png'];

/** 解析命令行：`--key value` + 位置参数（图片路径）。 */
function parseArgs(argv) {
  const opts = { strength: 80, diffusionMode: 'fast', files: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--strength' && i + 1 < argv.length) {
      opts.strength = Number(argv[++i]);
    } else if (a === '--diffusion' && i + 1 < argv.length) {
      const v = String(argv[++i]).toLowerCase();
      if (v === 'quality' || v === 'fast') opts.diffusionMode = v;
    } else if (a.startsWith('--')) {
      console.warn(`[warn] unknown option: ${a}`);
    } else {
      opts.files.push(a);
    }
  }
  if (!Number.isFinite(opts.strength)) opts.strength = 80;
  opts.strength = Math.min(100, Math.max(0, opts.strength));
  return opts;
}

/** 解码图片 → { width, height, rgba: Uint8Array/Buffer } */
function decodeImage(buf, ext) {
  if (ext === '.png') {
    const png = PNG.sync.read(buf);
    return { width: png.width, height: png.height, rgba: png.data };
  }
  // jpeg-js 两个默认限制：maxResolutionInMP=100（100MP 上限）与 maxMemoryUsageInMB=512。
  // 131MP+ 大图会分别抛 "maxResolutionInMP limit exceeded" / "maxMemoryUsageInMB limit
  // exceeded"——一并提高（与 run.bat 的大堆匹配）。
  const j = jpeg.decode(buf, {
    useTArray: true,
    formatAsRGBA: true,
    maxResolutionInMP: 1024,
    maxMemoryUsageInMB: 8192,
  });
  return { width: j.width, height: j.height, rgba: j.data };
}

/** 编码为输出格式（jpg 质量 92，png 无压缩损失）→ Buffer */
function encodeImage(width, height, rgba, ext) {
  if (ext === '.png') {
    return PNG.sync.write({ width, height, data: Buffer.from(rgba) });
  }
  const out = jpeg.encode({ data: Buffer.from(rgba), width, height }, 92);
  return out.data; // jpeg.encode 返回 { data, width, height }，需取 .data
}

/**
 * 单张图片处理：RGBA 8-bit → 显示编码 float RGB → 核心算法（processTiledWithTrc，
 * 内部按图大小自动分块 + 带内 TRC）→ RGBA 8-bit。
 * @returns {{ms:number,rgba:Uint8Array}} 处理耗时（不含磁盘编解码）与结果像素
 */
function processImage(width, height, rgba) {
  const n = width * height;
  const rgb = new Float32Array(n * 3);
  for (let i = 0, p = 0; i < n; i++, p += 3) {
    rgb[p] = rgba[i * 4] / 255;
    rgb[p + 1] = rgba[i * 4 + 1] / 255;
    rgb[p + 2] = rgba[i * 4 + 2] / 255;
  }
  const t0 = Date.now();
  // 显示编码 → 分块/整图（带内 sRGB decode → 算法 → encode）→ 显示编码
  const display = processTiledWithTrc({ width, height, rgb }, params, TRC).rgb;
  const ms = Date.now() - t0;

  // 打包 RGBA（>1 的 HDR 编码值在 8-bit 写回时自然 clamp）
  const rgbaOut = new Uint8Array(n * 4);
  for (let i = 0, p = 0; i < n; i++, p += 3) {
    rgbaOut[i * 4] = clampByte(display[p] * 255);
    rgbaOut[i * 4 + 1] = clampByte(display[p + 1] * 255);
    rgbaOut[i * 4 + 2] = clampByte(display[p + 2] * 255);
    rgbaOut[i * 4 + 3] = 255;
  }
  return { ms, rgba: rgbaOut };
}

function clampByte(v) {
  return v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
}

/** 显式 GC（需要 node --expose-gc；不可用时静默跳过）。用于 encode 前回收大缓冲，降低峰值。 */
function forceGc() {
  if (typeof global.gc === 'function') global.gc();
}

/** 处理一张图片文件；失败打印原因并返回 false。 */
function handleFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const dir = path.dirname(filePath);
  const base = path.basename(filePath, ext);
  const outPath = path.join(dir, `${base}_halation${ext}`);
  try {
    const buf = fs.readFileSync(filePath);
    let width = 0;
    let height = 0;
    let rgba = null;
    ({ width, height, rgba } = decodeImage(buf, ext));
    const t0 = Date.now();
    const { ms: algoMs, rgba: outRgba } = processImage(width, height, rgba);
    rgba = null; // 解码缓冲可回收
    forceGc(); // 回收算法大缓冲（1.5GB 级），避免与编码阶段叠加
    const enc = encodeImage(width, height, outRgba, ext);
    forceGc();
    fs.writeFileSync(outPath, enc);
    console.log(
      `[ok] ${path.basename(filePath)} -> ${path.basename(outPath)} (${width}x${height}, algo ${algoMs}ms, total ${Date.now() - t0}ms)`,
    );
    return true;
  } catch (e) {
    console.error(`[fail] ${path.basename(filePath)}: ${e && (e.message || e)}`);
    return false;
  }
}

/** 扫描目录下所有支持的图片（顶层，不递归；跳过上次生成的结果文件避免链式累积）。 */
function listImagesInDir(dir) {
  return fs
    .readdirSync(dir)
    .filter((f) => SUPPORTED.has(path.extname(f).toLowerCase()) && !/_halation\.(jpg|jpeg|png)$/i.test(f))
    .map((f) => path.join(dir, f))
    .sort();
}

// ---- 入口 ----
const opts = parseArgs(process.argv.slice(2));
const params = createHalationParams({ strength: opts.strength, diffusionMode: opts.diffusionMode });

// 脚本所在目录：用户把本程序放进图片文件夹，扫描该文件夹。用 process.argv[1]
// （Node 入口文件路径）而非 import.meta.url——后者在 CJS bundle 中不可靠。
const scriptDir = path.dirname(process.argv[1]);
const files = opts.files.length > 0 ? opts.files : listImagesInDir(scriptDir);

console.log('=== Film Halation (standalone) ===');
console.log(`params: strength=${params.strength}, sigma=${params.sigma}, diffusion=${params.diffusionMode}`);
console.log(`files: ${files.length}`);

if (files.length === 0) {
  console.log(`No images found in ${scriptDir} (supported: ${IMG_EXTS.join('/')}).`);
  console.log('Put this program in the folder with your images, or pass image paths as arguments.');
  process.exit(1);
}

let okCount = 0;
for (const f of files) {
  if (handleFile(f)) okCount++;
}
console.log(`Done. ${okCount}/${files.length} processed. Outputs saved as *_halation.jpg/png in the same folder.`);
process.exit(okCount === files.length ? 0 : 1);
