// @ts-nocheck
/** Film Emulation V1.7 Public Beta 1 — 非破坏性 UXP 编排。 */
import { createPanel } from './ui/panel.jsx';
import { mergeIndependentGraphChange } from './ui/graphState.js';
import { displayScaleForPreview } from './ui/previewMode.js';
import { createDocumentLifecycle, shouldScheduleActivatedDocumentPreview } from './ui/documentLifecycle.js';
import { planUiLocaleChange } from './ui/languageTransition.js';
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
import { renderFilmDocumentToLayer, streamFilmGeometry } from './io/streamRender.js';
import { preparePanelPreviewSRGB, resolveDocumentTRC, resolveImagingPixelTRC, standardProfileName } from './io/colorPipeline.js';
import { readDocumentPixels } from './io/imageAccess.js';
import { createHeavyBlurPlaceholder } from './io/previewPlaceholder.js';
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
import { detectUiLocale, getStrings } from './ui/i18n.js';
import { floatRgbToPng, pngToDataUrl } from './ui/pngEncoder.js';
import { saveParamsForDoc, loadParamsForDoc } from './storage/pluginStorage.js';
import { loadUiPreferences, saveUiPreferences } from './storage/preferences.js';
import { loadBundledWasm } from './io/wasmRuntime.js';

const ps = require('photoshop');
const app = ps.app;
const BUILD_PLUGIN_ID = __FILM_PLUGIN_ID__;
const PACKAGE_VERSION = __FILM_PACKAGE_VERSION__;
const RELEASE_NAME = __FILM_RELEASE_NAME__;

function detectedHostLocale() {
  const candidates = [];
  try { candidates.push(app.locale); } catch (error) { /* optional host field */ }
  try {
    const uxp = require('uxp');
    candidates.push(uxp.host?.uiLocale, uxp.host?.locale);
  } catch (error) { /* optional host field */ }
  try { candidates.push(...(globalThis.navigator?.languages || []), globalThis.navigator?.language); } catch (error) { /* optional browser field */ }
  return detectUiLocale(candidates, 'en');
}

let uiLocale = detectedHostLocale();
let STRINGS = getStrings(uiLocale);
let runtimeBackend = 'loading';
// These session-only view values survive UI remounts (for example, a language switch).
let activeDomain = 'halation';
let previewMode = 'fit';

function runtimeBackendLabel() {
  if (runtimeBackend === 'wasm') return STRINGS.backendWasm;
  if (runtimeBackend === 'js') return STRINGS.backendJs;
  return STRINGS.backendLoading;
}

let params = createHalationPreset('tungsten-800');
function createRuntimeDocument(halationParams, seed = 0x4f1bbcdc) {
  return {
    format: { gauge: '35mm', iso: 250 },
    graph: createDefaultEffectGraph(halationParams, seed),
  };
}
let filmDocument = createRuntimeDocument(params);
let documentState = {
  format: { gauge: '35mm', iso: 250 },
  bindings: { sourceLayer: null, targetLayer: null },
};
// Session-scoped host policy, deliberately not serialized into document
// state. Auto remains conservative; High is an explicit 16 GiB+ opt-in for
// UXP builds that do not expose navigator.deviceMemory.
let applyMemoryMode = 'auto';

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

