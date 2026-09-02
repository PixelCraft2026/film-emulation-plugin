import test from 'node:test';
import assert from 'node:assert/strict';
import { detectUiLocale, getStrings, normalizeUiLocale, translateUiText } from '../../src/ui/i18n.js';

test('UI locale normalization supports Chinese and English host variants', () => {
  assert.equal(normalizeUiLocale('zh-Hans-CN'), 'zh-CN');
  assert.equal(normalizeUiLocale('en_US'), 'en');
  assert.equal(detectUiLocale(['fr-FR', 'zh_CN']), 'zh-CN');
  assert.equal(detectUiLocale(['ja-JP'], 'en'), 'en');
});

test('Chinese terminology and runtime messages use the approved wording', () => {
  const en = getStrings('en');
  const zh = getStrings('zh-CN');
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort());
  for (const key of Object.keys(en)) assert.equal(typeof zh[key], typeof en[key], `translation type mismatch: ${key}`);
  assert.equal(translateUiText('Halation', 'zh-CN'), '胶片光晕');
  assert.equal(translateUiText('Defringe', 'zh-CN'), '去色边');
  assert.equal(translateUiText('Film Grain', 'zh-CN'), '胶片颗粒');
  assert.equal(translateUiText('CineStill 800T', 'zh-CN'), 'CineStill 800T');
  assert.equal(zh.rebind, '重新绑定源图层');
  assert.equal(en.windowsTestBuild, 'Windows test build');
  assert.equal(zh.windowsTestBuild, 'Windows 测试版');
  assert.match(zh.statusApplied(123), /源图层保持不变/);
});
