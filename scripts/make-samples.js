/**
 * 合成四类视觉验证样张（程序化，确定性）→ tests/visual/samples/。
 * 用法：node scripts/make-samples.js
 * 样张：
 *  - v1-night.png   夜景：深蓝黑背景 + 暖色路灯（V-1 判据：红晕/暗侧/无整图红雾）
 *  - v2-sun.png     太阳：天空渐变 + 亮白太阳圆盘（V-2 判据：太阳周围红晕）
 *  - v3-window.png  窗对比：暗室内墙 + 明亮窗户（V-3 判据：窗缘红晕 + 暗侧保持）
 *  - v4-portrait.png 人像：暗背景 + 简单人像轮廓 + 头侧光（V-4 判据：人像边缘晕）
 * 均为 256×256 sRGB PNG（显示编码），由 render.js 消费。
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

const OUT = fileURLToPath(new URL('../tests/visual/samples', import.meta.url));
const SIZE = 256;

function makePng(paint) {
  const png = new PNG({ width: SIZE, height: SIZE });
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const [r, g, b] = paint(x, y);
      const i = (y * SIZE + x) * 4;
      png.data[i] = Math.max(0, Math.min(255, Math.round(r)));
      png.data[i + 1] = Math.max(0, Math.min(255, Math.round(g)));
      png.data[i + 2] = Math.max(0, Math.min(255, Math.round(b)));
      png.data[i + 3] = 255;
    }
  }
  return png;
}

const dist = (x1, y1, x2, y2) => Math.hypot(x1 - x2, y1 - y2);

// V-1 夜景：深蓝黑渐变 + 三盏暖色路灯（带光晕的亮圆点）
const night = makePng((x, y) => {
  let r = 8 + y * 0.04;
  let g = 10 + y * 0.04;
  let b = 18 + y * 0.06;
  const lamps = [
    [70, 130, 1.0, 0.85, 0.6],
    [150, 90, 0.95, 0.8, 0.55],
    [200, 170, 0.9, 0.75, 0.5],
  ];
  for (const [lx, ly, lr, lg, lb] of lamps) {
    const d = dist(x, y, lx, ly);
    if (d < 4) {
      r = lr * 255;
      g = lg * 255;
      b = lb * 255;
    } else if (d < 22) {
      const k = (1 - d / 22) * 0.9;
      r = Math.max(r, lr * 255 * k);
      g = Math.max(g, lg * 255 * k);
      b = Math.max(b, lb * 255 * k);
    }
  }
  return [r, g, b];
});

// V-2 太阳：天空渐变 + 白色太阳圆盘（HDR 感，接近 255 白）
const sun = makePng((x, y) => {
  const t = y / SIZE; // 0 顶部 → 1 底部
  let r = 90 + t * 60;
  let g = 120 + t * 60;
  let b = 190 + t * 20;
  const d = dist(x, y, 170, 80);
  if (d < 26) {
    r = 255;
    g = 250;
    b = 235;
  } else if (d < 40) {
    const k = (1 - (d - 26) / 14);
    r = Math.max(r, 255 * k + r * (1 - k));
    g = Math.max(g, 250 * k + g * (1 - k));
    b = Math.max(b, 235 * k + b * (1 - k));
  }
  return [r, g, b];
});

// V-3 窗对比：暗室内墙 + 明亮窗户
const window_ = makePng((x, y) => {
  let r = 22;
  let g = 24;
  let b = 30;
  if (x >= 100 && x <= 156 && y >= 70 && y <= 140) {
    // 亮窗
    r = 240;
    g = 250;
    b = 255;
  } else if (x >= 96 && x <= 160 && y >= 66 && y <= 144) {
    // 窗框渐变过渡
    r = 150;
    g = 160;
    b = 175;
  }
  return [r, g, b];
});

// V-4 人像：暗背景 + 简单人像（头 + 肩轮廓）+ 侧光
const portrait = makePng((x, y) => {
  let r = 14;
  let g = 16;
  let b = 22;
  // 头部（椭圆，中心 128,100）
  const headD = ((x - 128) / 42) ** 2 + ((y - 100) / 52) ** 2;
  // 肩部（椭圆，中心 128,190）
  const shoulderD = ((x - 128) / 78) ** 2 + ((y - 190) / 34) ** 2;
  if (shoulderD <= 1) {
    r = 60;
    g = 50;
    b = 52;
  }
  if (headD <= 1) {
    r = 190;
    g = 160;
    b = 140; // 肤色
  }
  // 侧光（左侧暖光）
  const side = Math.max(0, 1 - dist(x, y, 30, 90) / 160);
  if (headD <= 1) {
    r = Math.min(255, r + side * 40);
    g = Math.min(255, g + side * 20);
  }
  return [r, g, b];
});

mkdirSync(OUT, { recursive: true });
const files = {
  'v1-night.png': night,
  'v2-sun.png': sun,
  'v3-window.png': window_,
  'v4-portrait.png': portrait,
};
for (const [name, png] of Object.entries(files)) {
  const p = join(OUT, name);
  writeFileSync(p, PNG.sync.write(png));
  console.log(`sample written: ${p}`);
}
console.log(`samples dir: ${OUT}`);
