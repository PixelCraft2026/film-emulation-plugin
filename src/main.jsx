// @ts-nocheck
/** Film Halation V1.5 — 非破坏性 UXP 编排。 */
import { createPanel } from './ui/panel.jsx';
import { renderPreviewIncremental } from './io/previewRender.js';
import { computePreviewScale } from './io/preview.js';
import { createHalationParams } from './core/index.js';
import { renderDocumentToLayer } from './io/streamRender.js';
import { resolveDocumentTRC, resolvePixelTRC, standardProfileName } from './io/colorPipeline.js';
import { readDocumentPixels } from './io/imageAccess.js';
import {
  EFFECT_LAYER_NAME,
  ensureEffectLayer,
  resolveTargetLayer,
  resolveLayerBinding,
  resolvePreviewSourceLayer,
  createLayerBinding,
  noTargetLayerMessage,
  isPixelLayer,
  unreadableLayerMessage,
  layerPixelBounds,
  unlockPixelLayer,
  resolveApplyTarget,
} from './io/layerOps.js';
import { STRINGS } from './ui/i18n.js';
import { saveParamsForDoc, loadParamsForDoc } from './storage/pluginStorage.js';
import { loadBundledWasm } from './io/wasmRuntime.js';

const ps = require('photoshop');
const app = ps.app;

loadBundledWasm().then((wasm) => {
  console.log(`[film-halation] compute backend: ${wasm.backend}${wasm.error ? ` (${wasm.error})` : ''}`);
});

let params = createHalationParams({ strength: 50 });
let documentState = {
  format: { gauge: '35mm', iso: 250 },
  bindings: { sourceLayer: null, targetLayer: null },
};

async function writeDiagFile(name, data) {
  try {
    const { localFileSystem } = require('uxp').storage;
    const folder = await localFileSystem.getDataFolder();
    const file = await folder.createFile(name, { overwrite: true });
    await file.write(JSON.stringify(data, null, 2));
  } catch (error) {
    console.error('[film-halation] diagnostic write failed: ' + error);
  }
}

let panel;
let img;
let status;
let applyBtn;
try {
  panel = createPanel({
    params,
    onParamsChange,
    onApply: runApply,
    onRebind: runRebind,
  });
  document.body.append(panel);
  ({ img, status, applyBtn } = panel.__handles);
} catch (error) {
  console.error('[film-halation] panel creation failed: ' + (error && (error.stack || error.message || error)));
  writeDiagFile('ui-error.json', { message: String(error), at: new Date().toISOString() });
  status = { textContent: '' };
  img = { removeAttribute() {}, src: '' };
  applyBtn = { disabled: false };
}

let taskChain = Promise.resolve();
function enqueueTask(fn) {
  const result = taskChain.then(fn);
  taskChain = result.catch((error) => console.warn('[film-halation] queued task failed: ' + error));
  return result;
}

function currentDoc() {
  return app.activeDocument;
}

let lastDocId = null;
setInterval(() => {
  const doc = currentDoc();
  const id = doc ? doc.id : null;
  if (id === lastDocId) return;
  lastDocId = id;
  img.removeAttribute('src');
  previewCache = null;
  documentState = { format: { gauge: '35mm', iso: 250 }, bindings: { sourceLayer: null, targetLayer: null } };
  if (!doc) {
    status.textContent = 'No active document.';
    return;
  }
  status.textContent = 'Document changed. Loading Film Halation state…';
  loadStoredParams(doc, id);
}, 750);

function onParamsChange(partial) {
  try {
    params = createHalationParams({ ...params, ...partial });
  } catch (error) {
    status.textContent = STRINGS.statusFailed(error.message);
    return;
  }
  schedulePreview();
}

let panelTimer = null;
function schedulePreview() {
  clearTimeout(panelTimer);
  panelTimer = setTimeout(() => enqueueTask(runPanelPreview), 80);
}

