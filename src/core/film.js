// @ts-nocheck
/** FilmLab 可扩展效果图执行器（V1.6：Halation → MTF → Grain）。 */
import { normalizeEffectGraph, getEffectDefinition, graphMinimumEngineVersion, EFFECT_ORDER } from './effectRegistry.js';

export const ENGINE_VERSION = '1.5.1';
export const FILM_GRAPH_VERSION = '1.6.0';

/**
 * @param {{width:number,height:number,rgb:Float32Array,alpha?:Float32Array}} input
 * @param {{graph:Array<{id:string,type:string,enabled:boolean,params:object}>}} document
 * @param {{width?:number,height?:number,fullWidth?:number,fullHeight?:number,originX?:number,originY?:number,quality?:'fast'|'quality',format?:object,previewScale?:number,seed?:number,memoryPlan?:object,signal?:AbortSignal,nodeId?:string}} [context]
 */
export function processFilm(input, document, context = {}) {
  if (!document || !Array.isArray(document.graph)) throw new TypeError('processFilm: document.graph is required');
  if (context.signal?.aborted) throw new Error('Film render cancelled');
  if ((context.width && context.width !== input.width) || (context.height && context.height !== input.height)) {
    throw new RangeError('processFilm: RenderContext dimensions do not match input');
  }
  const graph = normalizeEffectGraph(document.graph);
  const result = runEffectNodes(input, graph, context);
  return {
    ...result,
    stats: {
      engineVersion: graphMinimumEngineVersion(graph) === ENGINE_VERSION ? ENGINE_VERSION : FILM_GRAPH_VERSION,
      halationEngineVersion: ENGINE_VERSION,
      minimumEngineVersion: graphMinimumEngineVersion(graph),
      seed: context.seed ?? 0,
      effectiveSeed: context.seed ?? 0,
      nodes: result.stats.nodes,
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
    current = { width: result.width, height: result.height, rgb: result.rgb, alpha: result.alpha };
    nodes.push({
      id: node.id,
      type: node.type,
      backend: result.stats?.backend ?? 'js',
      elapsedMs,
      scratchBytes: result.stats?.scratchBytes ?? 0,
      warnings: result.stats?.warnings ?? [],
    });
  }
  return {
    ...current,
    stats: {
      nodes,
    },
  };
}

export { EFFECT_ORDER };