function mountPanel(options = {}) {
  const previous = panel;
  const preservePreview = options.preservePreview === true;
  const readImageSrc = (element) => element?.getAttribute?.('src') || element?.src || '';
  const preservedPreview = preservePreview && previous
    ? {
      view: previous.__handles?.getPreviewView?.(),
      loading: previous.__handles?.getPreviewLoading?.() === true,
      previewPixelRatio: previous.__handles?.getPreviewPixelRatio?.(),
      previewSrc: readImageSrc(img),
      sourceSrc: readImageSrc(sourceImg),
      previewWidth: Number(img?.naturalWidth || 0),
      previewHeight: Number(img?.naturalHeight || 0),
      sourceWidth: Number(sourceImg?.naturalWidth || 0),
      sourceHeight: Number(sourceImg?.naturalHeight || 0),
      statusText: status?.textContent || '',
      applyDisabled: applyBtn?.disabled === true,
    }
    : null;
  if (preservedPreview?.view?.domain) activeDomain = preservedPreview.view.domain;
  if (previous) {
    if (!preservePreview) {
      previewRequestId++;
      previewAbortController?.abort();
      clearPreviewImage();
    }
    previous.__handles?.dispose?.();
    previous.remove?.();
  }
  try {
    panel = createPanel({
      params,
      graph: filmDocument.graph,
      format: filmDocument.format,
      onParamsChange,
      onGraphChange,
      onFormatChange,
      onRandomizeGrain,
      onPreviewModeChange,
      onPreviewPan,
      onPreviewViewportChange,
      applyMemoryMode,
      onApplyMemoryModeChange: (mode) => { applyMemoryMode = mode; },
      onApply: runApply,
      onRebind: runRebind,
      locale: uiLocale,
      onLanguageChange: (nextLocale) => setUiLocale(nextLocale, true),
      initialDomain: activeDomain,
      initialPreviewMode: preservedPreview?.view?.mode,
      initialPreviewPixelRatio: preservedPreview?.previewPixelRatio,
      releaseInfo: { name: `${RELEASE_NAME} · ${STRINGS.windowsTestBuild}`, backend: runtimeBackendLabel() },
    });
    document.body.append(panel);
    ({ img, sourceImg, status, applyBtn } = panel.__handles);
    const restoredView = panel.__handles?.getPreviewView?.();
    if (restoredView) {
      activeDomain = restoredView.domain || activeDomain;
      previewMode = restoredView.mode === 'actual' ? 'actual' : 'fit';
    }
    if (preservedPreview) {
      if (preservedPreview.sourceSrc) sourceImg.src = preservedPreview.sourceSrc;
      if (preservedPreview.previewSrc) img.src = preservedPreview.previewSrc;
      if (preservedPreview.sourceWidth > 0 && preservedPreview.sourceHeight > 0) {
        panel.__handles.setPreviewPixelDimensions('source', preservedPreview.sourceWidth, preservedPreview.sourceHeight);
      }
      if (preservedPreview.previewWidth > 0 && preservedPreview.previewHeight > 0) {
        panel.__handles.setPreviewPixelDimensions('preview', preservedPreview.previewWidth, preservedPreview.previewHeight);
      }
      panel.__handles.setPreviewLoading(preservedPreview.loading, { useSource: false });
      if (preservedPreview.statusText) status.textContent = preservedPreview.statusText;
      applyBtn.disabled = preservedPreview.applyDisabled;
    }
    if (options.preview && currentDoc()) schedulePreview();
  } catch (error) {
    console.error('[film-emulation] panel creation failed: ' + (error && (error.stack || error.message || error)));
    writeDiagFile('ui-error.json', { message: String(error), at: new Date().toISOString() });
    status = { textContent: '' };
    img = { removeAttribute() {}, getAttribute() { return ''; }, src: '' };
    sourceImg = { removeAttribute() {}, src: '' };
    applyBtn = { disabled: false };
  }
}

function setUiLocale(nextLocale, persist = false) {
  const transition = planUiLocaleChange(uiLocale, nextLocale, {
    filmDocument,
    documentState,
    previewRequestId,
  });
  if (!transition.changed) return;
  uiLocale = transition.uiLocale;
  STRINGS = getStrings(uiLocale);
  // Language is presentation-only. Keep the current preview image/request alive;
  // rebuilding the labels must not enqueue another algorithm render.
  mountPanel({ preservePreview: true });
  if (persist) {
    saveUiPreferences({ uiLocale }).catch((error) => console.warn('[film-emulation] language preference save failed: ' + (error?.message || error)));
  }
}

