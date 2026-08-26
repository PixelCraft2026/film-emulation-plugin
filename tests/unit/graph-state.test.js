import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createDefaultEffectGraph,
  createFilmResolutionParams,
  createGrainParams,
  createHalationParams,
} from '../../src/core/index.js';
import { mergeIndependentGraphChange, replaceGraphNodeParams } from '../../src/ui/graphState.js';

test('editing Grain cannot restore stale Halation or Resolution state', () => {
  const authoritative = createDefaultEffectGraph(createHalationParams({ strength: 0 }), 0x12345678)
    .map((node) => node.type === 'filmResolution'
      ? { ...node, enabled: true, params: createFilmResolutionParams({ amount: 0.35 }) }
      : node);
  const stalePanel = createDefaultEffectGraph(createHalationParams({ strength: 82 }), 0x12345678)
    .map((node) => {
      if (node.type === 'filmResolution') {
        return { ...node, enabled: false, params: createFilmResolutionParams({ amount: 1.4 }) };
      }
      if (node.type === 'grain') {
        return { ...node, enabled: true, params: createGrainParams({ amount: 1.25, seed: 0x12345678 }) };
      }
      return node;
    });

  const merged = mergeIndependentGraphChange(authoritative, stalePanel, 'grain');
  assert.equal(merged.find((node) => node.type === 'halation').params.strength, 0);
  assert.equal(merged.find((node) => node.type === 'filmResolution').enabled, true);
  assert.equal(merged.find((node) => node.type === 'filmResolution').params.amount, 0.35);
  assert.equal(merged.find((node) => node.type === 'grain').enabled, true);
  assert.equal(merged.find((node) => node.type === 'grain').params.amount, 1.25);
});

test('Halation control changes update the panel graph snapshot without touching other nodes', () => {
  const graph = createDefaultEffectGraph(createHalationParams({ strength: 70 }), 0x12345678);
  const nextParams = createHalationParams({ strength: 0 });
  const next = replaceGraphNodeParams(graph, 'halation', nextParams);
  assert.equal(next.find((node) => node.type === 'halation').params.strength, 0);
  assert.strictEqual(
    next.find((node) => node.type === 'grain'),
    graph.find((node) => node.type === 'grain'),
  );
});
