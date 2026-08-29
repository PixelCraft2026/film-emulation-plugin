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
import {
  createDefringeParams,
  DEFRINGE_DEFAULTS,
  processDefringe,
  validateDefringeParams,
  defringeSupport,
} from './defringe.js';
import {
  createBloomParams,
  BLOOM_DEFAULTS,
  processBloom,
  validateBloomParams,
  bloomSupport,
} from './bloom.js';
import {
  createHighlightProtectionParams,
  HIGHLIGHT_PROTECTION_DEFAULTS,
  processHighlightProtection,
  validateHighlightProtectionParams,
} from './highlightProtection.js';
import { createLumaMask, LUMA_MASK_DEFAULTS } from './mask.js';

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
    /** @param {any} params @param {any} [context] */
    describeWorkset(params, context = {}) {
      return Object.freeze({
        sourceRadius: 0,
        generatedFieldRadius: 0,
        phasePeriod: 1,
        buffers: [],
        wasm: { supported: false },
        backends: {
          'js-reference': { supported: false, resident: false, precision: 'f32' },
          'wasm-resident': { supported: false, resident: true, precision: 'f32' },
          'gpu-native': {
            supported: false,
            planned: false,
            resident: true,
            abi: 'gpu-native-reserved-v1',
            precision: 'f32',
            reason: `Effect "${type}" is not implemented in this build`,
          },
        },
        identity: true,
      });
    },
    /** @param {any} frame @param {any} params */
    estimateMemory(frame, params) { return 0; },
    /** @param {any} input @param {any} params @param {any} context */
    process(input, params, context) {
      throw new Error(`Effect "${type}" requires engine ${introducedIn}; it is not available in this build`);
    },
  });
}

const V17_WASM_CAPABILITY = Object.freeze({
  'js-reference': { supported: true, resident: false, precision: 'f32' },
  'wasm-resident': { supported: true, resident: true, abi: 'v17-command-v1', precision: 'f32' },
  'wasm-resident-simd': {
    supported: true,
    resident: true,
    abi: 'v17-command-v1',
    precision: 'f32',
    qualified: false,
    reason: 'Requires simd128 validation and >=10% QA speedup',
  },
  'gpu-native': {
    supported: false,
    planned: true,
    resident: true,
    abi: 'gpu-native-reserved-v1',
    precision: 'f32',
    reason: 'Reserved for GPU feasibility work after V1.7',
  },
});

/**
 * @param {{sourceRadius?:number, generatedFieldRadius?:number, phasePeriod?:number,
 * buffers?:any[], identity?:boolean, transientsRead?:string[], transientsWrite?:string[],
 * residentArenaPlanes?:number, residentTransientPlanes?:number}} options
 */
function v17Workset({ sourceRadius = 0, generatedFieldRadius = 0, phasePeriod = 1, buffers = [], identity = false, transientsRead = [], transientsWrite = [], residentArenaPlanes = 0, residentTransientPlanes = 0 }) {
  return Object.freeze({
    sourceRadius,
    generatedFieldRadius,
    phasePeriod,
    buffers,
    transientsRead,
    transientsWrite,
    residentArenaPlanes,
    residentTransientPlanes,
    wasm: { supported: true, mode: 'v17-command-v1' },
    backends: V17_WASM_CAPABILITY,
    identity,
  });
}