mountPanel();

loadUiPreferences(uiLocale)
  .then((preferences) => setUiLocale(preferences.uiLocale, false))
  .catch((error) => console.warn('[film-emulation] language preference load failed: ' + (error?.message || error)));

loadBundledWasm().then((wasm) => {
  runtimeBackend = wasm.available && wasm.backend !== 'js' ? 'wasm' : 'js';
  panel?.__handles?.setRuntimeInfo?.({ backend: runtimeBackendLabel() });
  console.log(`[${BUILD_PLUGIN_ID}] release=${RELEASE_NAME} version=${PACKAGE_VERSION} compute=${wasm.backend}${wasm.error ? ` (${wasm.error})` : ''}`);
});

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
  panel?.__handles?.setPreviewLoading?.(false);
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

function immediateSourcePreviewPixels(source) {
  const scale = computePreviewScale(source.width, source.height, PREVIEW_MAX_EDGE);
  if (scale >= 1) return { width: source.width, height: source.height, rgb: source.rgb, alpha: source.alpha };
  const width = Math.max(1, Math.round(source.width * scale));
  const height = Math.max(1, Math.round(source.height * scale));
  return {
    width,
    height,
    rgb: downsampleBox(source.rgb, source.width, source.height, width, height),
    alpha: source.alpha ? downsamplePlane(source.alpha, source.width, source.height, width, height) : undefined,
  };
}

function inspectionSourcePreviewPixels(source) {
  const crop = source.outputCrop ?? { x: 0, y: 0, width: source.display.width, height: source.display.height };
  return {
    width: crop.width,
    height: crop.height,
    rgb: cropInterleavedRgb(source.display.rgb, source.display.width, source.display.height, crop),
    alpha: cropPreviewPlane(source.display.alpha, source.display.width, source.display.height, crop),
  };
}

function createPreviewAbortController() {
  if (typeof AbortController === 'function') return new AbortController();
  const signal = { aborted: false };
  return { signal, abort() { signal.aborted = true; } };
}

function currentDoc() {
  return app.activeDocument;
}

let inspectionState = { centerX: null, centerY: null, pendingX: 0, pendingY: 0, viewportWidth: 512, viewportHeight: 512 };

const documentLifecycle = createDocumentLifecycle();

async function activateDocument(doc, id) {
  previewRequestId++;
  previewAbortController?.abort();
  clearPreviewImage();
  clearPreviewCaches();
  inspectionState = { ...inspectionState, centerX: null, centerY: null, pendingX: 0, pendingY: 0 };
  documentState = { format: { gauge: '35mm', iso: 250 }, bindings: { sourceLayer: null, targetLayer: null } };
  filmDocument = createRuntimeDocument(params, randomSeed(`document:${String(id ?? '')}`));
  panel?.__handles?.updateParams?.(params);
  panel?.__handles?.updateGraph?.(filmDocument.graph);
  panel?.__handles?.updateFormat?.(filmDocument.format);
  if (!doc) {
    status.textContent = STRINGS.statusNoDocument;
    return;
  }
  status.textContent = STRINGS.statusDocumentChanged;
  const active = await loadStoredParams(doc, id);
  if (shouldScheduleActivatedDocumentPreview(active, currentDoc()?.id, id)) schedulePreview();
}

function synchronizeActiveDocument() {
  const doc = currentDoc();
  const transition = documentLifecycle.transition(doc);
  if (!transition.changed) return;
  activateDocument(doc, transition.id).catch((error) => {
    console.warn('[film-emulation] document activation failed: ' + (error?.message || error));
    if (currentDoc()?.id === transition.id) status.textContent = STRINGS.statusFailed(error?.message || error);
  });
}

setInterval(synchronizeActiveDocument, 750);

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
  const graphDomain = String(changedType || '').split(':')[0];
  filmDocument = {
    ...filmDocument,
    graph: mergeIndependentGraphChange(filmDocument.graph, nextGraph, graphDomain),
  };
  schedulePreview();
}

