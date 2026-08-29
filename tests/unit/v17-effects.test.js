import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BLOOM_LOBES,
  createBloomParams,
  createDefringeParams,
  createHalationParams,
  createHighlightProtectionParams,
  createLumaMask,
  createDefaultEffectGraph,
  processBloom,
  processDefringe,
  processFilm,
  processFilmStages,
  processHighlightProtection,
  validateGraphCommandBuffer,
  createFilmRenderPlan,
  createGraphCommandBuffer,
} from '../../src/core/index.js';

function image(width, height, value = 0.18) {
  return { width, height, rgb: new Float32Array(width * height * 3).fill(value), alpha: new Float32Array(width * height).fill(1) };
}

function lumaAt(rgb, pixel) {
  const p = pixel * 3;
  return 0.2126 * rgb[p] + 0.7152 * rgb[p + 1] + 0.0722 * rgb[p + 2];
}

function ycocgYAt(rgb, pixel) {
  const p = pixel * 3;
  return (rgb[p] + 2 * rgb[p + 1] + rgb[p + 2]) * 0.25;
}

function ycocgCgAt(rgb, pixel) {
  const p = pixel * 3;
  return (-rgb[p] + 2 * rgb[p + 1] - rgb[p + 2]) * 0.25;
}

function estimateMtf50(rgb, width, height) {
  const esf = new Float64Array(width);
  for (let x = 0; x < width; x += 1) {
    for (let y = 0; y < height; y += 1) esf[x] += ycocgYAt(rgb, y * width + x);
    esf[x] /= height;
  }
  const lsf = new Float64Array(width - 1);
  for (let x = 0; x < lsf.length; x += 1) lsf[x] = esf[x + 1] - esf[x];
  let dc = 0;
  for (const value of lsf) dc += value;
  dc = Math.abs(dc);
  let previous = 1;
  for (let k = 1; k <= Math.floor(lsf.length / 2); k += 1) {
    let real = 0;
    let imaginary = 0;
    for (let x = 0; x < lsf.length; x += 1) {
      const phase = -2 * Math.PI * k * x / lsf.length;
      real += lsf[x] * Math.cos(phase);
      imaginary += lsf[x] * Math.sin(phase);
    }
    const magnitude = Math.hypot(real, imaginary) / dc;
    if (magnitude <= 0.5) {
      const fraction = (previous - 0.5) / Math.max(1e-12, previous - magnitude);
      return (k - 1 + Math.max(0, Math.min(1, fraction))) / lsf.length;
    }
    previous = magnitude;
  }
  return 0.5;
}

function sumChannel(values, channel) {
  let sum = 0;
  for (let i = channel; i < values.length; i += 3) sum += values[i];
  return sum;
}

test('V1.7 default graph keeps new nodes disabled and has deterministic mask defaults', () => {
  const graph = createDefaultEffectGraph(createHalationParams({ strength: 0 }), 7);
  assert.deepEqual(graph.map((node) => node.type), ['defringe', 'halation', 'bloom', 'highlightProtection', 'filmResolution', 'grain']);
  for (const node of graph) {
    assert.deepEqual(node.mask, createLumaMask());
    if (['defringe', 'bloom', 'highlightProtection'].includes(node.type)) assert.equal(node.enabled, false);
  }
});

