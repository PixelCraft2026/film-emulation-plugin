/**
 * storage/serializer — 参数文档的确定性序列化与解析（TDD §9 / PRD §2.4）。
 * 纯逻辑、零依赖、Node 可测。
 *
 * 文档 schema：
 *   { plugin: 'FilmLab', version: '1.0', effects: { halation: { ...HalationParams } } }
 *
 * 不变量：serialize(parse(json)) === json（确定性键序；NaN/Inf 拒绝）。
 * version migration：版本迁移钩子（当前 v1.0 为空迁移路径）。
 *
 * @typedef {Object} FilmLabDocument
 * @property {string} plugin
 * @property {string} version
 * @property {{halation: import('../core/params.js').HalationParams}} effects
 */

import { createHalationParams, validateParams, DEFAULT_PARAMS } from '../core/index.js';

/** 文档 schema 常量。 */
export const PLUGIN_NAME = 'FilmLab';
export const SCHEMA_VERSION = '1.0';

/** 参数键的确定性输出顺序（与 DEFAULT_PARAMS 一致 + 校验）。 */
export const PARAM_KEY_ORDER = Object.freeze([
  'strength',
  'sigma',
  'threshold',
  'thresholdSoftness',
  'backgroundThreshold',
  'redshift',
  'sigmaRatio',
  'globalDiffusion',
  'centerAttenuation',
  'blendMode',
  'diffusionMode',
]);

/**
 * @param {unknown} v
 * @returns {boolean}
 */
const isFiniteNumber = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * 校验并规范化参数文档对象（migration 后调用）。
 * @param {unknown} doc
 * @returns {{params:import('../core/params.js').HalationParams, version:string}} 规范化结果
 * @throws 非法文档
 */
export function normalizeDocument(doc) {
  if (!doc || typeof doc !== 'object') throw new Error('Invalid sidecar document: not an object');
  const d = /** @type {Record<string, unknown>} */ (doc);
  if (d.plugin !== PLUGIN_NAME) throw new Error(`Invalid sidecar document: plugin="${String(d.plugin)}"`);
  const effects = /** @type {Record<string, unknown>} */ (d.effects);
  const halation = effects && effects.halation;
  if (!halation || typeof halation !== 'object') {
    throw new Error('Invalid sidecar document: missing effects.halation');
  }
  // 缺失字段用默认值补齐（向前兼容）
  const merged = /** @type {import('../core/params.js').HalationParams} */ ({ ...DEFAULT_PARAMS, ...halation });
  const params = createHalationParams(merged);
  return { params, version: String(d.version ?? SCHEMA_VERSION) };
}

/**
 * 构造文档对象（确定性键序）。
 * @param {import('../core/params.js').HalationParams} params
 * @returns {FilmLabDocument}
 */
export function toDocument(params) {
  const validated = validateParams(params);
  /** @type {Record<string, unknown>} */
  const ordered = {};
  for (const key of PARAM_KEY_ORDER) {
    const value = /** @type {Record<string, unknown>} */ (validated)[key];
    ordered[key] = Array.isArray(value) ? [.../** @type {number[]} */ (value)] : value;
  }
  return {
    plugin: PLUGIN_NAME,
    version: SCHEMA_VERSION,
    effects: { halation: /** @type {import('../core/params.js').HalationParams} */ (ordered) },
  };
}

/**
 * 确定性序列化：键序固定、NaN/Inf 拒绝、紧凑 JSON。
 * @param {import('../core/params.js').HalationParams} params
 * @returns {string}
 */
export function serializeParams(params) {
  const doc = toDocument(params);
  // 深度校验无 NaN/Inf（数组字段逐元素）
  for (const key of /** @type {const} */ (['redshift', 'sigmaRatio'])) {
    const arr = doc.effects.halation[key];
    if (!arr.every(isFiniteNumber)) {
      throw new TypeError(`serializeParams: ${key} contains NaN/Infinity`);
    }
  }
  return JSON.stringify(doc);
}

/**
 * 解析并迁移文档 → { params, version }。
 * @param {string} json
 * @returns {{params:import('../core/params.js').HalationParams, version:string}}
 */
export function parseDocument(json) {
  /** @type {unknown} */
  let doc;
  try {
    doc = JSON.parse(json.replace(/^\uFEFF/, ''));
  } catch (e) {
    throw new Error(`Invalid sidecar JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  const migrated = migrateDocument(doc);
  return normalizeDocument(migrated);
}

/**
 * version migration 链。当前 v1.0：空迁移（直接返回）。
 * 未来版本在此按 version 逐级升级（如 v0.9 → v1.0 重命名/补默认值）。
 * @param {unknown} doc
 * @returns {unknown} 迁移到最新版本后的文档
 */
export function migrateDocument(doc) {
  if (!doc || typeof doc !== 'object') return doc;
  const d = /** @type {Record<string, unknown>} */ (doc);
  const version = String(d.version ?? '0.0');
  // v0.x → v1.0：占位迁移（schema 从 v1.0 起才正式引入）
  if (version !== SCHEMA_VERSION) {
    // 未来：按版本链逐级迁移；当前直接标记为目标版本（字段兼容由 normalize 补齐默认值）
    return { ...d, version: SCHEMA_VERSION };
  }
  return doc;
}
