// @ts-nocheck
/** Film Halation V1.5 — 非破坏性 UXP 编排。 */
import { createPanel } from './ui/panel.jsx';
import { renderPreviewIncremental } from './io/previewRender.js';
import { PREVIEW_MAX_EDGE, PREVIEW_EFFECT_MAX_EDGE, computePreviewScale, downsampleBox, downsamplePlane } from './io/preview.js';
import { createHalationParams, createHalationPreset, createDefaultEffectGraph, createFilmResolutionParams, createGrainParams, deriveSeed, fmix32, SEED_GOLDEN_RATIO, normalizeFilmFormat } from './core/index.js';
import { renderDocumentToLayer, renderFilmDocumentToLayer, streamGeometry, streamFilmGeometry } from './io/streamRender.js';
import { resolveDocumentTRC, resolvePixelTRC, standardProfileName } from './io/colorPipeline.js';
import { readDocumentPixels } from './io/imageAccess.js';
import { documentComponentSize } from './io/bitDepth.js';
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
import { floatRgbToPng, pngToDataUrl } from './ui/pngEncoder.js';
import {
  saveParamsForDoc,
  loadParamsForDoc,
  exportMigrationState,
  prepareMigrationImport,
  commitMigrationImport,
} from './storage/pluginStorage.js';
import { loadBundledWasm } from './io/wasmRuntime.js';

const ps = require('photoshop');
const app = ps.app;
const BUILD_PLUGIN_ID = __FILM_PLUGIN_ID__;
const MIGRATION_ROLE = __FILM_MIGRATION_ROLE__;
const FEATURE_LEVEL = __FILM_FEATURE_LEVEL__;
const IS_CURRENT_BUILD = FEATURE_LEVEL === 'current';

loadBundledWasm().then((wasm) => {
  console.log(`[${BUILD_PLUGIN_ID}] feature=${FEATURE_LEVEL} compute backend: ${wasm.backend}${wasm.error ? ` (${wasm.error})` : ''}`);
});

let params = createHalationPreset('tungsten-800');
function createRuntimeDocument(halationParams, seed = 0x4f1bbcdc) {
  return {
    format: { gauge: '35mm', iso: 250 },
    graph: IS_CURRENT_BUILD
      ? createDefaultEffectGraph(halationParams, seed)
      : [{ id: 'halation-main', type: 'halation', enabled: true, params: createHalationParams(halationParams) }],
  };
}
let filmDocument = createRuntimeDocument(params);
let documentState = {
  format: { gauge: '35mm', iso: 250 },
  bindings: { sourceLayer: null, targetLayer: null },
};

function randomSeed(fingerprint = '') {
  const values = new Uint32Array(1);
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(values);
    return values[0] >>> 0;
  }
  return deriveSeed(0x4f1bbcdc, fingerprint, 'grain-main');
}

function setHalationParams(next) {
  params = createHalationParams(next);
  filmDocument = {
    ...filmDocument,
    graph: filmDocument.graph.map((node) => node.type === 'halation' ? { ...node, params } : node),
  };
}

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
let migrationBtn;
try {
  panel = createPanel({
    params,
    graph: filmDocument.graph,
    format: filmDocument.format,
    featureLevel: FEATURE_LEVEL,
    onParamsChange,
    onGraphChange,
    onFormatChange,
    onRandomizeGrain,
    onApply: runApply,
    onRebind: runRebind,
    migrationRole: MIGRATION_ROLE,
    onExportMigration: runExportMigration,
    onImportMigration: runImportMigration,
  });
  document.body.append(panel);
  ({ img, status, applyBtn, migrationBtn } = panel.__handles);
} catch (error) {
  console.error('[film-halation] panel creation failed: ' + (error && (error.stack || error.message || error)));
  writeDiagFile('ui-error.json', { message: String(error), at: new Date().toISOString() });
  status = { textContent: '' };
  img = { removeAttribute() {}, src: '' };
  applyBtn = { disabled: false };
  migrationBtn = { disabled: false };
}

let taskChain = Promise.resolve();
function enqueueTask(fn) {
  const result = taskChain.then(fn);
  taskChain = result.catch((error) => console.warn('[film-halation] queued task failed: ' + error));
  return result;
}

