// tests/unit/layerOps.test.js — 图层解析/可读性判断的纯函数单测（Node 直测，零 UXP 依赖）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isPixelLayer,
  unreadableLayerMessage,
  resolveTargetLayer,
  findLayerByIdRecursive,
  createLayerBinding,
  resolveLayerBinding,
  resolvePreviewSourceLayer,
  effectLayerName,
  ensureEffectLayer,
  unlockPixelLayer,
  resolveApplyTarget,
} from '../../src/io/layerOps.js';

test('isPixelLayer: only kind "pixel" is directly readable (background layer included)', () => {
  assert.equal(isPixelLayer({ kind: 'pixel' }), true, 'pixel layer readable');
  assert.equal(isPixelLayer({ kind: 'smartObject' }), false, 'smart object not readable');
  assert.equal(isPixelLayer({ kind: 'text' }), false, 'text layer not readable');
  assert.equal(isPixelLayer({ kind: 'group' }), false, 'group not readable');
  assert.equal(isPixelLayer({ kind: 'curves' }), false, 'adjustment not readable');
  assert.equal(isPixelLayer(null), false, 'null layer');
  assert.equal(isPixelLayer(undefined), false, 'undefined layer');
  const throws = {
    get kind() {
      throw new Error('boom');
    },
  };
  assert.equal(isPixelLayer(throws), false, 'kind access throws -> not readable');
});

test('unreadableLayerMessage: per-kind actionable guidance', () => {
  assert.match(unreadableLayerMessage({ kind: 'smartObject' }), /Smart Object/);
  assert.match(unreadableLayerMessage({ kind: 'text' }), /text layer/);
  assert.match(unreadableLayerMessage({ kind: 'group' }), /group/);
  assert.match(unreadableLayerMessage({ kind: 'curves' }), /curves/);
  assert.match(unreadableLayerMessage(null), /unknown/);
});

test('resolveTargetLayer: activeLayers[0] preferred, top layer fallback, null when empty', () => {
  const mk = (id) => ({ id, kind: 'pixel' });
  // 正常：当前选中图层
  assert.equal(resolveTargetLayer({ activeLayers: [mk(11)], layers: [mk(1), mk(2)] }).id, 11);
  // 选中图层元素为 undefined（真机已见）→ fallback 顶层
  assert.equal(resolveTargetLayer({ activeLayers: [undefined], layers: [mk(1), mk(2)] }).id, 2);
  // 选中图层缺 id → fallback
  assert.equal(resolveTargetLayer({ activeLayers: [{}], layers: [mk(5)] }).id, 5);
  // activeLayers 访问抛错 → fallback layers
  assert.equal(
    resolveTargetLayer({
      get activeLayers() {
        throw new Error('boom');
      },
      layers: [mk(7)],
    }).id,
    7,
  );
  // 全空 → null
  assert.equal(resolveTargetLayer({ activeLayers: [], layers: [] }), null);
  assert.equal(resolveTargetLayer(null), null);
});

test('findLayerByIdRecursive: 递归组嵌套命中组内图层（多图层修复）', () => {
  // mock 文档：顶层两个图层 + 一个组（内含子图层 + 嵌套组）
  const inner = { id: 101, name: 'inner-pixel', kind: 'pixel', layers: null };
  const nested = { id: 202, name: 'nested-text', kind: 'text', layers: null };
  const childGroup = { id: 201, name: 'Child Group', kind: 'group', layers: [nested] };
  const group = { id: 30, name: 'Group', kind: 'group', layers: [inner, childGroup] };
  const top1 = { id: 10, name: 'bg', kind: 'pixel', layers: null };
  const doc = { layers: [top1, group] };
  // 顶层命中
  assert.equal(findLayerByIdRecursive(doc, 10), top1);
  // 组内命中（旧实现顶层遍历找不到 → 盲传 id → PS Unknown layer）
  assert.equal(findLayerByIdRecursive(doc, 101), inner, '组内图层递归命中');
  assert.equal(findLayerByIdRecursive(doc, 202), nested, '嵌套组递归命中');
  assert.equal(findLayerByIdRecursive(doc, 999), null, '不存在 → null');
  // 健壮性：集合访问抛错 / 无 layers
  assert.equal(
    findLayerByIdRecursive(
      {
        get layers() {
          throw new Error('boom');
        },
      },
      1,
    ),
    null,
  );
  assert.equal(findLayerByIdRecursive(null, 1), null);
  assert.equal(findLayerByIdRecursive(doc, 'x'), null, '非 number id');
});

