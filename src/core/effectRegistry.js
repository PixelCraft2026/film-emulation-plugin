import { createHalationParams, DEFAULT_PARAMS, resolveSigmaParams } from './params.js';
import { processHalation } from './pipeline.js';
import {
  createFilmResolutionParams,
  FILM_RESOLUTION_DEFAULTS,
  processFilmResolution,
  validateFilmResolutionParams,
  filmResolutionSupport,
} from './resolution.js';
import {
  createGrainParams,
  GRAIN_DEFAULTS,
  processGrain,
  validateGrainParams,
  grainSupport,
} from './grain.js';

export const EFFECT_ORDER = Object.freeze([
  'defringe',
  'vignette',
  'halation',
  'bloom',
  'highlightProtection',
  'filmResolution',
  'grain',
  'damage',
  'overscan',
]);

/** @type {Record<string, number>} */
const STAGES = Object.freeze({
  defringe: 10,
  vignette: 20,
  halation: 30,
  bloom: 40,
  highlightProtection: 50,
  filmResolution: 60,
  grain: 70,
  damage: 80,
  overscan: 90,
});

/** @param {string} type @param {string} introducedIn */
function unsupported(type, introducedIn) {
  return Object.freeze({
    type,
    introducedIn,
    physicalStage: STAGES[type],
    implemented: false,
    defaults: Object.freeze({}),
    /** @param {any} value */
    validate(value) {
      throw new Error(`Effect "${type}" requires engine ${introducedIn}; it is not available in this build`);
    },
    /** @param {any} params @param {any} context */
    supportRadius(params, context) { return 0; },
    /** @param {any} frame @param {any} params */
    estimateMemory(frame, params) { return 0; },
    /** @param {any} input @param {any} params @param {any} context */
    process(input, params, context) {
      throw new Error(`Effect "${type}" requires engine ${introducedIn}; it is not available in this build`);
    },
  });
}

/** @type {Record<string, any>} */
export const FILM_EFFECT_REGISTRY = Object.freeze({
  defringe: unsupported('defringe', '1.7.0'),
  vignette: unsupported('vignette', '1.8.0'),
  halation: Object.freeze({
    type: 'halation',
    introducedIn: '1.5.1',
    physicalStage: STAGES.halation,
    implemented: true,
    defaults: DEFAULT_PARAMS,
    validate: createHalationParams,
    /** @param {any} params @param {any} [context] */
    supportRadius(params, context = {}) {
      /** @type {any} */
      const validated = createHalationParams(params);
      /** @type {any} */
      const resolved = resolveSigmaParams(validated, context.fullWidth ?? 1, context.fullHeight ?? 1);
      const sigma = Number(resolved.sigma ?? 0);
      const ratio = Math.max(...(resolved.sigmaRatio ?? [1, 1, 1]));
      const redTail = 1.9;
      const local = 5 * sigma * ratio * redTail;
      const global = resolved.globalDiffusion > 0 ? Math.max(12, sigma * 4) : 0;
      const expansion = resolved.sourceExpansion > 0 ? sigma * (0.45 + 0.85 * resolved.sourceExpansion) : 0;
      return Math.ceil(Math.max(local, global, expansion));
    },
    /** @param {any} frame @param {any} params */
    estimateMemory(frame, params) {
      return frame.width * frame.height * 4 * 4;
    },
    /** @param {any} input @param {any} params @param {any} context */
    process(input, params, context) {
      const validated = createHalationParams({
        ...params,
        // Halation already has a serialized per-node diffusion choice. Only
        // an explicit preview force-fast request may override it; graph-wide
        // MTF quality must not silently disable the user's Halation setting.
        ...(context.forceFast ? { diffusionMode: 'fast' } : {}),
      });
      const resolved = resolveSigmaParams(
        validated,
        context.fullWidth ?? input.width,
        context.fullHeight ?? input.height,
      );
      return processHalation(input, resolved, context);
    },
  }),
  bloom: unsupported('bloom', '1.7.0'),
  highlightProtection: unsupported('highlightProtection', '1.7.0'),
  filmResolution: Object.freeze({
    type: 'filmResolution',
    introducedIn: '1.6.0',
    physicalStage: STAGES.filmResolution,
    implemented: true,
    defaults: FILM_RESOLUTION_DEFAULTS,
    validate: createFilmResolutionParams,
    /** @param {any} params @param {any} [context] */
    supportRadius(params, context = {}) {
      return filmResolutionSupport(validateFilmResolutionParams(params), context.format, context.fullWidth ?? 1, context.previewScale ?? 1, context.quality);
    },
    /** @param {any} frame */
    estimateMemory(frame) {
      return frame.width * frame.height * 7 * 4;
    },
    process: processFilmResolution,
  }),
  grain: Object.freeze({
    type: 'grain',
    introducedIn: '1.6.0',
    physicalStage: STAGES.grain,
    implemented: true,
    defaults: GRAIN_DEFAULTS,
    validate: createGrainParams,
    supportRadius: grainSupport,
    /** @param {any} frame */
    estimateMemory(frame) {
      return frame.width * frame.height * 8 * 4;
    },
    /** @param {any} input @param {any} params @param {any} context */
    process(input, params, context) {
      const effective = context.quality === 'fast' && params.mode !== 'fast'
        ? createGrainParams({ ...params, mode: 'fast' })
        : params;
      return processGrain(input, effective, context);
    },
  }),
  damage: unsupported('damage', '1.8.0'),
  overscan: unsupported('overscan', '1.9.0'),
});