function onFormatChange(partial) {
  filmDocument = { ...filmDocument, format: normalizeFilmFormat({ ...filmDocument.format, ...partial }) };
  documentState.format = filmDocument.format;
  schedulePreview();
}

function onRandomizeGrain() {
  filmDocument = {
    ...filmDocument,
    graph: filmDocument.graph.map((node) => node.type === 'grain'
      ? { ...node, params: createGrainParams({ ...node.params, seed: fmix32((node.params.seed + SEED_GOLDEN_RATIO) >>> 0) }) }
      : node),
  };
  panel.__handles.updateGraph(filmDocument.graph);
  schedulePreview();
}

function onPreviewModeChange(mode, domain) {
  if (domain) activeDomain = domain;
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
let previewLoadingPlaceholder = null;
function schedulePreview() {
  clearTimeout(panelTimer);
  previewAbortController?.abort();
  const controller = createPreviewAbortController();
  previewAbortController = controller;
  const requestId = ++previewRequestId;
  // UI feedback is intentionally outside the serialized Photoshop task lane:
  // parameter changes, domain switches and pan gestures can immediately show
  // the source placeholder even while an older physical render is unwinding.
  panel?.__handles?.setPreviewLoading?.(true, { useSource: false });
  if (previewLoadingPlaceholder) publishPreviewImage(previewLoadingPlaceholder, requestId, 'preview');
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
  previewLoadingPlaceholder = null;
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
  if (!doc) {
    if (requestId === null || requestId === previewRequestId) panel?.__handles?.setPreviewLoading?.(false);
    return;
  }
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
    const trc = {
      display: resolveImagingPixelTRC(
        doc,
        sources.display.colorProfile,
        sources.display.componentSize,
        standardProfileName('sRGB'),
      ),
      effect: resolveImagingPixelTRC(
        doc,
        sources.effect.colorProfile,
        sources.effect.componentSize,
      ),
    };
    const sourceChanged = !previewCache || previewCache.sourceKey !== sources.cacheKey;
    if (sourceChanged) {
      panel?.__handles?.resetPreviewPanVisual?.();
      const sourcePixelsRaw = sources.mode === 'actual'
        ? inspectionSourcePreviewPixels(sources)
        : immediateSourcePreviewPixels(sources.display);
      const sourceDisplay = preparePanelPreviewSRGB(sourcePixelsRaw.rgb, trc.display, {
        componentSize: sources.display.componentSize,
        alpha: sourcePixelsRaw.alpha,
      });
      const sourcePixels = { ...sourcePixelsRaw, rgb: sourceDisplay.rgb };
      const baseResult = {
        png: floatRgbToPng(sourcePixels.width, sourcePixels.height, sourcePixels.rgb, sourcePixels.alpha),
        dataUrl: null,
        width: sourcePixels.width,
        height: sourcePixels.height,
      };
      // Source is published and painted independently before placeholder or
      // physical-effect work starts. It always remains the clear ICC-managed
      // image, including after domain switches and 100% pan reads.
      publishPreviewImage(baseResult, requestId ?? previewRequestId, 'source');
      status.textContent = STRINGS.statusPreviewRefining;
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (signal?.aborted || (requestId !== null && requestId !== previewRequestId)) return;
      const blurred = createHeavyBlurPlaceholder(sourcePixels, { maxEdge: 40, sigma: 2.4 });
      previewLoadingPlaceholder = {
        png: floatRgbToPng(blurred.width, blurred.height, blurred.rgb, blurred.alpha),
        dataUrl: null,
        width: blurred.width,
        height: blurred.height,
        layoutWidth: blurred.layoutWidth,
        layoutHeight: blurred.layoutHeight,
      };
      publishPreviewImage(previewLoadingPlaceholder, requestId ?? previewRequestId, 'preview');
      panel?.__handles?.setPreviewLoading?.(true, { useSource: false });
      // Give UXP a full paint opportunity before entering the first heavy
      // synchronous algorithm stage.
      await new Promise((resolve) => setTimeout(resolve, 16));
      if (signal?.aborted || (requestId !== null && requestId !== previewRequestId)) return;
    }
    const objectUrl = supportsPreviewObjectUrl();
    const result = await renderPreviewIncremental(doc, renderParams, trc, previewCache, sources, {
      signal,
      returnDataUrl: !objectUrl,
    });
    if (signal?.aborted || (requestId !== null && requestId !== previewRequestId)) return;
    previewCache = result.cache;
    const transport = publishPreviewImage(result, requestId ?? previewRequestId);
    panel?.__handles?.setPreviewLoading?.(false);
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
    panel?.__handles?.setPreviewLoading?.(false);
    status.textContent = STRINGS.statusFailed(error.message || error);
  }
}

