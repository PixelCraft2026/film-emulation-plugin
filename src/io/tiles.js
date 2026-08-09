// @ts-nocheck
/**
 * io/tiles — 行带分块工具（Phase 6 渲染兜底：128–512 行带 + 边缘重叠 ceil(5σ) 镜像）。
 * 本模块只提供几何划分（纯函数），不接触宿主；Phase 6 接入渲染路径。
 */

/**
 * 按行带划分图像，带间带边缘重叠（重叠区在结果中裁掉，仅保留带中间有效区）。
 * @param {number} width
 * @param {number} height
 * @param {number} bandHeight 每带高度（不含重叠）
 * @param {number} overlapPx 上下各重叠像素（= ceil(5σ) 镜像）
 * @returns {{start:number,end:number,y0:number,y1:number,crop0:number,crop1:number}[]}
 *   start/end：处理带的行范围（含重叠）；y0/y1：写回有效区；crop0/crop1：带内偏移。
 */
export function splitBands(width, height, bandHeight, overlapPx) {
  const bands = [];
  const step = Math.max(1, bandHeight);
  for (let top = 0; top < height; top += step) {
    const effectiveEnd = Math.min(height, top + step);
    const start = Math.max(0, top - overlapPx);
    const end = Math.min(height, effectiveEnd + overlapPx);
    bands.push({
      start,
      end,
      y0: top,
      y1: effectiveEnd,
      crop0: top - start,
      crop1: effectiveEnd - start,
    });
  }
  return bands;
}
