// @ts-nocheck
/**
 * io/preview — 实时预览支撑：1024 最长边降采样（box 平均）+ fast 渲染建议。
 * 预览管线（Phase 4 UI 调用）：readDocumentPixels(componentSize:8) → 降采样 →
 * colorPipeline decode → processHalation(fast) → encode → putPixels 到临时图层/面板显示。
 */

/** 预览最长边像素上限（A3 预览 <500ms 目标）。 */
export const PREVIEW_MAX_EDGE = 1024;

/**
 * 效果源代理最长边。底图仍为 1024px；Threshold/Hue Response 等非线性步骤
 * 在更高分辨率、原生工作空间代理上执行，再降采样光源能量场。
 */
export const PREVIEW_EFFECT_MAX_EDGE = 2048;

/**
 * Clamp a point-to-point inspection viewport to a pixel layer's document-space
 * bounds. Dimensions and coordinates are integers so one source sample maps to
 * one preview image sample without sub-pixel resampling.
 * @param {{left:number,top:number,right:number,bottom:number}} outer
 * @param {{x?:number|null,y?:number|null}} center
 * @param {{width:number,height:number}} viewport
 */
export function inspectionVisibleBounds(outer, center, viewport) {
  const leftEdge = Math.ceil(Number(outer.left));
  const topEdge = Math.ceil(Number(outer.top));
  const rightEdge = Math.floor(Number(outer.right));
  const bottomEdge = Math.floor(Number(outer.bottom));
  if (!(rightEdge > leftEdge && bottomEdge > topEdge)) throw new RangeError('Inspection bounds must have positive area');
  const outerWidth = rightEdge - leftEdge;
  const outerHeight = bottomEdge - topEdge;
  const width = Math.min(outerWidth, Math.max(1, Math.floor(Number(viewport.width) || 1)));
  const height = Math.min(outerHeight, Math.max(1, Math.floor(Number(viewport.height) || 1)));
  const requestedX = Number.isFinite(center?.x) ? Number(center.x) : (leftEdge + rightEdge) / 2;
  const requestedY = Number.isFinite(center?.y) ? Number(center.y) : (topEdge + bottomEdge) / 2;
  const left = Math.max(leftEdge, Math.min(rightEdge - width, Math.round(requestedX - width / 2)));
  const top = Math.max(topEdge, Math.min(bottomEdge - height, Math.round(requestedY - height / 2)));
  return {
    left,
    top,
    right: left + width,
    bottom: top + height,
    centerX: left + width / 2,
    centerY: top + height / 2,
    width,
    height,
  };
}

/** Expand an inspection viewport by the graph support radius, clamped to the layer. */
export function inspectionReadBounds(visible, outer, padding) {
  const pad = Math.max(0, Math.ceil(Number(padding) || 0));
  const left = Math.max(Math.ceil(Number(outer.left)), visible.left - pad);
  const top = Math.max(Math.ceil(Number(outer.top)), visible.top - pad);
  const right = Math.min(Math.floor(Number(outer.right)), visible.right + pad);
  const bottom = Math.min(Math.floor(Number(outer.bottom)), visible.bottom + pad);
  return { left, top, right, bottom };
}

/** Extract an integer RGB crop without resampling. */
export function cropInterleavedRgb(rgb, width, height, crop) {
  const x = Math.floor(crop.x);
  const y = Math.floor(crop.y);
  const cropWidth = Math.floor(crop.width);
  const cropHeight = Math.floor(crop.height);
  if (x < 0 || y < 0 || cropWidth < 1 || cropHeight < 1 || x + cropWidth > width || y + cropHeight > height) {
    throw new RangeError('RGB crop is outside the source frame');
  }
  const out = new Float32Array(cropWidth * cropHeight * 3);
  const rowLength = cropWidth * 3;
  for (let row = 0; row < cropHeight; row++) {
    const start = ((y + row) * width + x) * 3;
    out.set(rgb.subarray(start, start + rowLength), row * rowLength);
  }
  return out;
}

/** Extract an integer single-channel crop without resampling. */
export function cropPreviewPlane(plane, width, height, crop) {
  if (!plane) return undefined;
  const x = Math.floor(crop.x);
  const y = Math.floor(crop.y);
  const cropWidth = Math.floor(crop.width);
  const cropHeight = Math.floor(crop.height);
  if (x < 0 || y < 0 || cropWidth < 1 || cropHeight < 1 || x + cropWidth > width || y + cropHeight > height) {
    throw new RangeError('Plane crop is outside the source frame');
  }
  const out = new Float32Array(cropWidth * cropHeight);
  for (let row = 0; row < cropHeight; row++) {
    const start = (y + row) * width + x;
    out.set(plane.subarray(start, start + cropWidth), row * cropWidth);
  }
  return out;
}

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

