/**
 * tiles 几何划分纯函数测试：splitBands（渲染分带）与 splitBlocks（像素传输分块）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitBands, splitBlocks } from '../../src/io/tiles.js';

test('splitBlocks: covers all rows exactly once, each block <= maxPx', () => {
  // 32.7MP 图（用户 7008x4672 场景），每块 ≤4MP
  const maxPx = 4 * 1024 * 1024;
  const blocks = splitBlocks(7008, 4672, maxPx);
  const blockH = Math.floor(maxPx / 7008); // 598
  assert.equal(blocks.length, Math.ceil(4672 / blockH)); // 8 块
  let covered = 0;
  for (const b of blocks) {
    assert.ok(b.h > 0);
    assert.ok(b.h * 7008 <= maxPx, `block ${b.top} exceeds maxPx`);
    covered += b.h;
  }
  assert.equal(covered, 4672);
  // 相邻块无缝拼接
  for (let i = 1; i < blocks.length; i++) {
    assert.equal(blocks[i].top, blocks[i - 1].top + blocks[i - 1].h);
  }
});

test('splitBlocks: small image is a single block', () => {
  const maxPx = 4 * 1024 * 1024;
  // 3504x2336 = 8.18MP > 4MP → 2 块（blockH=1197）
  assert.equal(splitBlocks(3504, 2336, maxPx).length, 2);
  // 2MP < 4MP → 1 块
  assert.deepEqual(splitBlocks(2000, 1000, maxPx), [{ top: 0, h: 1000 }]);
});

test('splitBlocks: degenerate width keeps blockH >= 1', () => {
  const blocks = splitBlocks(4 * 1024 * 1024 + 1, 10, 4 * 1024 * 1024);
  assert.ok(blocks.length >= 1);
  let covered = 0;
  for (const b of blocks) covered += b.h;
  assert.equal(covered, 10);
});

test('splitBands: overlap crops keep effective area exact', () => {
  const bands = splitBands(100, 300, 64, 10);
  let covered = 0;
  for (const b of bands) {
    assert.ok(b.y0 >= b.start && b.y1 <= b.end);
    assert.equal(b.y1 - b.y0, b.crop1 - b.crop0);
    covered += b.y1 - b.y0;
  }
  assert.equal(covered, 300);
});
