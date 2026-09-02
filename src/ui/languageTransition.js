import { normalizeUiLocale } from './i18n.js';

/**
 * Plan a presentation-only language change. The render state is deliberately
 * retained by reference: language changes must not mutate the graph, grain
 * seed, layer bindings, or preview request generation.
 * @template T
 * @param {string} currentLocale
 * @param {string} nextLocale
 * @param {T} renderState
 */
export function planUiLocaleChange(currentLocale, nextLocale, renderState) {
  const uiLocale = normalizeUiLocale(nextLocale, currentLocale);
  return Object.freeze({
    changed: uiLocale !== currentLocale,
    uiLocale,
    renderState,
    renderPreview: false,
  });
}
