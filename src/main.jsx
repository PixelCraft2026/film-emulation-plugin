// @ts-nocheck
/** Film Emulation V1.6 — 非破坏性 UXP 编排。 */
import { createPanel } from './ui/panel.jsx';
import { mergeIndependentGraphChange } from './ui/graphState.js';
import { displayScaleForPreview } from './ui/previewMode.js';
import { renderPreviewIncremental } from './io/previewRender.js';
import {
  PREVIEW_MAX_EDGE,
  PREVIEW_EFFECT_MAX_EDGE,
  computePreviewScale,
  cropInterleavedRgb,
  cropPreviewPlane,
  downsampleBox,
  downsamplePlane,
  inspectionReadBounds,
  inspectionVisibleBounds,
} from './io/preview.js';
import { createHalationParams, createHalationPreset, createDefaultEffectGraph, createFilmResolutionParams, createGrainParams, deriveSeed, fmix32, SEED_GOLDEN_RATIO, normalizeFilmFormat } from './core/index.js';
import { renderDocumentToLayer, renderFilmDocumentToLayer, streamGeometry, streamFilmGeometry } from './io/streamRender.js';
import { resolveDocumentTRC, resolvePixelTRC, standardProfileName } from './io/colorPipeline.js';
import { readDocumentPixels } from './io/imageAccess.js';
import { documentComponentSize } from './io/bitDepth.js';
import {
  isEffectLayerName,
  ensureEffectLayer,
  resolveTargetLayer,
  resolveLayerBinding,
  resolvePreviewSourceLayer,
  createLayerBinding,
  noTargetLayerMessage,
  isPixelLayer,
  unreadableLayerMessage,
  layerPixelBounds,
  normalizeEffectLayerPresentation,
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
    console.error('[film-emulation] diagnostic write failed: ' + error);
  }
}

let panel;
let img;
let sourceImg;
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
    onPreviewModeChange,
    onPreviewPan,
    onPreviewViewportChange,
    onApply: runApply,
    onRebind: runRebind,
    migrationRole: MIGRATION_ROLE,
    onExportMigration: runExportMigration,
    onImportMigration: runImportMigration,
  });
  document.body.append(panel);
  ({ img, sourceImg, status, applyBtn, migrationBtn } = panel.__handles);
} catch (error) {
  console.error('[film-emulation] panel creation failed: ' + (error && (error.stack || error.message || error)));
  writeDiagFile('ui-error.json', { message: String(error), at: new Date().toISOString() });
  status = { textContent: '' };
  img = { removeAttribute() {}, src: '' };
  sourceImg = { removeAttribute() {}, src: '' };
  applyBtn = { disabled: false };
  migrationBtn = { disabled: false };
}

async function refreshPreviewDisplayScale() {
  if (!panel?.__handles?.setPreviewPixelRatio) return false;
  const reported = panel.__handles.getReportedPreviewPixelRatio?.() ?? 1;
  let configurations = [];
  try {
    configurations = await ps.core.getDisplayConfiguration({ physicalResolution: true });
  } catch (error) {
    console.warn('[film-emulation] display scale query failed; using UXP ratio: ' + (error?.message || error));
  }
  const displayList = Array.isArray(configurations) ? configurations : [];
  const ratio = displayScaleForPreview(displayList, reported);
  const changed = panel.__handles.setPreviewPixelRatio(ratio);
  console.log('[film-emulation] preview display scale', {
    reportedRatio: reported,
    resolvedRatio: ratio,
    displays: displayList.map((display) => ({ scaleFactor: display.scaleFactor, isPrimary: display.isPrimary })),
  });
  return changed;
}

Promise.resolve()
  .then(() => refreshPreviewDisplayScale())
  .then((changed) => {
    if (changed && panel?.__handles?.getPreviewView?.().mode === 'actual') schedulePreview();
  })
  .catch((error) => console.warn('[film-emulation] preview display scale initialization failed: ' + (error?.message || error)));

