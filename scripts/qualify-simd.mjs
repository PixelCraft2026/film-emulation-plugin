import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const [, , scalarArgument, simdArgument, outputArgument] = process.argv;
if (!scalarArgument || !simdArgument) {
  throw new Error('Usage: node scripts/qualify-simd.mjs <scalar-report.json> <simd-report.json> [output.json]');
}

const scalarPath = resolve(scalarArgument);
const simdPath = resolve(simdArgument);
const outputPath = resolve(outputArgument ?? 'tests/performance-baselines/pf12-simd-qualification.json');
const scalarReport = JSON.parse(readFileSync(scalarPath, 'utf8'));
const simdReport = JSON.parse(readFileSync(simdPath, 'utf8'));
const scalar = scalarReport.v16Full;
const simd = simdReport.v16Full;
if (!scalar || !simd) throw new Error('Both reports must contain v16Full');

const protocolFields = [
  'warmups', 'runs', 'size', 'width', 'height', 'componentSize', 'profile',
  'quality', 'memoryMode', 'deviceMemoryGB', 'profileResident', 'collectStepSamples',
];
const protocolMismatches = protocolFields.filter((field) => scalarReport.protocol?.[field] !== simdReport.protocol?.[field]);
const sameGraph = scalar.graphHash === simd.graphHash && scalar.planHash === simd.planHash;
const sameFingerprint = scalarReport.sourceFingerprint === simdReport.sourceFingerprint;
const sameChecksum = scalar.checksum === simd.checksum;
const noFallback = !scalar.fallback && !simd.fallback;
const scalarIsScalar = scalar.backendVariant === 'wasm-resident-scalar';
const simdIsSimd = simd.backendVariant === 'wasm-resident-simd';
const schedulerCapacityValid = (sample) => {
  const scheduler = sample.scheduler ?? {};
  const expectedInitialAllocations = sample.executionMode === 'resident-segmented' ? 2 : 1;
  return Number(scheduler.actualArenaFloats) <= Number(scheduler.plannedArenaFloats)
    && Number(scheduler.actualTransientFloats) <= Number(scheduler.plannedTransientFloats)
    && Number(scheduler.allocationCount) <= expectedInitialAllocations;
};
const matchingAllocations = scalar.scheduler?.allocationCount === simd.scheduler?.allocationCount;
const noUnexpectedGrowth = schedulerCapacityValid(scalar) && schedulerCapacityValid(simd) && matchingAllocations;
const p50Speedup = scalar.p50Ms / simd.p50Ms - 1;
const p95Speedup = scalar.p95Ms / simd.p95Ms - 1;
const correctness = protocolMismatches.length === 0 && sameGraph && sameFingerprint
  && sameChecksum && noFallback && scalarIsScalar && simdIsSimd && noUnexpectedGrowth;
const qualified = correctness && p95Speedup >= 0.10;

const result = {
  generatedAt: new Date().toISOString(),
  scalarReport: scalarPath,
  simdReport: simdPath,
  sourceFingerprint: scalarReport.sourceFingerprint,
  protocolMismatches,
  correctness: {
    passed: correctness,
    sameGraph,
    sameFingerprint,
    sameChecksum,
    noFallback,
    scalarIsScalar,
    simdIsSimd,
    noUnexpectedGrowth,
    matchingAllocations,
  },
  performance: {
    scalarP50Ms: scalar.p50Ms,
    scalarP95Ms: scalar.p95Ms,
    simdP50Ms: simd.p50Ms,
    simdP95Ms: simd.p95Ms,
    p50Speedup,
    p95Speedup,
    requiredP95Speedup: 0.10,
  },
  qualified,
  decision: qualified
    ? 'PASS: SIMD may be promoted for Auto in this qualified runtime.'
    : 'FAIL: keep Auto on the scalar resident backend.',
};

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
console.log(`${result.decision} P95 speedup=${(p95Speedup * 100).toFixed(2)}%`);
console.log(`report: ${outputPath}`);
if (!qualified) process.exitCode = 1;
