/**
 * 生成 golden 基准输出（tests/golden/halation-default.json）。
 * 用法：npm run golden（或 node scripts/generate-golden.mjs）
 * 内容：确定性输入（tests/unit/golden-input.js）在默认参数下 quality/fast 两种
 * 模式的输出 hash，供 T5 golden 对比（回归检测算法变化）。
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { processHalation, createHalationParams } from '../src/core/index.js';
import { makeGoldenInput } from '../tests/unit/golden-input.js';

function fnv1a(bytes) {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

const input = makeGoldenInput();
// 非零强度：golden 必须捕获实际算法效果（identity 参数无回归检测价值）
const params = createHalationParams({ strength: 100 });
const golden = {
  params,
  width: input.width,
  height: input.height,
  inputHash: fnv1a(new Uint8Array(input.rgb.buffer)),
  outputHash: {},
  generatedAt: new Date().toISOString(),
};
for (const mode of ['quality', 'fast']) {
  const out = processHalation(input, createHalationParams({ ...params, diffusionMode: mode }));
  golden.outputHash[mode] = fnv1a(new Uint8Array(out.rgb.buffer));
}

const outPath = fileURLToPath(new URL('../tests/golden/halation-default.json', import.meta.url));
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(golden, null, 2) + '\n', 'utf8');
console.log(`golden written: ${outPath}`);
console.log(`input hash: ${golden.inputHash}`);
console.log(`output hashes: quality=${golden.outputHash.quality} fast=${golden.outputHash.fast}`);
