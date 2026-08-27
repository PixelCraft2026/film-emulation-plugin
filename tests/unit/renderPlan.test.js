import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BufferArena,
  createFilmRenderPlan,
  createDefaultEffectGraph,
  createHalationParams,
  createFilmExecutor,
  createFilmResolutionParams,
  createGrainParams,
  BACKEND_IDS,
} from '../../src/core/index.js';

function fullGraph() {
  return createDefaultEffectGraph(createHalationParams({ sigma: 4 }), 0x12345678)
    .map((node) => ({ ...node, enabled: true }));
}

test('RenderPlan uses cumulative source dependencies and isolates generated Grain halo', () => {
  const graph = fullGraph();
  const plan = createFilmRenderPlan({
    width: 320,
    height: 200,
    fullWidth: 2560,
    fullHeight: 1600,
    graph,
    format: { gauge: '35mm', iso: 800 },
    quality: 'quality',
    memoryMode: 'balanced',
  });
  const halation = plan.dependencies.find((item) => item.type === 'halation');
  const resolution = plan.dependencies.find((item) => item.type === 'filmResolution');
  const grain = plan.dependencies.find((item) => item.type === 'grain');
  assert.ok(halation.sourceRadius > 0);
  assert.ok(resolution.sourceRadius > 0);
  assert.equal(grain.sourceRadius, 0);
  assert.ok(grain.generatedFieldRadius >= 0);
  assert.ok(halation.requiredInputHalo >= halation.sourceRadius + resolution.sourceRadius);
  assert.ok(plan.overlap >= halation.requiredInputHalo);
  assert.equal(plan.bands[0].start, 0);
  assert.equal(plan.bands.at(-1).end, 200);
  assert.equal(plan.phasePeriod, 2, 'Quality Halation phase is the graph LCM');
});

test('RenderPlan aligns non-divisible band tails and reports an explicit budget failure', () => {
  const graph = fullGraph();
  const plan = createFilmRenderPlan({
    width: 1_000_000,
    height: 205,
    fullWidth: 1_000_000,
    fullHeight: 205,
    graph,
    componentSize: 32,
    quality: 'quality',
    memoryMode: 'balanced',
    deviceMemoryGB: 0,
  });
  assert.equal(plan.phasePeriod, 2);
  assert.equal(plan.bands[0].y0 % plan.phasePeriod, 0);
  assert.equal(plan.bands.at(-1).y1, 205);
  assert.equal(plan.bands.at(-1).y0 % plan.phasePeriod, 0);
  assert.equal(plan.hardBudgetExceeded, true);
});

test('RenderPlan hash is stable for equivalent graph key order and memory modes are conservative', () => {
  const graph = fullGraph();
  const a = createFilmRenderPlan({ width: 64, height: 48, graph, componentSize: 16, memoryMode: 'balanced' });
  const b = createFilmRenderPlan({ width: 64, height: 48, graph: graph.map((node) => ({ params: { ...node.params }, enabled: node.enabled, type: node.type, id: node.id })), componentSize: 16, memoryMode: 'balanced' });
  assert.equal(a.graphHash, b.graphHash);
  assert.equal(a.planHash, b.planHash);
  const unknown = createFilmRenderPlan({ width: 64, height: 48, graph, componentSize: 16, memoryMode: 'auto', deviceMemoryGB: 0 });
  assert.equal(unknown.memoryMode, 'balanced');
});

