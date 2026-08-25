// @ts-nocheck
/** Film Emulation schema v2: deterministic graph serialization and strict migration. */
import { DEFAULT_PARAMS, createHalationParams, validateParams } from '../core/params.js';
import { ENGINE_VERSION, FILM_GRAPH_VERSION } from '../core/film.js';
import {
  createDefaultEffectGraph,
  graphMinimumEngineVersion,
  normalizeEffectGraph,
} from '../core/effectRegistry.js';
import { createFilmResolutionParams } from '../core/resolution.js';
import { createGrainParams } from '../core/grain.js';
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

function orderedParams(params, keys, validate) {
  const validated = validate(params);
  const ordered = {};
  for (const key of keys) {
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

function orderedNode(node) {
  if (node.type === 'halation') {
    return {
      id: node.id,
      type: node.type,
      enabled: node.enabled,
      params: orderedParams(node.params, PARAM_KEY_ORDER, validateParams),
    };
  }
  if (node.type === 'filmResolution') {
    return {
      id: node.id,
      type: node.type,
      enabled: node.enabled,
      params: orderedParams(node.params, RESOLUTION_PARAM_KEY_ORDER, createFilmResolutionParams),
    };
  }
  if (node.type === 'grain') {
    return {
      id: node.id,
      type: node.type,
      enabled: node.enabled,
      params: orderedParams(node.params, GRAIN_PARAM_KEY_ORDER, createGrainParams),
    };
  }
  return { id: node.id, type: node.type, enabled: node.enabled, params: { ...node.params } };
}

function normalizeGraphForDocument(graph) {
  return normalizeEffectGraph(graph).map(orderedNode);
}

function documentEngineVersion(graph) {
  return graph.some((node) => node.type === 'filmResolution' || node.type === 'grain')
    ? FILM_GRAPH_VERSION
    : ENGINE_VERSION;
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