let previewObjectUrl = null;
function supportsPreviewObjectUrl() {
  return typeof Blob === 'function'
    && typeof URL !== 'undefined'
    && typeof URL.createObjectURL === 'function'
    && typeof URL.revokeObjectURL === 'function';
}

function releasePreviewObjectUrl() {
  if (!previewObjectUrl) return;
  try { URL.revokeObjectURL(previewObjectUrl); } catch (error) { /* host cleanup is best-effort */ }
  previewObjectUrl = null;
}

function clearPreviewImage() {
  img.removeAttribute('src');
  releasePreviewObjectUrl();
}

function publishPreviewImage(result, requestId) {
  if (supportsPreviewObjectUrl()) {
    try {
      const nextUrl = URL.createObjectURL(new Blob([result.png], { type: 'image/png' }));
      const previousUrl = previewObjectUrl;
      previewObjectUrl = nextUrl;
      img.onerror = () => {
        if (previewObjectUrl !== nextUrl || requestId !== previewRequestId) return;
        try { URL.revokeObjectURL(nextUrl); } catch (error) { /* ignore */ }
        previewObjectUrl = null;
        img.onerror = null;
        img.src = result.dataUrl || pngToDataUrl(result.png);
      };
      img.src = nextUrl;
      if (previousUrl) {
        try { URL.revokeObjectURL(previousUrl); } catch (error) { /* ignore */ }
      }
      return 'blob';
    } catch (error) {
      console.warn('[film-halation] Blob preview URL unavailable; using data URL fallback: ' + (error?.message || error));
    }
  }
  releasePreviewObjectUrl();
  img.onerror = null;
  img.src = result.dataUrl || pngToDataUrl(result.png);
  return 'data';
}

function immediateSourcePreviewPng(source) {
  const scale = computePreviewScale(source.width, source.height, PREVIEW_MAX_EDGE);
  if (scale >= 1) return floatRgbToPng(source.width, source.height, source.rgb, source.alpha);
  const width = Math.max(1, Math.round(source.width * scale));
  const height = Math.max(1, Math.round(source.height * scale));
  return floatRgbToPng(
    width,
    height,
    downsampleBox(source.rgb, source.width, source.height, width, height),
    source.alpha ? downsamplePlane(source.alpha, source.width, source.height, width, height) : undefined,
  );
}

function createPreviewAbortController() {
  if (typeof AbortController === 'function') return new AbortController();
  const signal = { aborted: false };
  return { signal, abort() { signal.aborted = true; } };
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
  previewRequestId++;
  previewAbortController?.abort();
  clearPreviewImage();
  previewCache = null;
  previewSourceCache = null;
  documentState = { format: { gauge: '35mm', iso: 250 }, bindings: { sourceLayer: null, targetLayer: null } };
  filmDocument = createRuntimeDocument(params, randomSeed(`document:${String(id ?? '')}`));
  if (!doc) {
    status.textContent = 'No active document.';
    return;
  }
  status.textContent = 'Document changed. Loading Film Halation state…';
  loadStoredParams(doc, id);
}, 750);

function onParamsChange(partial) {
  try {
    setHalationParams({ ...params, ...partial });
  } catch (error) {
    status.textContent = STRINGS.statusFailed(error.message);
    return;
  }
  schedulePreview();
}

function onGraphChange(nextGraph) {
  if (!IS_CURRENT_BUILD) return;
  filmDocument = { ...filmDocument, graph: nextGraph };
  schedulePreview();
}

function onFormatChange(partial) {
  if (!IS_CURRENT_BUILD) return;
  filmDocument = { ...filmDocument, format: normalizeFilmFormat({ ...filmDocument.format, ...partial }) };
  documentState.format = filmDocument.format;
  schedulePreview();
}

function onRandomizeGrain() {
  if (!IS_CURRENT_BUILD) return;
  filmDocument = {
    ...filmDocument,
    graph: filmDocument.graph.map((node) => node.type === 'grain'
      ? { ...node, params: createGrainParams({ ...node.params, seed: fmix32((node.params.seed + SEED_GOLDEN_RATIO) >>> 0) }) }
      : node),
  };
  panel.__handles.updateGraph(filmDocument.graph);
  schedulePreview();
}

