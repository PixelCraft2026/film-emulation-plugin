// @ts-nocheck
/**
 * Film Halation V1.5.1 物理管线。
 *
 * 线性 RGB → 曝光相关光谱源场 → 同一三瓣 PSF（Fast/Quality）→ 局部暗侧门控 →
 * 宽半径红层 Global Diffusion → HDR 安全合成。
 *
 * Fast 与 Quality 的物理模型完全相同；差异仅限单瓣高斯数值实现以及允许的
 * 多尺度阈值。core 始终保持纯函数和宿主无关。
 */

import { validateParams } from './params.js';
import {
  extractHighlights,
  smoothstep,
  spectralHueResponse,
  SOURCE_CLASS_SOFTNESS,
  HUE_PURITY_START,
  HUE_PURITY_FULL,
} from './extract.js';
import { gaussianBlurSep } from './diffuse/conv.js';
import { boxBlur3 } from './diffuse/box.js';
import { vvGauss } from './diffuse/vv.js';
import { boxDownsample, bilinearUpsample } from './diffuse/resample.js';
import { channelSigmas } from './redshift.js';
import { blend } from './composite.js';
import { tryWasmBoxBlur, getWasmBackendStatus } from './wasmBackend.js';

/** V1.5.1 默认三瓣 PSF：扎实核芯、肩部和低能量红色尾部。 */
export const PSF_LOBES = Object.freeze([
  { sigmaRatio: 0.235, weight: 0.617 },
  { sigmaRatio: 0.6575, weight: 0.282 },
  { sigmaRatio: 1.4325, weight: 0.101 },
]);

/** 多尺度保持的最低低分辨率 sigma；Quality 更保守。 */
export const LOWRES_MIN_SIGMA = 3;
export const LOWRES_MAX_SCALE = 8;

/**
 * 把实际红层扩散能量转换为局部背景门控豁免。该值作用于 strength 之前，
 * 因而 Preview/Apply 和不同输出强度保持一致；纯蓝/青光源因红层源场接近零，
 * 不会借此重新获得红色 halo。
 */
export const LOCAL_GATE_RELIEF_GAIN = 48;
/** 局部平均/源峰值低于此值时，判为紧凑自发光体并完整放开灯芯保护。 */
export const COMPACT_SOURCE_RATIO_LOW = 0.22;
/** 高于此值时，判为大面积反射面并完整保留光源内部保护。 */
export const COMPACT_SOURCE_RATIO_HIGH = 0.72;

const nowMs = () => globalThis.performance?.now?.() ?? Date.now();

/**
 * @param {object} params
 * @param {'neutral'|'red'|'green'|'blue'} [channel]
 * @returns {Array<{sigmaRatio:number,weight:number}>}
 */
export function psfLobesFor(params, channel = 'neutral') {
  const s = Math.min(1, Math.max(0, Number(params.smoothness ?? 0.15)));
  const shoulderWeight = 0.27 + 0.08 * s;
  const tailWeight = 0.08 + 0.14 * s;
  const lobes = [
    { sigmaRatio: 0.22 + 0.1 * s, weight: 1 - shoulderWeight - tailWeight },
    { sigmaRatio: 0.62 + 0.25 * s, weight: shoulderWeight },
    { sigmaRatio: 1.35 + 0.55 * s, weight: tailWeight },
  ];
  if (channel !== 'red') return lobes;

  // No-Remjet 只改变深红层的能量分布：把一部分核芯能量移入更宽的肩部/尾部，
  // 绿层仍保持窄小橙核，远端自然转为红色。总 DC 权重保持 1。
  const tail = Math.min(1, Math.max(0, Number(params.redTail ?? 0)));
  if (tail <= 0) return lobes;
  lobes[0].weight *= 1 - 0.34 * tail;
  lobes[1].weight *= 1 + 0.62 * tail;
  lobes[2].weight *= 1 + 1.9 * tail;
  lobes[1].sigmaRatio *= 1 + 0.16 * tail;
  lobes[2].sigmaRatio *= 1 + 0.42 * tail;
  const sum = lobes[0].weight + lobes[1].weight + lobes[2].weight;
  for (const lobe of lobes) lobe.weight /= sum;
  return lobes;
}