test('strict layer bindings reject renamed or ambiguous targets', () => {
  const source = { id: 1, name: 'Source', kind: 'pixel', layers: null };
  const target = { id: 2, name: effectLayerName('abc'), kind: 'pixel', layers: null };
  const doc = { layers: [source, target] };
  const binding = createLayerBinding(target, 'abc');
  assert.equal(resolveLayerBinding(doc, binding), target, 'id + name binding resolves');
  target.name = 'Renamed';
  assert.equal(resolveLayerBinding(doc, binding), null, 'renamed id is not silently accepted');
  const duplicateName = effectLayerName('dup');
  const ambiguous = { id: null, name: duplicateName, token: 'dup' };
  assert.equal(
    resolveLayerBinding({ layers: [{ id: 3, name: duplicateName }, { id: 4, name: duplicateName }] }, ambiguous),
    null,
    'ambiguous name fallback is rejected',
  );
});

test('preview uses current pixel selection before binding, then remains strict', () => {
  const selected = { id: 1, name: 'Source', kind: 'pixel', layers: null };
  const other = { id: 2, name: 'Other', kind: 'pixel', layers: null };
  const doc = { activeLayers: [selected], layers: [selected, other] };
  assert.equal(resolvePreviewSourceLayer(doc, null), selected, 'first slider preview uses active layer');
  assert.equal(resolvePreviewSourceLayer(doc, createLayerBinding(other)), other, 'saved binding wins');
  assert.equal(
    resolvePreviewSourceLayer(doc, { id: 99, name: 'Missing', token: '' }),
    null,
    'invalid binding never falls back to active layer',
  );
});

test('ensureEffectLayer creates a blank pixel target without duplicate/clipboard operations', async () => {
  const source = { id: 1, name: 'Source', kind: 'pixel', layers: null };
  let createdOptions = null;
  let movedRelative = null;
  let movedPlacement = null;
  const target = {
    id: 2,
    name: '',
    kind: 'pixel',
    layers: null,
    move(relative, placement) {
      movedRelative = relative;
      movedPlacement = placement;
    },
  };
  const doc = {
    activeLayers: [source],
    layers: [source],
    async createLayer(kind, options) {
      assert.equal(kind, 'pixel');
      createdOptions = options;
      return target;
    },
  };
  const photoshop = {
    constants: {
      LayerKind: { NORMAL: 'pixel' },
      ElementPlacement: { PLACEBEFORE: 'before' },
    },
  };

  const created = await ensureEffectLayer(doc, source, null, photoshop);
  assert.equal(created, target);
  assert.match(createdOptions.name, /^Film Halation \[/);
  assert.equal(target.name, createdOptions.name);
  assert.equal(movedRelative, source);
  assert.equal(movedPlacement, 'before');
  assert.equal('duplicateLayers' in doc, false);
});

test('unlockPixelLayer clears every Photoshop pixel-layer protection flag', () => {
  const layer = {
    allLocked: true,
    pixelsLocked: true,
    transparentPixelsLocked: true,
    positionLocked: true,
    get locked() {
      return this.allLocked || this.pixelsLocked || this.transparentPixelsLocked || this.positionLocked;
    },
  };
  assert.equal(unlockPixelLayer(layer), true);
  assert.equal(layer.allLocked, false);
  assert.equal(layer.pixelsLocked, false);
  assert.equal(layer.transparentPixelsLocked, false);
  assert.equal(layer.positionLocked, false);
});

test('Apply recreates stale/ambiguous output bindings but never guesses a target', () => {
  const source = { id: 1, name: 'Source', kind: 'pixel', layers: null };
  const target = { id: 2, name: effectLayerName('current'), kind: 'pixel', layers: null };
  const doc = { layers: [source, target] };
  assert.deepEqual(resolveApplyTarget(doc, null), {
    target: null,
    legacyTarget: null,
    recreate: false,
  });
  assert.deepEqual(resolveApplyTarget(doc, createLayerBinding(target, 'render-target-v1')), {
    target,
    legacyTarget: null,
    recreate: false,
  });
  assert.deepEqual(resolveApplyTarget(doc, { id: 99, name: 'Missing', token: 'render-target-v1' }), {
    target: null,
    legacyTarget: null,
    recreate: true,
  });
  const duplicateName = effectLayerName('ambiguous');
  const ambiguousDoc = {
    layers: [
      { id: 3, name: duplicateName, kind: 'pixel' },
      { id: 4, name: duplicateName, kind: 'pixel' },
    ],
  };
  assert.equal(resolveApplyTarget(ambiguousDoc, { id: null, name: duplicateName, token: 'render-target-v1' }).target, null);
  assert.equal(resolveApplyTarget(ambiguousDoc, { id: null, name: duplicateName, token: 'render-target-v1' }).recreate, true);
});
