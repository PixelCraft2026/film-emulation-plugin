// @ts-nocheck
/**
 * Film Halation V1.5 物理管线。
 *
 * 线性 RGB → 光谱光源场 → 同一双瓣 PSF（Fast/Quality）→ 局部暗侧门控 →
 * 宽半径红层 Global Diffusion → HDR 安全合成。
 *
 * Fast 与 Quality 的物理模型完全相同；差异仅限单瓣高斯数值实现以及允许的
 * 多尺度阈值。core 始终保持纯函数和宿主无关。
 */

import { validateParams } from './params.js';
import { extractHighlights, smoothstep } from './extract.js';
import { gaussianBlurSep } from './diffuse/conv.js';
import { boxBlur3 } from './diffuse/box.js';
import { vvGauss } from './diffuse/vv.js';
import { boxDownsample, bilinearUpsample } from './diffuse/resample.js';
import { channelSigmas } from './redshift.js';
import { blend } from './composite.js';
import { tryWasmBoxBlur, tryWasmHalation, getWasmBackendStatus } from './wasmBackend.js';

/** V1.4 权威默认双瓣 PSF；smoothness 可围绕该基线连续调整。 */
export const PSF_LOBES = Object.freeze([
  { sigmaRatio: 0.35, weight: 0.15 },
  { sigmaRatio: 1.5, weight: 0.85 },
]);

/** 多尺度保持的最低低分辨率 sigma；Quality 更保守。 */
export const LOWRES_MIN_SIGMA = 3;
export const LOWRES_MAX_SCALE = 8;

/** @returns {[{sigmaRatio:number,weight:number},{sigmaRatio:number,weight:number}]} */
export function psfLobesFor(params) {
  const s = Math.min(1, Math.max(0, Number(params.smoothness ?? 2 / 3)));
  const coreSigma = 0.25 + 0.15 * s;
  const tailSigma = 1.2 + 0.45 * s;
  const coreWeight = 0.25 - 0.15 * s;
  return [
    { sigmaRatio: coreSigma, weight: coreWeight },
    { sigmaRatio: tailSigma, weight: 1 - coreWeight },
  ];
}

/** 选择 1/2/4/8 多尺度；窄核芯永远全分辨率。 */
export function lobeScale(params, lobeSigma, core = false) {
  if (core) return 1;
  const minimum = params.diffusionMode === 'quality' ? 4 : 3;
  let scale = 1;
  for (const candidate of [2, 4, 8]) {
    if (lobeSigma / candidate >= minimum) scale = candidate;
  }
  return Math.min(LOWRES_MAX_SCALE, scale);
}

/** 兼容旧 API：返回最宽默认尾瓣的多尺度比例。 */
export function lowResScale(params, effSigma) {
  const [, tail] = psfLobesFor(params);
  return lobeScale(params, effSigma * tail.sigmaRatio, false);
}

function blurPrimitive(src, dst, tempA, tempB, width, height, sigma, params) {
  if (sigma <= 0.01) {
    dst.set(src);
    return;
  }
  if (params.diffusionMode === 'fast') {
    if (tryWasmBoxBlur(src, dst, width, height, sigma)) return;
    boxBlur3(src, dst, tempA, tempB, width, height, sigma);
  } else if (sigma < 4) {
    gaussianBlurSep(src, dst, tempA, tempB, width, height, sigma);
  } else {
    vvGauss(src, dst, tempA, tempB, width, height, sigma);
  }
}

function blurAtScale(src, dst, tempA, tempB, width, height, sigma, params, scale) {
  if (scale === 1) {
    blurPrimitive(src, dst, tempA, tempB, width, height, sigma, params);
    return;
  }
  const ds = boxDownsample(src, width, height, scale);
  const lowOut = new Float32Array(ds.dw * ds.dh);
  const lowA = new Float32Array(ds.dw * ds.dh);
  const lowB = new Float32Array(ds.dw * ds.dh);
  blurPrimitive(ds.data, lowOut, lowA, lowB, ds.dw, ds.dh, sigma / scale, params);
  bilinearUpsample(lowOut, ds.dw, ds.dh, width, height, scale, dst);
}

/** 构造同一双瓣 PSF。Fast 也计算 core+tail，禁止退化为单瓣。 */
export function makeBlurFn(params) {
  const [core, tail] = psfLobesFor(params);
  return (src, dst, tempA, tempB, width, height, sigma) => {
    const n = width * height;
    const tailOut = new Float32Array(n);
    const coreSigma = sigma * core.sigmaRatio;
    const tailSigma = sigma * tail.sigmaRatio;
    const scale = lobeScale(params, tailSigma);
    const tailTempA = scale === 1 ? new Float32Array(n) : tempA;
    const tailTempB = scale === 1 ? new Float32Array(n) : tempB;
    blurAtScale(src, dst, tempA, tempB, width, height, coreSigma, params, 1);
    blurAtScale(src, tailOut, tailTempA, tailTempB, width, height, tailSigma, params, scale);
    for (let i = 0; i < n; i++) dst[i] = dst[i] * core.weight + tailOut[i] * tail.weight;
  };
}