/** 选择 1/2/4/8 多尺度；窄核芯永远全分辨率。 */
export function lobeScale(params, lobeSigma, core = false) {
  if (core) return 1;
  const minimum = params.diffusionMode === 'quality' ? 4 : LOWRES_MIN_SIGMA;
  let scale = 1;
  for (const candidate of [2, 4, 8]) {
    if (lobeSigma / candidate >= minimum) scale = candidate;
  }
  return Math.min(LOWRES_MAX_SCALE, scale);
}

/** 兼容旧 API：返回最宽默认尾瓣的多尺度比例。 */
export function lowResScale(params, effSigma) {
  const lobes = psfLobesFor(params, 'red');
  const tail = lobes[lobes.length - 1];
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

/** 构造同一三瓣 PSF。Fast/Quality 只改变单瓣数值实现和多尺度精度。 */
export function makeBlurFn(params, channel = 'neutral') {
  const lobes = psfLobesFor(params, channel);
  return (src, dst, tempA, tempB, width, height, sigma) => {
    const n = width * height;
    const lobeOut = new Float32Array(n);
    const core = lobes[0];
    blurAtScale(src, dst, tempA, tempB, width, height, sigma * core.sigmaRatio, params, 1);
    for (let i = 0; i < n; i++) dst[i] *= core.weight;

    // 宽肩部和尾部经常选择相同的 1/2、1/4 或 1/8 尺度。面积降采样和
    // 双线性上采样都是线性算子，因此可在同一低分辨率平面完成多个高斯瓣的
    // 加权累加，只做一次 downsample/upsample，数值模型不变。
    const groups = new Map();
    for (let l = 1; l < lobes.length; l++) {
      const lobe = lobes[l];
      const lobeSigma = sigma * lobe.sigmaRatio;
      const scale = lobeScale(params, lobeSigma, false);
      const list = groups.get(scale) ?? [];
      list.push({ lobe, lobeSigma });
      groups.set(scale, list);
    }
    for (const [scale, group] of groups) {
      if (scale === 1 || group.length === 1) {
        for (const { lobe, lobeSigma } of group) {
          blurAtScale(src, lobeOut, tempA, tempB, width, height, lobeSigma, params, scale);
          for (let i = 0; i < n; i++) dst[i] += lobeOut[i] * lobe.weight;
        }
        continue;
      }
      const ds = boxDownsample(src, width, height, scale);
      const lowN = ds.dw * ds.dh;
      const lowAccum = new Float32Array(lowN);
      const lowOut = new Float32Array(lowN);
      const lowA = new Float32Array(lowN);
      const lowB = new Float32Array(lowN);
      for (const { lobe, lobeSigma } of group) {
        blurPrimitive(ds.data, lowOut, lowA, lowB, ds.dw, ds.dh, lobeSigma / scale, params);
        for (let i = 0; i < lowN; i++) lowAccum[i] += lowOut[i] * lobe.weight;
      }
      bilinearUpsample(lowAccum, ds.dw, ds.dh, width, height, scale, lobeOut);
      for (let i = 0; i < n; i++) dst[i] += lobeOut[i];
    }
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
  if (source instanceof Float32Array) return { r: source, g: source, b: source, w: source, u: null, k: null };
  return {
    r: source.sourceR,
    g: source.sourceG,
    b: source.sourceB,
    w: source.W ?? source.sourceR,
    u: source.U ?? null,
    k: source.K ?? null,
  };
}

/** 光谱源逐通道扩散。 */
export function diffuseStep(source, width, height, params) {
  const n = width * height;
  const fields = sourcePlanes(source);
  const redBlurFn = makeBlurFn(params, 'red');
  const greenBlurFn = makeBlurFn(params, 'green');
  const blueBlurFn = makeBlurFn(params, 'blue');
  const [sr, sg, sb] = channelSigmas(params);
  const rs = params.redshift;
  const plane = new Float32Array(n * 3);
  const temp = new Float32Array(n);
  const temp2 = new Float32Array(n);
  const rView = plane.subarray(0, n);
  const gView = plane.subarray(n, 2 * n);
  const bView = plane.subarray(2 * n, 3 * n);
  redBlurFn(fields.r, rView, temp, temp2, width, height, sr);
  greenBlurFn(fields.g, gView, temp, temp2, width, height, sg);
  blueBlurFn(fields.b, bView, temp, temp2, width, height, sb);
  for (let i = 0; i < n; i++) {
    rView[i] *= rs[0];
    gView[i] *= rs[1];
    bView[i] *= rs[2];
  }
  return { plane, temp, temp2, blurFn: redBlurFn, fields };
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
  const sourceRgb = context.sourceRgb ?? null;
  const halo = new Float32Array(n * 3);
  const rView = plane.subarray(0, n);
  const gView = plane.subarray(n, 2 * n);
  const bView = plane.subarray(2 * n, 3 * n);
  const interiorProtection = params.sourceInteriorProtection;
  let sourceEnvelope = null;
  let environmentLuminance = null;
  let densityGate = null;
  if (interiorProtection > 0) {
    // 窄尺度局部平均同时承担两项任务：区分紧凑自发光体与大面积反射面，
    // 以及填平白衣褶皱、灯箱纹理等源体内部的小暗沟。只在保护路径分配。
    sourceEnvelope = new Float32Array(n);
    const envelopeSigma = Math.max(0.5, params.sigma * 0.7);
    blurPrimitive(fields.r, sourceEnvelope, temp, temp2, width, height, envelopeSigma, params);
    if (luminance) {
      // 光源本身的局部平均无法区分“黑夜中的紧凑灯芯”和“白衣上的窄褶皱”。
      // 再观察更宽的原始亮度环境：前者周围暗、后者属于连续亮反射面。
      environmentLuminance = new Float32Array(n);
      const contextSigma = Math.max(2, params.sigma * 1.25);
      blurAtScale(
        luminance,
        environmentLuminance,
        temp,
        temp2,
        width,
        height,
        contextSigma,
        params,
        lobeScale(params, contextSigma),
      );
    }
  }
  if (sourceEnvelope && params.colorDensity > 0) {
    // Color Density 仍使用基础保护强度，而不是下方的紧凑光源豁免：灯芯可以
    // 恢复连续扩散能量，但白色高光核心不会被密度着色直接涂红。
    densityGate = context.densityGate ?? new Float32Array(n);
    const normalizeEnergy = Math.max(1, params.amplify);
    for (let i = 0; i < n; i++) {
      const protectedRedSource = Math.max(fields.r[i], sourceEnvelope[i]);
      const body = smoothstep(0.015, 0.08, protectedRedSource / normalizeEnergy);
      densityGate[i] = 1 - interiorProtection * body;
    }
    context.densityGate = densityGate;
  }
  for (let i = 0; i < n; i++) {
    const backgroundGate = localGate ? localGate[i] : 1;
    const p = i * 3;
    const hotMix = fields.u
      ? smoothstep(
        params.hotSourceThreshold - SOURCE_CLASS_SOFTNESS,
        params.hotSourceThreshold + SOURCE_CLASS_SOFTNESS,
        fields.u[i],
      )
      : 0;
    // Strong Core 使用立方映射：中高值能真正保留紧实核芯，低值仍有细腻调节空间。
    const hotAttenuation = Math.pow(1 - params.hotCoreStrength, 3);
    const attenuation = params.centerAttenuation * (1 - hotMix + hotMix * hotAttenuation);
    const legacyRedPotential = Math.max(0, rView[i] - attenuation * fields.r[i]);
    const legacyGreenPotential = Math.max(0, gView[i] - attenuation * fields.g[i]);
    const legacyBluePotential = Math.max(0, bView[i] - attenuation * fields.b[i]);
    // 大面积白色反射面在归一化 PSF 内部满足 D≈redshift·S。保护路径减去同增益
    // 的原始源场，让均匀内部残差趋近 0；源体包络另行限制内部 Color Density。
    // p=0 明确走旧分支，保证 No-Remjet 预设维持 V1.5.1 的逐值兼容外观。
    let redPotential = legacyRedPotential;
    let greenPotential = legacyGreenPotential;
    let bluePotential = legacyBluePotential;
    let gateRelief;
    if (interiorProtection > 0) {
      // 归一化局部平均接近 1 表示宽阔、连续的反射面；远小于 1 表示点状或
      // 紧凑灯芯。只允许 Strong Source 获得豁免，避免普通纹理重新染红。
      const sourcePeak = fields.r[i];
      const envelopeRatio = sourcePeak > 1e-8
        ? Math.min(1, sourceEnvelope[i] / sourcePeak)
        : 1;
      const darkEnvironment = environmentLuminance
        ? 1 - smoothstep(0.32, 0.62, environmentLuminance[i])
        : 1;
      const compactShape = 1 - smoothstep(
        COMPACT_SOURCE_RATIO_LOW,
        COMPACT_SOURCE_RATIO_HIGH,
        envelopeRatio,
      );
      // Expansion 把被强灯授权的低阈值 optical glow 写入源场；这些像素自身 U
      // 不一定达到 Strong Source。K 传播的是已经通过色谱筛选的种子许可，能
      // 放开整段灯芯到外缘的保护，而纯蓝 LED 因没有红层种子不会得到 K。
      const expandedEmitterSupport = fields.k ? Math.min(1, Math.max(0, fields.k[i])) : 0;
      const compactAuthorization = Math.max(hotMix * compactShape, expandedEmitterSupport);
      // 空间门控可以在整个紧凑光源周围放开，但光源本体仍应保留原色。
      // U 是扩张前的真实高光响应：越接近 clipped core，越少撤销内部保护；
      // K 授权的低阈值 optical glow（U≈0）仍可恢复连续的外缘红晕。
      const sourceBody = fields.u ? smoothstep(0.04, 0.42, fields.u[i]) : 0;
      const gateCompactRelief = compactAuthorization * darkEnvironment;
      const potentialCompactRelief = gateCompactRelief * (1 - sourceBody);
      const effectiveProtection = interiorProtection * (1 - potentialCompactRelief);
      const edgeRedPotential = Math.max(0, rView[i] - params.redshift[0] * fields.r[i]);
      const edgeGreenPotential = Math.max(0, gView[i] - params.redshift[1] * fields.g[i]);
      const edgeBluePotential = Math.max(0, bView[i] - params.redshift[2] * fields.b[i]);
      const keepLegacy = 1 - effectiveProtection;
      redPotential = legacyRedPotential * keepLegacy + edgeRedPotential * effectiveProtection;
      greenPotential = legacyGreenPotential * keepLegacy + edgeGreenPotential * effectiveProtection;
      bluePotential = legacyBluePotential * keepLegacy + edgeBluePotential * effectiveProtection;
      const legacySpreadRelief = (1 - Math.exp(-legacyRedPotential * LOCAL_GATE_RELIEF_GAIN)) * params.hotCoreStrength;
      const legacyCoreRelief = hotMix * params.hotCoreStrength;
      const legacyGateRelief = Math.max(legacyCoreRelief, legacySpreadRelief);
      // 大面积亮反射面内部不得借 edge residual 绕过背景门控；黑夜中的灯、
      // 以及亮光覆盖到较暗/蓝色环境的外缘仍可获得空间豁免。
      const reflectiveSurface = luminance && environmentLuminance
        ? smoothstep(0.45, 0.72, luminance[i]) * smoothstep(0.38, 0.68, environmentLuminance[i])
        : 0;
      const edgeGateRelief = (1 - Math.exp(-edgeRedPotential * LOCAL_GATE_RELIEF_GAIN))
        * params.hotCoreStrength
        * (1 - reflectiveSurface);
      const effectiveGateProtection = interiorProtection * (1 - gateCompactRelief);
      gateRelief = legacyGateRelief * (1 - effectiveGateProtection) + edgeGateRelief * effectiveGateProtection;
    } else {
      const spreadRelief = (1 - Math.exp(-redPotential * LOCAL_GATE_RELIEF_GAIN)) * params.hotCoreStrength;
      const coreRelief = hotMix * params.hotCoreStrength;
      gateRelief = Math.max(coreRelief, spreadRelief);
    }
    // 背景门控不能只看目标像素：预先存在的白色镜头 glow 会把蓝天局部推成
    // 高亮青白色，但强白光穿透乳剂产生的红层扩散仍应覆盖该区域。用已经经过
    // 光源色谱筛选的 redPotential 生成空间豁免，可让白/暖强光的红晕穿过蓝天
    // 与光学 glow，同时保持纯蓝/青光源严格受抑制。
    const gate = backgroundGate + (1 - backgroundGate) * gateRelief;
    let targetPreserve = 0;
    if (interiorProtection > 0 && params.spectralSensitivity > 0 && sourceRgb) {
      const tr = Math.max(0, sourceRgb[p]);
      const tg = Math.max(0, sourceRgb[p + 1]);
      const tb = Math.max(0, sourceRgb[p + 2]);
      const hueResponse = spectralHueResponse(tr, tg, tb);
      const purity = smoothstep(HUE_PURITY_START, HUE_PURITY_FULL, hueResponse.saturation);
      // 只保护明亮、高纯度且红层响应极低的蓝/青自发光体。蓝天通常在线性域
      // 峰值较低，仍可接受来自白色光源的外部红晕。
      const blueCyan = 1 - smoothstep(0.02, 0.25, Math.min(1, Math.max(0, hueResponse.red)));
      const emissive = smoothstep(0.28, 0.72, Math.max(tr, tg, tb));
      targetPreserve = purity * blueCyan * emissive * smoothstep(0, 1, params.spectralSensitivity);
    }
    const targetHalo = gate * (1 - targetPreserve);
    halo[p] = redPotential * targetHalo;
    halo[p + 1] = greenPotential * targetHalo;
    halo[p + 2] = bluePotential * targetHalo;
  }

  if (params.globalDiffusion > 0) {
    const globalSource = temp;
    const global = temp2;
    for (let i = 0; i < n; i++) {
      const sourceGate = fields.u
        ? smoothstep(
          params.globalSourceThreshold - SOURCE_CLASS_SOFTNESS,
          params.globalSourceThreshold + SOURCE_CLASS_SOFTNESS,
          fields.u[i],
        )
        : 1;
      globalSource[i] = (fields.r[i] * 0.88 + fields.g[i] * 0.12) * sourceGate;
    }
    const broadSigma = Math.max(12, params.sigma * 4);
    blurAtScale(globalSource, global, temp, temp2, width, height, broadSigma, params, lobeScale(params, broadSigma));
    for (let i = 0; i < n; i++) {
      const y = luminance ? Math.max(0, luminance[i]) : 0.35;
      const gate = smoothstep(0.03, 0.3, y) * (1 - smoothstep(0.75, 1.8, y));
      // 稠密光源的能量采用软饱和聚合，避免窗户阵列无界累积成红雾。
      const aggregated = (1 - Math.exp(-Math.max(0, global[i]) * 0.75)) / 0.75;
      const value = aggregated * params.globalDiffusion * gate;
      const p = i * 3;
      halo[p] += value;
      halo[p + 1] += value * 0.12;
      halo[p + 2] += value * 0.025;
    }
  }
  return halo;
}

export function blendStep(input, halo, gate, width, height, params, densityGate = null) {
  return blend(input.rgb, halo, gate, width, height, params, undefined, densityGate);
}

/** 完整 V1.5.1 处理。输入和 alpha 均不修改。 */
export function processHalation(input, params, options = {}) {
  validateParams(params);
  const { width, height } = input;
  const timings = options.profileTimings ? {} : null;
  let started = timings ? nowMs() : 0;
  const extracted = extractStep(input, params, options);
  if (timings) {
    timings.extractMs = nowMs() - started;
    started = nowMs();
  }
  const source = {
    sourceR: extracted.sourceR,
    sourceG: extracted.sourceG,
    sourceB: extracted.sourceB,
    W: extracted.W,
    U: extracted.U,
    K: extracted.K,
  };
  const { plane, temp, temp2, blurFn } = diffuseStep(source, width, height, params);
  if (timings) {
    timings.diffuseMs = nowMs() - started;
    started = nowMs();
  }
  const haloContext = {
    localGate: extracted.G,
    luminance: extracted.Y,
    sourceRgb: input.rgb,
  };
  const halo = haloStep(source, plane, width, height, params, blurFn, temp, temp2, haloContext);
  if (timings) {
    timings.haloMs = nowMs() - started;
    started = nowMs();
  }
  // 诊断路径保留真实 halo；compact 宿主路径复用其内存作为输出。
  const rgb = blend(input.rgb, halo, null, width, height, params, options.compact ? halo : undefined, haloContext.densityGate);
  if (timings) timings.blendMs = nowMs() - started;
  return {
    width,
    height,
    rgb,
    alpha: input.alpha ? new Float32Array(input.alpha) : undefined,
    S: extracted.S,
    G: extracted.G,
    W: extracted.W,
    U: options.compact ? undefined : extracted.U,
    halo: options.compact ? undefined : halo,
    stats: { backend: getWasmBackendStatus().backend, psf: 'triple-gaussian-exposure-aware', timings },
  };
}
