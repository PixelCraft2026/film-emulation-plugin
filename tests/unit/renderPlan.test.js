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
  return createDefaultEffectGraph(createHalationParams({ sigma: 4, strength: 0.8 }), 0x12345678)
    .map((node) => ({ ...node, enabled: true }));
}

test('PF-9 compiles deterministic local segments and keeps Grain padding local', () => {
  const graph = fullGraph();
  const request = {
    width: 320,
    height: 205,
    fullWidth: 2560,
    fullHeight: 1600,
    graph,
    format: { gauge: '35mm', iso: 800 },
    quality: 'quality',
    memoryMode: 'balanced',
    componentSize: 16,
    deviceMemoryGB: 16,
  };
  const a = createFilmRenderPlan(request);
  const b = createFilmRenderPlan(request);
  assert.equal(a.planHash, b.planHash);
  assert.deepEqual(a.spatialSegments.map((segment) => segment.segmentHash), b.spatialSegments.map((segment) => segment.segmentHash));
  assert.deepEqual(a.spatialSegments.map((segment) => segment.nodeTypes), [
    ['defringe'], ['halation'], ['bloom', 'highlightProtection'], ['filmResolution'], ['grain'],
  ]);
  const bloomHp = a.spatialSegments[2];
  assert.equal(bloomHp.nodeIds.includes('bloom-main'), true);
  assert.equal(bloomHp.nodeIds.includes('highlight-protection-main'), true);
  const grain = a.spatialSegments.at(-1);
  assert.equal(grain.inputHalo, 0);
  assert.ok(grain.generatedFieldHalo > 0);
  assert.ok(a.spatialSegments.slice(0, -1).every((segment) => segment.generatedFieldHalo === 0));
  for (const segment of a.spatialSegments) {
    assert.equal(segment.bands[0].start, 0);
    assert.equal(segment.bands.at(-1).end, request.height);
    assert.ok(segment.bands.every((band) => band.y0 < band.y1 && band.start <= band.y0 && band.y1 <= band.end));
    assert.ok(segment.segmentHash);
  }
});

test('PF-9 grows 16GB segment cores independently without spending Grain padding upstream', () => {
  const plan = createFilmRenderPlan({
    width: 6000,
    height: 4000,
    fullWidth: 6000,
    fullHeight: 4000,
    graph: fullGraph(),
    format: { gauge: '35mm', iso: 800 },
    quality: 'quality',
    memoryMode: 'balanced',
    componentSize: 16,
    deviceMemoryGB: 16,
  });
  const bandHeights = new Set(plan.spatialSegments.map((segment) => segment.bandHeight));
  const bloom = plan.spatialSegments.find((segment) => segment.nodeIds.includes('bloom-main'));
  const grain = plan.spatialSegments.find((segment) => segment.nodeIds.includes('grain-main'));
  assert.equal(plan.executionMode, 'resident-segmented');
  assert.equal(plan.execution.candidates.residentSegmented.valid, true);
  assert.ok(bandHeights.size > 1, 'segment-local memory envelopes choose independent core heights');
  assert.ok(bloom.bands.length < grain.bands.length, 'wide-halo Bloom receives memory before zero-input-halo Grain');
  assert.ok(bloom.estimatedCost.inputPixels / bloom.estimatedCost.corePixels < 1.5);
  assert.equal(grain.inputHalo, 0);
  assert.ok(plan.execution.selected.estimatedPeakBytes * 1.15 <= plan.budgetBytes);
});

test('PF-10 selects whole-frame for a safe canonical Preview', () => {
  const plan = createFilmRenderPlan({
    width: 1024,
    height: 683,
    fullWidth: 6000,
    fullHeight: 4000,
    previewScale: 1024 / 6000,
    graph: fullGraph(),
    format: { gauge: '35mm', iso: 800 },
    quality: 'fast',
    memoryMode: 'high',
    componentSize: 32,
    deviceMemoryGB: 16,
  });
  assert.equal(plan.execution.candidates.wholeFrame.valid, true);
  assert.equal(plan.executionMode, 'whole-frame');
  assert.equal(plan.execution.selected.mode, 'whole-frame');
  assert.equal(plan.execution.selected.bandCount, 1);
});

