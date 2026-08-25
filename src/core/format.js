/**
 * Shared physical film-format profiles for the V1.6 optical effects.
 *
 * The serialized V1 schema stores the legacy gauge/ISO pair.  Core code uses
 * the richer profile so every effect converts microns to pixels identically.
 */

export const FORMAT_PROFILES = Object.freeze({
  super8: Object.freeze({
    id: 'super8',
    gauge: '8mm',
    stockWidthMm: 8.00,
    apertureWidthMm: 5.79,
    apertureHeightMm: 4.01,
    framePitchMm: 4.234,
    perforation: Object.freeze({ widthMm: 0.914, heightMm: 1.143, pitchMm: 4.234, sides: 1 }),
  }),
  super16: Object.freeze({
    id: 'super16',
    gauge: '16mm',
    stockWidthMm: 16.00,
    apertureWidthMm: 12.52,
    apertureHeightMm: 7.41,
    framePitchMm: 7.620,
    perforation: Object.freeze({ widthMm: 1.829, heightMm: 1.270, pitchMm: 7.620, sides: 1 }),
  }),
  'super35-4perf': Object.freeze({
    id: 'super35-4perf',
    gauge: '35mm',
    stockWidthMm: 35.00,
    apertureWidthMm: 24.89,
    apertureHeightMm: 18.66,
    framePitchMm: 19.000,
    perforation: Object.freeze({ widthMm: 2.794, heightMm: 1.981, pitchMm: 4.750, sides: 2 }),
  }),
  '65mm-5perf': Object.freeze({
    id: '65mm-5perf',
    gauge: '65mm',
    stockWidthMm: 65.00,
    apertureWidthMm: 52.15,
    apertureHeightMm: 23.07,
    framePitchMm: 23.750,
    perforation: Object.freeze({ widthMm: 2.794, heightMm: 1.981, pitchMm: 4.750, sides: 2 }),
  }),
});

/** @type {Record<string, any>} */
const PROFILE_BY_GAUGE = Object.freeze({
  '8mm': FORMAT_PROFILES.super8,
  '16mm': FORMAT_PROFILES.super16,
  '35mm': FORMAT_PROFILES['super35-4perf'],
  '65mm': FORMAT_PROFILES['65mm-5perf'],
});

export const DEFAULT_FILM_FORMAT = Object.freeze({ gauge: '35mm', iso: 250 });

/** @param {any} value */
function finite(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/** @param {Record<string, any>|undefined} value @returns {{gauge:string,iso:number}} */
export function normalizeFilmFormat(value) {
  const source = value ?? {};
  const gauge = typeof source.gauge === 'string' && PROFILE_BY_GAUGE[source.gauge]
    ? source.gauge
    : DEFAULT_FILM_FORMAT.gauge;
  const iso = finite(source.iso) && source.iso > 0 && source.iso <= 12800
    ? source.iso
    : DEFAULT_FILM_FORMAT.iso;
  return { gauge, iso };
}

/** @param {Record<string, any>|undefined} value @returns {any} */
export function resolveFilmFormat(value) {
  const normalized = normalizeFilmFormat(value);
  return PROFILE_BY_GAUGE[normalized.gauge];
}

/** @param {Record<string, any>|undefined} format @param {number} fullWidth */
export function pixelsPerMm(format, fullWidth) {
  const profile = resolveFilmFormat(format);
  if (!(Number.isFinite(fullWidth) && fullWidth > 0)) throw new RangeError('fullWidth must be positive');
  return fullWidth / profile.apertureWidthMm;
}

/** @param {Record<string, any>|undefined} format @param {number} fullWidth */
export function pixelsPerMicron(format, fullWidth) {
  return pixelsPerMm(format, fullWidth) / 1000;
}

/** @param {number} micron @param {Record<string, any>|undefined} format @param {number} fullWidth @param {number} [scale=1] */
export function physicalMicronsToPixels(micron, format, fullWidth, scale = 1) {
  if (!(Number.isFinite(micron) && micron >= 0)) throw new RangeError('micron must be non-negative');
  if (!(Number.isFinite(scale) && scale > 0)) throw new RangeError('scale must be positive');
  return micron * pixelsPerMicron(format, fullWidth) * scale;
}

export const GAUGES = Object.freeze(Object.keys(PROFILE_BY_GAUGE));
