import { tryWasmMaxFilter } from './wasmBackend.js';

/**
 * 高光提取 — Y / M / S / G / W（PRD §5.2 / TDD §5）。
 * 零依赖，纯函数。输入为线性 RGB ImageBuffer，输出 mask（0..1）与辐射度加权场 W。
 *
 * 语义（以 PRD 为准）：
 *  - Y：线性亮度（默认 Rec.709 系数；options.luma 可覆盖——2.1：Rec2020/ProPhoto
 *    工作空间用各自 primaries 的亮度权重），驱动 soft-threshold 提取与 background gating；
 *  - M：max(R,G,B)，用于 spill 提取变体（V-5 A/B 对照，默认不用）；
 *  - S：高光 mask = smoothstep(threshold±softness/2, Y)——默认提取方式；
 *  - G：红层背景占用门控。用 0.82R+0.18G 而不是 Y 判断长波通道余量；蓝/青背景
 *       不会再错误阻断白色光源的红层扩散，亮的中性/暖色背景仍可抑制红雾；
 *  - U：为 SDR 高光压缩重建的光源曝光坐标。T..1 映射为 0..1，HDR >1 继续按 EV 延伸；
 *  - W：非线性光源响应。T..1 的数字高光余量先归一化为 0..1，再按 Source Impact
 *       超线性整形；HDR >1 从白点连续按曝光档延伸。刚过阈值的弱光源迅速收敛，
 *       clipped white 仍保持完整响应，软肩只限制极端 HDR 能量。
 */

/** smoothstep 插值（edge0<edge1；x 越界 clamp）。
 * @param {number} edge0
 * @param {number} edge1
 * @param {number} x
 * @returns {number}
 */
