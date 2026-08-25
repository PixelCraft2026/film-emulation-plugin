// @ts-nocheck
/**
 * io/tileRender — 行带分块渲染（大图内存兜底，主线程串行）。
 * 背景（capability R-6）：UXP 无 Web Worker → 并行降级为主线程分块 + 进度提示。
 * 用法：整图线性像素 → 按行带（含重叠）逐带 processHalation → 写回有效区。
 * 结果与整图渲染在重叠充分时数值一致（L2 极小，可测）。
 *
 * 3.2 修复：重叠按最大通道 σ = σ·max(sigmaRatio) 计算（sigmaRatio UI 上限 2.0，
 * 旧实现按基础 σ 导致大 σ + 高分比时带间截尾出现接缝）。
 * 3.3 优化：bandHeight 随重叠自适应（≥2×overlap），大 σ 时计算放大率 ≤2（旧固定
 * 256 行在 σ=50 时放大率 ≈3）。
 *
 * processTiledWithTrc 在带内做 TRC decode/encode（显示编码进、显示编码出），
 * 避免整图 linear 缓冲——大图（100MP+）时峰值内存显著降低，与独立验证程序一致。
 */
import { processHalation, lowResScale, psfLobesFor, applyMatrix3, resolveSigmaParams } from '../core/index.js';
import { splitBands } from './tiles.js';
import { decodeToLinear, encodeFromLinear, primariesMatrices } from './colorPipeline.js';

/** 超过该像素数改用行带分块（内存兜底；分块与整图数值一致，L2<1e-6）。 */
export const TILE_THRESHOLD = 8 * 1024 * 1024;
const nowMs = () => globalThis.performance?.now?.() ?? Date.now();

function addTimings(target, source) {
  if (!target || !source) return;
  for (const [key, value] of Object.entries(source)) target[key] = (target[key] ?? 0) + value;
}

/**
 * 分块渲染（含 TRC）：显示编码 RGB → 线性 → 算法 → 显示编码。
 * 小图走整图（无分块开销）；大图逐带内 decode/encode + 分块处理，峰值内存显著降低。
 * @param {{width:number,height:number,rgb:Float32Array,alpha?:Float32Array}} input 显示编码整图
 * @param {object} params HalationParams
 * @param {{decode:(v:number)=>number,encode:(v:number)=>number}} trc
 * @param {{bandHeight?:number,overlapPx?:number,forceFast?:boolean,tileThreshold?:number,outputTrc?:object}} [opts]
 *   overlapPx 默认 = ceil(5·σ·max(sigmaRatio))（覆盖最宽通道核）；bandHeight 默认
 *   = max(256, 2·overlapPx)（大 σ 限制冗余计算）；quality+大 σ 时两者向上取整到
 *   低分辨率 scale 的整数倍（相位对齐：带内低分辨率格子与整图重合，见 resample.js）；
 *   forceFast 强制 fast 扩散（预览用）；tileThreshold 覆盖分块阈值（测试注入小阈值）。
 * @returns {{width:number,height:number,rgb:Float32Array}} 显示编码整图
 */
