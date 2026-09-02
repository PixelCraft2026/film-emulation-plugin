import test from 'node:test';
import assert from 'node:assert/strict';
import {
  UI_PREFERENCES_FILE,
  loadUiPreferences,
  normalizeUiPreferences,
  saveUiPreferences,
} from '../../src/storage/preferences.js';

function memoryStorage(initial = null) {
  let text = initial;
  return {
    async exists(name) { return name === UI_PREFERENCES_FILE && text !== null; },
    async load() { return text; },
    async save(name, value) { assert.equal(name, UI_PREFERENCES_FILE); text = value; },
    read() { return text; },
  };
}

test('UI language preference is global and normalized independently of document state', async () => {
  const storage = memoryStorage();
  assert.deepEqual(await loadUiPreferences('zh-CN', storage), { version: 1, uiLocale: 'zh-CN' });
  await saveUiPreferences({ uiLocale: 'en-US', document: { graph: [] } }, storage);
  assert.deepEqual(JSON.parse(storage.read()), { version: 1, uiLocale: 'en' });
  assert.deepEqual(normalizeUiPreferences({ uiLocale: 'zh' }), { version: 1, uiLocale: 'zh-CN' });
});