test('PF-9 identity nodes stay in logical segment ranges without physical cost', () => {
  const graph = fullGraph().map((node) => node.type === 'halation'
    ? { ...node, params: createHalationParams({ ...node.params, strength: 0 }) }
    : node);
  const plan = createFilmRenderPlan({ width: 96, height: 64, graph, componentSize: 16, memoryMode: 'balanced' });
  const ids = plan.spatialSegments.flatMap((segment) => segment.nodeIds);
  assert.ok(ids.includes('halation-main'), 'identity node remains represented in a segment range');
  const halation = plan.spatialSegments.find((segment) => segment.nodeIds.includes('halation-main'));
  assert.ok(halation.inputHalo > 0, 'the neighboring Bloom halo belongs to the physical segment');
  assert.equal(halation.generatedFieldHalo, 0);
  assert.equal(halation.estimatedCost.estimatedPasses, 21, 'identity contributes no kernel passes');
});

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
  assert.equal(plan.phasePeriod, 8, 'Bloom phase is included in the graph LCM');
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
  assert.equal(plan.phasePeriod, 8);
  assert.equal(plan.bands[0].y0 % plan.phasePeriod, 0);
  assert.equal(plan.bands.at(-1).y1, 205);
  assert.equal(plan.bands.at(-1).y0 % plan.phasePeriod, 0);
  assert.equal(plan.hardBudgetExceeded, true);
});

test('Balanced planning never creates a sub-halo core for a 26MP H+B+G graph', () => {
  const graph = fullGraph().map((node) => ({
    ...node,
    enabled: ['halation', 'bloom', 'grain'].includes(node.type),
  }));
  const plan = createFilmRenderPlan({
    width: 6500,
    height: 4000,
    fullWidth: 6500,
    fullHeight: 4000,
    graph,
    format: { gauge: '35mm', iso: 250 },
    componentSize: 16,
    quality: 'quality',
    memoryMode: 'auto',
    deviceMemoryGB: 0,
  });
  assert.equal(plan.memoryMode, 'balanced');
  assert.ok(plan.bandHeight >= plan.overlap);
  assert.ok(plan.bands.length <= Math.ceil(4000 / plan.overlap));
  assert.ok(plan.bands.reduce((rows, band) => rows + band.end - band.start, 0) < 4000 * 3);
  assert.equal(plan.hardBudgetExceeded, false);
});