test('Defringe meets neutral, chroma-reduction, MTF50, identity, and alpha gates', () => {
  const neutral = image(9, 3, 0.2);
  const neutralOut = processDefringe(neutral, createDefringeParams({ amount: 1, radiusPx: 1.5 }));
  let neutralSquaredError = 0;
  for (let i = 0; i < neutral.rgb.length; i += 1) neutralSquaredError += (neutralOut.rgb[i] - neutral.rgb[i]) ** 2;
  assert.ok(Math.sqrt(neutralSquaredError / neutral.rgb.length) <= 1e-5);
  assert.equal(neutralOut.alpha, neutral.alpha);

  const width = 65;
  const height = 9;
  const rgb = new Float32Array(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const luminance = x < 32 ? 0.05 : 1.2;
      const cg = x === 31 ? -0.6 : x === 32 ? 0.6 : 0;
      const p = (y * width + x) * 3;
      rgb[p] = luminance - cg;
      rgb[p + 1] = luminance + cg;
      rgb[p + 2] = luminance - cg;
    }
  }
  const alpha = new Float32Array(width * height).fill(0.75);
  const input = { width, height, rgb, alpha };
  const out = processDefringe(input, createDefringeParams({ amount: 1, radiusPx: 2, threshold: 0.01, softness: 0.04, edgeSensitivity: 2 }));
  let chromaBefore = 0;
  let chromaAfter = 0;
  let ySquaredError = 0;
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    ySquaredError += (ycocgYAt(rgb, pixel) - ycocgYAt(out.rgb, pixel)) ** 2;
  }
  for (let y = 0; y < height; y += 1) {
    for (const x of [31, 32]) {
      chromaBefore += Math.abs(ycocgCgAt(rgb, y * width + x));
      chromaAfter += Math.abs(ycocgCgAt(out.rgb, y * width + x));
    }
  }
  assert.ok(1 - chromaAfter / chromaBefore >= 0.6, `chroma reduction=${1 - chromaAfter / chromaBefore}`);
  assert.ok(Math.sqrt(ySquaredError / (width * height)) <= 1e-5);
  const mtfBefore = estimateMtf50(rgb, width, height);
  const mtfAfter = estimateMtf50(out.rgb, width, height);
  assert.ok((mtfBefore - mtfAfter) / mtfBefore <= 0.05, `MTF50 before=${mtfBefore}, after=${mtfAfter}`);
  assert.equal(out.alpha, alpha);

  for (const params of [{ amount: 0 }, { edgeSensitivity: 0 }]) {
    const identity = processDefringe(input, createDefringeParams(params));
    assert.equal(identity.rgb, input.rgb);
    assert.equal(identity.alpha, input.alpha);
  }
});

test('Bloom PSF is nonnegative, normalized, radially monotone, and energy-neutral across RGB', () => {
  const width = 129;
  const height = 129;
  const alpha = new Float32Array(width * height).fill(1);
  const centerPixel = 64 * width + 64;
  const params = createBloomParams({ thresholdEV: -2, softnessEV: 0.1, radius: 2, amplify: 1, saturation: 1, saveLights: 0 });
  const rgb = new Float32Array(width * height * 3);
  rgb[centerPixel * 3] = 8;
  rgb[centerPixel * 3 + 1] = 8;
  rgb[centerPixel * 3 + 2] = 8;
  const bloom = processBloom({ width, height, rgb, alpha }, params, { fullWidth: width, fullHeight: height, quality: 'quality' });
  assert.ok(Math.abs(BLOOM_LOBES.reduce((sum, lobe) => sum + lobe.weight, 0) - 1) <= 1e-12);
  assert.ok(bloom.transient.bloomContribution.every((value) => value >= -1e-7));
  assert.ok(Math.abs(sumChannel(bloom.transient.bloomContribution, 0) / 8 - 1) <= 0.02);

  const radial = Array.from({ length: 48 }, () => ({ sum: 0, count: 0 }));
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const radius = Math.floor(Math.hypot(x - 64, y - 64));
      if (radius >= radial.length) continue;
      radial[radius].sum += bloom.transient.bloomContribution[(y * width + x) * 3];
      radial[radius].count += 1;
    }
  }
  const profile = radial.filter((bin) => bin.count > 0).map((bin) => bin.sum / bin.count);
  for (let radius = 1; radius < profile.length; radius += 1) {
    assert.ok(profile[radius] <= profile[radius - 1] + 1e-7, `PSF rises at radius ${radius}`);
  }

  const rec709 = [0.2126, 0.7152, 0.0722];
  const luminanceEnergy = [];
  for (let channel = 0; channel < 3; channel += 1) {
    const colored = new Float32Array(width * height * 3);
    colored[centerPixel * 3 + channel] = 1 / rec709[channel];
    const result = processBloom({ width, height, rgb: colored, alpha }, params, { fullWidth: width, fullHeight: height, quality: 'quality' });
    luminanceEnergy.push(rec709.reduce((sum, coefficient, c) => sum + coefficient * sumChannel(result.transient.bloomContribution, c), 0));
  }
  assert.ok(Math.max(...luminanceEnergy) / Math.min(...luminanceEnergy) - 1 <= 0.02, luminanceEnergy.join(', '));
});

