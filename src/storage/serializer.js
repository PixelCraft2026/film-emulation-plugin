// @ts-nocheck
/** Film Emulation schema v2: deterministic graph serialization and strict migration. */
import { DEFAULT_PARAMS, createHalationParams, validateParams } from '../core/params.js';
import {
  createDefaultEffectGraph,
  graphMinimumEngineVersion,
  normalizeEffectGraph,
} from '../core/effectRegistry.js';
import { createFilmResolutionParams } from '../core/resolution.js';
import { createGrainParams } from '../core/grain.js';
import { createDefringeParams } from '../core/defringe.js';
import { createBloomParams } from '../core/bloom.js';
import { createHighlightProtectionParams } from '../core/highlightProtection.js';
import { createLumaMask, LUMA_MASK_DEFAULTS } from '../core/mask.js';
import { DEFAULT_FILM_FORMAT, GAUGES, normalizeFilmFormat } from '../core/format.js';

export const PLUGIN_NAME = 'FilmHalation';
export const LEGACY_PLUGIN_NAME = 'FilmLab';
export const SCHEMA_VERSION = 2;
export const DEFAULT_FORMAT = DEFAULT_FILM_FORMAT;

export const PARAM_KEY_ORDER = Object.freeze([
  'strength', 'sigma', 'sigmaUnits', 'threshold', 'thresholdUnits', 'thresholdSoftness',
  'sourceSoftness', 'backgroundSoftness', 'smoothness', 'backgroundThreshold',
  'sourceImpact', 'amplify', 'sourceExpansion', 'redTail', 'blueCompensation',
  'colorDensity', 'sourceInteriorProtection', 'hotSourceThreshold', 'hotCoreStrength',
  'globalSourceThreshold', 'spectralSensitivity', 'redLayerThresholdBias', 'redshift',
  'sigmaRatio', 'globalDiffusion', 'centerAttenuation', 'blendMode', 'diffusionMode',
  'extraction', 'spillMix', 'rolloff', 'profile',
]);
export const RESOLUTION_PARAM_KEY_ORDER = Object.freeze(['amount', 'response', 'toeLoss', 'shoulderLoss', 'profile']);
export const GRAIN_PARAM_KEY_ORDER = Object.freeze(['amount', 'size', 'roughness', 'chroma', 'profile', 'mode', 'seedMode', 'seed']);
export const DEFRINGE_PARAM_KEY_ORDER = Object.freeze(['amount', 'radiusPx', 'threshold', 'softness', 'edgeSensitivity']);
export const BLOOM_PARAM_KEY_ORDER = Object.freeze(['thresholdEV', 'softnessEV', 'radius', 'amplify', 'saturation', 'saveLights']);
export const HIGHLIGHT_PROTECTION_PARAM_KEY_ORDER = Object.freeze(['amount', 'thresholdEV', 'softnessEV']);
export const MASK_KEY_ORDER = Object.freeze(['mode', 'lowEV', 'highEV', 'softnessEV', 'invert']);

function orderedParams(params, keys, validate) {
  const validated = validate(params);
  const ordered = {};
  for (const key of keys) {
    const value = validated[key];
    ordered[key] = Array.isArray(value) ? [...value] : value;
  }
  return ordered;
}

