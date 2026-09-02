// @ts-nocheck
import { pluginStorage } from './pluginStorage.js';
import { normalizeUiLocale } from '../ui/i18n.js';

export const UI_PREFERENCES_FILE = 'film-emulation-preferences.json';
export const UI_PREFERENCES_VERSION = 1;

export function normalizeUiPreferences(value, fallbackLocale = 'en') {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    version: UI_PREFERENCES_VERSION,
    uiLocale: normalizeUiLocale(source.uiLocale, fallbackLocale),
  };
}

export async function loadUiPreferences(fallbackLocale = 'en', storage = pluginStorage) {
  if (!(await storage.exists(UI_PREFERENCES_FILE))) return normalizeUiPreferences({}, fallbackLocale);
  const parsed = JSON.parse(await storage.load(UI_PREFERENCES_FILE));
  return normalizeUiPreferences(parsed, fallbackLocale);
}

export async function saveUiPreferences(preferences, storage = pluginStorage) {
  const normalized = normalizeUiPreferences(preferences);
  await storage.save(UI_PREFERENCES_FILE, JSON.stringify(normalized));
  return normalized;
}
