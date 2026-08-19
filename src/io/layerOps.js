// @ts-nocheck
/**
 * io/layerOps — 效果图层创建/更新/定位（不依赖用户图层名）。
 * 基于官方文档（ps_reference classes/document#createlayer, classes/layer#move）：
 *  - doc.createLayer(constants.LayerKind.NORMAL, { name, ... }) → Promise<Layer>
 *  - layer.move(relativeLayer, constants.ElementPlacement.PLACEBEFORE) 置于其正上方
 *  - layer.id 供 imaging.putPixels 使用
 *
 * 不使用 layer.duplicate()/duplicate action：Photoshop 的 UXP Imaging API 在同一
 * 操作中复制图层后可能以“不能输入剪贴板”失败。效果层从空白像素层创建，再由
 * 渲染器一次性写入完整结果；源层始终只读。
 *
 * 纯函数部分（resolveTargetLayer/isPixelLayer/noTargetLayerMessage/unreadableLayerMessage）
 * 零 UXP 依赖，Node 可直接单测；photoshop 仅在 ensureEffectLayer 内懒加载。
 */

/** 效果图层固定名前缀（可识别、可查找；参数持久化不依赖它，见 storage 层）。 */
export const EFFECT_LAYER_NAME = 'Film Halation';

/** 构造稳定、可人工识别的效果层名。 */
export function effectLayerName(token) {
  return `${EFFECT_LAYER_NAME} [${token}]`;
}

/** 仅保存可验证字段，不按模糊名称猜测。 */
export function createLayerBinding(layer, token = '') {
  if (!layer) return null;
  let id = null;
  let name = '';
  try { id = typeof layer.id === 'number' ? layer.id : null; } catch (e) { /* ignore */ }
  try { name = String(layer.name || ''); } catch (e) { /* ignore */ }
  return { id, name, token };
}

/**
 * 图层的有效像素范围（文档坐标，像素单位）。
 * UXP 官方文档：像素图层原点可不同于 (0,0)，读写必须用 boundsNoEffects 定位——
 * getPixels 的 sourceBounds / putPixels 的 targetBounds 均为文档坐标，
 * 假设图层在 (0,0) 会让多图层（有偏移的图层）错位（真机已见：偏移图层渲染后下方变透明）。
 * @param {object|null} layer
 * @returns {{left:number,top:number,right:number,bottom:number}|null}
 */
export function layerPixelBounds(layer) {
  if (!layer) return null;
  try {
    const b = layer.boundsNoEffects;
    if (
      b &&
      typeof b.left === 'number' &&
      typeof b.top === 'number' &&
      typeof b.right === 'number' &&
      typeof b.bottom === 'number' &&
      b.right > b.left &&
      b.bottom > b.top
    ) {
      return { left: b.left, top: b.top, right: b.right, bottom: b.bottom };
    }
  } catch (e) {
    /* ignore */
  }
  return null;
}

/**
 * 解析读写目标图层：优先当前选中图层（activeLayers[0]），
 * 回退文档最上层像素图层（doc.layers 顶层）。
 * 说明：PS 某些状态下 `doc.activeLayers[0]` 可能为 undefined（当前无选中图层 /
 * 选择状态异常，真机已见 `Cannot read properties of undefined (reading 'id')`），
 * 直接访问会炸；此处兜底保证预览/Apply 有确定写入目标。
 * @param {object} doc
 * @returns {object|null} Layer（无任何可用图层时返回 null）
 */
export function resolveTargetLayer(doc) {
  if (!doc) return null;
  let sel = null;
  let all = null;
  try {
    sel = doc.activeLayers;
  } catch (e) {
    console.warn('[film-halation] doc.activeLayers access failed: ' + e);
  }
  try {
    all = doc.layers;
  } catch (e) {
    console.warn('[film-halation] doc.layers access failed: ' + e);
  }
  if (sel && typeof sel.length === 'number' && sel.length > 0) {
    const l = sel[0];
    if (l && typeof l.id === 'number') return l;
    console.warn(`[film-halation] activeLayers[0] invalid (length=${sel.length}), falling back to top layer`);
  }
  if (all && typeof all.length === 'number' && all.length > 0) {
    const top = all[all.length - 1];
    if (top && typeof top.id === 'number') return top;
  }
  return null;
}

