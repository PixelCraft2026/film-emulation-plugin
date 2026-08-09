// @ts-nocheck
/**
 * Film Halation — Photoshop UXP plugin entry（Phase 4：完整 UI）。
 * 结构：core（纯算法）← io（宿主访问）← ui（视图）← main（装配/编排）。
 */
import { createPanel } from './ui/panel.jsx';
import { renderPreviewDataURL } from './io/previewRender.js';
import { createHalationParams, processHalation } from './core/index.js';
import { resolveDocumentTRC, decodeToLinear, encodeFromLinear } from './io/colorPipeline.js';
import { readDocumentPixels, writeDocumentPixels } from './io/imageAccess.js';
import { ensureEffectLayer, activateLayer } from './io/layerOps.js';
import { STRINGS } from './ui/i18n.js';

const ps = require('photoshop');
const app = ps.app;

/** 当前参数状态（UI 持有的单一 HalationParams 实例）。 */
let params = createHalationParams({ strength: 50 });

const panel = createPanel({
  params,
  onParamsChange: (partial) => onParamsChange(partial),
  onPreview: () => schedulePreview(),
  onApply: () => runApply(),
});
document.body.append(panel);
const { img, status, applyBtn } = panel.__handles;

// 文档/图层切换刷新（UXP 无直接事件，轻量轮询 activeDocument）
let lastDocId = null;
setInterval(() => {
  const doc = currentDoc();
  const id = doc ? doc.id : null;
  if (id !== lastDocId) {
    lastDocId = id;
    img.removeAttribute('src');
    if (doc) {
      status.textContent = 'Document changed. Previewing…';
      schedulePreview();
    } else {
      status.textContent = 'No active document.';
    }
  }
}, 1000);

function currentDoc() {
  return app.activeDocument;
}

function resolveTRC(doc) {
  return resolveDocumentTRC(doc);
}

/** 参数变更：更新状态 + debounce 预览（100ms）。 */
let previewTimer = null;
function onParamsChange(partial) {
  try {
    params = createHalationParams({ ...params, ...partial });
  } catch (e) {
    status.textContent = STRINGS.statusFailed(e.message);
    return;
  }
  schedulePreview();
}

function schedulePreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(runPreview, 100);
}

/** 预览：面板内显示（降采样 + fast，不触碰文档）。 */
async function runPreview() {
  const doc = currentDoc();
  if (!doc) {
    status.textContent = 'No active document.';
    return;
  }
  let trc;
  try {
    trc = resolveTRC(doc);
  } catch (e) {
    status.textContent = STRINGS.statusFailed(e.message);
    return;
  }
  status.textContent = STRINGS.statusRendering;
  try {
    const r = await ps.core.executeAsModal(() => renderPreviewDataURL(doc, params, trc), {
      commandName: 'film-halation-preview',
    });
    img.src = r.dataUrl;
    status.textContent = STRINGS.statusPreviewed(r.ms);
  } catch (e) {
    status.textContent = STRINGS.statusFailed(e.message);
  }
}

/** Apply：全分辨率 quality 渲染写回（PS 27 UXP 效果图层限制 → 临时写回源图层，可 Ctrl+Z 撤销）。 */
async function runApply() {
  const doc = currentDoc();
  if (!doc) {
    status.textContent = 'No active document.';
    return;
  }
  let trc;
  try {
    trc = resolveTRC(doc);
  } catch (e) {
    status.textContent = STRINGS.statusFailed(e.message);
    return;
  }
  status.textContent = STRINGS.statusRendering;
  applyBtn.disabled = true;
  try {
    const r = await ps.core.executeAsModal(() => applyHalation(doc, params, { trc }), {
      commandName: 'film-halation-apply',
    });
    status.textContent = r.ok ? STRINGS.statusApplied(r.applyMs) : STRINGS.statusFailed(r.error);
  } catch (e) {
    status.textContent = STRINGS.statusFailed(e.message);
  } finally {
    applyBtn.disabled = false;
  }
}

/**
 * 完整 Apply 管线（不包 executeAsModal，由调用方包裹）。
 * @param {object} doc
 * @param {object} params HalationParams（完整）
 * @param {{trc?:object,writeToSource?:boolean}} [opts]
 * @returns {Promise<{ok:boolean,error?:string,applyMs?:number}>}
 */
async function applyHalation(doc, params, opts = {}) {
  try {
    const trc = opts.trc ?? resolveTRC(doc);
    const writeSize = doc.bitsPerChannel;
    const t0 = Date.now();
    let step = 'read';
    try {
      const sourceLayer = doc.activeLayers[0];
      const { width, height, rgb } = await readDocumentPixels(doc, { componentSize: 32 });
      step = 'decode';
      const linear = decodeToLinear(rgb, trc);
      step = 'process';
      const out = processHalation({ width, height, rgb: linear }, params);
      step = 'encode';
      const display = encodeFromLinear(out.rgb, trc);
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
