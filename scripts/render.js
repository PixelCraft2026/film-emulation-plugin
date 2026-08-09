/**
 * 命令行渲染工具：PNG 图片 + 参数 JSON → 处理后 PNG（确定性）。
 * 用法：node scripts/render.js <input.png> <params.json> <output.png> [--mode quality|fast] [--trc sRGB|AdobeRGB|ProPhoto|linear]
 *
 * 说明：输入/输出均为显示编码（默认 sRGB，可用 --trc 指定）；管线在 core 的
 * 线性域进行（decode TRC → processHalation → encode TRC → clamp 写回）。
 * params.json 为 HalationParams 的部分覆盖（缺省用默认值）。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import { processHalation, createHalationParams, getTRC } from '../src/core/index.js';

function parseArgs(argv) {
  const args = { trc: 'sRGB', mode: null, files: [] };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--mode') args.mode = argv[++i];
    else if (a === '--trc') args.trc = argv[++i];
    else args.files.push(a);
  }
  if (args.files.length < 3) {
    throw new Error('usage: node scripts/render.js <input.png> <params.json> <output.png> [--mode quality|fast] [--trc NAME]');
  }
  return { input: args.files[0], paramsFile: args.files[1], output: args.files[2], ...args };
}

function pngToLinearFloat(png, trc) {
  const { width, height, data } = png;
  const n = width * height;
  const rgb = new Float32Array(n * 3);
  for (let i = 0, p = 0; i < n; i++, p += 3) {
    rgb[p] = trc.decode(data[i * 4] / 255);
    rgb[p + 1] = trc.decode(data[i * 4 + 1] / 255);
    rgb[p + 2] = trc.decode(data[i * 4 + 2] / 255);
  }
  return { width, height, rgb };
}

function linearFloatToPng(out, trc) {
  const { width, height, rgb } = out;
  const png = new PNG({ width, height });
  for (let i = 0, p = 0; i < width * height; i++, p += 3) {
    const r = trc.encode(rgb[p]);
    const g = trc.encode(rgb[p + 1]);
    const b = trc.encode(rgb[p + 2]);
    png.data[i * 4] = Math.round(Math.min(255, Math.max(0, r * 255)));
    png.data[i * 4 + 1] = Math.round(Math.min(255, Math.max(0, g * 255)));
    png.data[i * 4 + 2] = Math.round(Math.min(255, Math.max(0, b * 255)));
    png.data[i * 4 + 3] = 255;
  }
  return png;
}

function main() {
  const args = parseArgs(process.argv);
  const trc = getTRC(args.trc);
  const params = createHalationParams({
    ...JSON.parse(readFileSync(args.paramsFile, 'utf8').replace(/^\uFEFF/, '')),
    ...(args.mode ? { diffusionMode: args.mode } : {}),
  });
  const png = PNG.sync.read(readFileSync(args.input));
  const input = pngToLinearFloat(png, trc);
  const out = processHalation(input, params);
  const outPng = linearFloatToPng(out, trc);
  writeFileSync(args.output, PNG.sync.write(outPng));
  console.log(`render: ${args.input} -> ${args.output} (${png.width}x${png.height}, mode=${params.diffusionMode}, trc=${args.trc})`);
}

try {
  main();
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