/** 无可用图层时的诊断信息（附文档状态，便于真机定位；访问失败时显示 n/a）。 */
export function noTargetLayerMessage(doc) {
  let selLen = 'n/a';
  let allLen = 'n/a';
  try {
    if (doc && doc.activeLayers && typeof doc.activeLayers.length === 'number') selLen = doc.activeLayers.length;
  } catch (e) {
    /* ignore */
  }
  try {
    if (doc && doc.layers && typeof doc.layers.length === 'number') allLen = doc.layers.length;
  } catch (e) {
    /* ignore */
  }
  return `No target layer (activeLayers=${selLen}, layers=${allLen}). Select a pixel layer and retry.`;
}

/**
 * 图层是否可直接读写像素：UXP imaging 仅支持像素图层（LayerKind.NORMAL = "pixel"；
 * 背景层同样是 "pixel"）。智能对象/文本/调整/填充/组等对 getPixels/putPixels 会报
 * PS 原生错误（真机实测：智能对象 → "无法更新智能对象文件" / "不能输入剪贴板"）。
 * @param {object|null} layer
 * @returns {boolean}
 */
export function isPixelLayer(layer) {
  if (!layer) return false;
  try {
    return String(layer.kind) === 'pixel';
  } catch (e) {
    return false;
  }
}

/** Clear every writable lock that can prevent Imaging API pixel replacement. */
export function unlockPixelLayer(layer) {
  if (!layer) return false;
  for (const property of ['allLocked', 'pixelsLocked', 'transparentPixelsLocked', 'positionLocked']) {
    try { layer[property] = false; } catch (error) { /* unsupported/background property */ }
  }
  try { return layer.locked !== true; } catch (error) { return true; }
}

/** 不可读图层类型的操作指引（英文，与 V1 英文 UI 一致）。 */
export function unreadableLayerMessage(layer) {
  let kind = 'unknown';
  try {
    kind = layer && layer.kind ? String(layer.kind) : 'unknown';
  } catch (e) {
    /* ignore */
  }
  if (kind === 'smartObject') {
    return 'Target layer is a Smart Object - UXP imaging cannot read/write smart object pixels. Double-click the layer to open its contents and apply inside, or rasterize it first (Layer > Rasterize > Smart Object).';
  }
  if (kind === 'text') {
    return 'Target layer is a text layer - rasterize it first (Layer > Rasterize > Type).';
  }
  if (kind === 'group') {
    return 'Target layer is a group - select an individual pixel layer inside it.';
  }
  return `Target layer kind "${kind}" has no directly readable pixels - rasterize the layer first.`;
}

/**
 * 递归遍历图层树（组嵌套），按 id 反查图层对象。
 * 多图层修复：UXP 27 中 activeLayers 与 layers 的 id 可能不一致、且选中组内图层时
 * 顶层遍历找不到——递归组层级（Layer.layers）提高命中率，避免盲传 id 触发
 * PS 原生 "Unknown layer" 错误。
 * 纯函数（doc mock 可测）；任意访问异常按找不到处理。
 * @param {object} doc Photoshop Document（或任意含 layers 集合的对象）
 * @param {number} id 目标图层 id
 * @returns {object|null}
 */
export function findLayerByIdRecursive(doc, id) {
  if (!doc || typeof id !== 'number') return null;
  const visit = (layer) => {
    if (!layer) return null;
    try {
      if (typeof layer.id === 'number' && layer.id === id) return layer;
    } catch (e) {
      /* ignore */
    }
    let children = null;
    try {
      children = layer.layers;
    } catch (e) {
      /* ignore */
    }
    if (children && typeof children.length === 'number') {
      for (let i = 0; i < children.length; i++) {
        const found = visit(children[i]);
        if (found) return found;
      }
    }
    return null;
  };
  let layers = null;
  try {
    layers = doc.layers;
  } catch (e) {
    return null;
  }
  if (!layers || typeof layers.length !== 'number') return null;
  for (let i = 0; i < layers.length; i++) {
    const found = visit(layers[i]);
    if (found) return found;
  }
  return null;
}

