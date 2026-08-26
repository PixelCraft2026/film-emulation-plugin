/** Pure graph-state helpers used to keep effect-domain controls independent. */

/** @param {Array<any>} graph @param {string} type @param {object} params */
export function replaceGraphNodeParams(graph, type, params) {
  return graph.map((node) => node.type === type ? { ...node, params } : node);
}

/**
 * Accept one domain change while retaining every other domain from the
 * authoritative runtime graph. This prevents a stale panel snapshot from
 * restoring old Halation parameters during a Resolution/Grain adjustment.
 * @param {Array<any>} currentGraph
 * @param {Array<any>} proposedGraph
 * @param {string} changedType
 */
export function mergeIndependentGraphChange(currentGraph, proposedGraph, changedType) {
  const changedNode = proposedGraph.find((node) => node.type === changedType);
  if (!changedNode) return currentGraph;
  let replaced = false;
  const next = currentGraph.map((node) => {
    if (node.type !== changedType) return node;
    replaced = true;
    return changedNode;
  });
  if (!replaced) next.push(changedNode);
  return next;
}