let taskChain = Promise.resolve();
function enqueueTask(fn) {
  const result = taskChain.then(fn);
  taskChain = result.catch((error) => console.warn('[film-emulation] queued task failed: ' + error));
  return result;
}

const previewObjectUrls = { preview: null, source: null };
function supportsPreviewObjectUrl() {
  return typeof Blob === 'function'
    && typeof URL !== 'undefined'
    && typeof URL.createObjectURL === 'function'
    && typeof URL.revokeObjectURL === 'function';
}

function releasePreviewObjectUrl(target = 'preview') {
  const url = previewObjectUrls[target];
  if (!url) return;
  try { URL.revokeObjectURL(url); } catch (error) { /* host cleanup is best-effort */ }
  previewObjectUrls[target] = null;
}

function clearPreviewImage() {
  img.removeAttribute('src');
  sourceImg.removeAttribute('src');
  releasePreviewObjectUrl('preview');
  releasePreviewObjectUrl('source');
}

function publishPreviewImage(result, requestId, target = 'preview') {
  const element = target === 'source' ? sourceImg : img;
  const layoutWidth = Number(result.layoutWidth ?? result.width);
  const layoutHeight = Number(result.layoutHeight ?? result.height);
  if (layoutWidth > 0 && layoutHeight > 0) {
    panel?.__handles?.setPreviewPixelDimensions?.(target, layoutWidth, layoutHeight);
  }
  if (supportsPreviewObjectUrl()) {
    try {
      const nextUrl = URL.createObjectURL(new Blob([result.png], { type: 'image/png' }));
      const previousUrl = previewObjectUrls[target];
      previewObjectUrls[target] = nextUrl;
      element.onerror = () => {
        if (previewObjectUrls[target] !== nextUrl || requestId !== previewRequestId) return;
        try { URL.revokeObjectURL(nextUrl); } catch (error) { /* ignore */ }
        previewObjectUrls[target] = null;
        element.onerror = null;
        element.src = result.dataUrl || pngToDataUrl(result.png);
      };
      element.src = nextUrl;
      if (previousUrl) {
        try { URL.revokeObjectURL(previousUrl); } catch (error) { /* ignore */ }
      }
      return 'blob';
    } catch (error) {
      console.warn('[film-emulation] Blob preview URL unavailable; using data URL fallback: ' + (error?.message || error));
    }
  }
  releasePreviewObjectUrl(target);
  element.onerror = null;
  element.src = result.dataUrl || pngToDataUrl(result.png);
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

function inspectionSourcePreviewPng(source) {
  const crop = source.outputCrop ?? { x: 0, y: 0, width: source.display.width, height: source.display.height };
  return floatRgbToPng(
    crop.width,
    crop.height,
    cropInterleavedRgb(source.display.rgb, source.display.width, source.display.height, crop),
    cropPreviewPlane(source.display.alpha, source.display.width, source.display.height, crop),
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

let previewMode = 'fit';
let inspectionState = { centerX: null, centerY: null, pendingX: 0, pendingY: 0, viewportWidth: 512, viewportHeight: 512 };

let lastDocId = null;
setInterval(() => {
  const doc = currentDoc();
  const id = doc ? doc.id : null;
  if (id === lastDocId) return;
  lastDocId = id;
  previewRequestId++;
  previewAbortController?.abort();
  clearPreviewImage();
  clearPreviewCaches();
  inspectionState = { ...inspectionState, centerX: null, centerY: null, pendingX: 0, pendingY: 0 };
  documentState = { format: { gauge: '35mm', iso: 250 }, bindings: { sourceLayer: null, targetLayer: null } };
  filmDocument = createRuntimeDocument(params, randomSeed(`document:${String(id ?? '')}`));
  if (!doc) {
    status.textContent = 'No active document.';
    return;
  }
  status.textContent = 'Document changed. Loading Film Emulation state…';
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

function onGraphChange(nextGraph, changedType) {
  if (!IS_CURRENT_BUILD) return;
  filmDocument = {
    ...filmDocument,
    graph: mergeIndependentGraphChange(filmDocument.graph, nextGraph, changedType),
  };
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

function onPreviewModeChange(mode) {
  previewMode = mode === 'actual' ? 'actual' : 'fit';
  const view = panel?.__handles?.getPreviewView?.();
  if (view) inspectionState = { ...inspectionState, viewportWidth: view.width, viewportHeight: view.height };
  schedulePreview();
}

function onPreviewPan(delta) {
  if (previewMode !== 'actual') return;
  const dx = Number(delta.x || 0);
  const dy = Number(delta.y || 0);
  inspectionState = {
    ...inspectionState,
    centerX: Number.isFinite(inspectionState.centerX) ? inspectionState.centerX + dx : null,
    centerY: Number.isFinite(inspectionState.centerY) ? inspectionState.centerY + dy : null,
    pendingX: Number.isFinite(inspectionState.centerX) ? 0 : inspectionState.pendingX + dx,
    pendingY: Number.isFinite(inspectionState.centerY) ? 0 : inspectionState.pendingY + dy,
  };
  schedulePreview();
}

function onPreviewViewportChange(viewport) {
  if (previewMode !== 'actual') return;
  const width = Math.max(1, Math.floor(Number(viewport.width) || 1));
  const height = Math.max(1, Math.floor(Number(viewport.height) || 1));
  if (Math.abs(width - inspectionState.viewportWidth) < 2 && Math.abs(height - inspectionState.viewportHeight) < 2) return;
  inspectionState = { ...inspectionState, viewportWidth: width, viewportHeight: height };
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
const previewSourceCaches = new Map();

function clearPreviewCaches() {
  previewCache = null;
  previewSourceCache = null;
  previewSourceCaches.clear();
}

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
    console.warn(`[film-emulation] ${label} targetSize read failed; retrying full resolution inside modal scope: ${error?.message || error}`);
    return readDocumentPixels(doc, readOptions);
  }
}

async function boundPreviewSources(doc, view) {
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
  const actual = view?.mode === 'actual';
  let visibleBounds = null;
  let readBounds = bounds;
  let support = 0;
  if (actual) {
    visibleBounds = inspectionVisibleBounds(
      bounds,
      {
        x: (Number.isFinite(inspectionState.centerX) ? inspectionState.centerX : (bounds.left + bounds.right) / 2) + inspectionState.pendingX,
        y: (Number.isFinite(inspectionState.centerY) ? inspectionState.centerY : (bounds.top + bounds.bottom) / 2) + inspectionState.pendingY,
      },
      { width: view.width, height: view.height },
    );
    inspectionState = {
      ...inspectionState,
      centerX: visibleBounds.centerX,
      centerY: visibleBounds.centerY,
      pendingX: 0,
      pendingY: 0,
      viewportWidth: visibleBounds.width,
      viewportHeight: visibleBounds.height,
    };
    const supportPlan = streamFilmGeometry(sourceWidth, sourceHeight, filmDocument, {
      componentSize,
      fullWidth: Number(doc.width),
      fullHeight: Number(doc.height),
      previewScale: 1,
      quality: 'quality',
      memoryMode: 'balanced',
      deviceMemoryGB: Number(globalThis.navigator?.deviceMemory ?? 0),
    });
    support = supportPlan.overlap;
    readBounds = inspectionReadBounds(visibleBounds, bounds, support);
  }
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
    actual ? 'actual' : 'fit',
    readBounds.left,
    readBounds.top,
    readBounds.right,
    readBounds.bottom,
    visibleBounds?.left ?? '',
    visibleBounds?.top ?? '',
    visibleBounds?.right ?? '',
    visibleBounds?.bottom ?? '',
    actual ? 1 : 0,
  ].join(':');
  const cached = previewSourceCaches.get(cacheKey);
  if (cached) {
    previewSourceCache = cached;
    return cached;
  }

  const nativeReadOptions = {
    layerID: sourceLayer.id,
    layerName: sourceLayer.name,
    bounds: readBounds,
    componentSize,
  };
  // 100% inspection reads only the padded local tile at native resolution.
  // Fit mode retains Photoshop's 1024/2048 pyramid proxies.
  const readWidth = readBounds.right - readBounds.left;
  const readHeight = readBounds.bottom - readBounds.top;
  const display = actual
    ? await readDocumentPixels(doc, { ...nativeReadOptions, colorProfile: standardProfileName('sRGB') })
    : await readPreviewVariant(
      doc,
      { ...nativeReadOptions, colorProfile: standardProfileName('sRGB') },
      readWidth,
      readHeight,
      PREVIEW_MAX_EDGE,
      'display preview',
    );
  const effect = actual
    ? await readDocumentPixels(doc, nativeReadOptions)
    : await readPreviewVariant(
      doc,
      nativeReadOptions,
      readWidth,
      readHeight,
      PREVIEW_EFFECT_MAX_EDGE,
      'effect-source preview',
    );
  const outputCrop = visibleBounds
    ? {
      x: visibleBounds.left - readBounds.left,
      y: visibleBounds.top - readBounds.top,
      width: visibleBounds.width,
      height: visibleBounds.height,
    }
    : null;
  previewSourceCache = {
    display,
    effect,
    cacheKey,
    documentID: doc.id,
    layerID: sourceLayer.id,
    historyKey,
    originX: readBounds.left,
    originY: readBounds.top,
    previewScale: actual ? 1 : undefined,
    effectPreviewScale: actual ? 1 : undefined,
    pixelRatio: actual ? Number(view.pixelRatio || 1) : 1,
    outputCrop,
    visibleBounds,
    readBounds,
    support,
    mode: actual ? 'actual' : 'fit',
  };
  previewSourceCaches.set(cacheKey, previewSourceCache);
  while (previewSourceCaches.size > 6) previewSourceCaches.delete(previewSourceCaches.keys().next().value);
  return previewSourceCache;
}

async function runPanelPreview(requestId = null, signal = null) {
  const doc = currentDoc();
  if (!doc) return;
  if (signal?.aborted || (requestId !== null && requestId !== previewRequestId)) return;
  const view = panel?.__handles?.getPreviewView?.() ?? { mode: previewMode, width: 512, height: 512 };
  previewMode = view.mode === 'actual' ? 'actual' : 'fit';
  if (previewMode === 'actual') {
    inspectionState = { ...inspectionState, viewportWidth: view.width, viewportHeight: view.height };
  }
  const renderParams = filmDocument;
  const totalStarted = Date.now();
  try {
    const readStarted = Date.now();
    const sources = await ps.core.executeAsModal(async () => boundPreviewSources(doc, view), {
      commandName: 'film-halation-read-preview',
    });
    const readMs = Date.now() - readStarted;
    if (signal?.aborted || (requestId !== null && requestId !== previewRequestId)) return;
    const sourceChanged = !previewCache || previewCache.sourceKey !== sources.cacheKey;
    if (sourceChanged && (supportsPreviewObjectUrl() || sources.mode === 'actual')) {
      panel?.__handles?.resetPreviewPanVisual?.();
      const baseResult = sources.mode === 'actual'
        ? {
          png: inspectionSourcePreviewPng(sources),
          dataUrl: null,
          width: sources.outputCrop.width,
          height: sources.outputCrop.height,
        }
        : {
          png: immediateSourcePreviewPng(sources.display),
          dataUrl: null,
          width: sources.display.width,
          height: sources.display.height,
        };
      if (sources.mode === 'actual') publishPreviewImage(baseResult, requestId ?? previewRequestId, 'source');
      publishPreviewImage(baseResult, requestId ?? previewRequestId, 'preview');
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
    console.log('[film-emulation] Panel preview timing', {
      totalMs,
      readMs,
      renderMs: result.ms,
      transport,
      pngBytes: result.png.length,
      mode: sources.mode,
      pixelRatio: sources.pixelRatio,
      visibleBounds: sources.visibleBounds,
      support: sources.support,
      grain: (() => {
        const node = renderParams.graph?.find((item) => item.type === 'grain');
        return node ? {
          enabled: node.enabled !== false,
          seed: node.params?.seed,
          amount: node.params?.amount,
          size: node.params?.size,
          mode: node.params?.mode,
          profile: node.params?.profile,
          iso: renderParams.format?.iso,
          originX: sources.originX,
          originY: sources.originY,
        } : null;
      })(),
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
    console.log('[film-emulation] Apply render result', result.render);
    previewRequestId++;
    previewAbortController?.abort();
    clearPreviewCaches();
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
  if (isEffectLayerName(selectedName)) {
    status.textContent = STRINGS.statusFailed('Select the original pixel layer, not a Film Emulation effect copy.');
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
    clearPreviewCaches();
    inspectionState = { ...inspectionState, centerX: null, centerY: null, pendingX: 0, pendingY: 0 };
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
  let componentSize;
  try {
    componentSize = documentComponentSize(doc);
  } catch (error) {
    return { ok: false, error: `Film render preflight failed; no effect layer was created. ${error.message || error}` };
  }
  let sourceLayer = resolveLayerBinding(doc, documentState.bindings.sourceLayer);
  if (!sourceLayer) {
    if (documentState.bindings.sourceLayer) {
      return { ok: false, error: 'The saved source binding is missing or ambiguous. Select the original pixel layer and click Rebind Source.' };
    }
    const selected = resolveTargetLayer(doc);
    if (!selected) return { ok: false, error: noTargetLayerMessage(doc) };
    let selectedName = '';
    try { selectedName = String(selected.name || ''); } catch (error) { /* ignore */ }
    if (isEffectLayerName(selectedName)) {
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
          componentSize,
          fullWidth: Number(doc.width),
          fullHeight: Number(doc.height),
          deviceMemoryGB: Number(globalThis.navigator?.deviceMemory ?? 0),
          memoryMode: 'auto',
        })
      : streamGeometry(sourceBounds.right - sourceBounds.left, sourceBounds.bottom - sourceBounds.top, renderDocument.graph.find((node) => node.type === 'halation').params, {
          componentSize,
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
  if (recreate) console.warn('[film-emulation] saved effect target is stale or legacy; creating a new isolated pixel target');
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
  const targetPresentation = normalizeEffectLayerPresentation(
    targetLayer,
    ps.constants?.BlendMode?.NORMAL ?? 'normal',
  );
  console.log('[film-emulation] Apply target presentation', targetPresentation);
  const targetBinding = createLayerBinding(targetLayer, 'render-target-v1');
  try {
    const targetBounds = layerPixelBounds(targetLayer) ?? sourceBounds;
    const trc = resolveDocumentTRC(doc);
    const renderResult = IS_CURRENT_BUILD
      ? await renderFilmDocumentToLayer(doc, sourceLayer, targetLayer, sourceBounds, targetBounds, renderDocument, trc, {
          componentSize,
          seed: renderDocument.graph.find((node) => node.type === 'grain')?.params.seed ?? 0x46534c4d,
          signal: options.signal,
        })
      : await renderDocumentToLayer(doc, sourceLayer, targetLayer, sourceBounds, targetBounds, renderDocument.graph.find((node) => node.type === 'halation').params, trc, {
          componentSize,
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
    status.textContent = 'Loaded Film Emulation state. Adjust a slider to preview.';
  } catch (error) {
    console.warn('[film-emulation] state load failed: ' + error);
    status.textContent = STRINGS.statusFailed('Stored settings could not be loaded.');
  }
}

const initialDocument = currentDoc();
if (initialDocument) {
  filmDocument = createRuntimeDocument(params, randomSeed(`document:${String(initialDocument.id ?? '')}`));
  loadStoredParams(initialDocument).catch((error) => console.warn('[film-emulation] initial load failed: ' + error));
}
