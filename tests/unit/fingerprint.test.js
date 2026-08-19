/**
 * storage/pluginStorage fingerprint 单测（纯逻辑部分）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeFingerprint, fingerprintKey, fingerprintMatches, _test } from '../../src/storage/pluginStorage.js';

test('F1 normalizePath: backslashes unified, case folded, trailing slash trimmed', () => {
  assert.equal(_test.normalizePath('C:\\Users\\A\\Doc.PSD'), 'c:/users/a/doc.psd');
  assert.equal(_test.normalizePath('C:/Users/A/Doc.PSD/'), 'c:/users/a/doc.psd');
  assert.equal(_test.normalizePath(''), '');
});

test('F2 computeFingerprint: pathHash stable, fileName kept, size/mtime reserved null', () => {
  const doc = { path: 'C:\\Photos\\night.psd', name: 'night.psd', id: 42 };
  const fp = computeFingerprint(doc);
  assert.equal(fp.fileName, 'night.psd');
  assert.equal(fp.documentId, 42);
  assert.equal(fp.fileSize, null);
  assert.equal(fp.mtimeMs, null);
  // 大小写/分隔符变化不改变 pathHash
  const fp2 = computeFingerprint({ path: 'c:/photos/NIGHT.psd', name: 'night.psd' });
  assert.equal(fp.pathHash, fp2.pathHash, 'path hash case/sep insensitive');
});

test('F3 fingerprintKey: deterministic and filesystem-safe', () => {
  const fp = computeFingerprint({ path: 'C:\\a\\b\\x.psd', name: 'x.psd' });
  const key = fingerprintKey(fp);
  assert.equal(key, fingerprintKey(fp), 'deterministic');
  assert.ok(key.endsWith('.film.json'));
  assert.ok(!/[\\/:*?"<>|]/.test(key), 'filesystem-safe chars');
  assert.ok(key.startsWith('doc-'), 'prefix');
});

test('F4 fingerprintMatches: pathHash+fileName match; different file no match', () => {
  const a = computeFingerprint({ path: 'C:\\a\\x.psd', name: 'x.psd' });
  const b = computeFingerprint({ path: 'C:\\a\\x.psd', name: 'x.psd' });
  assert.ok(fingerprintMatches(a, b));
  const moved = computeFingerprint({ path: 'D:\\b\\x.psd', name: 'x.psd' });
  assert.ok(!fingerprintMatches(a, moved), 'moved file does not match');
  const renamed = computeFingerprint({ path: 'C:\\a\\y.psd', name: 'y.psd' });
  assert.ok(!fingerprintMatches(a, renamed), 'renamed file does not match');
});

test('F5 unsaved documents use document id and do not collide', () => {
  const a = computeFingerprint({ path: '', name: 'Untitled-1', id: 11 });
  const b = computeFingerprint({ path: '', name: 'Untitled-1', id: 12 });
  assert.equal(a.unsaved, true);
  assert.notEqual(a.pathHash, b.pathHash);
  assert.ok(!fingerprintMatches(a, b));
});