test('Bloom never darkens HDR, ignores hidden RGB, and amplify zero is exact', () => {
  const source = image(17, 13, 0);
  for (let i = 0; i < source.rgb.length; i += 1) source.rgb[i] = ((i * 37) % 29) / 5 - 1;
  const result = processBloom(source, createBloomParams({ thresholdEV: -2, amplify: 1, radius: 0.5 }), { quality: 'quality' });
  for (let i = 0; i < source.rgb.length; i += 1) assert.ok(result.rgb[i] >= source.rgb[i] - 1e-7);
  assert.equal(result.alpha, source.alpha);

  const hidden = image(9, 9, 0);
  hidden.alpha.fill(0);
  hidden.rgb.fill(12);
  const hiddenResult = processBloom(hidden, createBloomParams({ thresholdEV: -2, amplify: 4 }), { quality: 'quality' });
  assert.ok(hiddenResult.transient.bloomContribution.every((value) => value === 0));
  assert.deepEqual(hiddenResult.rgb, hidden.rgb);

  const identity = processBloom(source, createBloomParams({ amplify: 0 }));
  assert.equal(identity.rgb, source.rgb);
  assert.equal(identity.alpha, source.alpha);
  assert.ok(identity.transient.bloomContribution.every((value) => value === 0));
});

test('Bloom transient feeds Highlight Protection and zero mask is exact', () => {
  const source = image(7, 7, 0.1);
  source.rgb[(3 * 7 + 3) * 3] = 4;
  source.rgb[(3 * 7 + 3) * 3 + 1] = 4;
  source.rgb[(3 * 7 + 3) * 3 + 2] = 4;
  const bloom = processBloom(source, createBloomParams({ radius: 0.4, amplify: 1 }));
  assert.ok(bloom.transient.bloomBase === source.rgb);
  assert.ok(bloom.transient.bloomContribution.some((value) => value > 0));
  for (const lobe of BLOOM_LOBES) assert.ok(lobe.weight >= 0);
  const protectedOutput = processHighlightProtection(bloom, createHighlightProtectionParams({ amount: 1 }), { transient: bloom.transient });
  assert.ok(protectedOutput.rgb[(3 * 7 + 3) * 3] <= bloom.rgb[(3 * 7 + 3) * 3]);
  const graph = createDefaultEffectGraph(createHalationParams({ strength: 0 }), 7).map((node) => {
    if (node.type === 'bloom') return { ...node, enabled: true, params: createBloomParams({ amplify: 1 }), mask: createLumaMask({ mode: 'luma', lowEV: 8, highEV: 9, softnessEV: 0.1 }) };
    return node;
  });
  const result = processFilm(source, { graph }, { width: 7, height: 7, fullWidth: 7, fullHeight: 7, quality: 'fast' });
  assert.deepEqual(result.rgb, source.rgb);
});

test('Highlight Protection without Bloom is a visible identity warning', () => {
  const input = image(2, 2, 0.8);
  const result = processHighlightProtection(input, createHighlightProtectionParams(), {});
  assert.deepEqual(result.rgb, input.rgb);
  assert.ok(result.stats.warnings.includes('missingBloomContribution'));
});

