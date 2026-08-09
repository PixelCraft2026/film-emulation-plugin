/**
 * Golden 测试共享输入：确定性生成的 32×32 线性 RGB 测试图。
 * 供 tests/unit/halation.test.js（T5 golden 对比）与 scripts/generate-golden.mjs 共用，
 * 保证生成与校验使用完全相同的输入。
 * 图案：暗背景 + 三个高光点（含 >1 HDR 值）+ 中亮度渐变。
 */

export function makeGoldenInput(width = 32, height = 32) {
  const rgb = new Float32Array(width * height * 3);
  // 渐变背景（确定性，基于像素坐标）
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = (y * width + x) * 3;
      const base = 0.02 + 0.05 * ((x + y) % 7) / 7;
      rgb[p] = base;
      rgb[p + 1] = base * 0.9;
      rgb[p + 2] = base * 0.8;
    }
  }
  // 三个高光点（中心、右上、左下）
  const spots = [
    [16, 16, 2.0, 1.2, 0.9], // HDR 高光
    [24, 8, 1.0, 0.6, 0.4],
    [6, 26, 0.9, 0.5, 0.3],
  ];
  for (const [x, y, r, g, b] of spots) {
    const p = (y * width + x) * 3;
    rgb[p] = r;
    rgb[p + 1] = g;
    rgb[p + 2] = b;
  }
  return { width, height, rgb };
}