/** @param {{width:number,height:number,rgb:Float32Array,alpha?:Float32Array}} input */
export function extractStep(input, params, options = {}) {
  return extractHighlights(input, params, {
    extraction: params.extraction,
    spillMix: params.spillMix,
    ...options,
  });
}

function sourcePlanes(source) {
  if (source instanceof Float32Array) return { r: source, g: source, b: source, w: source };
  return {
    r: source.sourceR,
    g: source.sourceG,
    b: source.sourceB,
    w: source.W ?? source.sourceR,
  };
}

/** 光谱源逐通道扩散。 */
export function diffuseStep(source, width, height, params) {
  const n = width * height;
  const fields = sourcePlanes(source);
  const blurFn = makeBlurFn(params);
  const [sr, sg, sb] = channelSigmas(params);
  const rs = params.redshift;
  const plane = new Float32Array(n * 3);
  const temp = new Float32Array(n);
  const temp2 = new Float32Array(n);
  const rView = plane.subarray(0, n);
  const gView = plane.subarray(n, 2 * n);
  const bView = plane.subarray(2 * n, 3 * n);
  blurFn(fields.r, rView, temp, temp2, width, height, sr);
  blurFn(fields.g, gView, temp, temp2, width, height, sg);
  blurFn(fields.b, bView, temp, temp2, width, height, sb);
  for (let i = 0; i < n; i++) {
    rView[i] *= rs[0];
    gView[i] *= rs[1];
    bView[i] *= rs[2];
  }
  return { plane, temp, temp2, blurFn, fields };
}

/**
 * 局部光晕和独立 Global Diffusion。localGate 只作用于局部光晕；
 * Global Diffusion 使用自己的中间调门控。
 */
export function haloStep(source, plane, width, height, params, blurFn, temp, temp2, context = {}) {
  const n = width * height;
  const fields = sourcePlanes(source);
  const localGate = context.localGate ?? null;
  const luminance = context.luminance ?? null;
  const halo = new Float32Array(n * 3);
  const rView = plane.subarray(0, n);
  const gView = plane.subarray(n, 2 * n);
  const bView = plane.subarray(2 * n, 3 * n);
  for (let i = 0; i < n; i++) {
    const gate = localGate ? localGate[i] : 1;
    const p = i * 3;
    halo[p] = Math.max(0, rView[i] - params.centerAttenuation * fields.r[i]) * gate;
    halo[p + 1] = Math.max(0, gView[i] - params.centerAttenuation * fields.g[i]) * gate;
    halo[p + 2] = Math.max(0, bView[i] - params.centerAttenuation * fields.b[i]) * gate;
  }

  if (params.globalDiffusion > 0) {
    const globalSource = temp;
    const global = temp2;
    for (let i = 0; i < n; i++) globalSource[i] = fields.r[i] * 0.88 + fields.g[i] * 0.12;
    const broadSigma = Math.max(12, params.sigma * 4);
    blurAtScale(globalSource, global, temp, temp2, width, height, broadSigma, params, lobeScale(params, broadSigma));
    for (let i = 0; i < n; i++) {
      const y = luminance ? Math.max(0, luminance[i]) : 0.35;
      const gate = smoothstep(0.03, 0.3, y) * (1 - smoothstep(0.75, 1.8, y));
      const value = global[i] * params.globalDiffusion * gate;
      const p = i * 3;
      halo[p] += value;
      halo[p + 1] += value * 0.12;
      halo[p + 2] += value * 0.025;
    }
  }
  return halo;
}

export function blendStep(input, halo, gate, width, height, params) {
  return blend(input.rgb, halo, gate, width, height, params);
}

/** 完整 V1.5 处理。输入和 alpha 均不修改。 */
export function processHalation(input, params, options = {}) {
  validateParams(params);
  const wasmResult = tryWasmHalation(input, params, options);
  if (wasmResult) return wasmResult;
  const { width, height } = input;
  const extracted = extractStep(input, params, options);
  const source = {
    sourceR: extracted.sourceR,
    sourceG: extracted.sourceG,
    sourceB: extracted.sourceB,
    W: extracted.W,
  };
  const { plane, temp, temp2, blurFn } = diffuseStep(source, width, height, params);
  const halo = haloStep(source, plane, width, height, params, blurFn, temp, temp2, {
    localGate: extracted.G,
    luminance: extracted.Y,
  });
  const rgb = blend(input.rgb, halo, null, width, height, params, halo);
  return {
    width,
    height,
    rgb,
    alpha: input.alpha ? new Float32Array(input.alpha) : undefined,
    S: extracted.S,
    G: extracted.G,
    W: extracted.W,
    halo,
    stats: { backend: getWasmBackendStatus().backend, psf: 'dual-gaussian-multiscale' },
  };
}