test('Highlight Protection consumes the nearest preceding Bloom transient', () => {
  const source = image(17, 17, 0.1);
  const center = (8 * 17 + 8) * 3;
  source.rgb[center] = source.rgb[center + 1] = source.rgb[center + 2] = 5;
  const firstParams = createBloomParams({ radius: 0.2, amplify: 0.3, saveLights: 0 });
  const secondParams = createBloomParams({ radius: 0.8, amplify: 1, saveLights: 0 });
  const protectionParams = createHighlightProtectionParams({ amount: 1, thresholdEV: 0, softnessEV: 0.1 });
  const manualFirst = processBloom(source, firstParams, { quality: 'fast' });
  const manualSecond = processBloom(manualFirst, secondParams, { quality: 'fast' });
  const manual = processHighlightProtection(manualSecond, protectionParams, { transient: manualSecond.transient });
  const graph = [
    { id: 'bloom-first', type: 'bloom', enabled: true, params: firstParams, mask: createLumaMask() },
    { id: 'bloom-second', type: 'bloom', enabled: true, params: secondParams, mask: createLumaMask() },
    { id: 'hp', type: 'highlightProtection', enabled: true, params: protectionParams, mask: createLumaMask() },
  ];
  const result = processFilmStages(source, graph, { quality: 'fast' });
  assert.deepEqual(result.rgb, manual.rgb);
  assert.deepEqual(result.transient.bloomBase, manualSecond.transient.bloomBase);
  assert.deepEqual(result.transient.bloomContribution, manualSecond.transient.bloomContribution);
});

test('an actually zero luma mask is sample-exact for every implemented graph node', () => {
  const source = image(11, 9, 0.18);
  source.rgb[(4 * 11 + 5) * 3] = 3;
  const zeroMask = createLumaMask({ mode: 'luma', lowEV: 12, highEV: 13, softnessEV: 0.1 });
  const defaults = createDefaultEffectGraph(createHalationParams({ strength: 0.7 }), 11);
  for (const selected of defaults) {
    const graph = defaults.map((node) => ({ ...node, enabled: node.id === selected.id, mask: zeroMask }));
    const result = processFilm(source, { graph }, { quality: 'fast', seed: 11 });
    assert.deepEqual(result.rgb, source.rgb, selected.type);
    assert.equal(result.alpha, source.alpha, selected.type);
  }
});

test('V1.7 command buffer validates fixed stage opcodes and checked offsets', () => {
  const graph = createDefaultEffectGraph(createHalationParams({ strength: 0 }), 7).map((node) => ({ ...node, enabled: node.type === 'bloom' }));
  const plan = createFilmRenderPlan({ width: 4, height: 4, fullWidth: 4, fullHeight: 4, graph, quality: 'fast' });
  const command = createGraphCommandBuffer(plan, { originX: -2, originY: 3, effectiveSeed: 0xffffffff });
  const parsed = validateGraphCommandBuffer(command);
  assert.equal(parsed.header.commandVersion, 1);
  assert.equal(parsed.header.originX, -2);
  assert.equal(parsed.nodes[0].opcode, 40);
  const bad = command.slice();
  bad[0] ^= 0xff;
  assert.throws(() => validateGraphCommandBuffer(bad), /-2/);
});

test('RenderPlan freezes V1.7 workset liveness and resident boundary metadata', () => {
  const graph = createDefaultEffectGraph(createHalationParams({ strength: 0 }), 7)
    .map((node) => ({ ...node, enabled: true }));
  const plan = createFilmRenderPlan({ width: 32, height: 24, fullWidth: 32, fullHeight: 24, graph, quality: 'fast' });
  const bloom = plan.dependencies.find((node) => node.type === 'bloom');
  assert.deepEqual(bloom.buffers.map((buffer) => buffer.alias), ['bloom-source', 'bloomBase', 'bloomContribution', 'bloom-scratch']);
  const contribution = plan.aliasPlan.intervals.find((interval) => interval.alias === 'bloomContribution');
  assert.equal(contribution.last, 3, 'Bloom contribution remains live through Highlight Protection');
  assert.equal(plan.warnings.includes('v17ResidentCapabilityPending'), false);
  assert.equal(plan.backendSegments['wasm-resident'].length, 1);
  for (const segment of plan.backendSegments['wasm-resident']) {
    assert.equal(segment.uploadRgb, true);
    assert.equal(segment.uploadAlpha, true);
    assert.equal(segment.firstNode, segment.startIndex);
    assert.equal(segment.lastNodeInclusive, segment.endIndex);
  }
});
