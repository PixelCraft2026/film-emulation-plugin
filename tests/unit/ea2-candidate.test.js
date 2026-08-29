import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createBloomParams,
  createDefaultEffectGraph,
  createFilmRenderPlan,
  createHalationParams,
  createHighlightProtectionParams,
  createGraphCommandBuffer,
  validateGraphCommandBuffer,
} from '../../src/core/index.js';

test('EA-2 physical layout is deterministic, aligned, and frame-safe after HP', () => {
  const graph = createDefaultEffectGraph(createHalationParams({ strength: 0 }), 7).map((node) => {
    if (node.type === 'bloom') return { ...node, enabled: true, params: createBloomParams({ amplify: 0.4 }) };
    if (node.type === 'highlightProtection') return { ...node, enabled: true, params: createHighlightProtectionParams({ amount: 0.4 }) };
    return node;
  });
  const plan = createFilmRenderPlan({ width: 37, height: 29, fullWidth: 37, fullHeight: 29, graph, quality: 'quality', memoryMode: 'high' });
  assert.equal(plan.physicalLayout.version, 1);
  assert.equal(plan.physicalLayout.alignmentFloats, 16);
  assert.equal(plan.arenaHighWaterFloats, plan.physicalLayout.scratchFloats);
  assert.equal(plan.transientHighWaterFloats, plan.physicalLayout.transientFloats);
  assert.ok(plan.physicalLayout.layoutHash);
  assert.ok(plan.physicalLayout.residentScratchFloats <= plan.physicalLayout.scratchFloats);
  assert.equal(plan.physicalLayout.residentBindings.length, plan.physicalLayout.bindings.length);
  assert.ok(plan.physicalLayout.residentBindings.every((binding) => binding.buffers.every((buffer) => (
    buffer.kind === 'transient' || (buffer.offsetFloats + buffer.lengthFloats <= plan.physicalLayout.residentScratchFloats)
  ))));
  const hp = plan.physicalLayout.bindings.find((binding) => binding.nodeId === 'highlight-protection-main');
  assert.equal(hp.inputFrame, hp.outputFrame);
  const contribution = plan.physicalLayout.transient.find((slot) => slot.name === 'bloomContribution');
  assert.ok(contribution.lengthFloats > 0);
  // Bloom produces the contribution at index 1; HP consumes it at index 2.
  assert.equal(plan.aliasPlan.intervals.find((item) => item.alias === 'bloomContribution').last, 2);
  const command = createGraphCommandBuffer(plan, { width: 37, height: 29, quality: 'quality' });
  const parsed = validateGraphCommandBuffer(command);
  assert.equal(parsed.nodes.length, plan.commands.length);
});
