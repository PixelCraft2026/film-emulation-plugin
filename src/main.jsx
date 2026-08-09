// @ts-nocheck
/**
 * Film Halation — Photoshop UXP plugin entry.
 * Phase 3：图像管线装配（硬编码参数 Apply），Phase 4 接入真实 UI。
 */
import { runProbe } from './capability/probe.jsx';
import { processHalation, createHalationParams } from './core/index.js';
import { readDocumentPixels, writeDocumentPixels } from './io/imageAccess.js';
import { resolveDocumentTRC, decodeToLinear, encodeFromLinear } from './io/colorPipeline.js';
import { ensureEffectLayer, activateLayer } from './io/layerOps.js';
import { runSmoke } from './smoke/smoke.jsx';

const ps = require('photoshop');
const app = ps.app;

/** Phase 3 硬编码参数（Phase 4 由 UI 接管）。 */
const HARDCODED_PARAMS = { strength: 100 };

/**
 * 对指定文档执行完整 Apply 管线（Phase 3/4 共用）。
 * 不包 executeAsModal（由调用方包裹，避免嵌套）；不吞异常：返回 { ok, error? }。
 * @param {object} [doc] 目标文档（默认活动文档）
 * @param {object} [paramsOverrides] HalationParams 覆盖
 * @param {{trc?:object,writeToSource?:boolean}} [opts] trc：显式 TRC 覆盖（默认 resolveDocumentTRC(doc)）；
 *   writeToSource：true 时直接写回源图层（冒烟用——PS 27 UXP imaging 不支持运行时新建图层，
 *   效果图层方案作为已知限制另行解决）
 * @returns {Promise<{ok:boolean,error?:string,applyMs?:number}>}
 */
async function applyHalation(doc = app.activeDocument, paramsOverrides = HARDCODED_PARAMS, opts = {}) {
  if (!doc) return { ok: false, error: 'No active document.' };
  try {
    const trc = opts.trc ?? resolveDocumentTRC(doc);
    const writeSize = doc.bitsPerChannel; // 8 | 16 | 32
    const t0 = Date.now();
    let step = 'read';
    try {
      // 源图层引用必须在 modal 内获取（modal 外引用在进入后失效）
      const sourceLayer = doc.activeLayers[0];
      // 1) 读取（32-bit 捕获全动态范围，含 HDR >1）
      const { width, height, rgb } = await readDocumentPixels(doc, { componentSize: 32 });
      // 2) 显示编码 → 线性
      step = 'decode';
      const linear = decodeToLinear(rgb, trc);
      // 3) 算法
      step = 'process';
      const params = createHalationParams(paramsOverrides);
      const out = processHalation({ width, height, rgb: linear }, params);
      // 4) 线性 → 显示编码
      step = 'encode';
      const display = encodeFromLinear(out.rgb, trc);
      // 5) 写回：writeToSource 直接写源图层（冒烟）；否则效果图层（PS 27 UXP 已知限制）
      step = opts.writeToSource ? 'write-source' : 'layer';
      const targetLayer = opts.writeToSource ? sourceLayer : await ensureEffectLayer(doc, sourceLayer);
      if (!opts.writeToSource) {
        step = 'activate';
        activateLayer(doc, targetLayer);
      }
      step = 'write';
      await writeDocumentPixels(doc, { width, height, rgb: display }, { componentSize: writeSize, layerID: targetLayer.id });
    } catch (e2) {
      throw new Error(`[step:${step}] ${e2.message || e2}`);
    }
    return { ok: true, applyMs: Date.now() - t0 };
  } catch (e) {
    console.error('[film-halation] apply failed: ' + (e && (e.stack || e.message || e)));
    return { ok: false, error: String(e && (e.stack || e.message || e)) };
  }
}

function createPanel() {
  const panel = document.createElement('sp-panel');
  const heading = document.createElement('sp-heading');
  heading.textContent = 'Film Halation';
  const body = document.createElement('sp-body');
  body.textContent = 'Phase 3 pipeline (hardcoded params).';
  const applyBtn = document.createElement('sp-button');
  applyBtn.textContent = 'Apply Halation';
  const probeBtn = document.createElement('sp-button');
  probeBtn.textContent = 'Run capability probe';
  const status = document.createElement('sp-body');
  status.textContent = 'Ready.';
  applyBtn.addEventListener('click', async () => {
    const r = await ps.core.executeAsModal(() => applyHalation(), { commandName: 'film-halation-apply' });
    status.textContent = r.ok ? `Applied (${r.applyMs}ms).` : `Failed: ${r.error}`;
  });
  probeBtn.addEventListener('click', async () => {
    probeBtn.disabled = true;
    try {
      const report = await runProbe();
      status.textContent = 'Probe done (see console / data folder).';
    } catch (e) {
      status.textContent = `Probe failed: ${e}`;
    } finally {
      probeBtn.disabled = false;
    }
  });
  panel.append(heading, body, applyBtn, probeBtn, status);
  return panel;
}

document.body.append(createPanel());

// Phase 3 临时：插件加载时自动跑真机冒烟（创建独立测试文档，完成后恢复活动文档）。
// Phase 4 移除（冒烟改为 UI 触发/测试脚本）。
(async () => {
  try {
    await runSmoke(applyHalation);
  } catch (e) {
    console.error('[film-halation] auto smoke failed: ' + e);
  }
})();
