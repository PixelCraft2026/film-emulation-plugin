// @ts-nocheck
/** FilmLab 可扩展效果图执行器（V1.5 仅启用 halation 节点）。 */
import { createHalationParams } from './params.js';
import { processHalation } from './pipeline.js';

export const ENGINE_VERSION = '1.5.0';
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

/**
 * @param {{width:number,height:number,rgb:Float32Array,alpha?:Float32Array}} input
 * @param {{graph:Array<{id:string,type:string,enabled:boolean,params:object}>}} document
 * @param {{width?:number,height?:number,quality?:'fast'|'quality',seed?:number,signal?:AbortSignal}} [context]
 */
export function processFilm(input, document, context = {}) {
  if (!document || !Array.isArray(document.graph)) throw new TypeError('processFilm: document.graph is required');
  if (context.signal?.aborted) throw new Error('Film render cancelled');
  if ((context.width && context.width !== input.width) || (context.height && context.height !== input.height)) {
    throw new RangeError('processFilm: RenderContext dimensions do not match input');
  }
  let current = {
    width: input.width,
    height: input.height,
    rgb: new Float32Array(input.rgb),
    alpha: input.alpha ? new Float32Array(input.alpha) : undefined,
  };
  const nodes = [];
  for (const node of document.graph) {
    if (!node || node.enabled === false) continue;
    if (context.signal?.aborted) throw new Error('Film render cancelled');
    if (node.type !== 'halation') {
      throw new Error(`processFilm: effect "${String(node.type)}" is not available in engine ${ENGINE_VERSION}`);
    }
    const params = createHalationParams({
      ...node.params,
      ...(context.quality ? { diffusionMode: context.quality } : {}),
    });
    const result = processHalation(current, params);
    current = { width: result.width, height: result.height, rgb: result.rgb, alpha: result.alpha };
    nodes.push({ id: node.id, type: node.type, backend: result.stats.backend });
  }
  return { ...current, stats: { engineVersion: ENGINE_VERSION, seed: context.seed ?? 0, nodes } };
}