test('explicit High can acknowledge 16 GiB when UXP device memory is unavailable', () => {
  const graph = fullGraph().map((node) => ({
    ...node,
    enabled: ['halation', 'bloom', 'grain'].includes(node.type),
  }));
  const request = {
    width: 6500,
    height: 4000,
    fullWidth: 6500,
    fullHeight: 4000,
    graph,
    format: { gauge: '35mm', iso: 250 },
    componentSize: 16,
    quality: 'quality',
    deviceMemoryGB: 0,
  };
  const automatic = createFilmRenderPlan({ ...request, memoryMode: 'auto' });
  const explicit = createFilmRenderPlan({ ...request, memoryMode: 'high' });
  assert.equal(automatic.memoryMode, 'balanced');
  assert.equal(automatic.assumedDeviceMemoryGB, 0);
  assert.equal(explicit.memoryMode, 'high');
  assert.equal(explicit.reportedDeviceMemoryGB, 0);
  assert.equal(explicit.assumedDeviceMemoryGB, 16);
  assert.equal(explicit.bands.length, 1);
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

test('RenderPlan exposes one complete V1.7 resident segment while keeping GPU planned-only', () => {
  const plan = createFilmRenderPlan({
    width: 64,
    height: 48,
    graph: fullGraph(),
    componentSize: 16,
    memoryMode: 'balanced',
  });
  assert.equal(plan.backendSegments[BACKEND_IDS.JS].length, 1);
  assert.equal(plan.backendSegments[BACKEND_IDS.WASM].length, 1);
  assert.deepEqual(
    plan.backendSegments[BACKEND_IDS.WASM][0].nodeTypes,
    ['defringe', 'halation', 'bloom', 'highlightProtection', 'filmResolution', 'grain'],
  );
  assert.deepEqual(
    plan.backendSegments[BACKEND_IDS.WASM_SIMD][0].nodeTypes,
    ['defringe', 'halation', 'bloom', 'highlightProtection', 'filmResolution', 'grain'],
  );
  assert.equal(plan.backendSegments[BACKEND_IDS.GPU].length, 0);
  assert.equal(plan.backendCandidates[BACKEND_IDS.GPU].length, 1);
  assert.deepEqual(
    plan.backendCandidates[BACKEND_IDS.GPU][0].nodeTypes,
    ['defringe', 'halation', 'bloom', 'highlightProtection', 'filmResolution', 'grain'],
  );
  assert.deepEqual(plan.backendOrder, [BACKEND_IDS.WASM_SIMD, BACKEND_IDS.WASM, BACKEND_IDS.JS]);
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

test('FilmExecutor does not dispose a request arena owned by the Apply host', () => {
  const graph = createDefaultEffectGraph(createHalationParams({ strength: 0 }), 7);
  const plan = createFilmRenderPlan({ width: 8, height: 6, graph, componentSize: 16, memoryMode: 'balanced' });
  const arena = new BufferArena();
  const executor = createFilmExecutor(plan, { backend: 'js', arena });
  executor.dispose();
  const allocation = arena.acquire(16, 'host-after-executor');
  assert.equal(allocation.array.length, 16);
  arena.release(allocation.handle);
  arena.dispose();
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
          : node.type === 'defringe'
            ? { ...node.params, amount: 0 }
            : node.type === 'bloom'
              ? { ...node.params, amplify: 0 }
              : node.type === 'highlightProtection'
                ? { ...node.params, amount: 0 }
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

test('resident failure retries the complete JS graph once and disables resident for the request', () => {
  const graph = createDefaultEffectGraph(createHalationParams({ strength: 0 }), 7);
  const plan = createFilmRenderPlan({ width: 8, height: 6, graph, memoryMode: 'balanced' });
  const rgb = Float32Array.from({ length: 8 * 6 * 3 }, (_, index) => (index % 19) / 23);
  let calls = 0;
  const resident = {
    supportsPlan: () => true,
    execute(input) {
      calls += 1;
      const output = new Float32Array(input.rgb);
      output[17] = Number.NaN;
      return { ...input, rgb: output, stats: { backend: 'wasm-resident' } };
    },
  };
  const executor = createFilmExecutor(plan, { backend: 'wasm-resident', residentBackend: resident });
  const first = executor.render({ width: 8, height: 6, rgb }, { graph });
  assert.deepEqual(first.rgb, rgb);
  assert.equal(first.stats.fallback.code, 'ERR_WASM_RESIDENT_NONFINITE');
  assert.equal(executor.stats().residentDisabledForRequest, true);
  executor.render({ width: 8, height: 6, rgb }, { graph });
  assert.equal(calls, 1);
  executor.dispose();
});

test('resident cancellation never starts the expensive JS fallback', () => {
  const graph = createDefaultEffectGraph(createHalationParams({ strength: 0 }), 7);
  const plan = createFilmRenderPlan({ width: 8, height: 6, graph, memoryMode: 'balanced' });
  const rgb = new Float32Array(8 * 6 * 3).fill(0.18);
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  const resident = {
    supportsPlan: () => true,
    execute() {
      calls += 1;
      throw new Error('Film render cancelled');
    },
  };
  const executor = createFilmExecutor(plan, { backend: 'wasm-resident', residentBackend: resident });
  assert.throws(() => executor.render({ width: 8, height: 6, rgb }, { graph }, { signal: controller.signal }), /cancelled/);
  assert.equal(calls, 1);
  assert.equal(executor.stats().residentDisabledForRequest, false);
  executor.dispose();
});

test('renderAsync propagates resident cancellation without disabling or falling back', async () => {
  const graph = createDefaultEffectGraph(createHalationParams({ strength: 0 }), 7);
  const plan = createFilmRenderPlan({ width: 8, height: 6, graph, memoryMode: 'balanced' });
  const rgb = new Float32Array(8 * 6 * 3).fill(0.18);
  const controller = new AbortController();
  let asyncCalls = 0;
  const resident = {
    supportsPlan: () => true,
    async executeAsync() {
      asyncCalls += 1;
      controller.abort();
      const error = new Error('Film render cancelled');
      error.code = 'ERR_CANCELLED';
      throw error;
    },
  };
  const executor = createFilmExecutor(plan, { backend: 'wasm-resident', residentBackend: resident });
  await assert.rejects(
    executor.renderAsync({ width: 8, height: 6, rgb }, { graph }, { signal: controller.signal }),
    /cancelled/,
  );
  assert.equal(asyncCalls, 1);
  assert.equal(executor.stats().residentDisabledForRequest, false);
  assert.equal(executor.stats().fallback, null);
  executor.dispose();
});

test('debug resident dual-run reports the first excessive coordinate and channel', () => {
  const graph = createDefaultEffectGraph(createHalationParams({ strength: 0 }), 7);
  const plan = createFilmRenderPlan({ width: 8, height: 6, graph, memoryMode: 'balanced' });
  const rgb = new Float32Array(8 * 6 * 3).fill(0.18);
  const resident = {
    supportsPlan: () => true,
    execute(input) {
      const output = new Float32Array(input.rgb);
      output[(2 * 8 + 3) * 3 + 1] += 0.01;
      return { ...input, rgb: output, stats: { backend: 'wasm-resident' } };
    },
  };
  const executor = createFilmExecutor(plan, { backend: 'wasm-resident', residentBackend: resident, debugDualRun: true });
  const result = executor.render({ width: 8, height: 6, rgb }, { graph });
  assert.equal(result.stats.dualRun.firstExcess.x, 3);
  assert.equal(result.stats.dualRun.firstExcess.y, 2);
  assert.equal(result.stats.dualRun.firstExcess.channel, 'G');
  assert.ok(result.stats.dualRun.max >= 0.009);
  executor.dispose();
});
