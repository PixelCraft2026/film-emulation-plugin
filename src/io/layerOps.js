// @ts-nocheck
/**
 * io/layerOps — 效果图层创建/更新/定位（不依赖用户图层名）。
 * 基于官方文档（ps_reference classes/document#createlayer, classes/layer#move）：
 *  - doc.createLayer(constants.LayerKind.NORMAL, { name, ... }) → Promise<Layer>
 *  - layer.move(relativeLayer, constants.ElementPlacement.PLACEBEFORE) 置于其正上方
 *  - layer.id 供 imaging.putPixels 使用
 */
const ps = require('photoshop');
const constants = ps.constants;

/** 效果图层固定名前缀（可识别、可查找；参数持久化不依赖它，见 storage 层）。 */
export const EFFECT_LAYER_NAME = 'Film Halation';

/**
 * 按前缀查找效果图层（根级），找不到返回 null。
 * @param {object} doc
 * @returns {object|null}
 */
export function findEffectLayer(doc) {
  const layers = doc.layers;
  for (let i = 0; i < layers.length; i++) {
    if (layers[i].name.startsWith(EFFECT_LAYER_NAME)) return layers[i];
  }
  return null;
}

/**
 * 确保效果图层存在（不存在则创建），并移动到源图层正上方。
 * @param {object} doc
 * @param {object} sourceLayer 源图层（在其上方放置）
 * @returns {Promise<object>} 效果图层
 */
export async function ensureEffectLayer(doc, sourceLayer) {
  let layer = findEffectLayer(doc);
  if (!layer) {
    // createLayer 空白层无像素 sheet（putPixels 报 invalid target sheet）；
    // UXP Layer.duplicate() 报 "You can only move layers in the same document"。
    // 方案：选中源图层后用 batchPlay duplicate（无 _target，作用于当前选中层），
    // 副本自带像素 sheet 且直接命名。
    // 空白像素层无像素 sheet（putPixels 报 invalid target sheet），且 PS 27 UXP imaging
    // 无法访问运行时新建图层 id（getPixels/putPixels 均报 Unknown layer）。
    // 效果图层方案为已知限制（Phase 7 攻关）；此处保留创建流程，fill 失败不致命。
    await doc.createLayer(constants.LayerKind.NORMAL, { name: EFFECT_LAYER_NAME });
    layer = findEffectLayer(doc);
    if (!layer) {
      throw new Error('Effect layer creation failed (not found after createLayer)');
    }
    try {
      await ps.action.batchPlay(
        [
          {
            _obj: 'fill',
            _target: [{ _ref: 'layer', _id: layer.id }],
            using: { _enum: 'fillContents', _value: 'black' },
            opacity: { _unit: 'percentUnit', _value: 100 },
            mode: { _enum: 'blendMode', _value: 'normal' },
          },
        ],
        { synchronousExecution: true },
      );
    } catch (e) {
      console.warn('[film-halation] fill init failed (non-fatal): ' + e);
    }
  }
  // 定位到源图层正上方；失败不致命（图层已存在/创建），仅记录
  try {
    layer.move(sourceLayer, constants.ElementPlacement.PLACEBEFORE);
  } catch (e) {
    console.warn('[film-halation] layer.move failed: ' + e);
  }
  return layer;
}

/**
 * 把指定图层设为活动图层（供 imaging.putPixels 写目标）。
 * @param {object} doc
 * @param {object} layer
 */
export function activateLayer(doc, layer) {
  doc.activeLayers = [layer];
}

/** 获取图层 id（供 putPixels layerID）。 */
export function layerId(layer) {
  return layer.id;
}