function orderedMask(mask) {
  const validated = createLumaMask(mask ?? LUMA_MASK_DEFAULTS);
  const ordered = {};
  for (const key of MASK_KEY_ORDER) ordered[key] = validated[key];
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

function orderedNode(node) {
  if (node.type === 'halation') {
    return {
      id: node.id,
      type: node.type,
      enabled: node.enabled,
      params: orderedParams(node.params, PARAM_KEY_ORDER, validateParams),
      mask: orderedMask(node.mask),
    };
  }
  if (node.type === 'defringe') {
    return {
      id: node.id,
      type: node.type,
      enabled: node.enabled,
      params: orderedParams(node.params, DEFRINGE_PARAM_KEY_ORDER, createDefringeParams),
      mask: orderedMask(node.mask),
    };
  }
  if (node.type === 'bloom') {
    return {
      id: node.id,
      type: node.type,
      enabled: node.enabled,
      params: orderedParams(node.params, BLOOM_PARAM_KEY_ORDER, createBloomParams),
      mask: orderedMask(node.mask),
    };
  }
  if (node.type === 'highlightProtection') {
    return {
      id: node.id,
      type: node.type,
      enabled: node.enabled,
      params: orderedParams(node.params, HIGHLIGHT_PROTECTION_PARAM_KEY_ORDER, createHighlightProtectionParams),
      mask: orderedMask(node.mask),
    };
  }
  if (node.type === 'filmResolution') {
    return {
      id: node.id,
      type: node.type,
      enabled: node.enabled,
      params: orderedParams(node.params, RESOLUTION_PARAM_KEY_ORDER, createFilmResolutionParams),
      mask: orderedMask(node.mask),
    };
  }
  if (node.type === 'grain') {
    return {
      id: node.id,
      type: node.type,
      enabled: node.enabled,
      params: orderedParams(node.params, GRAIN_PARAM_KEY_ORDER, createGrainParams),
      mask: orderedMask(node.mask),
    };
  }
  return { id: node.id, type: node.type, enabled: node.enabled, params: { ...node.params }, mask: orderedMask(node.mask) };
}

/**
 * V1.6 sidecars did not persist the three V1.7 nodes.  Upgrade in memory by
 * appending disabled nodes; they are only written back when the document is
 * subsequently serialized.  Existing node ids and parameters are untouched.
 */
function upgradeEffectGraphToV17(graph) {
  const result = graph.map((node) => ({ ...node, mask: node.mask ?? createLumaMask() }));
  const ids = new Set(result.map((node) => node.id));
  const add = (id, type, params) => {
    if (!ids.has(id)) {
      result.push({ id, type, enabled: false, params, mask: createLumaMask() });
      ids.add(id);
    }
  };
  add('defringe-main', 'defringe', createDefringeParams());
  add('bloom-main', 'bloom', createBloomParams());
  add('highlight-protection-main', 'highlightProtection', createHighlightProtectionParams());
  return result;
}

function normalizeGraphForDocument(graph) {
  const hasV16OrLaterNode = graph.some((node) => ['defringe', 'bloom', 'highlightProtection', 'filmResolution', 'grain'].includes(node.type));
  const hasV17Mask = graph.some((node) => node.mask?.mode === 'luma');
  const normalized = hasV16OrLaterNode || hasV17Mask
    ? upgradeEffectGraphToV17(graph)
    : graph;
  return normalizeEffectGraph(normalized).map(orderedNode);
}

function documentEngineVersion(graph) {
  return graphMinimumEngineVersion(graph);
}

/** Construct a schema-v2 document. options.graph enables the complete V1.6 graph. */
export function toDocument(params, options = {}) {
  const graph = options.graph
    ? normalizeGraphForDocument(options.graph)
    : [{
        id: options.nodeId || 'halation-main',
        type: 'halation',
        enabled: options.enabled !== false,
        params: orderedParams(params, PARAM_KEY_ORDER, validateParams),
        mask: orderedMask(options.mask),
      }];
  return {
    plugin: PLUGIN_NAME,
    schemaVersion: SCHEMA_VERSION,
    engineVersion: documentEngineVersion(graph),
    minimumEngineVersion: graphMinimumEngineVersion(graph),
    format: normalizeFilmFormat(options.format),
    graph,
    bindings: {
      sourceLayer: normalizeBinding(options.bindings?.sourceLayer),
      targetLayer: normalizeBinding(options.bindings?.targetLayer),
    },
    documentFingerprint: options.documentFingerprint ?? null,
  };
}

export function toFilmDocument(graph, options = {}) {
  const halation = graph.find((node) => node.type === 'halation');
  if (!halation) throw new Error('toFilmDocument: halation node is required');
  return toDocument(halation.params, { ...options, graph });
}

export function createDefaultFilmDocument(halationParams, options = {}) {
  const graph = createDefaultEffectGraph(halationParams ?? DEFAULT_PARAMS, options.seed);
  return toFilmDocument(graph, options);
}

/** Convert legacy v1 effects.halation into a Halation-only schema-v2 graph. */
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

/** Validate and normalize schema-v2 graph without silently dropping nodes. */
export function normalizeDocument(doc) {
  const migrated = migrateDocument(doc);
  if (migrated.plugin !== PLUGIN_NAME) throw new Error(`Invalid sidecar document: plugin="${String(migrated.plugin)}"`);
  if (migrated.schemaVersion !== SCHEMA_VERSION) throw new Error(`Invalid schemaVersion: ${String(migrated.schemaVersion)}`);
  if (!Array.isArray(migrated.graph)) throw new Error('Invalid sidecar document: graph must be an array');
  const graph = normalizeGraphForDocument(migrated.graph);
  const halation = graph.find((node) => node.type === 'halation');
  const document = toFilmDocument(graph, {
    format: migrated.format,
    bindings: migrated.bindings,
    documentFingerprint: migrated.documentFingerprint ?? null,
  });
  return { params: halation.params, version: String(SCHEMA_VERSION), document };
}

export function serializeParams(params, options = {}) {
  return JSON.stringify(toDocument(params, options));
}

export function serializeDocument(document) {
  return JSON.stringify(normalizeDocument(document).document);
}

export function parseDocument(json) {
  let doc;
  try {
    doc = JSON.parse(String(json).replace(/^\uFEFF/, ''));
  } catch (error) {
    throw new Error(`Invalid sidecar JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return normalizeDocument(doc);
}

export { GAUGES };
