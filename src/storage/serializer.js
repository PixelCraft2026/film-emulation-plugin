// @ts-nocheck
/** Film Halation schema v2：确定性序列化、严格迁移与未来效果图基础。 */
import { createHalationParams, validateParams, DEFAULT_PARAMS, ENGINE_VERSION } from '../core/index.js';

export const PLUGIN_NAME = 'FilmHalation';
export const LEGACY_PLUGIN_NAME = 'FilmLab';
export const SCHEMA_VERSION = 2;
export const DEFAULT_FORMAT = Object.freeze({ gauge: '35mm', iso: 250 });
export const GAUGES = Object.freeze(['8mm', '16mm', '35mm', '65mm']);

export const PARAM_KEY_ORDER = Object.freeze([
  'strength',
  'sigma',
  'sigmaUnits',
  'threshold',
  'thresholdUnits',
  'thresholdSoftness',
  'sourceSoftness',
  'backgroundSoftness',
  'smoothness',
  'backgroundThreshold',
  'sourceImpact',
  'amplify',
  'sourceExpansion',
  'redTail',
  'blueCompensation',
  'colorDensity',
  'sourceInteriorProtection',
  'hotSourceThreshold',
  'hotCoreStrength',
  'globalSourceThreshold',
  'spectralSensitivity',
  'redLayerThresholdBias',
  'redshift',
  'sigmaRatio',
  'globalDiffusion',
  'centerAttenuation',
  'blendMode',
  'diffusionMode',
  'extraction',
  'spillMix',
  'rolloff',
  'profile',
]);

const isFiniteNumber = (v) => typeof v === 'number' && Number.isFinite(v);

function orderedParams(params) {
  const validated = validateParams(params);
  const ordered = {};
  for (const key of PARAM_KEY_ORDER) {
    const value = validated[key];
    ordered[key] = Array.isArray(value) ? [...value] : value;
  }
  return ordered;
}

function normalizeBinding(binding) {
  if (!binding) return null;
  if (typeof binding !== 'object') throw new Error('Invalid layer binding');
  const id = typeof binding.id === 'number' && Number.isFinite(binding.id) ? binding.id : null;
  const name = typeof binding.name === 'string' ? binding.name : '';
  const token = typeof binding.token === 'string' ? binding.token : '';
  if (id === null && !name && !token) return null;
  return { id, name, token };
}

function normalizeFormat(format) {
  const gauge = GAUGES.includes(format?.gauge) ? format.gauge : DEFAULT_FORMAT.gauge;
  const iso = isFiniteNumber(format?.iso) && format.iso > 0 && format.iso <= 12800 ? format.iso : DEFAULT_FORMAT.iso;
  return { gauge, iso };
}

/** 构造 schema v2 文档；options 用于宿主层绑定，不污染 HalationParams。 */
export function toDocument(params, options = {}) {
  return {
    plugin: PLUGIN_NAME,
    schemaVersion: SCHEMA_VERSION,
    engineVersion: ENGINE_VERSION,
    format: normalizeFormat(options.format),
    graph: [
      {
        id: options.nodeId || 'halation-main',
        type: 'halation',
        enabled: options.enabled !== false,
        params: orderedParams(params),
      },
    ],
    bindings: {
      sourceLayer: normalizeBinding(options.bindings?.sourceLayer),
      targetLayer: normalizeBinding(options.bindings?.targetLayer),
    },
    documentFingerprint: options.documentFingerprint ?? null,
  };
}

/** 将 v1 effects.halation 文档明确迁移成单节点 graph。 */
export function migrateDocument(doc) {
  if (!doc || typeof doc !== 'object') throw new Error('Invalid sidecar document: not an object');
  if (doc.schemaVersion !== undefined) {
    const version = Number(doc.schemaVersion);
    if (!Number.isInteger(version) || version < 1) throw new Error(`Unsupported schemaVersion: ${String(doc.schemaVersion)}`);
    if (version > SCHEMA_VERSION) throw new Error(`Sidecar schema v${version} is newer than supported v${SCHEMA_VERSION}`);
    if (version === SCHEMA_VERSION) return doc;
  }

  const legacyVersion = String(doc.version ?? '');
  const legacyPlugin = doc.plugin === LEGACY_PLUGIN_NAME || doc.plugin === PLUGIN_NAME;
  if (!legacyPlugin || !doc.effects || typeof doc.effects.halation !== 'object') {
    throw new Error(`Unsupported sidecar schema${legacyVersion ? ` v${legacyVersion}` : ''}`);
  }
  const params = createHalationParams({ ...DEFAULT_PARAMS, ...doc.effects.halation });
  return toDocument(params);
}

/** 校验并规范化 schema v2。 */
export function normalizeDocument(doc) {
  const migrated = migrateDocument(doc);
  if (migrated.plugin !== PLUGIN_NAME) throw new Error(`Invalid sidecar document: plugin="${String(migrated.plugin)}"`);
  if (migrated.schemaVersion !== SCHEMA_VERSION) throw new Error(`Invalid schemaVersion: ${String(migrated.schemaVersion)}`);
  if (!Array.isArray(migrated.graph)) throw new Error('Invalid sidecar document: graph must be an array');
  const unsupported = migrated.graph.find((node) => !node || node.type !== 'halation');
  if (unsupported) {
    throw new Error(`Unsupported effect node type in schema v${SCHEMA_VERSION}: ${String(unsupported?.type)}`);
  }
  const halationNodes = migrated.graph.filter((node) => node && node.type === 'halation');
  if (halationNodes.length !== 1) throw new Error('Invalid sidecar document: exactly one halation node is required');
  const node = halationNodes[0];
  if (!node.params || typeof node.params !== 'object') throw new Error('Invalid sidecar document: halation params missing');
  const params = createHalationParams({ ...DEFAULT_PARAMS, ...node.params });
  const document = toDocument(params, {
    nodeId: typeof node.id === 'string' && node.id ? node.id : 'halation-main',
    enabled: node.enabled !== false,
    format: migrated.format,
    bindings: migrated.bindings,
    documentFingerprint: migrated.documentFingerprint ?? null,
  });
  return { params, version: String(SCHEMA_VERSION), document };
}

export function serializeParams(params, options = {}) {
  const document = toDocument(params, options);
  for (const key of ['redshift', 'sigmaRatio']) {
    if (!document.graph[0].params[key].every(isFiniteNumber)) {
      throw new TypeError(`serializeParams: ${key} contains NaN/Infinity`);
    }
  }
  return JSON.stringify(document);
}

export function parseDocument(json) {
  let doc;
  try {
    doc = JSON.parse(json.replace(/^\uFEFF/, ''));
  } catch (error) {
    throw new Error(`Invalid sidecar JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return normalizeDocument(doc);
}