let previewCache = null;
async function boundPreviewSource(doc) {
  const binding = documentState.bindings.sourceLayer;
  const sourceLayer = resolvePreviewSourceLayer(doc, binding);
  if (!sourceLayer) {
    if (binding) throw new Error('The saved source binding is missing or ambiguous. Select the original pixel layer and click Rebind Source.');
    throw new Error(noTargetLayerMessage(doc));
  }
  if (!isPixelLayer(sourceLayer)) throw new Error(unreadableLayerMessage(sourceLayer));
  const bounds = layerPixelBounds(sourceLayer) ?? { left: 0, top: 0, right: doc.width, bottom: doc.height };
  const scale = computePreviewScale(bounds.right - bounds.left, bounds.bottom - bounds.top);
  const readOptions = {
    layerID: sourceLayer.id,
    layerName: sourceLayer.name,
    bounds,
    // Let Photoshop's ICC engine convert the document thumbnail to sRGB.
    // The panel PNG is untagged and is displayed as sRGB by UXP.
    colorProfile: standardProfileName('sRGB'),
  };
  let source;
  try {
    source = await readDocumentPixels(doc, {
      ...readOptions,
      componentSize: 8,
      targetSize: {
        width: Math.max(1, Math.round((bounds.right - bounds.left) * scale)),
        height: Math.max(1, Math.round((bounds.bottom - bounds.top) * scale)),
      },
    });
  } catch (error) {
    console.warn('[film-halation] preview targetSize read failed; retrying full resolution inside modal scope: ' + (error?.message || error));
    source = await readDocumentPixels(doc, { ...readOptions, componentSize: 32 });
  }
  source.cacheKey = `${doc.id}:${sourceLayer.id}:${bounds.left},${bounds.top},${bounds.right},${bounds.bottom}`;
  return source;
}

async function runPanelPreview() {
  const doc = currentDoc();
  if (!doc) return;
  try {
    const source = await ps.core.executeAsModal(async () => boundPreviewSource(doc), {
      commandName: 'film-halation-read-preview',
    });
    const trc = resolvePixelTRC(doc, source.colorProfile);
    const result = await renderPreviewIncremental(doc, params, trc, previewCache, source);
    previewCache = result.cache;
    img.src = result.dataUrl;
    status.textContent = STRINGS.statusPreviewed(result.ms);
  } catch (error) {
    status.textContent = STRINGS.statusFailed(error.message || error);
  }
}

async function runApply() {
  const doc = currentDoc();
  if (!doc) {
    status.textContent = 'No active document.';
    return;
  }
  status.textContent = STRINGS.statusRendering;
  applyBtn.disabled = true;
  try {
    const result = await enqueueTask(() => ps.core.executeAsModal(
      async () => renderToSafeCopy(doc, params, { allowCreate: true }),
      { commandName: 'film-halation-apply-safe-copy' },
    ));
    if (result.bindings) documentState.bindings = result.bindings;
    // 即使效果层创建或写入失败，也保存已经确认的源绑定，便于安全重试。
    await saveParamsForDoc(doc, params, documentState);
    if (!result.ok) {
      status.textContent = STRINGS.statusFailed(result.error);
      return;
    }
    previewCache = null;
    status.textContent = STRINGS.statusApplied(result.applyMs);
  } catch (error) {
    status.textContent = STRINGS.statusFailed(error.message || error);
  } finally {
    applyBtn.disabled = false;
  }
}

async function runRebind() {
  const doc = currentDoc();
  const selected = resolveTargetLayer(doc);
  if (!doc || !selected) {
    status.textContent = STRINGS.statusFailed(noTargetLayerMessage(doc));
    return;
  }
  let selectedName = '';
  try { selectedName = String(selected.name || ''); } catch (error) { /* ignore */ }
  if (!isPixelLayer(selected)) {
    status.textContent = STRINGS.statusFailed(unreadableLayerMessage(selected));
    return;
  }
  if (selectedName.startsWith(EFFECT_LAYER_NAME)) {
    status.textContent = STRINGS.statusFailed('Select the original pixel layer, not a Film Halation effect copy.');
    return;
  }
  documentState.bindings = {
    sourceLayer: createLayerBinding(selected, `source-${doc.id}`),
    targetLayer: null,
  };
  previewCache = null;
  await saveParamsForDoc(doc, params, documentState);
  status.textContent = STRINGS.statusRebound;
  enqueueTask(runPanelPreview);
}