test('RenderPlan reserves GPU candidates without making GPU executable in V1.6', () => {
  const plan = createFilmRenderPlan({
    width: 64,
    height: 48,
    graph: fullGraph(),
    componentSize: 16,
    memoryMode: 'balanced',
  });
  assert.equal(plan.backendSegments[BACKEND_IDS.JS].length, 1);
  assert.equal(plan.backendSegments[BACKEND_IDS.WASM].length, 1);
  assert.equal(plan.backendSegments[BACKEND_IDS.GPU].length, 0);
  assert.equal(plan.backendCandidates[BACKEND_IDS.GPU].length, 1);
  assert.deepEqual(
    plan.backendCandidates[BACKEND_IDS.GPU][0].nodeTypes,
    ['halation', 'filmResolution', 'grain'],
  );
  assert.deepEqual(plan.backendOrder, [BACKEND_IDS.WASM, BACKEND_IDS.JS]);
  assert.equal(plan.memory.gpuResidentBytes, 0);
  assert.equal(plan.memory.gpuScratchBytes, 0);
  for (const dependency of plan.dependencies) {
    assert.equal(dependency.backends[BACKEND_IDS.GPU].supported, false);
    assert.equal(dependency.backends[BACKEND_IDS.GPU].planned, true);
  }
});

test('BufferArena reuses released compatible slots without aliasing live buffers', () => {
  const arena = new BufferArena();
  const first = arena.acquire(32, 'first');
  const second = arena.acquire(32, 'second');
  assert.notEqual(first.handle.id, second.handle.id);
  first.array[0] = 7;
  arena.release(first.handle);
  const reused = arena.acquire(16, 'reused');
  assert.equal(reused.handle.id, first.handle.id);
  assert.equal(reused.array[0], 7);
  assert.equal(arena.stats().activeCount, 2);
  assert.equal(arena.stats().reusedCount, 1);
  assert.throws(() => arena.release(first.handle), /unknown|already released/);
  arena.release(second.handle);
  arena.release(reused.handle);
  assert.equal(arena.stats().activeCount, 0);
});

test('FilmExecutor publishes plan/copy/pass stats and reuses request scratch', () => {
  const graph = fullGraph().map((node) => {
    if (node.type === 'filmResolution') return { ...node, params: createFilmResolutionParams({ amount: 0.4 }) };
    if (node.type === 'grain') return { ...node, params: createGrainParams({ amount: 0.35, mode: 'fast', seed: 0x12345678 }) };
    return node;
  });
  const plan = createFilmRenderPlan({
    width: 32,
    height: 24,
    fullWidth: 2560,
    fullHeight: 1600,
    graph,
    format: { gauge: '35mm', iso: 250 },
    componentSize: 16,
    memoryMode: 'balanced',
  });
  const executor = createFilmExecutor(plan, { backend: 'js' });
  const rgb = new Float32Array(32 * 24 * 3).fill(0.18);
  const result = executor.render(
    { width: 32, height: 24, rgb },
    { format: { gauge: '35mm', iso: 250 }, graph },
    { fullWidth: 2560, fullHeight: 1600, format: { gauge: '35mm', iso: 250 }, quality: 'fast' },
  );
  assert.equal(result.stats.planHash, plan.planHash);
  assert.equal(result.stats.graphHash, plan.graphHash);
  assert.ok(result.stats.passes.fullPixelPasses > 0);
  assert.ok(result.stats.memory.plannedPeakBytes > 0);
  assert.equal(executor.stats().activeCount, 0);
  executor.dispose();
});