/** @type {Record<string, any>} */
export const FILM_EFFECT_REGISTRY = Object.freeze({
  defringe: Object.freeze({
    type: 'defringe',
    introducedIn: '1.7.0',
    physicalStage: STAGES.defringe,
    implemented: true,
    compositeMode: 'replacement',
    defaults: DEFRINGE_DEFAULTS,
    validate: validateDefringeParams,
    supportRadius: defringeSupport,
    /** @param {any} params @param {any} [context] */
    describeWorkset(params, context = {}) {
      const validated = validateDefringeParams(params);
      return v17Workset({
        sourceRadius: defringeSupport(validated, context),
        buffers: [
          { name: 'defringe-y', channels: 1, factor: 1, kind: 'plane', lifetime: 'node' },
          { name: 'defringe-cg', channels: 1, factor: 1, kind: 'plane', lifetime: 'node' },
          { name: 'defringe-blur', channels: 1, factor: 1, kind: 'scratch', lifetime: 'node' },
        ],
        residentArenaPlanes: 7,
        identity: validated.amount === 0 || validated.edgeSensitivity === 0,
      });
    },
    /** @param {{width:number,height:number}} frame */
    estimateMemory(frame) { return frame.width * frame.height * 5 * 4; },
    /** @param {any} input @param {any} params @param {any} context */
    process: processDefringe,
  }),
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
    /** @param {any} params @param {any} [context] */
    describeWorkset(params, context = {}) {
      const validated = createHalationParams(params);
      const resolved = resolveSigmaParams(validated, context.fullWidth ?? 1, context.fullHeight ?? 1);
      const sourceRadius = this.supportRadius(validated, context);
      return Object.freeze({
        sourceRadius,
        generatedFieldRadius: 0,
        phasePeriod: Math.max(1, Math.trunc(context.quality === 'fast' ? 1 : 2)),
        buffers: [
          { name: 'extract-y', channels: 1, factor: 1 },
          { name: 'extract-source', channels: 3, factor: 1 },
          { name: 'halo', channels: 3, factor: 1 },
          { name: 'diffuse-scratch', channels: 2, factor: 1 },
        ],
        residentArenaPlanes: 19,
        residentTransientPlanes: 1,
        wasm: { supported: true, mode: 'v17-command-v1' },
        backends: {
          'js-reference': { supported: true, resident: false, precision: 'f32' },
          'wasm-resident': { supported: true, resident: true, abi: 'v17-command-v1', precision: 'f32' },
          'wasm-resident-simd': { supported: true, resident: true, abi: 'v17-command-v1', precision: 'f32', qualified: false, reason: 'Requires simd128 validation and >=10% QA speedup' },
          'gpu-native': {
            supported: false,
            planned: true,
            resident: true,
            abi: 'gpu-native-reserved-v1',
            precision: 'f32',
            reason: 'Reserved for GPU feasibility work after V1.6',
          },
        },
        identity: validated.strength === 0,
      });
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
      return processHalation(input, resolved, { ...context, compact: context.compact ?? true });
    },
  }),
  bloom: Object.freeze({
    type: 'bloom',
    introducedIn: '1.7.0',
    physicalStage: STAGES.bloom,
    implemented: true,
    compositeMode: 'additive',
    defaults: BLOOM_DEFAULTS,
    validate: validateBloomParams,
    supportRadius: bloomSupport,
    /** @param {any} params @param {any} [context] */
    describeWorkset(params, context = {}) {
      const validated = validateBloomParams(params);
      return v17Workset({
        sourceRadius: bloomSupport(validated, context),
        phasePeriod: 8,
        buffers: [
          { name: 'bloom-source', channels: 3, factor: 1, kind: 'plane', lifetime: 'node' },
          { name: 'bloom-base', channels: 3, factor: 1, kind: 'transient', lifetime: 'until-consumed', alias: 'bloomBase' },
          { name: 'bloom-contribution', channels: 3, factor: 1, kind: 'transient', lifetime: 'until-consumed', alias: 'bloomContribution' },
          { name: 'bloom-scratch', channels: 2, factor: 1, kind: 'scratch', lifetime: 'node' },
        ],
        transientsWrite: ['bloomBase', 'bloomContribution'],
        residentArenaPlanes: 10,
        residentTransientPlanes: 3,
        identity: validated.amplify === 0,
      });
    },
    /** @param {{width:number,height:number}} frame */
    estimateMemory(frame) { return frame.width * frame.height * 8 * 4; },
    /** @param {any} input @param {any} params @param {any} context */
    process: processBloom,
  }),
  highlightProtection: Object.freeze({
    type: 'highlightProtection',
    introducedIn: '1.7.0',
    physicalStage: STAGES.highlightProtection,
    implemented: true,
    compositeMode: 'replacement',
    defaults: HIGHLIGHT_PROTECTION_DEFAULTS,
    validate: validateHighlightProtectionParams,
    supportRadius() { return 0; },
    /** @param {any} params */
    describeWorkset(params) {
      const validated = validateHighlightProtectionParams(params);
      return v17Workset({
        buffers: [],
        transientsRead: ['bloomBase', 'bloomContribution'],
        residentTransientPlanes: 3,
        identity: validated.amount === 0,
      });
    },
    estimateMemory() { return 0; },
    /** @param {any} input @param {any} params @param {any} context */
    process: processHighlightProtection,
  }),
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
    /** @param {any} params @param {any} context */
    describeWorkset(params, context = {}) {
      const validated = validateFilmResolutionParams(params);
      return Object.freeze({
        sourceRadius: this.supportRadius(validated, context),
        generatedFieldRadius: 0,
        phasePeriod: 1,
        buffers: [
          { name: 'resolution-source', channels: 3, factor: 1 },
          { name: 'resolution-blur', channels: 3, factor: 1 },
          { name: 'resolution-scratch', channels: 2, factor: 1 },
          { name: 'resolution-weights', channels: 1, factor: 1 },
        ],
        residentArenaPlanes: 6,
        residentTransientPlanes: 1,
        wasm: { supported: true, mode: 'v17-command-v1' },
        backends: {
          'js-reference': { supported: true, resident: false, precision: 'f32' },
          'wasm-resident': { supported: true, resident: true, abi: 'v17-command-v1', precision: 'f32' },
          'wasm-resident-simd': {
            supported: true,
            resident: true,
            abi: 'v17-command-v1',
            precision: 'f32',
            qualified: false,
            reason: 'Requires simd128 validation and >=10% QA speedup',
          },
          'gpu-native': {
            supported: false,
            planned: true,
            resident: true,
            abi: 'gpu-native-reserved-v1',
            precision: 'f32',
            reason: 'Reserved for GPU feasibility work after V1.6',
          },
        },
        identity: validated.amount === 0,
      });
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
    /** @param {any} params @param {any} context */
    describeWorkset(params, context = {}) {
      const validated = createGrainParams(params);
      return Object.freeze({
        sourceRadius: 0,
        generatedFieldRadius: grainSupport(validated, context),
        phasePeriod: 1,
        buffers: [
          { name: 'grain-accum', channels: 3, factor: 1 },
          { name: 'grain-field', channels: 1, factor: 1 },
          { name: 'grain-scratch', channels: 3, factor: 1 },
        ],
        // Grain's downsampled generated field includes coordinate-addressed
        // padding. Nineteen planes covers the validated parameter envelope
        // while remaining below wasm32's single-allocation limit per band.
        residentArenaPlanes: 19,
        residentTransientPlanes: 1,
        wasm: { supported: true, mode: 'v17-command-v1' },
        backends: {
          'js-reference': { supported: true, resident: false, precision: 'f32' },
          'wasm-resident': { supported: true, resident: true, abi: 'v17-command-v1', precision: 'f32' },
          'wasm-resident-simd': {
            supported: true,
            resident: true,
            abi: 'v17-command-v1',
            precision: 'f32',
            qualified: false,
            reason: 'Requires simd128 validation and >=10% QA speedup',
          },
          'gpu-native': {
            supported: false,
            planned: true,
            resident: true,
            abi: 'gpu-native-reserved-v1',
            precision: 'f32',
            reason: 'Reserved for GPU feasibility work after V1.6',
          },
        },
        identity: validated.amount === 0,
      });
    },
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
  const mask = createLumaMask(node.mask ?? LUMA_MASK_DEFAULTS);
  return { id: node.id, type: node.type, enabled: node.enabled !== false, params, mask };
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
    { id: 'defringe-main', type: 'defringe', enabled: false, params: createDefringeParams(), mask: createLumaMask() },
    { id: 'halation-main', type: 'halation', enabled: true, params: createHalationParams(halationParams), mask: createLumaMask() },
    { id: 'bloom-main', type: 'bloom', enabled: false, params: createBloomParams(), mask: createLumaMask() },
    { id: 'highlight-protection-main', type: 'highlightProtection', enabled: false, params: createHighlightProtectionParams(), mask: createLumaMask() },
    // V1.6 physical effects are opt-in. Keep their calibrated parameters in
    // the document so enabling a switch never has to reconstruct user state.
    { id: 'film-resolution-main', type: 'filmResolution', enabled: false, params: createFilmResolutionParams(), mask: createLumaMask() },
    { id: 'grain-main', type: 'grain', enabled: false, params: createGrainParams({ seed, seedMode: 'randomOnCreate' }), mask: createLumaMask() },
  ]);
}

/** @param {any[]} graph */
export function graphMinimumEngineVersion(graph) {
  return graph.some((node) => ['defringe', 'bloom', 'highlightProtection'].includes(node.type)
    || (node.mask && node.mask.mode !== 'none'))
    ? '1.7.0'
    : graph.some((node) => node.type === 'filmResolution' || node.type === 'grain') ? '1.6.0' : '1.5.1';
}