let panelTimer = null;
let previewRequestId = 0;
let previewAbortController = null;
function schedulePreview() {
  clearTimeout(panelTimer);
  previewAbortController?.abort();
  const controller = createPreviewAbortController();
  previewAbortController = controller;
  const requestId = ++previewRequestId;
  panelTimer = setTimeout(
    () => enqueueTask(() => (requestId === previewRequestId && !controller.signal.aborted
      ? runPanelPreview(requestId, controller.signal)
      : undefined)),
    80,
  );
}

let previewCache = null;
let previewSourceCache = null;

function previewHistoryKey(doc) {
  try {
    const state = doc?.activeHistoryState;
    return state ? String(state.id ?? state.name ?? '') : '';
  } catch (error) {
    return '';
  }
}

async function readPreviewVariant(doc, readOptions, sourceWidth, sourceHeight, maxEdge, label) {
  const scale = computePreviewScale(sourceWidth, sourceHeight, maxEdge);
  if (scale >= 1) return readDocumentPixels(doc, readOptions);
  try {
    return await readDocumentPixels(doc, {
      ...readOptions,
      targetSize: {
        width: Math.max(1, Math.round(sourceWidth * scale)),
        height: Math.max(1, Math.round(sourceHeight * scale)),
      },
    });
  } catch (error) {
    console.warn(`[film-halation] ${label} targetSize read failed; retrying full resolution inside modal scope: ${error?.message || error}`);
    return readDocumentPixels(doc, readOptions);
  }
}

async function boundPreviewSources(doc) {
  const binding = documentState.bindings.sourceLayer;
  const sourceLayer = resolvePreviewSourceLayer(doc, binding);
  if (!sourceLayer) {
    if (binding) throw new Error('The saved source binding is missing or ambiguous. Select the original pixel layer and click Rebind Source.');
    throw new Error(noTargetLayerMessage(doc));
  }
  if (!isPixelLayer(sourceLayer)) throw new Error(unreadableLayerMessage(sourceLayer));
  const bounds = layerPixelBounds(sourceLayer) ?? { left: 0, top: 0, right: doc.width, bottom: doc.height };
  const sourceWidth = bounds.right - bounds.left;
  const sourceHeight = bounds.bottom - bounds.top;
  const componentSize = documentComponentSize(doc);
  const historyKey = previewHistoryKey(doc);
  const cacheKey = [
    doc.id,
    sourceLayer.id,
    bounds.left,
    bounds.top,
    bounds.right,
    bounds.bottom,
    componentSize,
    String(doc.colorProfileName || ''),
    historyKey,
  ].join(':');
  if (previewSourceCache?.cacheKey === cacheKey) return previewSourceCache;

  const nativeReadOptions = {
    layerID: sourceLayer.id,
    layerName: sourceLayer.name,
    bounds,
    componentSize,
  };
  // 1024px 底图由 Photoshop ICC 引擎转换到 sRGB，保证面板观感与画布一致。
  const display = await readPreviewVariant(
    doc,
    { ...nativeReadOptions, colorProfile: standardProfileName('sRGB') },
    sourceWidth,
    sourceHeight,
    PREVIEW_MAX_EDGE,
    'display preview',
  );
  // 2048px 效果代理不请求 profile 转换；后续使用与 Apply 相同的 TRC/primaries 路径，
  // 保留 Rec.2020 等宽色域中的高饱和峰值并在更高分辨率执行非线性提取。
  const effect = await readPreviewVariant(
    doc,
    nativeReadOptions,
    sourceWidth,
    sourceHeight,
    PREVIEW_EFFECT_MAX_EDGE,
    'effect-source preview',
  );
  previewSourceCache = {
    display,
    effect,
    cacheKey,
    documentID: doc.id,
    layerID: sourceLayer.id,
    historyKey,
    originX: bounds.left,
    originY: bounds.top,
  };
  return previewSourceCache;
}

