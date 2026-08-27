// @ts-nocheck
/** FilmLab 可扩展效果图执行器（V1.6：Halation → MTF → Grain）。 */
import { normalizeEffectGraph, getEffectDefinition, graphMinimumEngineVersion, EFFECT_ORDER } from './effectRegistry.js';
import { createFilmRenderPlan } from './renderPlan.js';
import { getWasmBackendStatus } from './wasmBackend.js';
import { createBackendTransferStats } from './backendContract.js';

export const ENGINE_VERSION = '1.5.1';
export const FILM_GRAPH_VERSION = '1.6.0';

/**
 * @param {{width:number,height:number,rgb:Float32Array,alpha?:Float32Array}} input
 * @param {{graph:Array<{id:string,type:string,enabled:boolean,params:object}>}} document
 * @param {{width?:number,height?:number,fullWidth?:number,fullHeight?:number,originX?:number,originY?:number,quality?:'fast'|'quality',format?:object,previewScale?:number,seed?:number,memoryPlan?:object,signal?:AbortSignal,nodeId?:string,renderPlan?:object,arena?:object,backend?:string,memoryMode?:string,componentSize?:number,deviceMemoryGB?:number}} [context]
 */
export function processFilm(input, document, context = {}) {
  if (!document || !Array.isArray(document.graph)) throw new TypeError('processFilm: document.graph is required');
  if (context.signal?.aborted) throw new Error('Film render cancelled');
  if ((context.width && context.width !== input.width) || (context.height && context.height !== input.height)) {
    throw new RangeError('processFilm: RenderContext dimensions do not match input');
  }
  const graph = normalizeEffectGraph(document.graph);
  const renderPlan = context.renderPlan ?? createFilmRenderPlan({
    width: input.width,
    height: input.height,
    fullWidth: context.fullWidth ?? input.width,
    fullHeight: context.fullHeight ?? input.height,
    previewScale: context.previewScale ?? 1,
    componentSize: context.componentSize ?? 32,
    quality: context.quality ?? 'quality',
    format: context.format ?? document.format,
    memoryMode: context.memoryMode ?? 'auto',
    deviceMemoryGB: context.deviceMemoryGB,
    graph,
  });
  const result = runEffectNodes(input, graph, { ...context, renderPlan });
  const arenaStats = context.arena?.stats?.() ?? null;
  const nodeStats = result.stats.nodes;
  return {
    ...result,
    stats: {
      engineVersion: graphMinimumEngineVersion(graph) === ENGINE_VERSION ? ENGINE_VERSION : FILM_GRAPH_VERSION,
      halationEngineVersion: ENGINE_VERSION,
      minimumEngineVersion: graphMinimumEngineVersion(graph),
      seed: context.seed ?? 0,
      effectiveSeed: context.seed ?? 0,
      nodes: nodeStats,
      planHash: renderPlan.planHash,
      graphHash: renderPlan.graphHash,
      backend: context.backend && context.backend !== 'auto'
        ? context.backend
        : (nodeStats.map((node) => node.backend).includes('wasm') ? 'wasm' : 'js'),
      memory: {
        budgetBytes: renderPlan.budgetBytes,
        plannedPeakBytes: renderPlan.memory.plannedPeakBytes,
        estimatedBandBytes: renderPlan.memory.estimatedBandBytes,
        actualPeakBytes: arenaStats?.peakBytes ?? 0,
        breakdown: renderPlan.memory,
      },
      copies: {
        ...createBackendTransferStats(),
        ...(result.stats.copies ?? { inputBytes: 0, outputBytes: 0, count: 0 }),
      },
      passes: result.stats.passes ?? { fullPixelPasses: 0, perNode: {} },
      timings: result.stats.timings ?? { total: 0, read: 0, process: 0, quantize: 0, write: 0, perNode: {}, perStage: {} },
      fallback: result.stats.fallback ?? null,
      wasm: getWasmBackendStatus().metrics,
      outputGeometryChanged: false,
    },
  };
}

/** Execute a validated subset of nodes against an already-rendered frame. */
export function processFilmStages(input, nodes, context = {}) {
  const graph = normalizeEffectGraph(nodes, { requireHalation: false });
  return runEffectNodes(input, graph, context);
}

function runEffectNodes(input, graph, context) {
  let current = {
    width: input.width,
    height: input.height,
    // Effect processors are pure and allocate their own non-identity output.
    // Keeping the canonical input by reference avoids a redundant full-frame
    // RGB/alpha clone at every graph or preview-stage invocation.
    rgb: input.rgb,
    alpha: input.alpha,
  };
  const nodes = [];
  const perNodeTimings = {};
  const perStageTimings = {};
  let fullPixelPasses = 0;
  let inputBytes = 0;
  let outputBytes = 0;
  const startedAll = globalThis.performance?.now?.() ?? Date.now();
  for (const node of graph) {
    if (!node || node.enabled === false) continue;
    if (context.signal?.aborted) throw new Error('Film render cancelled');
    const definition = getEffectDefinition(node.type);
    const cache = context.nodeCaches
      ? (context.nodeCaches[node.id] ?? (context.nodeCaches[node.id] = {}))
      : undefined;
    const started = globalThis.performance?.now?.() ?? Date.now();
    const result = definition.process(current, node.params, {
      ...context,
      width: current.width,
      height: current.height,
      fullWidth: context.fullWidth ?? input.width,
      fullHeight: context.fullHeight ?? input.height,
      nodeId: node.id,
      cache,
    });
    const elapsedMs = (globalThis.performance?.now?.() ?? Date.now()) - started;
    perNodeTimings[node.id] = elapsedMs;
    for (const [stage, stageMs] of Object.entries(result.stats?.timings ?? {})) {
      if (Number.isFinite(stageMs)) perStageTimings[stage] = (perStageTimings[stage] ?? 0) + stageMs;
    }
    fullPixelPasses += result.stats?.fullPixelPasses ?? 1;
    inputBytes += result.stats?.inputBytes ?? 0;
    outputBytes += result.stats?.outputBytes ?? 0;
    current = { width: result.width, height: result.height, rgb: result.rgb, alpha: result.alpha };
    nodes.push({
      id: node.id,
      type: node.type,
      backend: result.stats?.backend ?? 'js',
      elapsedMs,
      scratchBytes: result.stats?.scratchBytes ?? 0,
      warnings: result.stats?.warnings ?? [],
      fullPixelPasses: result.stats?.fullPixelPasses ?? 1,
      inputBytes: result.stats?.inputBytes ?? 0,
      outputBytes: result.stats?.outputBytes ?? 0,
      fieldsGenerated: result.stats?.fieldsGenerated ?? 0,
      sharedFieldsGenerated: result.stats?.sharedFieldsGenerated ?? 0,
      independentFieldsGenerated: result.stats?.independentFieldsGenerated ?? 0,
      timings: result.stats?.timings ?? null,
    });
  }
  const totalElapsed = (globalThis.performance?.now?.() ?? Date.now()) - startedAll;
  return {
    ...current,
    stats: {
      nodes,
      copies: { inputBytes, outputBytes, count: nodes.length ? nodes.length * 2 : 0 },
      passes: { fullPixelPasses, perNode: Object.fromEntries(nodes.map((node) => [node.id, node.fullPixelPasses])) },
      timings: {
        total: totalElapsed,
        read: 0,
        process: totalElapsed,
        quantize: 0,
        write: 0,
        perNode: perNodeTimings,
        perStage: perStageTimings,
      },
    },
  };
}

export { EFFECT_ORDER };
