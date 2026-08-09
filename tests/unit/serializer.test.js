/**
 * storage/serializer 单元测试（TDD §9）：
 * 往返不变量、NaN/Inf 拒绝、键序规范化、默认补齐、version migration。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  serializeParams,
  parseDocument,
  toDocument,
  normalizeDocument,
  migrateDocument,
  SCHEMA_VERSION,
} from '../../src/storage/serializer.js';
import { createHalationParams } from '../../src/core/index.js';

test('S1 roundtrip invariant: serialize(parse(json)) === json', () => {
  const params = createHalationParams({ strength: 60, sigma: 12, blendMode: 'screen' });
  const json = serializeParams(params);
  const { params: parsed } = parseDocument(json);
  const json2 = serializeParams(parsed);
  assert.equal(json2, json, 'deterministic roundtrip');
});

test('S2 NaN/Infinity rejected', () => {
  const bad = createHalationParams({ strength: 50 });
  bad.redshift = [NaN, 0.05, 0.02];
  assert.throws(() => serializeParams(bad), TypeError, 'NaN rejected');
  bad.redshift = [1, Infinity, 0.02];
  assert.throws(() => serializeParams(bad), TypeError, 'Infinity rejected');
});

test('S3 key order is normalized (insertion order independent)', () => {
  const a = createHalationParams({ strength: 10 });
  const b = createHalationParams({ strength: 10 });
  // 构造不同插入顺序的对象
  const shuffled = { ...b, thresholdSoftness: b.thresholdSoftness, strength: b.strength };
  assert.equal(serializeParams(a), serializeParams(shuffled), 'key order normalized');
});

test('S4 missing fields filled with defaults on parse', () => {
  const doc = { plugin: 'FilmLab', version: '1.0', effects: { halation: { strength: 25 } } };
  const { params, version } = normalizeDocument(doc);
  assert.equal(params.strength, 25);
  assert.equal(params.sigma, 7.0, 'default sigma filled');
  assert.equal(version, '1.0');
});

test('S5 invalid documents rejected', () => {
  assert.throws(() => normalizeDocument(null), /not an object/);
  assert.throws(() => normalizeDocument({ plugin: 'Other' }), /plugin/);
  assert.throws(() => normalizeDocument({ plugin: 'FilmLab', effects: {} }), /effects\.halation/);
  assert.throws(() => parseDocument('{bad json'), /Invalid sidecar JSON/);
  assert.throws(() => parseDocument('{"plugin":"FilmLab","version":"1.0","effects":{"halation":{"strength":-5}}}'), /strength/);
});

test('S6 version migration: unknown version tagged to latest (empty chain for v1.0)', () => {
  const old = { plugin: 'FilmLab', version: '0.9', effects: { halation: { strength: 10 } } };
  const migrated = migrateDocument(old);
  assert.equal(migrated.version, SCHEMA_VERSION);
  const { params } = normalizeDocument(migrated);
  assert.equal(params.strength, 10);
  // 当前最新版本文档迁移为幂等
  assert.equal(migrateDocument({ ...old, version: SCHEMA_VERSION }).version, SCHEMA_VERSION);
});

test('S7 toDocument shape: plugin/version/effects.halation with ordered keys', () => {
  const params = createHalationParams({});
  const doc = toDocument(params);
  assert.equal(doc.plugin, 'FilmLab');
  assert.equal(doc.version, '1.0');
  assert.deepEqual(Object.keys(doc.effects.halation), [
    'strength', 'sigma', 'threshold', 'thresholdSoftness', 'backgroundThreshold',
    'redshift', 'sigmaRatio', 'globalDiffusion', 'centerAttenuation', 'blendMode', 'diffusionMode', 'profile',
  ]);
});