async function runPanelPreview(requestId = null, signal = null) {
  const doc = currentDoc();
  if (!doc) return;
  if (signal?.aborted || (requestId !== null && requestId !== previewRequestId)) return;
  const renderParams = filmDocument;
  const totalStarted = Date.now();
  try {
    const readStarted = Date.now();
    const sources = await ps.core.executeAsModal(async () => boundPreviewSources(doc), {
      commandName: 'film-halation-read-preview',
    });
    const readMs = Date.now() - readStarted;
    if (signal?.aborted || (requestId !== null && requestId !== previewRequestId)) return;
    const sourceChanged = !previewCache || previewCache.sourceKey !== sources.cacheKey;
    if (sourceChanged && supportsPreviewObjectUrl()) {
      const basePng = immediateSourcePreviewPng(sources.display);
      publishPreviewImage({ png: basePng, dataUrl: null }, requestId ?? previewRequestId);
      status.textContent = STRINGS.statusPreviewRefining;
      // Let UXP paint the color-managed source before the heavier physical
      // effect proxy is processed on the main thread.
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (signal?.aborted || (requestId !== null && requestId !== previewRequestId)) return;
    }
    const trc = {
      display: resolvePixelTRC(doc, sources.display.colorProfile),
      effect: resolvePixelTRC(doc, sources.effect.colorProfile),
    };
    const objectUrl = supportsPreviewObjectUrl();
    const result = await renderPreviewIncremental(doc, renderParams, trc, previewCache, sources, {
      signal,
      returnDataUrl: !objectUrl,
    });
    if (signal?.aborted || (requestId !== null && requestId !== previewRequestId)) return;
    previewCache = result.cache;
    const transport = publishPreviewImage(result, requestId ?? previewRequestId);
    const totalMs = Date.now() - totalStarted;
    status.textContent = STRINGS.statusPreviewedDetailed(totalMs, readMs, result.ms);
    console.log('[film-halation] Panel preview timing', {
      totalMs,
      readMs,
      renderMs: result.ms,
      transport,
      pngBytes: result.png.length,
      ...result.timings,
    });
  } catch (error) {
    if (signal?.aborted || (requestId !== null && requestId !== previewRequestId)) return;
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
  clearTimeout(panelTimer);
  previewAbortController?.abort();
  try {
    const result = await enqueueTask(() => ps.core.executeAsModal(
      async () => renderToSafeCopy(doc, filmDocument, { allowCreate: true }),
      { commandName: 'film-halation-apply-safe-copy' },
    ));
    if (result.bindings) documentState.bindings = result.bindings;
    // 即使效果层创建或写入失败，也保存已经确认的源绑定，便于安全重试。
    await saveParamsForDoc(doc, params, { ...documentState, document: filmDocument });
    if (!result.ok) {
      status.textContent = STRINGS.statusFailed(result.error);
      return;
    }
    previewRequestId++;
    previewAbortController?.abort();
    previewCache = null;
    previewSourceCache = null;
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
  const cachedSourceIsSelected = previewSourceCache?.documentID === doc.id
    && previewSourceCache?.layerID === selected.id
    && previewSourceCache?.historyKey === previewHistoryKey(doc);
  documentState.bindings = {
    sourceLayer: createLayerBinding(selected, `source-${doc.id}`),
    targetLayer: null,
  };
  previewRequestId++;
  previewAbortController?.abort();
  if (!cachedSourceIsSelected) {
    previewCache = null;
    previewSourceCache = null;
  }
  await saveParamsForDoc(doc, params, { ...documentState, document: filmDocument });
  status.textContent = STRINGS.statusRebound;
  if (!cachedSourceIsSelected || !img.getAttribute?.('src')) schedulePreview();
}

async function runExportMigration() {
  status.textContent = STRINGS.statusMigrationExporting;
  if (migrationBtn) migrationBtn.disabled = true;
  try {
    const result = await exportMigrationState();
    if (result.cancelled) {
      status.textContent = 'Migration export cancelled.';
      return;
    }
    const invalidLabel = result.invalidEntries.length === 1 ? 'entry' : 'entries';
    status.textContent = `Exported ${result.exported} document state(s) to ${result.fileName}; ${result.invalidEntries.length} invalid cache ${invalidLabel} skipped. CRC32 ${result.crc32}.`;
  } catch (error) {
    status.textContent = STRINGS.statusFailed(error.message || error);
  } finally {
    if (migrationBtn) migrationBtn.disabled = false;
  }
}

async function runImportMigration() {
  status.textContent = STRINGS.statusMigrationImporting;
  if (migrationBtn) migrationBtn.disabled = true;
  try {
    // Keep the picker directly on the button call stack: UXP may require an
    // active user gesture for getFileForOpening/getFileForSaving.
    const plan = await prepareMigrationImport();
    if (plan.cancelled) {
      status.textContent = 'Migration import cancelled.';
      return;
    }
    if (plan.repeated) {
      status.textContent = `Migration package ${plan.parsed.crc32} was already imported. No state was changed.`;
      return;
    }
    const overwriteKeys = await panel.__handles.chooseMigrationConflicts(plan.conflicts);
    if (overwriteKeys === null) {
      status.textContent = 'Migration import cancelled; no state was changed.';
      return;
    }
    const result = await commitMigrationImport(plan, { overwriteKeys });
    const invalidLabel = result.invalid === 1 ? 'entry' : 'entries';
    status.textContent = `Imported ${result.imported} document state(s); ${result.preserved} existing state(s) preserved; ${result.invalid} invalid ${invalidLabel} skipped.`;
    const doc = currentDoc();
    if (doc) await loadStoredParams(doc, doc.id);
  } catch (error) {
    status.textContent = STRINGS.statusFailed(error.message || error);
  } finally {
    if (migrationBtn) migrationBtn.disabled = false;
  }
}

async function renderToSafeCopy(doc, renderDocument, options) {
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
  const sourceBounds = layerPixelBounds(sourceLayer) ?? { left: 0, top: 0, right: doc.width, bottom: doc.height };
  try {
    const preflight = IS_CURRENT_BUILD
      ? streamFilmGeometry(sourceBounds.right - sourceBounds.left, sourceBounds.bottom - sourceBounds.top, renderDocument, {
          componentSize: doc.bitsPerChannel,
          fullWidth: Number(doc.width),
          fullHeight: Number(doc.height),
          deviceMemoryGB: Number(globalThis.navigator?.deviceMemory ?? 0),
          memoryMode: 'auto',
        })
      : streamGeometry(sourceBounds.right - sourceBounds.left, sourceBounds.bottom - sourceBounds.top, renderDocument.graph.find((node) => node.type === 'halation').params, {
          componentSize: doc.bitsPerChannel,
          deviceMemoryGB: Number(globalThis.navigator?.deviceMemory ?? 0),
          memoryMode: 'auto',
        });
    if (preflight.hardBudgetExceeded) return { ok: false, error: `Film render preflight exceeds the ${Math.round(preflight.hardBudgetBytes / 1024 ** 3)} GiB hard memory budget; no effect layer was created.` };
  } catch (error) {
    return { ok: false, error: `Film render preflight failed; no effect layer was created. ${error.message || error}` };
  }
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
  try {
    const targetBounds = layerPixelBounds(targetLayer) ?? sourceBounds;
    const trc = resolveDocumentTRC(doc);
    const renderResult = IS_CURRENT_BUILD
      ? await renderFilmDocumentToLayer(doc, sourceLayer, targetLayer, sourceBounds, targetBounds, renderDocument, trc, {
          componentSize: doc.bitsPerChannel,
          seed: renderDocument.graph.find((node) => node.type === 'grain')?.params.seed ?? 0x46534c4d,
          signal: options.signal,
        })
      : await renderDocumentToLayer(doc, sourceLayer, targetLayer, sourceBounds, targetBounds, renderDocument.graph.find((node) => node.type === 'halation').params, trc, {
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
      render: renderResult,
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
    const storedGraph = stored.document?.graph;
    filmDocument = IS_CURRENT_BUILD && Array.isArray(storedGraph)
      ? { ...stored.document, graph: storedGraph }
      : createRuntimeDocument(params, randomSeed(`document:${String(doc.id ?? '')}`));
    documentState = {
      format: stored.format || { gauge: '35mm', iso: 250 },
      bindings: stored.bindings || { sourceLayer: null, targetLayer: null },
    };
    panel.__handles.updateParams(params);
    panel.__handles.updateGraph?.(filmDocument.graph);
    panel.__handles.updateFormat?.(filmDocument.format);
    status.textContent = 'Loaded Film Halation v2 state. Adjust a slider to preview.';
  } catch (error) {
    console.warn('[film-halation] state load failed: ' + error);
    status.textContent = STRINGS.statusFailed('Stored settings could not be loaded.');
  }
}

const initialDocument = currentDoc();
if (initialDocument) {
  filmDocument = createRuntimeDocument(params, randomSeed(`document:${String(initialDocument.id ?? '')}`));
  loadStoredParams(initialDocument).catch((error) => console.warn('[film-halation] initial load failed: ' + error));
}