async function runApply() {
  const doc = currentDoc();
  if (!doc) {
    status.textContent = STRINGS.statusNoDocument;
    return;
  }
  status.textContent = STRINGS.statusRendering;
  applyBtn.disabled = true;
  clearTimeout(panelTimer);
  previewAbortController?.abort();
  panel?.__handles?.setPreviewLoading?.(false);
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
    status.textContent = STRINGS.statusFailed(STRINGS.selectOriginalSource);
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
  panel?.__handles?.setPreviewLoading?.(false);
  if (!cachedSourceIsSelected) {
    clearPreviewCaches();
    inspectionState = { ...inspectionState, centerX: null, centerY: null, pendingX: 0, pendingY: 0 };
  }
  await saveParamsForDoc(doc, params, { ...documentState, document: filmDocument });
  status.textContent = STRINGS.statusRebound;
  if (!cachedSourceIsSelected || !img.getAttribute?.('src')) schedulePreview();
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
  const deviceMemoryGB = Number(globalThis.navigator?.deviceMemory ?? 0);
  try {
    const preflight = streamFilmGeometry(sourceBounds.right - sourceBounds.left, sourceBounds.bottom - sourceBounds.top, renderDocument, {
      componentSize,
      fullWidth: Number(doc.width),
      fullHeight: Number(doc.height),
      deviceMemoryGB,
      memoryMode: applyMemoryMode,
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
    const renderResult = await renderFilmDocumentToLayer(doc, sourceLayer, targetLayer, sourceBounds, targetBounds, renderDocument, trc, {
      componentSize,
      seed: renderDocument.graph.find((node) => node.type === 'grain')?.params.seed ?? 0x46534c4d,
      signal: options.signal,
      deviceMemoryGB,
      memoryMode: applyMemoryMode,
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
  if (!doc) return false;
  try {
    const stored = await loadParamsForDoc(doc);
    if (currentDoc()?.id !== expectedId) return false;
    if (!stored) {
      status.textContent = STRINGS.statusReadyForPreview;
      return true;
    }
    params = createHalationParams(stored.params);
    const storedGraph = stored.document?.graph;
    filmDocument = Array.isArray(storedGraph)
      ? { ...stored.document, graph: storedGraph }
      : createRuntimeDocument(params, randomSeed(`document:${String(doc.id ?? '')}`));
    documentState = {
      format: stored.format || { gauge: '35mm', iso: 250 },
      bindings: stored.bindings || { sourceLayer: null, targetLayer: null },
    };
    panel.__handles.updateParams(params);
    panel.__handles.updateGraph?.(filmDocument.graph);
    panel.__handles.updateFormat?.(filmDocument.format);
    status.textContent = STRINGS.statusLoaded;
    return true;
  } catch (error) {
    console.warn('[film-emulation] state load failed: ' + error);
    if (currentDoc()?.id !== expectedId) return false;
    status.textContent = STRINGS.statusFailed(STRINGS.storedSettingsFailed);
    return true;
  }
}

synchronizeActiveDocument();