export function smoothstep(edge0, edge1, x) {
  // 精确阈值（softness=0）是合法模式。避免 0/0 产生 NaN，并采用右连续阶跃。
  if (edge0 === edge1) return x >= edge1 ? 1 : 0;
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/** 亮度系数（Rec.709 线性）。 */
export const LUMA_R = 0.2126;
export const LUMA_G = 0.7152;
export const LUMA_B = 0.0722;

/** 中灰基准（#3 stops 换算）。 */
const MIDDLE_GRAY = 0.18;

/** 非线性响应的渐近上限；避免极端 HDR/错误输入让卷积场溢出。 */
export const SOURCE_RESPONSE_LIMIT = 8;

/** 强光源重建坐标的固定过渡半宽。 */
export const SOURCE_CLASS_SOFTNESS = 0.25;
/**
 * 色相选择性只针对高色纯度发光体。低于起点的冷白光不按蓝色 LED 处理；
 * 达到终点后才完整使用乳剂色相响应，以严格压制纯蓝/青 LED 泄漏。
 */
export const HUE_PURITY_START = 0.35;
export const HUE_PURITY_FULL = 0.80;
/** 大平面上 JS 滑动 deque 比 WASM 跨边界复制更快；小平面优先使用 WASM。 */
export const WASM_MAX_FILTER_PIXEL_LIMIT = 1024 * 1024;
/** @deprecated 历史导出名；保留给 V1.5 调用方。 */
export const SOURCE_CLASS_SOFTNESS_EV = SOURCE_CLASS_SOFTNESS;

/** 红层背景占用使用与深层感光源一致的长波权重。 */
export const BACKGROUND_LONG_WAVE_R = 0.82;
export const BACKGROUND_LONG_WAVE_G = 0.18;

/** 深红层入射曝光代理；权重和为 1，使中性白在两种阈值模式下保持同一标尺。 */
export const RED_LAYER_EXPOSURE_R = 0.82;
export const RED_LAYER_EXPOSURE_G = 0.16;
export const RED_LAYER_EXPOSURE_B = 0.02;

/**
 * 六个主色相上的乳剂层相对响应（R/Y/G/C/B/M，循环插值）。
 * 红层代表穿透乳剂后返回到最深感光层的长波能量；绿层只用于高曝光
 * 附近的橙色核芯。中性光由 saturation 门控保持 1，不被色相曲线染色。
 */
export const RED_LAYER_HUE_RESPONSE = Object.freeze([1.45, 1.15, 0.62, 0.015, 0.002, 0.82]);
export const GREEN_LAYER_HUE_RESPONSE = Object.freeze([0.35, 1.25, 0.85, 0.008, 0.001, 0.12]);
export const BLUE_LAYER_HUE_RESPONSE = Object.freeze([0.10, 0.08, 0.04, 0.002, 0.0, 0.04]);

/**
 * 从线性 RGB 计算连续、循环的色相响应。
 * @param {number} r
 * @param {number} g
 * @param {number} b
 * @returns {{hue:number,saturation:number,red:number,green:number,blue:number}}
 */
export function spectralHueResponse(r, g, b) {
  const pr = Math.max(0, Number.isFinite(r) ? r : 0);
  const pg = Math.max(0, Number.isFinite(g) ? g : 0);
  const pb = Math.max(0, Number.isFinite(b) ? b : 0);
  const max = Math.max(pr, pg, pb);
  const min = Math.min(pr, pg, pb);
  const delta = max - min;
  if (max <= 1e-12 || delta <= 1e-12) return { hue: 0, saturation: 0, red: 1, green: 1, blue: 1 };

  let h6;
  if (max === pr) h6 = ((pg - pb) / delta + 6) % 6;
  else if (max === pg) h6 = (pb - pr) / delta + 2;
  else h6 = (pr - pg) / delta + 4;
  const i0 = Math.floor(h6) % 6;
  const i1 = (i0 + 1) % 6;
  const rawT = h6 - Math.floor(h6);
  const t = rawT * rawT * (3 - 2 * rawT);
  /** @param {number} a @param {number} c */
  const lerp = (a, c) => a + (c - a) * t;
  return {
    hue: h6 / 6,
    saturation: delta / max,
    red: lerp(RED_LAYER_HUE_RESPONSE[i0], RED_LAYER_HUE_RESPONSE[i1]),
    green: lerp(GREEN_LAYER_HUE_RESPONSE[i0], GREEN_LAYER_HUE_RESPONSE[i1]),
    blue: lerp(BLUE_LAYER_HUE_RESPONSE[i0], BLUE_LAYER_HUE_RESPONSE[i1]),
  };
}

/**
 * 曝光相关乳剂响应。输入是高于主阈值的档位；0 EV 必须严格返回 0。
 * @param {number} exposureStops
 * @param {number} impact 0..1，对应指数 1..2.5
 */
export function sourceResponseFor(exposureStops, impact) {
  const u = Math.max(0, Number.isFinite(exposureStops) ? exposureStops : 0);
  const exponent = 1 + 1.5 * Math.min(1, Math.max(0, impact));
  const raw = Math.pow(u, exponent);
  return SOURCE_RESPONSE_LIMIT * (1 - Math.exp(-raw / SOURCE_RESPONSE_LIMIT));
}

/**
 * 从被 0..1 数字白点压缩的高光重建强光分类坐标。
 *
 * T<1 时，T..1 的完整可用高光范围定义为 0..1；这样 16-bit/8-bit 文档中的
 * clipped white 仍会被 Strong Core 识别，而刚越过阈值的窗户不会被误判为强光。
 * HDR >1 从坐标 1 连续按曝光档延伸。T>=1 时回退到相对阈值的真实 EV。
 *
 * @param {number} radiance
 * @param {number} threshold
 * @returns {number}
 */
export function reconstructedSourceExposureFor(radiance, threshold) {
  const e = Math.max(0, Number.isFinite(radiance) ? radiance : 0);
  const t = Math.max(0, Number.isFinite(threshold) ? threshold : 0);
  if (e <= t) return 0;
  if (t < 1) {
    return e <= 1
      ? (e - t) / Math.max(1e-6, 1 - t)
      : 1 + Math.log2(e);
  }
  return Math.max(0, Math.log2(e / Math.max(t, 1e-6)));
}

/**
 * O(N) 可分离方形最大值滤波。用于把“已通过色谱筛选的强光种子”传播到
 * 邻近的低阈值光学 glow；只传播许可，不直接制造光能。
 * dst 可与 src 是同一数组。
 * @param {Float32Array} src
 * @param {number} width
 * @param {number} height
 * @param {number} radius
 * @param {Float32Array} [dst]
 */
export function maxFilterSeparable(src, width, height, radius, dst = new Float32Array(width * height)) {
  const w = width;
  const h = height;
  const r = Math.max(0, Math.floor(radius));
  if (r === 0) {
    if (dst !== src) dst.set(src);
    return dst;
  }
  const temp = new Float32Array(w * h);
  const deque = new Int32Array(Math.max(w, h));

  for (let y = 0; y < h; y++) {
    const row = y * w;
    let head = 0;
    let tail = 0;
    let next = 0;
    for (let x = 0; x < w; x++) {
      const right = Math.min(w - 1, x + r);
      while (next <= right) {
        const value = src[row + next];
        while (tail > head && src[row + deque[tail - 1]] <= value) tail--;
        deque[tail++] = next++;
      }
      const left = x - r;
      while (tail > head && deque[head] < left) head++;
      temp[row + x] = src[row + deque[head]];
    }
  }

  for (let x = 0; x < w; x++) {
    let head = 0;
    let tail = 0;
    let next = 0;
    for (let y = 0; y < h; y++) {
      const bottom = Math.min(h - 1, y + r);
      while (next <= bottom) {
        const value = temp[next * w + x];
        while (tail > head && temp[deque[tail - 1] * w + x] <= value) tail--;
        deque[tail++] = next++;
      }
      const top = y - r;
      while (tail > head && deque[head] < top) head++;
      dst[y * w + x] = temp[deque[head] * w + x];
    }
  }
  return dst;
}

/**
 * 面向峰值通常被限制在 0..1 的数字图像构造光源响应。
 *
 * 直接对 log2(E/T) 做高次幂时，T=0.82、E=1 也只有 0.286 EV；在 8/16-bit
 * Photoshop 文档中会把最亮白色压到几乎没有 halation。这里把 T..1 映射到
 * 0..1 的可用高光余量，再应用曝光非线性。HDR E>1 从 1 连续地按档位延伸。
 * T>=1 时没有 SDR 余量可归一化，回退到相对阈值的曝光档响应。
 *
 * 有理软肩在归一化输入 1 时严格输出 1，并渐近 SOURCE_RESPONSE_LIMIT；因此
 * clipped white 仍能产生可见光晕，同时极端 HDR 不会使扩散场失控。
 *
 * @param {number} radiance 选定的线性亮度/最大通道混合值
 * @param {number} threshold 已换算到线性域的主阈值
 * @param {number} impact 0..1，对应指数 1..2.5
 * @returns {number}
 */
export function compressedHighlightResponseFor(radiance, threshold, impact) {
  const normalized = reconstructedSourceExposureFor(radiance, threshold);
  if (normalized <= 0) return 0;

  const exponent = 1 + 1.5 * Math.min(1, Math.max(0, impact));
  const raw = Math.pow(Math.max(0, normalized), exponent);
  return (SOURCE_RESPONSE_LIMIT * raw) / (SOURCE_RESPONSE_LIMIT - 1 + raw);
}

/**
 * 提取 Y/M/S/G/W。
 * @param {{width:number,height:number,rgb:Float32Array,alpha?:Float32Array}} input 线性 RGB（长度 w*h*3）
 * @param {{threshold:number,thresholdSoftness:number,sourceSoftness?:number,backgroundSoftness?:number,backgroundThreshold:number,thresholdUnits?:string,redLayerThresholdBias?:number,sourceImpact?:number,amplify?:number,sourceExpansion?:number,sourceInteriorProtection?:number,blueCompensation?:number,hotSourceThreshold?:number,spectralSensitivity?:number,sigma?:number}} params
 * @param {{extraction?:string,spillMix?:number,luma?:[number,number,number],compact?:boolean,keepW?:boolean}} [options]
 *   extraction: 'threshold'（默认，基于 Y）| 'spill'（基于 M，AlcedoStudio 参考）
 *   spillMix: 0..1 中间态混合权重（extraction='spill' 时生效；0=纯 threshold，1=纯 spill）
 *   luma: 亮度权重 [r,g,b]（默认 Rec.709；Rec2020/ProPhoto 工作空间由 io 层传入 2.1）
 * @returns {{Y:Float32Array,M:Float32Array|null,S:Float32Array|null,G:Float32Array,W:Float32Array|null,U:Float32Array,K:Float32Array|null,sourceR:Float32Array,sourceG:Float32Array,sourceB:Float32Array}}
 */
export function extractHighlights(input, params, options = {}) {
  const { width: w, height: h, rgb } = input;
  const n = w * h;
  const Y = new Float32Array(n);
  const M = options.compact ? null : new Float32Array(n);
  const S = options.compact ? null : new Float32Array(n);
  const G = new Float32Array(n);
  const sourceExpansion = Math.min(1, Math.max(0, params.sourceExpansion ?? 0));
  // Expansion 需要暂存原始 W，并在最大值传播后复用该缓冲写回最终能量。
  const W = options.compact && !options.keepW && sourceExpansion <= 0 ? null : new Float32Array(n);
  const U = new Float32Array(n);
  let K = null;
  const sourceR = new Float32Array(n);
  const sourceG = new Float32Array(n);
  const sourceB = new Float32Array(n);

  const luma = options.luma ?? [LUMA_R, LUMA_G, LUMA_B];
  const spillMix = options.extraction === 'spill' ? (options.spillMix ?? 1) : 0;
  // #3：thresholdUnits='stops' 时阈值按中灰基准曝光档位换算（跨位深/工作空间语义统一）
  const T = params.thresholdUnits === 'stops' ? MIDDLE_GRAY * Math.pow(2, params.threshold) : params.threshold;
  const BT = params.thresholdUnits === 'stops' ? MIDDLE_GRAY * Math.pow(2, params.backgroundThreshold) : params.backgroundThreshold;
  const sourceSoftness = params.sourceSoftness ?? params.thresholdSoftness;
  const backgroundSoftness = params.backgroundSoftness ?? params.thresholdSoftness;
  const t0 = T - sourceSoftness / 2;
  const t1 = T + sourceSoftness / 2;
  const g0 = BT - backgroundSoftness;
  const g1 = BT;
  const sourceImpact = params.sourceImpact ?? 0.65;
  const hotThreshold = params.hotSourceThreshold ?? 0.25;
  const spectralSensitivity = Math.min(1, Math.max(0, params.spectralSensitivity ?? 0));
  const blueCompensation = Math.min(1, Math.max(0, params.blueCompensation ?? 0));
  const redLayerThresholdBias = Math.min(1, Math.max(0, params.redLayerThresholdBias ?? 0));

  for (let i = 0, p = 0; i < n; i++, p += 3) {
    const r = rgb[p];
    const g = rgb[p + 1];
    const b = rgb[p + 2];
    const a = input.alpha ? Math.min(1, Math.max(0, input.alpha[i])) : 1;
    const y = luma[0] * r + luma[1] * g + luma[2] * b;
    const m = r > g ? (r > b ? r : b) : g > b ? g : b;
    Y[i] = y;
    if (M) M[i] = m;
    const sThreshold = smoothstep(t0, t1, y);
    const sSpill = smoothstep(t0, t1, m);
    const legacyMask = spillMix === 0 ? sThreshold : sThreshold * (1 - spillMix) + sSpill * spillMix;
    const legacyRadiance = Math.max(0, y * (1 - spillMix) + m * spillMix);
    const redLayerExposure = Math.max(
      0,
      RED_LAYER_EXPOSURE_R * r + RED_LAYER_EXPOSURE_G * g + RED_LAYER_EXPOSURE_B * b,
    );

    // 色相置信度只参与深红层阈值分支。低饱和冷白光保持 1；高饱和蓝/青
    // 发光体趋近 0；红/黄发光体保持 1。这样滑块右端代表完整的
    // RedLayerGate(ER) × RedEmitterConfidence，而不是把 R 通道生硬替换为亮度。
    const pr = Math.max(0, r);
    const pg = Math.max(0, g);
    const pb = Math.max(0, b);
    let redHueGain = 1;
    let greenHueGain = 1;
    let blueHueGain = 1;
    let redEmitterConfidence = 1;
    if (spectralSensitivity > 0) {
      const hueResponse = spectralHueResponse(pr, pg, pb);
      const purityGate = smoothstep(HUE_PURITY_START, HUE_PURITY_FULL, hueResponse.saturation);
      const hueMix = smoothstep(0, 1, spectralSensitivity) * purityGate;
      redHueGain += hueMix * (hueResponse.red - 1);
      greenHueGain += hueMix * (hueResponse.green - 1);
      blueHueGain += hueMix * (hueResponse.blue - 1);
      const longWaveEligibility = Math.min(1, Math.max(0, hueResponse.red));
      redEmitterConfidence += hueMix * (longWaveEligibility - 1);
    }

    const redLayerMask = smoothstep(t0, t1, redLayerExposure);
    // 先分别完成两条源场的阈值、曝光响应和色谱资格判断，再线性混合。
    // bias=0 必须严格等同 V1.5.1 的 BrightnessGate(E) 路径；bias=1 则完全
    // 使用 RedLayerGate(ER) × RedEmitterConfidence，中间值不会跳变。
    const legacyMaskedSource = legacyMask * a;
    const redLayerMaskedSource = redLayerMask * redEmitterConfidence * a;
    const legacyResponse = compressedHighlightResponseFor(legacyRadiance, T, sourceImpact);
    const redLayerResponse = compressedHighlightResponseFor(redLayerExposure, T, sourceImpact);
    const legacyAmplitude = legacyMaskedSource * legacyResponse;
    const redLayerAmplitude = redLayerMaskedSource * redLayerResponse;
    const sourceAmplitude = legacyAmplitude
      + (redLayerAmplitude - legacyAmplitude) * redLayerThresholdBias;
    const sourceMask = legacyMaskedSource
      + (redLayerMaskedSource - legacyMaskedSource) * redLayerThresholdBias;
    if (S) S[i] = sourceMask;
    // Halation 主要叠加到红层。用长波通道占用而不是总亮度作为背景门控：
    // 蓝天即使 Y 较高，R 通道仍有充足余量，不应阻断白灯产生的红晕；
    // 亮的中性/暖色区域长波占用高，仍会限制大面积红雾。
    const longWaveBackground = BACKGROUND_LONG_WAVE_R * r + BACKGROUND_LONG_WAVE_G * g;
    const clampedLongWave = longWaveBackground < 0 ? 0 : longWaveBackground > 1 ? 1 : longWaveBackground;
    const baseBackgroundGate = 1 - smoothstep(g0, g1, clampedLongWave);
    const backgroundPeak = Math.max(practicalZero(r), practicalZero(g), practicalZero(b));
    const coolBackground = backgroundPeak > 1e-8
      ? Math.max(0, practicalZero(b) - practicalZero(r)) / backgroundPeak
      : 0;
    G[i] = baseBackgroundGate + (1 - baseBackgroundGate) * coolBackground * blueCompensation;
    // sourceExposure 同步混合两条完整曝光坐标；红层一端继续乘发光体置信度，
    // 避免被阈值拒绝的纯蓝 LED 仍进入 Strong Source 分类。
    const legacySourceExposure = reconstructedSourceExposureFor(legacyRadiance, T);
    const redLayerSourceExposure = reconstructedSourceExposureFor(redLayerExposure, T)
      * redEmitterConfidence;
    const sourceExposure = legacySourceExposure
      + (redLayerSourceExposure - legacySourceExposure) * redLayerThresholdBias;
    U[i] = sourceExposure;
    if (W) W[i] = sourceAmplitude;

    // 分层感光源：红层接受红/绿为主的反射光，蓝色贡献被严格限制；
    // 绿层随曝光非线性增强，形成靠近光源的橙色核芯和更远的红色尾部。
    const legacySpectralNorm = legacyRadiance > 1e-8 ? legacyAmplitude / legacyRadiance : 0;
    const redLayerSpectralNorm = redLayerExposure > 1e-8 ? redLayerAmplitude / redLayerExposure : 0;
    const legacyHotMix = smoothstep(
      hotThreshold - SOURCE_CLASS_SOFTNESS,
      hotThreshold + SOURCE_CLASS_SOFTNESS,
      legacySourceExposure,
    );
    const redLayerHotMix = smoothstep(
      hotThreshold - SOURCE_CLASS_SOFTNESS,
      hotThreshold + SOURCE_CLASS_SOFTNESS,
      redLayerSourceExposure,
    );
    // 绿层只在强曝光附近显著增强：近源偏橙，远端/弱源保持红色。
    const legacyGreenShoulder = 0.12 + 0.88 * legacyHotMix;
    const redLayerGreenShoulder = 0.12 + 0.88 * redLayerHotMix;
    const redExposure = Math.max(
      0,
      RED_LAYER_EXPOSURE_R * pr + RED_LAYER_EXPOSURE_G * pg + RED_LAYER_EXPOSURE_B * pb,
    );
    const greenExposure = Math.max(0, 0.08 * pr + 0.74 * pg + 0.03 * pb);
    const blueExposure = Math.max(0, 0.01 * pr + 0.03 * pg + 0.06 * pb);
    const legacySourceR = redExposure * legacySpectralNorm * redHueGain;
    const redLayerSourceR = redExposure * redLayerSpectralNorm * redHueGain;
    const legacySourceG = greenExposure * legacySpectralNorm * legacyGreenShoulder * greenHueGain;
    const redLayerSourceG = greenExposure * redLayerSpectralNorm * redLayerGreenShoulder * greenHueGain;
    const legacySourceB = blueExposure * legacySpectralNorm * blueHueGain;
    const redLayerSourceB = blueExposure * redLayerSpectralNorm * blueHueGain;
    sourceR[i] = legacySourceR + (redLayerSourceR - legacySourceR) * redLayerThresholdBias;
    sourceG[i] = legacySourceG + (redLayerSourceG - legacySourceG) * redLayerThresholdBias;
    sourceB[i] = legacySourceB + (redLayerSourceB - legacySourceB) * redLayerThresholdBias;
  }

  if (sourceExpansion > 0 && W) {
    // 1) 仅把已经通过深红层色谱响应、且属于 Strong Source 的像素作为种子。
    for (let i = 0; i < n; i++) {
      const hotMix = smoothstep(
        hotThreshold - SOURCE_CLASS_SOFTNESS,
        hotThreshold + SOURCE_CLASS_SOFTNESS,
        U[i],
      );
      W[i] = Math.min(1, Math.max(0, sourceR[i] * hotMix));
    }
    // 2) 在与局部 PSF 同量级的范围传播种子许可。候选像素仍必须自身足够亮，
    // 因而不会把蓝天或普通暗背景填成实体红块。
    const growRadius = Math.max(1, Math.ceil(Math.max(0.5, params.sigma ?? 1) * (0.45 + 0.85 * sourceExpansion)));
    if (n > WASM_MAX_FILTER_PIXEL_LIMIT || !tryWasmMaxFilter(W, W, w, h, growRadius)) {
      maxFilterSeparable(W, w, h, growRadius, W);
    }
    // 内部保护需要知道哪些低阈值 optical glow 是由附近强光种子授权的。
    // K 在候选像素完成自身亮度和色相复核后写入，不能直接复制方形最大值场；
    // 否则白色窗灯附近的高饱和蓝/青灯带也会错误获得红层扩散许可。
    // 仅保护路径分配；No-Remjet(p=0) 不增加内存或改变旧分支性能。
    if ((params.sourceInteriorProtection ?? 0) > 0) K = new Float32Array(n);
    const lowerThreshold = Math.max(0, T * (1 - 0.68 * sourceExpansion));
    const candidateSoftness = Math.max(0.02, sourceSoftness * 2);
    const candidateEnd = Math.max(lowerThreshold + candidateSoftness, T);

    // 3) 低阈值邻域可以继承强种子的长波属性，但候选像素仍需通过“色纯度复核”。
    // 低饱和冷白 optical glow 不受影响；只有高饱和蓝/青发光体会被严格拒绝。
    // 这可区分蓝天下的白灯光学 glow 与紧邻白窗的独立蓝色 LED 灯带。
    for (let i = 0, p = 0; i < n; i++, p += 3) {
      const r = rgb[p];
      const g = rgb[p + 1];
      const b = rgb[p + 2];
      const a = input.alpha ? Math.min(1, Math.max(0, input.alpha[i])) : 1;
      const y = luma[0] * r + luma[1] * g + luma[2] * b;
      const m = Math.max(r, g, b);
      const sThreshold = smoothstep(t0, t1, y);
      const sSpill = smoothstep(t0, t1, m);
      const legacyMask = spillMix === 0 ? sThreshold : sThreshold * (1 - spillMix) + sSpill * spillMix;
      const legacyRadiance = Math.max(0, y * (1 - spillMix) + m * spillMix);
      const redLayerExposure = Math.max(
        0,
        RED_LAYER_EXPOSURE_R * r + RED_LAYER_EXPOSURE_G * g + RED_LAYER_EXPOSURE_B * b,
      );
      let redEmitterConfidence = 1;
      if (spectralSensitivity > 0) {
        const hueResponse = spectralHueResponse(Math.max(0, r), Math.max(0, g), Math.max(0, b));
        const purityGate = smoothstep(HUE_PURITY_START, HUE_PURITY_FULL, hueResponse.saturation);
        const hueMix = smoothstep(0, 1, spectralSensitivity) * purityGate;
        const longWaveEligibility = Math.min(1, Math.max(0, hueResponse.red));
        redEmitterConfidence += hueMix * (longWaveEligibility - 1);
      }
      const redLayerMask = smoothstep(t0, t1, redLayerExposure);
      const legacyAmplitude = legacyMask * a
        * compressedHighlightResponseFor(legacyRadiance, T, sourceImpact);
      const redLayerAmplitude = redLayerMask * redEmitterConfidence * a
        * compressedHighlightResponseFor(redLayerExposure, T, sourceImpact);
      const baseAmplitude = legacyAmplitude
        + (redLayerAmplitude - legacyAmplitude) * redLayerThresholdBias;
      const legacyCandidate = smoothstep(lowerThreshold, candidateEnd, legacyRadiance) * a;
      const redLayerCandidate = smoothstep(lowerThreshold, candidateEnd, redLayerExposure)
        * redEmitterConfidence * a;
      const candidate = legacyCandidate
        + (redLayerCandidate - legacyCandidate) * redLayerThresholdBias;
      const support = W[i];
      // 内部保护的候选复核沿用同一个置信度。Brightness 一端仍保留旧路径，
      // Red Layer 一端则不会让高饱和蓝/青邻域继承白光种子的许可。
      const candidateEligibility = (params.sourceInteriorProtection ?? 0) > 0
        ? redEmitterConfidence
        : 1;
      // 邻域只重建被数字高光压缩丢失的一部分源体能量，不能把整片 optical glow
      // 当作与 clipped core 等强的发光面，否则归一化 PSF 会产生硬红色块。
      const authorizedCandidate = candidate * support * candidateEligibility;
      const grownAmplitude = authorizedCandidate * sourceExpansion * 0.42;
      const finalAmplitude = Math.max(baseAmplitude, grownAmplitude);
      W[i] = finalAmplitude;
      if (K) K[i] = authorizedCandidate;
      if (S) S[i] = Math.max(S[i], authorizedCandidate);
      sourceR[i] = Math.max(sourceR[i], grownAmplitude);
      sourceG[i] = Math.max(sourceG[i], grownAmplitude * (0.12 + 0.12 * support));
    }
  }

  // Amplify 是 PSF 之前的乳剂返回能量，独立于最终 Strength/Impact。
  const amplify = Math.min(4, Math.max(0, params.amplify ?? 1));
  if (amplify !== 1) {
    const greenAmplify = amplify <= 1 ? amplify : 1 + (amplify - 1) * 0.55;
    const blueAmplify = amplify <= 1 ? amplify : 1 + (amplify - 1) * 0.15;
    for (let i = 0; i < n; i++) {
      sourceR[i] *= amplify;
      sourceG[i] *= greenAmplify;
      sourceB[i] *= blueAmplify;
      if (W) W[i] *= amplify;
    }
  }
  return { Y, M, S, G, W, U, K, sourceR, sourceG, sourceB };
}

/** @param {number} value */
function practicalZero(value) {
  return Math.max(0, Number.isFinite(value) ? value : 0);
}