/** @param {string} type */
export function getEffectDefinition(type) {
  return FILM_EFFECT_REGISTRY[type] ?? null;
}

/** @param {any} node */
export function validateEffectNode(node) {
  if (!node || typeof node !== 'object') throw new TypeError('Effect node must be an object');
  if (typeof node.id !== 'string' || !node.id) throw new TypeError('Effect node id is required');
  const definition = getEffectDefinition(node.type);
  if (!definition) throw new Error(`Unknown effect node type: ${String(node.type)}`);
  if (!definition.implemented) definition.validate(node.params);
  const params = definition.validate(node.params ?? definition.defaults);
  return { id: node.id, type: node.type, enabled: node.enabled !== false, params };
}

/** @param {any[]} graph @param {{requireHalation?:boolean}} [options] */
export function normalizeEffectGraph(graph, options = {}) {
  if (!Array.isArray(graph)) throw new TypeError('Effect graph must be an array');
  const seen = new Set();
  const validated = graph.map((node) => {
    const result = validateEffectNode(node);
    if (seen.has(result.id)) throw new Error(`Duplicate effect node id: ${result.id}`);
    seen.add(result.id);
    return result;
  });
  if (options.requireHalation !== false) {
    const halation = validated.filter((node) => node.type === 'halation');
    if (halation.length !== 1) throw new Error('Effect graph must contain exactly one halation node');
  }
  validated.sort((a, b) => STAGES[a.type] - STAGES[b.type]);
  return validated;
}

/** @param {any} halationParams @param {number} [seed=GRAIN_DEFAULTS.seed] */
export function createDefaultEffectGraph(halationParams, seed = GRAIN_DEFAULTS.seed) {
  return normalizeEffectGraph([
    { id: 'halation-main', type: 'halation', enabled: true, params: createHalationParams(halationParams) },
    { id: 'film-resolution-main', type: 'filmResolution', enabled: true, params: createFilmResolutionParams() },
    { id: 'grain-main', type: 'grain', enabled: true, params: createGrainParams({ seed, seedMode: 'randomOnCreate' }) },
  ]);
}

/** @param {any[]} graph */
export function graphMinimumEngineVersion(graph) {
  return graph.some((node) => node.type === 'filmResolution' || node.type === 'grain') ? '1.6.0' : '1.5.1';
}