export function processTiledWithTrc(input, params, trc, opts = {}) {
  const { width, height, rgb, alpha } = input;
  // #5：σ 单位幂等解析（diagonal → 像素；渲染用副本，UI 参数不变）
  const rp = resolveSigmaParams(params, width, height);
  const maxRatio = Math.max(rp.sigmaRatio[0], rp.sigmaRatio[1], rp.sigmaRatio[2]);
  const effSigma = rp.sigma * maxRatio;
  const redLobes = psfLobesFor(rp, 'red');
  const redTail = redLobes[redLobes.length - 1];
  const localSupport = effSigma * redTail.sigmaRatio;
  const growSupport = rp.sourceExpansion > 0 ? rp.sigma * (0.45 + 0.85 * rp.sourceExpansion) : 0;
  const scale = lowResScale(rp, effSigma);
  const overlapBase = Math.max(35, Math.ceil(5 * Math.max(localSupport, growSupport)));
  const overlapDefault = scale > 1 ? Math.ceil(overlapBase / scale) * scale : overlapBase;
  const bandBase = Math.max(256, Math.ceil(2 * overlapDefault));
  const bandDefault = scale > 1 ? Math.ceil(bandBase / scale) * scale : bandBase;
  const {
    bandHeight = bandDefault,
    overlapPx = overlapDefault,
    forceFast = false,
    tileThreshold = TILE_THRESHOLD,
  } = opts;
  const p0 = forceFast ? { ...rp, diffusionMode: 'fast' } : rp;
  // #7 canonical space：算法统一在线性 sRGB primaries 执行——
  // 非 sRGB 工作空间在 decode 后转换到 sRGB，算法后转回（luma 恒 Rec.709）。
  const outputTrc = opts.outputTrc ?? trc;
  const { toSRGB } = primariesMatrices(trc && trc.baseKey);
  const { fromSRGB } = primariesMatrices(outputTrc && outputTrc.baseKey);
  const timings = opts.profileTimings ? {} : null;
  const algoOpts = { luma: [0.2126, 0.7152, 0.0722], compact: true, profileTimings: !!timings };

  if (width * height <= tileThreshold) {
    let started = timings ? nowMs() : 0;
    const linear = decodeToLinear(rgb, trc);
    if (timings) {
      timings.decodeMs = nowMs() - started;
      started = nowMs();
    }
    if (toSRGB) applyMatrix3(linear, toSRGB);
    const out = processHalation({ width, height, rgb: linear, alpha }, p0, algoOpts);
    if (timings) {
      timings.primariesAndProcessMs = nowMs() - started;
      addTimings(timings, out.stats?.timings);
      started = nowMs();
    }
    if (fromSRGB) applyMatrix3(out.rgb, fromSRGB);
    const encoded = encodeFromLinear(out.rgb, outputTrc);
    if (timings) timings.encodeMs = nowMs() - started;
    return { width, height, rgb: encoded, alpha: out.alpha, timings };
  }

  const out = new Float32Array(width * height * 3);
  const outAlpha = alpha ? new Float32Array(alpha) : undefined;
  const bands = splitBands(width, height, bandHeight, overlapPx);
  const rowStride = width * 3;
  for (const band of bands) {
    const bh = band.end - band.start;
    // 带内显示编码（含重叠）
    const bandIn = new Float32Array(rowStride * bh);
    const bandAlpha = alpha ? new Float32Array(width * bh) : undefined;
    for (let y = band.start; y < band.end; y++) {
      const s = y * rowStride;
      const d = (y - band.start) * rowStride;
      for (let i = 0; i < rowStride; i++) bandIn[d + i] = rgb[s + i];
      if (bandAlpha) {
        const alphaSource = y * width;
        const alphaTarget = (y - band.start) * width;
        for (let x = 0; x < width; x++) bandAlpha[alphaTarget + x] = alpha[alphaSource + x];
      }
    }
    let started = timings ? nowMs() : 0;
    const bandLinear = decodeToLinear(bandIn, trc);
    if (timings) {
      timings.decodeMs = (timings.decodeMs ?? 0) + nowMs() - started;
      started = nowMs();
    }
    if (toSRGB) applyMatrix3(bandLinear, toSRGB);
    const bandRes = processHalation({ width, height: bh, rgb: bandLinear, alpha: bandAlpha }, p0, algoOpts);
    if (timings) {
      timings.primariesAndProcessMs = (timings.primariesAndProcessMs ?? 0) + nowMs() - started;
      addTimings(timings, bandRes.stats?.timings);
      started = nowMs();
    }
    if (fromSRGB) applyMatrix3(bandRes.rgb, fromSRGB);
    const bandEnc = encodeFromLinear(bandRes.rgb, outputTrc);
    if (timings) timings.encodeMs = (timings.encodeMs ?? 0) + nowMs() - started;
    // 写回有效区
    for (let y = band.y0; y < band.y1; y++) {
      const s = (y - band.start) * rowStride;
      const d = y * rowStride;
      for (let i = 0; i < rowStride; i++) out[d + i] = bandEnc[s + i];
    }
  }
  return { width, height, rgb: out, alpha: outAlpha, timings };
}
