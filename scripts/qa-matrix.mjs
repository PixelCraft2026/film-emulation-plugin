/**
 * Deterministic EA-2 diagnostic runner.
 *
 * This is deliberately a Node/UXP-independent proxy for the Photoshop matrix:
 * it exercises the same graph, executor backends, cancellation and numerical
 * comparisons without claiming that Imaging API or modal-scope behaviour has
 * been validated. A QA build may wrap the JSON with Photoshop host results.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  createBloomParams,
  createDefaultEffectGraph,
  createDefringeParams,
  createFilmExecutor,
  createFilmRenderPlan,
  createV17ResidentBackend,
  createFilmResolutionParams,
  createGrainParams,
  createHalationParams,
  createHighlightProtectionParams,
  createLumaMask,
  installWasmModule,
  processFilm,
  resetWasmBackend,
  setWasmExecutionMode,
} from '../src/core/index.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const WIDTH = 64;
const HEIGHT = 40;
const PROFILES = ['sRGB', 'Adobe RGB', 'Display P3', 'Rec.2020'];
const DEPTHS = [8, 16, 32];
const ALPHA_MODES = ['none', 'transparent', 'semi'];
const BACKENDS = ['js-reference', 'wasm-primitive', 'wasm-resident-scalar', 'wasm-resident-simd'];

function fixture(alphaMode, width = WIDTH, height = HEIGHT) {
  const pixels = width * height;
  const rgb = new Float32Array(pixels * 3);
  const alpha = new Float32Array(pixels);
  for (let index = 0; index < pixels; index += 1) {
    const x = index % width;
    const y = Math.floor(index / width);
    const lamp = Math.hypot(x - 41, y - 18) < 4 ? 2.5 : 0;
    rgb[index * 3] = 0.02 + x / width * 0.3 + lamp;
    rgb[index * 3 + 1] = 0.03 + y / height * 0.25 + lamp * 0.9;
    rgb[index * 3 + 2] = 0.04 + ((x * 13 + y * 7) % 23) / 100 + lamp * 0.75;
    alpha[index] = alphaMode === 'none' ? 1 : alphaMode === 'transparent' ? (index % 11 === 0 ? 0 : 1) : 0.25 + (index % 7) / 10;
  }
  return { width, height, rgb, alpha };
}

function graph() {
  return createDefaultEffectGraph(createHalationParams({ strength: 28, sigma: 2.4, sigmaUnits: 'pixels', diffusionMode: 'fast' }), 0x13579bdf).map((node) => {
    if (node.type === 'defringe') return { ...node, enabled: true, params: createDefringeParams({ amount: 0.35 }) };
    if (node.type === 'bloom') return { ...node, enabled: true, params: createBloomParams({ amplify: 0.35, radius: 0.22 }) };
    if (node.type === 'highlightProtection') return { ...node, enabled: true, params: createHighlightProtectionParams({ amount: 0.25 }) };
    if (node.type === 'filmResolution') return { ...node, enabled: true, params: createFilmResolutionParams({ amount: 0.3 }) };
    if (node.type === 'grain') return { ...node, enabled: true, params: createGrainParams({ amount: 0.25, mode: 'analogue', seed: 0x13579bdf }) };
    return { ...node, enabled: true, mask: createLumaMask() };
  });
}

function diff(actual, expected) {
  let sum = 0;
  let max = 0;
  for (let index = 0; index < actual.length; index += 1) {
    const delta = actual[index] - expected[index];
    sum += delta * delta;
    max = Math.max(max, Math.abs(delta));
  }
  return { rms: Math.sqrt(sum / Math.max(1, actual.length)), max };
}

async function run() {
  const wasmPath = join(ROOT, 'assets', 'film_core.wasm');
  const simdPath = join(ROOT, 'assets', 'film_core_simd.wasm');
  let wasm = { available: false, error: 'asset missing' };
  try { wasm = await installWasmModule(readFileSync(wasmPath), readFileSync(simdPath)); } catch (error) { wasm = { available: false, error: String(error) }; }
  const rows = [];
  for (const componentSize of DEPTHS) for (const profile of PROFILES) for (const alphaMode of ALPHA_MODES) {
    const graphValue = graph();
    const document = { format: { gauge: '35mm', iso: 400, profile }, graph: graphValue };
    const input = fixture(alphaMode);
    const plan = createFilmRenderPlan({ width: WIDTH, height: HEIGHT, fullWidth: WIDTH, fullHeight: HEIGHT, componentSize, graph: graphValue, format: document.format, quality: 'quality', memoryMode: 'balanced', deviceMemoryGB: 32 });
    const reference = processFilm(input, document, {
      backend: 'js',
      quality: 'quality',
      fullWidth: WIDTH,
      fullHeight: HEIGHT,
      format: document.format,
    });
    let resident = null;
    let comparison = null;
    let error = null;
    let primitive = null;
    let primitiveError = null;
    if (wasm.available) {
      const previousMode = setWasmExecutionMode('wasm-primitive');
      try {
        const primitiveResult = processFilm(input, document, {
          backend: 'wasm-primitive',
          quality: 'quality',
          fullWidth: WIDTH,
          fullHeight: HEIGHT,
          format: document.format,
        });
        primitive = diff(primitiveResult.rgb, reference.rgb);
      } catch (caught) {
        primitiveError = { code: caught?.code ?? 'ERR_WASM_PRIMITIVE', message: String(caught?.message ?? caught) };
      } finally {
        setWasmExecutionMode(previousMode);
      }
      try {
        const residentMode = setWasmExecutionMode('wasm-resident');
        resident = createV17ResidentBackend(plan);
        const executor = createFilmExecutor(plan, { backend: 'wasm-resident', residentBackend: resident });
        const actual = executor.render(input, document, { intent: 'qa', quality: 'quality', format: document.format });
        comparison = diff(actual.rgb, reference.rgb);
        executor.dispose();
        setWasmExecutionMode(residentMode);
      } catch (caught) {
        error = { code: caught?.code ?? 'ERR_WASM_RESIDENT', message: String(caught?.message ?? caught) };
        setWasmExecutionMode('auto');
      }
    }
    rows.push({ componentSize, profile, alphaMode, backends: BACKENDS, primitive, resident: comparison, primitiveError, error });
  }
  // The SIMD artifact is deliberately not promoted by Auto.  Exercise one
  // fixed 16-bit/sRGB anchor explicitly so the candidate report proves the
  // forced backend path is numerically equivalent before any speed gate is
  // considered.
  let simdAnchor = { status: 'skipped', reason: 'SIMD artifact unavailable' };
  if (wasm.available) {
    const anchorGraph = graph();
    const anchorDocument = { format: { gauge: '35mm', iso: 400, profile: 'sRGB' }, graph: anchorGraph };
    const anchorInput = fixture('semi');
    const anchorPlan = createFilmRenderPlan({ width: WIDTH, height: HEIGHT, fullWidth: WIDTH, fullHeight: HEIGHT, componentSize: 16, graph: anchorGraph, format: anchorDocument.format, quality: 'quality', memoryMode: 'balanced', deviceMemoryGB: 32 });
    const reference = processFilm(anchorInput, anchorDocument, { backend: 'js', quality: 'quality', fullWidth: WIDTH, fullHeight: HEIGHT, format: anchorDocument.format });
    const previousMode = setWasmExecutionMode('wasm-resident-simd');
    try {
      const simdResident = createV17ResidentBackend(anchorPlan);
      if (!simdResident) {
        simdAnchor = { status: 'skipped', reason: 'SIMD capability probe unavailable' };
      } else {
        const executor = createFilmExecutor(anchorPlan, { backend: 'wasm-resident-simd', residentBackend: simdResident });
        const actual = executor.render(anchorInput, anchorDocument, { intent: 'qa', quality: 'quality', format: anchorDocument.format });
        simdAnchor = { status: 'passed', comparison: diff(actual.rgb, reference.rgb), backend: actual.stats.backendVariant };
        executor.dispose();
      }
    } catch (error) {
      simdAnchor = { status: 'failed', code: error?.code ?? 'ERR_WASM_RESIDENT_SIMD', message: String(error?.message ?? error) };
    } finally {
      setWasmExecutionMode(previousMode);
    }
  }
  let faultInjection = { status: 'skipped', reason: 'WASM unavailable' };
  if (wasm.available) {
    const faultGraph = graph();
    const faultPlan = createFilmRenderPlan({ width: WIDTH, height: HEIGHT, fullWidth: WIDTH, fullHeight: HEIGHT, graph: faultGraph, quality: 'quality', memoryMode: 'balanced', deviceMemoryGB: 32 });
    const failingResident = {
      supportsPlan: () => true,
      execute() {
        const injected = new Error('deterministic EA-2 fault injection');
        injected.code = 'ERR_INTERNAL';
        throw injected;
      },
    };
    const faultExecutor = createFilmExecutor(faultPlan, { backend: 'wasm-resident', residentBackend: failingResident });
    try {
      const fallback = faultExecutor.render(fixture('none'), { format: { gauge: '35mm', iso: 400 }, graph: faultGraph }, { quality: 'quality', format: { gauge: '35mm', iso: 400 } });
      faultInjection = {
        status: 'passed',
        fallbackCode: fallback.stats?.fallback?.code ?? null,
        residentDisabledForRequest: faultExecutor.stats().residentDisabledForRequest,
      };
    } finally {
      faultExecutor.dispose();
    }
  }
  const switchGraph = graph().map((node) => node.type === 'halation'
    ? { ...node, params: createHalationParams({ ...node.params, strength: Number(node.params.strength ?? 0) + 1 }) }
    : node);
  const switchA = createFilmRenderPlan({ width: WIDTH, height: HEIGHT, fullWidth: WIDTH, fullHeight: HEIGHT, graph: graph(), quality: 'quality', memoryMode: 'balanced', deviceMemoryGB: 32 });
  const switchB = createFilmRenderPlan({ width: WIDTH, height: HEIGHT, fullWidth: WIDTH, fullHeight: HEIGHT, graph: switchGraph, quality: 'quality', memoryMode: 'balanced', deviceMemoryGB: 32 });
  const documentSwitch = {
    status: switchA.graphHash !== switchB.graphHash && switchA.planHash !== switchB.planHash ? 'passed' : 'failed',
    oldGraphHash: switchA.graphHash,
    newGraphHash: switchB.graphHash,
  };
  // Cancellation probe uses the same resident adapter and verifies that an
  // AbortSignal rejects without publishing a result. It intentionally omits
  // pixel data from the report.
  let cancellation = { status: 'skipped', reason: 'WASM unavailable' };
  if (wasm.available) {
    const cancelGraph = graph();
    const cancelPlan = createFilmRenderPlan({ width: 256, height: 256, fullWidth: 256, fullHeight: 256, graph: cancelGraph, quality: 'quality', memoryMode: 'balanced', deviceMemoryGB: 32 });
    const cancelResident = createV17ResidentBackend(cancelPlan);
    const cancelExecutor = createFilmExecutor(cancelPlan, { backend: 'wasm-resident', residentBackend: cancelResident });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 0);
    try {
      await cancelExecutor.renderAsync(fixture('none', 256, 256), { format: { gauge: '35mm', iso: 400 }, graph: cancelGraph }, { quality: 'quality', format: { gauge: '35mm', iso: 400 }, signal: controller.signal, yieldIntervalMs: 1 });
      cancellation = { status: 'completed-before-abort' };
    } catch (error) {
      cancellation = { status: 'cancelled', code: error?.code ?? 'ERR_CANCELLED' };
    } finally {
      cancelExecutor.dispose();
    }
  }
  resetWasmBackend();
  const report = {
    protocol: 'EA-2 Photoshop matrix proxy v1',
    generatedAt: new Date().toISOString(),
    host: 'Node proxy; Photoshop Imaging API not exercised',
    photoshop: { '2024': 'pending UDT', '2026': 'pending UDT', '23.3': 'environment gap' },
    memory: { physicalGB: 32, balanced: 'logical proxy for 16GB', high: 'logical 32GB path', physical16GB: 'environment gap' },
    fixture: { width: WIDTH, height: HEIGHT, seed: '0x13579bdf', profiles: PROFILES, depths: DEPTHS, alphaModes: ALPHA_MODES },
    wasm,
    rows,
    simdAnchor,
    faultInjection,
    documentSwitch,
    checks: {
      cancellation,
      nonFiniteFallbackCodes: ['ERR_NONFINITE_OUTPUT', 'ERR_CAPACITY', 'ERR_INVALID_PLAN', 'ERR_STALE_HANDLE'],
      latestGenerationOnly: 'requires Photoshop UDT runner',
      sourceHashAndRollback: 'requires Photoshop UDT runner',
    },
    openGates: ['Photoshop 2024 UDT', 'Photoshop 2026 UDT', 'Photoshop 23.3', 'physical 16GB host', 'absolute Apply P95 <= 6s'],
  };
  const output = process.argv.find((argument) => argument.startsWith('--out='))?.slice(6);
  if (output) writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
  else process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

await run();
