/**
 * colorPipeline profile 解析测试：Rec.2020 匹配、32-bit linear 检测、写回 baseKey。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trcNameFromProfile, resolveDocumentTRC, resolvePixelTRC, standardProfileName, imageDataWriteProfile, matchProfileName, lumaForProfileKey, encodePanelPreviewSRGB } from '../../src/io/colorPipeline.js';

test('trcNameFromProfile: matches Rec.2020 and known bases', () => {
  assert.equal(trcNameFromProfile('sRGB IEC61966-2.1'), 'sRGB');
  assert.equal(trcNameFromProfile('Display P3'), 'DisplayP3');
  assert.equal(trcNameFromProfile('Adobe RGB (1998)'), 'AdobeRGB');
  assert.equal(trcNameFromProfile('ProPhoto RGB'), 'ProPhoto');
  assert.equal(trcNameFromProfile('Rec. 2020'), 'Rec2020');
  assert.equal(trcNameFromProfile('Rec.2020'), 'Rec2020');
  assert.equal(trcNameFromProfile('BT.2020'), 'Rec2020');
  assert.equal(trcNameFromProfile(null), null);
  assert.equal(trcNameFromProfile('Untagged RGB'), null);
});

test('resolveDocumentTRC: Rec.2020 doc uses Rec2020 TRC', () => {
  const r = resolveDocumentTRC({ colorProfileName: 'Rec. 2020' });
  assert.equal(r.profileKey, 'Rec2020');
  assert.equal(r.baseKey, 'Rec2020');
  assert.equal(r.assumed, false);
  // 往返验证走的是 Rec2020 曲线（与 sRGB 明显不同）
  assert.ok(Math.abs(r.decode(0.5) - Math.pow(0.5, 2.4)) < 1e-12);
});

test('resolveDocumentTRC: Display P3 uses the sRGB transfer curve with P3 primaries', () => {
  const r = resolveDocumentTRC({ colorProfileName: 'Display P3' });
  assert.equal(r.profileKey, 'DisplayP3');
  assert.equal(r.baseKey, 'DisplayP3');
  assert.equal(r.assumed, false);
  assert.ok(Math.abs(r.decode(0.5) - 0.21404114048223255) < 1e-12);
});

test('untagged panel preview is always sRGB-encoded, never document-TRC encoded', () => {
  const preview = encodePanelPreviewSRGB(new Float32Array([0.25, 0.5, 0.75]));
  assert.ok(Math.abs(preview[0] - 0.5370987) < 1e-6);
  assert.ok(Math.abs(preview[1] - 0.7353569) < 1e-6);
  assert.notEqual(preview[0], Math.pow(0.25, 1 / 2.4), 'Rec.2020 gamma must not be used for panel PNG');
});

test('panel preview encoder rejects frame objects instead of silently producing black pixels', () => {
  assert.throws(() => encodePanelPreviewSRGB({ rgb: new Float32Array([0.2, 0.3, 0.4]) }), /Float32 RGB/);
});

test('resolveDocumentTRC: 32-bit linear doc (profile name contains Linear) uses identity TRC, baseKey keeps base', () => {
  const r = resolveDocumentTRC({ colorProfileName: 'ProPhoto RGB (Linear)' });
  assert.equal(r.profileKey, 'linear');
  assert.equal(r.baseKey, 'ProPhoto');
  assert.equal(r.decode(0.5), 0.5, 'linear TRC identity');
  const r2 = resolveDocumentTRC({ colorProfileName: 'Rec. 2020 (Linear)' });
  assert.equal(r2.profileKey, 'linear');
  assert.equal(r2.baseKey, 'Rec2020');
});

test('resolvePixelTRC: actual Imaging API profile overrides document profile', () => {
  const doc = { colorProfileName: 'Rec. 2020' };
  const returnedLinear = resolvePixelTRC(doc, 'Rec. 2020 (Linear RGB Profile)');
  assert.equal(returnedLinear.profileKey, 'linear');
  assert.equal(returnedLinear.baseKey, 'Rec2020');
  assert.equal(returnedLinear.decode(0.18), 0.18, 'linear pixels must not be gamma-decoded again');

  const noReturnedProfile = resolvePixelTRC(doc, '');
  assert.equal(noReturnedProfile.profileKey, 'Rec2020', 'missing pixel profile falls back to document profile');
});

test('resolveDocumentTRC: untagged/unknown falls back to sRGB with assumed flag', () => {
  const r = resolveDocumentTRC({ colorProfileName: '' });
  assert.equal(r.profileKey, 'sRGB');
  assert.equal(r.assumed, true);
});

test('standardProfileName: Rec2020 and bases; linear writes base name (drop "(Linear)" suffix)', () => {
  assert.equal(standardProfileName('Rec2020'), 'Rec. 2020');
  assert.equal(standardProfileName('DisplayP3'), 'Display P3');
  assert.equal(standardProfileName('sRGB'), 'sRGB IEC61966-2.1');
  assert.equal(standardProfileName('AdobeRGB'), 'Adobe RGB (1998)');
  assert.equal(standardProfileName('ProPhoto'), 'ProPhoto RGB');
  // 32-bit linear 文档：写回用 baseKey 的基色名（文档要求去掉 "(Linear)"）
  const r = resolveDocumentTRC({ colorProfileName: 'ProPhoto RGB (Linear)' });
  assert.equal(standardProfileName(r.baseKey), 'ProPhoto RGB');
  const r2 = resolveDocumentTRC({ colorProfileName: 'Rec. 2020 (Linear)' });
  assert.equal(standardProfileName(r2.baseKey), 'Rec. 2020');
});

test('imageDataWriteProfile strips only the Photoshop 32-bit linear suffix', () => {
  assert.equal(imageDataWriteProfile('Rec. 2020 (Linear RGB Profile)'), 'Rec. 2020');
  assert.equal(imageDataWriteProfile('ProPhoto RGB (Linear Profile)'), 'ProPhoto RGB');
  assert.equal(imageDataWriteProfile('Rec. 2020'), 'Rec. 2020');
  assert.equal(imageDataWriteProfile(''), '');
});

test('matchProfileName: matches from PS color-settings list (names PS accepts); prefers exact, then non-linear, then any', () => {
  const list = ['sRGB IEC61966-2.1', 'Adobe RGB (1998)', 'ProPhoto RGB', 'Rec. 2020', 'Rec. 2020 (Linear)', 'Display P3', 'Generic RGB Profile'];
  // 精确匹配优先
  assert.equal(matchProfileName(list, 'Rec2020'), 'Rec. 2020');
  assert.equal(matchProfileName(list, 'DisplayP3'), 'Display P3');
  assert.equal(matchProfileName(list, 'sRGB'), 'sRGB IEC61966-2.1');
  assert.equal(matchProfileName(list, 'AdobeRGB'), 'Adobe RGB (1998)');
  assert.equal(matchProfileName(list, 'ProPhoto'), 'ProPhoto RGB');
  // 只有 linear 变体时也返回（但优先非 linear）
  assert.equal(matchProfileName(['Rec. 2020 (Linear)'], 'Rec2020'), 'Rec. 2020 (Linear)');
  // 找不到 → null
  assert.equal(matchProfileName(['Display P3', 'Generic RGB Profile'], 'Rec2020'), null);
  assert.equal(matchProfileName([], 'sRGB'), null);
  assert.equal(matchProfileName(null, 'sRGB'), null);
  // 子串匹配（无精确名时）：BT.2020 拼写
  assert.equal(matchProfileName(['BT.2020'], 'Rec2020'), 'BT.2020');
});

test('lumaForProfileKey (2.1): per-working-space luminance weights', () => {
  const rec709 = lumaForProfileKey('sRGB');
  assert.deepEqual(rec709, [0.2126, 0.7152, 0.0722], 'sRGB → Rec.709');
  assert.deepEqual(lumaForProfileKey('AdobeRGB'), rec709, 'AdobeRGB → Rec.709（同源 primaries）');
  assert.deepEqual(lumaForProfileKey('DisplayP3'), rec709, 'Display P3 转到 canonical sRGB 后使用 Rec.709');
  const rec2020 = lumaForProfileKey('Rec2020');
  assert.deepEqual(rec2020, [0.2627, 0.678, 0.0593], 'Rec2020 → BT.2020 luma');
  assert.notDeepEqual(rec2020, rec709, 'Rec2020 ≠ Rec.709');
  assert.deepEqual(lumaForProfileKey('ProPhoto'), [0.28804, 0.711953, 0.000007], 'ProPhoto（蓝原色近零亮度）');
  // 归一化权重：各空间系数之和 = 1
  for (const key of ['sRGB', 'Rec2020', 'ProPhoto', 'linear', undefined, null]) {
    const l = lumaForProfileKey(key);
    assert.ok(Math.abs(l[0] + l[1] + l[2] - 1) < 1e-9, `sum=1 for ${key}`);
  }
});
