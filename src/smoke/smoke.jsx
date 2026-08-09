// @ts-nocheck
/**
 * Phase 3 真机冒烟（临时模块，Phase 4 移除）：
 * 对 8/16/32-bit 三种位深各创建独立测试文档（128×128，含高光点），
 * 执行完整 Apply 管线，验证：
 *  - A4：原图层像素 hash 不变；
 *  - A2：效果图层有非零输出（且非整图饱和，banding 相关信号）；
 *  - 各位深写回成功、耗时。
 * 结果写入插件数据文件夹 smoke-test.json（与 capability-report 同通道）。
 */
const ps = require('photoshop');
const app = ps.app;
const imaging = ps.imaging;
import { getTRC } from '../core/index.js';

function fnv1a(bytes) {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

async function hashLayerPixels(doc, layerID) {
  const { imageData } = await imaging.getPixels({
    layerID,
    sourceBounds: { left: 0, top: 0, right: doc.width, bottom: doc.height },
    colorSpace: 'RGB',
    componentSize: 32,
    applyAlpha: false,
  });
  const arr = await imageData.getData();
  imageData.dispose();
  return fnv1a(new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength));
}

/** 在测试文档背景层画高光点（直接 putPixels 32-bit）。 */
async function paintHighlight(doc) {
  const w = doc.width;
  const h = doc.height;
  const layerID = doc.activeLayers[0].id;
  const buf = new Float32Array(w * h * 4);
  const spots = [
    [64, 64, 1.5, 1.0, 0.8],
    [96, 40, 0.8, 0.6, 0.5],
  ];
  for (const [x, y, r, g, b] of spots) {
    const p = (y * w + x) * 4;
    buf[p] = r;
    buf[p + 1] = g;
    buf[p + 2] = b;
    buf[p + 3] = 1;
  }
  const imageData = await imaging.createImageDataFromBuffer(buf, {
    width: w,
    height: h,
    components: 4,
    colorSpace: 'RGB',
    colorProfile: 'sRGB IEC61966-2.1',
  });
  try {
    await imaging.putPixels({ layerID, imageData, replace: true, targetBounds: { left: 0, top: 0 } });
  } finally {
    imageData.dispose();
  }
}

/**
 * 冒烟主体（必须在 executeAsModal 内调用或自行包裹）。
 * @param {(doc, params) => Promise<void>} applyFn 完整 Apply 管线（main.jsx 注入）
 */
export async function runSmoke(applyFn) {
  const results = [];
  const prevDoc = app.activeDocument;

  for (const depth of [8, 16, 32]) {
    const entry = { depth };
    try {
      await ps.core.executeAsModal(async () => {
        const doc = await app.documents.add({
          width: 128,
          height: 128,
          resolution: 72,
          mode: 'RGBColorMode',
          depth,
          fill: 'black',
          profile: 'sRGB IEC61966-2.1',
        });
        try {
          await paintHighlight(doc);
          const srcLayer = doc.activeLayers[0];
          const srcHashBefore = await hashLayerPixels(doc, srcLayer.id);
          entry.diag = { beforeActive: doc.activeLayers[0]?.name, layerCount: doc.layers.length };
          const res = await applyFn(doc, { strength: 100 }, { trc: getTRC('sRGB'), writeToSource: true });
          entry.applyMs = res.applyMs;
          entry.diag.afterActive = doc.activeLayers[0]?.name;
          entry.diag.layerCountAfter = doc.layers.length;
          entry.diag.layerNames = Array.from({ length: doc.layers.length }, (_, i) => doc.layers[i].name);
          if (!res.ok) {
            entry.applyError = res.error;
          }
          const srcHashAfter = await hashLayerPixels(doc, srcLayer.id);
          entry.srcHashUnchanged = srcHashBefore === srcHashAfter; // A4（writeToSource 模式预期 false）

          // 输出检查：writeToSource 检查源图层；否则效果图层（A2 信号：有内容且非整图饱和）
          const checkLayer = srcLayer; // writeToSource 模式
          const { imageData } = await imaging.getPixels({
            layerID: checkLayer.id,
            sourceBounds: { left: 0, top: 0, right: doc.width, bottom: doc.height },
            colorSpace: 'RGB',
            componentSize: 32,
            applyAlpha: false,
          });
          const arr = await imageData.getData();
          imageData.dispose();
          let nonZero = 0;
          let maxV = 0;
          let sum = 0;
          for (let i = 0; i < arr.length; i += 3) {
            const v = arr[i];
            if (v > 0.001) nonZero++;
            if (v > maxV) maxV = v;
            sum += v;
          }
          const n = doc.width * doc.height;
          entry.output = {
            nonZeroRatio: nonZero / n,
            maxChannel: maxV,
            mean: sum / arr.length,
          };
          entry.ok = true;
        } finally {
          await doc.close({ save: false });
        }
      }, { commandName: 'film-halation-smoke' });
    } catch (e) {
      entry.ok = false;
      entry.error = String(e);
    }
    results.push(entry);
  }

  // 恢复原活动文档
  if (prevDoc) {
    try {
      app.activeDocument = prevDoc;
    } catch (_) {}
  }

  const report = {
    ts: new Date().toISOString(),
    psVersion: app.version,
    results,
  };
  const json = JSON.stringify(report, null, 2);
  console.log('[film-halation] smoke test:\n' + json);
  try {
    const { localFileSystem } = require('uxp').storage;
    const folder = await localFileSystem.getDataFolder();
    const file = await folder.createFile('smoke-test.json', { overwrite: true });
    await file.write(json);
    console.log('[film-halation] smoke test written to plugin data folder');
  } catch (e) {
    console.log('[film-halation] could not persist smoke report: ' + e);
  }
  return report;
}