async function renderToSafeCopy(doc, renderParams, options) {
  const started = Date.now();
  let sourceLayer = resolveLayerBinding(doc, documentState.bindings.sourceLayer);
  if (!sourceLayer) {
    if (documentState.bindings.sourceLayer) {
      return { ok: false, error: 'The saved source binding is missing or ambiguous. Select the original pixel layer and click Rebind Source.' };
    }
    const selected = resolveTargetLayer(doc);
    if (!selected) return { ok: false, error: noTargetLayerMessage(doc) };
    let selectedName = '';
    try { selectedName = String(selected.name || ''); } catch (error) { /* ignore */ }
    if (selectedName.startsWith(EFFECT_LAYER_NAME)) {
      return { ok: false, error: 'The selected layer looks like an effect copy, but its source binding is missing. Select the original pixel layer and retry.' };
    }
    if (!isPixelLayer(selected)) return { ok: false, error: unreadableLayerMessage(selected) };
    sourceLayer = selected;
  }
  const sourceBinding = createLayerBinding(sourceLayer);
  const savedTargetBinding = documentState.bindings.targetLayer;
  const { target: savedTarget, legacyTarget, recreate } = resolveApplyTarget(doc, savedTargetBinding);
  let targetLayer = savedTarget;
  if (recreate) console.warn('[film-halation] saved effect target is stale or legacy; creating a new isolated pixel target');
  if (!targetLayer && !options.allowCreate) return { ok: false, error: 'Safe preview target is not available.' };
  try {
    // Never reuse a stale binding token as a layer name; ensureEffectLayer
    // generates a new unique token when a replacement is required.
    targetLayer = targetLayer || await ensureEffectLayer(doc, sourceLayer, null);
  } catch (error) {
    return {
      ok: false,
      error: error.message || String(error),
      bindings: { sourceLayer: sourceBinding, targetLayer: null },
    };
  }
  if (targetLayer === sourceLayer) {
    return { ok: false, error: 'Safety check failed: source and target resolve to the same layer. Nothing was written.' };
  }

  unlockPixelLayer(targetLayer);
  const targetBinding = createLayerBinding(targetLayer, 'render-target-v1');
  const sourceBounds = layerPixelBounds(sourceLayer) ?? { left: 0, top: 0, right: doc.width, bottom: doc.height };
  try {
    const targetBounds = layerPixelBounds(targetLayer) ?? sourceBounds;
    const trc = resolveDocumentTRC(doc);
    await renderDocumentToLayer(doc, sourceLayer, targetLayer, sourceBounds, targetBounds, renderParams, trc, {
      componentSize: doc.bitsPerChannel,
      seed: 0x46534c4d,
      signal: options.signal,
    });
    if (legacyTarget && legacyTarget !== targetLayer) {
      try { legacyTarget.visible = false; } catch (error) { /* old failed target may be protected */ }
    }
    return {
      ok: true,
      applyMs: Date.now() - started,
      bindings: { sourceLayer: sourceBinding, targetLayer: targetBinding },
    };
  } catch (error) {
    return {
      ok: false,
      error: `Safe-copy render failed; the source was not modified. ${error.message || error}`,
      bindings: { sourceLayer: sourceBinding, targetLayer: targetBinding },
    };
  }
}

async function loadStoredParams(doc, expectedId = doc?.id) {
  if (!doc) return;
  try {
    const stored = await loadParamsForDoc(doc);
    if (!stored || currentDoc()?.id !== expectedId) {
      status.textContent = 'Ready. Select a pixel layer and adjust a slider.';
      return;
    }
    params = createHalationParams(stored.params);
    documentState = {
      format: stored.format || { gauge: '35mm', iso: 250 },
      bindings: stored.bindings || { sourceLayer: null, targetLayer: null },
    };
    panel.__handles.updateParams(params);
    status.textContent = 'Loaded Film Halation v2 state. Adjust a slider to preview.';
  } catch (error) {
    console.warn('[film-halation] state load failed: ' + error);
    status.textContent = STRINGS.statusFailed('Stored settings could not be loaded.');
  }
}

const initialDocument = currentDoc();
if (initialDocument) {
  loadStoredParams(initialDocument).catch((error) => console.warn('[film-halation] initial load failed: ' + error));
}
