/**
 * Phase 6 性能基准（Node 侧，A3/V-3 前置验证）：
 *  - 24MP（6000×4000）processHalation 计时（quality / fast，A3 渲染 <5s 目标）
 *  - 峰值内存测量（--expose-gc 运行，V-3：≤3 份 3n 全分辨率缓冲）
 * 运行：npm run bench（= node --expose-gc tests/bench/perf.js）
 */
import { processHalation, createHalationParams } from '../../src/core/index.js';

const W = 6000;
const H = 4000;
const N = W * H;

function fnv1a(bytes) {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

function buildInput() {
  const rgb = new Float32Array(N * 3);
  // 确定性图案：暗背景 + 若干高光点（含 HDR）
  for (let i = 0; i < N; i++) {
    const v = ((i * 2654435761) >>> 8) / 0xffffff * 0.05;
    rgb[i * 3] = v;
    rgb[i * 3 + 1] = v * 0.9;
    rgb[i * 3 + 2] = v * 0.8;
  }
  for (let k = 0; k < 200; k++) {
    const x = (k * 137) % W;
    const y = (k * 229) % H;
    const p = (y * W + x) * 3;
    rgb[p] = 2.0;
    rgb[p + 1] = 1.5;
    rgb[p + 2] = 1.0;
  }
  return { width: W, height: H, rgb };
}

function memMB() {
  if (global.gc) global.gc();
  return process.memoryUsage().heapUsed / (1024 * 1024);
}

const report = { size: `${W}x${H} (24MP)`, runs: {} };
const input = buildInput();
console.log('input built, bytes=', input.rgb.byteLength, `(${input.rgb.byteLength / 1024 / 1024} MB)`);

for (const mode of ['quality', 'fast']) {
  const params = createHalationParams({ strength: 100, diffusionMode: mode });
  const baseMem = memMB();
  const t0 = performance.now();
  const out = processHalation(input, params);
  const t1 = performance.now();
  const peakMem = memMB();
  report.runs[mode] = {
    ms: Math.round((t1 - t0) * 10) / 10,
    peakHeapMB: Math.round((peakMem - baseMem) * 10) / 10,
    outHash: fnv1a(new Uint8Array(out.rgb.buffer)),
  };
  console.log(`${mode}: ${report.runs[mode].ms}ms, Δheap=${report.runs[mode].peakHeapMB}MB, hash=${report.runs[mode].outHash}`);
}

// 理论缓冲：S/G/D/temp/out = 3n*2 + n*2 = 8n 通道 = 96MB @Float32
const theoreticalMB = (3 * N * 2 + N * 2) * 4 / (1024 * 1024);
report.theoreticalBuffersMB = Math.round(theoreticalMB * 10) / 10;
console.log(`theoretical buffer working set ≈ ${report.theoreticalBuffersMB} MB (S,G,D,temp,out)`);

const jsonPath = new URL('../performance-data.json', import.meta.url);
const { writeFileSync } = await import('node:fs');
writeFileSync(jsonPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
console.log(`report: ${jsonPath.pathname}`);