test('FilmExecutor keeps auto on CPU and fully retries after an injected GPU failure', () => {
  const graph = createDefaultEffectGraph(createHalationParams({ strength: 0 }), 0x12345678)
    .map((node) => ({
      ...node,
      enabled: true,
      params: node.type === 'filmResolution'
        ? createFilmResolutionParams({ amount: 0 })
        : node.type === 'grain'
          ? createGrainParams({ amount: 0, seed: 0x12345678 })
          : node.params,
    }));
  const plan = createFilmRenderPlan({ width: 8, height: 6, graph, componentSize: 16, memoryMode: 'balanced' });
  const rgb = Float32Array.from({ length: 8 * 6 * 3 }, (_, index) => (index % 17) / 19);
  let gpuRenderCalls = 0;
  const failingGpu = {
    id: BACKEND_IDS.GPU,
    abi: 'gpu-native-reserved-v1',
    available: true,
    reason: null,
    prepare() {},
    render() {
      gpuRenderCalls += 1;
      const error = new Error('injected GPU execution failure');
      error.code = 'ERR_GPU_EXECUTE_INJECTED';
      throw error;
    },
    stats() {
      return {
        transfers: { hostToGpuBytes: 0, gpuToHostBytes: 0, boundaryCount: 0 },
        memory: { gpuResidentBytes: 0, gpuScratchBytes: 0, stagingBytes: 0 },
      };
    },
    dispose() {},
  };

  const auto = createFilmExecutor(plan, { backend: 'auto', gpuBackend: failingGpu });
  const autoResult = auto.render({ width: 8, height: 6, rgb }, { graph });
  assert.equal(gpuRenderCalls, 0, 'planned-only GPU segments must not be selected by auto');
  assert.equal(autoResult.stats.fallback, null);
  auto.dispose();

  const forced = createFilmExecutor(plan, {
    backend: BACKEND_IDS.GPU,
    gpuBackend: failingGpu,
    allowExperimentalGpu: true,
  });
  const result = forced.render({ width: 8, height: 6, rgb }, { graph });
  assert.equal(gpuRenderCalls, 1);
  assert.equal(result.stats.fallback.stage, 'gpu-execute');
  assert.equal(result.stats.fallback.code, 'ERR_GPU_EXECUTE_INJECTED');
  assert.deepEqual(result.stats.fallback.order, [BACKEND_IDS.GPU, BACKEND_IDS.WASM, BACKEND_IDS.JS]);
  assert.equal(result.stats.copies.hostToGpuBytes, 0);
  assert.equal(result.stats.copies.gpuToHostBytes, 0);
  assert.deepEqual(result.rgb, rgb, 'CPU retry must restart from the original input');
  forced.render({ width: 8, height: 6, rgb }, { graph });
  assert.equal(gpuRenderCalls, 1, 'one GPU failure disables further attempts for the request executor');
  assert.equal(forced.stats().gpuDisabledForRequest, true);
  forced.dispose();
});

test('FilmExecutor accepts a contract-compatible experimental GPU adapter and publishes telemetry', () => {
  const graph = createDefaultEffectGraph(createHalationParams({ strength: 0 }), 7)
    .map((node) => ({ ...node, enabled: node.type === 'halation' }));
  const plan = createFilmRenderPlan({ width: 4, height: 3, graph, componentSize: 16, memoryMode: 'balanced' });
  const rgb = new Float32Array(4 * 3 * 3).fill(0.25);
  const alpha = new Float32Array(4 * 3).fill(1);
  const gpu = {
    id: BACKEND_IDS.GPU,
    abi: 'gpu-native-reserved-v1',
    available: true,
    prepare() {},
    render({ input }) {
      return {
        ...input,
        stats: {
          copies: { inputBytes: 0, outputBytes: 0, count: 0 },
          memory: { breakdown: {} },
          fallback: null,
        },
      };
    },
    stats() {
      return {
        transfers: { hostToGpuBytes: rgb.byteLength, gpuToHostBytes: rgb.byteLength, boundaryCount: 2 },
        memory: { gpuResidentBytes: rgb.byteLength, gpuScratchBytes: 256, stagingBytes: rgb.byteLength },
      };
    },
    dispose() {},
  };
  const executor = createFilmExecutor(plan, {
    backend: BACKEND_IDS.GPU,
    gpuBackend: gpu,
    allowExperimentalGpu: true,
  });
  const result = executor.render({ width: 4, height: 3, rgb, alpha }, { graph });
  assert.equal(result.stats.backend, BACKEND_IDS.GPU);
  assert.equal(result.stats.copies.hostToGpuBytes, rgb.byteLength);
  assert.equal(result.stats.copies.gpuToHostBytes, rgb.byteLength);
  assert.equal(result.stats.copies.boundaryCount, 2);
  assert.equal(result.stats.memory.breakdown.gpuResidentBytes, rgb.byteLength);
  assert.equal(result.alpha, alpha);
  executor.dispose();
});