/** 单通道面积平均降采样（alpha/mask）。 */
export function downsamplePlane(src, w, h, dw, dh) {
  const out = new Float32Array(dw * dh);
  const sx = w / dw;
  const sy = h / dh;
  for (let y = 0; y < dh; y++) {
    const y0 = Math.floor(y * sy);
    const y1 = Math.min(h, Math.ceil((y + 1) * sy));
    for (let x = 0; x < dw; x++) {
      const x0 = Math.floor(x * sx);
      const x1 = Math.min(w, Math.ceil((x + 1) * sx));
      let sum = 0;
      let count = 0;
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          sum += src[yy * w + xx];
          count++;
        }
      }
      out[y * dw + x] = count ? sum / count : 0;
    }
  }
  return out;
}

/**
 * 权重加权的单通道降采样。用于把高分辨率光源分类量（如 U）按实际光源
 * 能量 W 汇聚到预览像素，避免一个强灯点被周围零值平均成“弱光源”。
 * 无权重时输出 0。
 *
 * @param {Float32Array} src
 * @param {Float32Array} weights
 * @param {number} w
 * @param {number} h
 * @param {number} dw
 * @param {number} dh
 * @returns {Float32Array}
 */
export function downsampleWeightedPlane(src, weights, w, h, dw, dh) {
  const out = new Float32Array(dw * dh);
  const sx = w / dw;
  const sy = h / dh;
  for (let y = 0; y < dh; y++) {
    const y0 = Math.floor(y * sy);
    const y1 = Math.min(h, Math.ceil((y + 1) * sy));
    for (let x = 0; x < dw; x++) {
      const x0 = Math.floor(x * sx);
      const x1 = Math.min(w, Math.ceil((x + 1) * sx));
      let weighted = 0;
      let weightSum = 0;
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const i = yy * w + xx;
          const weight = Math.max(0, weights[i]);
          weighted += src[i] * weight;
          weightSum += weight;
        }
      }
      out[y * dw + x] = weightSum > 1e-12 ? weighted / weightSum : 0;
    }
  }
  return out;
}

/**
 * 将高分辨率 extractStep 输出变为面板扩散尺寸。能量场按面积汇聚，U 按 W
 * 加权；这是预览与 Apply 保持非线性提取顺序一致的公共、可测试边界。
 *
 * @param {{W:Float32Array,G:Float32Array,Y:Float32Array,U:Float32Array,K?:Float32Array|null,sourceR:Float32Array,sourceG:Float32Array,sourceB:Float32Array}} extracted
 * @param {number} w
 * @param {number} h
 * @param {number} dw
 * @param {number} dh
 */
export function downsampleExtractedFields(extracted, w, h, dw, dh) {
  if (w === dw && h === dh) {
    const { W, G, Y, U, K = null, sourceR, sourceG, sourceB } = extracted;
    return { W, G, Y, U, K, sourceR, sourceG, sourceB };
  }
  const n = dw * dh;
  const W = new Float32Array(n);
  const G = new Float32Array(n);
  const Y = new Float32Array(n);
  const U = new Float32Array(n);
  const K = extracted.K ? new Float32Array(n) : null;
  const sourceR = new Float32Array(n);
  const sourceG = new Float32Array(n);
  const sourceB = new Float32Array(n);
  const sx = w / dw;
  const sy = h / dh;
  for (let y = 0; y < dh; y++) {
    const y0 = Math.floor(y * sy);
    const y1 = Math.min(h, Math.ceil((y + 1) * sy));
    for (let x = 0; x < dw; x++) {
      const x0 = Math.floor(x * sx);
      const x1 = Math.min(w, Math.ceil((x + 1) * sx));
      let sumW = 0;
      let sumG = 0;
      let sumY = 0;
      let weightedU = 0;
      let sumR = 0;
      let sumGreen = 0;
      let sumB = 0;
      let maxK = 0;
      let count = 0;
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const i = yy * w + xx;
          const weight = Math.max(0, extracted.W[i]);
          sumW += extracted.W[i];
          sumG += extracted.G[i];
          sumY += extracted.Y[i];
          weightedU += extracted.U[i] * weight;
          sumR += extracted.sourceR[i];
          sumGreen += extracted.sourceG[i];
          sumB += extracted.sourceB[i];
          if (K) maxK = Math.max(maxK, extracted.K[i]);
          count++;
        }
      }
      const o = y * dw + x;
      const invCount = count ? 1 / count : 0;
      W[o] = sumW * invCount;
      G[o] = sumG * invCount;
      Y[o] = sumY * invCount;
      U[o] = sumW > 1e-12 ? weightedU / sumW : 0;
      sourceR[o] = sumR * invCount;
      sourceG[o] = sumGreen * invCount;
      sourceB[o] = sumB * invCount;
      if (K) K[o] = maxK;
    }
  }
  return { W, G, Y, U, K, sourceR, sourceG, sourceB };
}