/** 严格绑定解析：id 命中后还需名称一致；名称兜底必须唯一。 */
export function resolveLayerBinding(doc, binding) {
  if (!binding) return null;
  if (typeof binding.id === 'number') {
    const byId = findLayerByIdRecursive(doc, binding.id);
    if (byId) {
      try {
        if (!binding.name || String(byId.name) === binding.name) return byId;
      } catch (e) {
        return null;
      }
    }
  }
  if (!binding.name) return null;
  const matches = [];
  const visit = (layer) => {
    if (!layer) return;
    try { if (String(layer.name) === binding.name) matches.push(layer); } catch (e) { /* ignore */ }
    let children = null;
    try { children = layer.layers; } catch (e) { /* ignore */ }
    if (children && typeof children.length === 'number') {
      for (let i = 0; i < children.length; i++) visit(children[i]);
    }
  };
  let layers = null;
  try { layers = doc.layers; } catch (e) { return null; }
  if (!layers || typeof layers.length !== 'number') return null;
  for (let i = 0; i < layers.length; i++) visit(layers[i]);
  return matches.length === 1 ? matches[0] : null;
}

/**
 * Panel preview may use the current selection before the user creates a
 * persistent binding. Once a binding exists it remains strict and never falls
 * back to an unrelated active layer.
 */
export function resolvePreviewSourceLayer(doc, binding) {
  return binding ? resolveLayerBinding(doc, binding) : resolveTargetLayer(doc);
}

/**
 * Resolve an Apply output binding without ever falling back to an unrelated
 * selected layer. A missing/ambiguous output is safe to replace because the
 * strictly bound source remains read-only.
 */
export function resolveApplyTarget(doc, binding) {
  if (!binding) return { target: null, legacyTarget: null, recreate: false };
  const resolved = resolveLayerBinding(doc, binding);
  if (binding.token === 'safe-copy') {
    return { target: null, legacyTarget: resolved, recreate: true };
  }
  return { target: resolved, legacyTarget: null, recreate: !resolved };
}

/**
 * 确保效果图层存在（不存在则创建空白像素层），并移动到源图层正上方。
 * @param {object} doc
 * @param {object} sourceLayer 源图层（在其上方放置）
 * @param {object|null} binding 已保存的严格目标绑定
 * @param {object|null} photoshopHost 测试注入；生产环境留空
 * @returns {Promise<object>} 效果图层
 */
export async function ensureEffectLayer(doc, sourceLayer, binding = null, photoshopHost = null) {
  const photoshop = photoshopHost || require('photoshop');
  const constants = photoshop.constants;
  const bound = resolveLayerBinding(doc, binding);
  if (bound) {
    if (!isPixelLayer(bound)) throw new Error('Bound Film Halation target is no longer a pixel layer. Relink it before applying.');
    return bound;
  }

  const token = binding?.token || `${Date.now().toString(36)}-${Math.floor(Math.random() * 0xffff).toString(16).padStart(4, '0')}`;
  const name = effectLayerName(token);
  let layer = null;
  try {
    layer = await doc.createLayer(constants.LayerKind.NORMAL, { name });
  } catch (error) {
    throw new Error(`Could not create a safe pixel-layer target. Create a blank pixel layer named "${name}", select it, then retry. The source was not modified. (${error && (error.message || error)})`);
  }

  // createLayer returns the authoritative host Layer object. Do not re-resolve it
  // through a potentially stale doc.layers collection immediately after creation.
  if (!layer || layer === sourceLayer || !isPixelLayer(layer)) {
    throw new Error(`Safe pixel-layer target could not be addressed after creation. The source was not modified.`);
  }
  try { layer.name = name; } catch (e) { /* createLayer normally applies the name */ }
  try { layer.move(sourceLayer, constants.ElementPlacement.PLACEBEFORE); } catch (e) {
    console.warn('[film-halation] safe-copy move failed: ' + e);
  }
  return layer;
}
