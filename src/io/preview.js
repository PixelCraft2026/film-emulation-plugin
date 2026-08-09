// @ts-nocheck
/**
 * io/preview — 实时预览支撑：1024 最长边降采样（box 平均）+ fast 渲染建议。
 * 预览管线（Phase 4 UI 调用）：readDocumentPixels(componentSize:8) → 降采样 →
 * colorPipeline decode → processHalation(fast) → encode → putPixels 到临时图层/面板显示。
 */

/** 预览最长边像素上限（A3 预览 <500ms 目标）。 */
export const PREVIEW_MAX_EDGE = 1024;

/**
 * 计算降采样比例：最长边 > maxEdge 时缩至 maxEdge，否则 1（原尺寸）。
 * @param {number} width
 * @param {number} height
 * @param {number} [maxEdge]
 * @returns {number} scale（<1 表示缩小）
 */
export function computePreviewScale(width, height, maxEdge = PREVIEW_MAX_EDGE) {
  const max = Math.max(width, height);
  return max > maxEdge ? maxEdge / max : 1;
}

/**
 * box 平均降采样：srcRGB(w*h*3) → dstRGB(dw*dh*3)。
 * 每个输出像素 = 对应源块的平均（RGB 各通道）。
 * @param {Float32Array} src
 * @param {number} w
 * @param {number} h
 * @param {number} dw
 * @param {number} dh
 * @returns {Float32Array} dw*dh*3
 */
export function downsampleBox(src, w, h, dw, dh) {
  const out = new Float32Array(dw * dh * 3);
  const sx = w / dw;
  const sy = h / dh;
  for (let y = 0; y < dh; y++) {
    const y0 = Math.floor(y * sy);
    const y1 = Math.min(h, Math.ceil((y + 1) * sy));
    for (let x = 0; x < dw; x++) {
      const x0 = Math.floor(x * sx);
      const x1 = Math.min(w, Math.ceil((x + 1) * sx));
      let r = 0;
      let g = 0;
      let b = 0;
      let count = 0;
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const p = (yy * w + xx) * 3;
          r += src[p];
          g += src[p + 1];
          b += src[p + 2];
          count++;
        }
      }
      const o = (y * dw + x) * 3;
      out[o] = r / count;
      out[o + 1] = g / count;
      out[o + 2] = b / count;
    }
  }
  return out;
}
