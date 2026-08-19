/**
 * 红色偏移 — r⊙D 通道增益 + SigmaRatio 逐通道扩散 σ（PRD §5.2）。
 * 零依赖，纯函数。
 *
 * 语义：高光 mask S 按每通道 σ = sigma × sigmaRatio[c] 扩散得到 D_c，
 * 再乘以通道增益 redshift[c]：红色保留（1.0），绿蓝大幅衰减（0.05/0.02）
 * → 高光周围呈现红色光晕（AlcedoStudio halation 参考基线）。
 * 扩散本身由调用方（pipeline）用 gaussianBlurSep / boxBlur3 执行；本模块只做
 * σ 计算与逐通道增益合成。
 */

/** 每通道扩散 σ（像素）= params.sigma × sigmaRatio[c]。
 * @param {{sigma:number,sigmaRatio:number[]}} params
 * @returns {number[]} [σr, σg, σb]
 */
export function channelSigmas(params) {
  const s = params.sigma;
  const r = params.sigmaRatio;
  return [s * r[0], s * r[1], s * r[2]];
}

/**
 * 红色偏移合成：三通道已扩散 mask（dr/dg/db）→ RGB（redshift 增益）。
 * @param {Float32Array} dr 红通道扩散结果（w*h）
 * @param {Float32Array} dg 绿通道扩散结果（w*h）
 * @param {Float32Array} db 蓝通道扩散结果（w*h）
 * @param {number} width
 * @param {number} height
 * @param {{redshift:number[]}} params
 * @returns {Float32Array} RGB（w*h*3，交错）
 */
export function applyRedShift(dr, dg, db, width, height, params) {
  const n = width * height;
  const out = new Float32Array(n * 3);
  const rs = params.redshift;
  for (let i = 0, p = 0; i < n; i++, p += 3) {
    out[p] = dr[i] * rs[0];
    out[p + 1] = dg[i] * rs[1];
    out[p + 2] = db[i] * rs[2];
  }
  return out;
}
