/**
 * Preview-mode defaults shared by the DOM panel and Node tests.
 * @param {string} domain
 */
export function defaultPreviewModeForDomain(domain) {
  return domain === 'resolution' || domain === 'grain' ? 'actual' : 'fit';
}

/**
 * Normalize the CSS-to-device-pixel ratio reported by the UXP host.
 * @param {number|undefined|null} value
 */
export function normalizePreviewPixelRatio(value) {
  const ratio = Number(value);
  return Number.isFinite(ratio) && ratio > 0 ? Math.max(0.5, Math.min(8, ratio)) : 1;
}

/**
 * Resolve the real host display scale. Older Photoshop UXP versions report
 * window.devicePixelRatio=1 even when Windows is scaled to 125/150/200%.
 * Prefer a trustworthy per-element ratio, then Photoshop's primary display.
 * @param {Array<{scaleFactor?:number,isPrimary?:boolean}>|undefined|null} configurations
 * @param {number|undefined|null} reportedRatio
 */
export function displayScaleForPreview(configurations, reportedRatio) {
  const reported = normalizePreviewPixelRatio(reportedRatio);
  if (reported > 1.0001) return reported;
  const displays = Array.isArray(configurations)
    ? configurations.filter((display) => Number(display?.scaleFactor) > 0)
    : [];
  const selected = displays.find((display) => display.isPrimary === true) ?? displays[0];
  return normalizePreviewPixelRatio(selected?.scaleFactor ?? reported);
}

/**
 * Convert a CSS viewport into the source-pixel crop needed for true 100%.
 * @param {number} cssWidth
 * @param {number} cssHeight
 * @param {number} pixelRatio
 * @param {number} [maxEdge]
 */
export function inspectionViewportForCss(cssWidth, cssHeight, pixelRatio, maxEdge = 4096) {
  const ratio = normalizePreviewPixelRatio(pixelRatio);
  const limit = Math.max(1, Math.floor(Number(maxEdge) || 4096));
  return {
    width: Math.min(limit, Math.max(1, Math.round((Number(cssWidth) || 1) * ratio))),
    height: Math.min(limit, Math.max(1, Math.round((Number(cssHeight) || 1) * ratio))),
    pixelRatio: ratio,
  };
}

/**
 * CSS dimensions that map one source pixel to one physical display pixel.
 * @param {number} pixelWidth
 * @param {number} pixelHeight
 * @param {number} pixelRatio
 */
export function inspectionCssSize(pixelWidth, pixelHeight, pixelRatio) {
  const ratio = normalizePreviewPixelRatio(pixelRatio);
  return {
    width: Math.max(1, Number(pixelWidth) || 1) / ratio,
    height: Math.max(1, Number(pixelHeight) || 1) / ratio,
  };
}

/**
 * Layout for a native inspection bitmap. `fill` is intentional: `none` keeps
 * the bitmap at its natural CSS size and defeats the high-DPI box correction.
 * Width and height share the same ratio, so no aspect distortion is introduced.
 * @param {number} pixelWidth
 * @param {number} pixelHeight
 * @param {number} pixelRatio
 */
export function inspectionImageLayout(pixelWidth, pixelHeight, pixelRatio) {
  return { ...inspectionCssSize(pixelWidth, pixelHeight, pixelRatio), objectFit: 'fill' };
}
