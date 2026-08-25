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
import { createDefaultEffectGraph } from '../../src/core/index.js';

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
  const { params, version, document } = normalizeDocument(doc);
  assert.equal(params.strength, 25);
  assert.equal(params.sigma, 7.0, 'default sigma filled');
  assert.equal(params.redLayerThresholdBias, 0, 'new threshold bias defaults to the compatible endpoint');
  assert.equal(version, '2');
  assert.equal(document.schemaVersion, 2);
  assert.equal(document.graph[0].type, 'halation');
});

test('S5 invalid documents rejected', () => {
  assert.throws(() => normalizeDocument(null), /not an object/);
  assert.throws(() => normalizeDocument({ plugin: 'Other' }), /Unsupported sidecar schema/);
  assert.throws(() => normalizeDocument({ plugin: 'FilmLab', effects: {} }), /Unsupported sidecar schema/);
  assert.throws(() => parseDocument('{bad json'), /Invalid sidecar JSON/);
  assert.throws(() => parseDocument('{"plugin":"FilmLab","version":"1.0","effects":{"halation":{"strength":-5}}}'), /strength/);
});

test('S6 version migration: v1 becomes graph v2; future versions are rejected', () => {
  const old = { plugin: 'FilmLab', version: '0.9', effects: { halation: { strength: 10 } } };
  const migrated = migrateDocument(old);
  assert.equal(migrated.schemaVersion, SCHEMA_VERSION);
  assert.equal(migrated.graph[0].type, 'halation');
  const { params } = normalizeDocument(migrated);
  assert.equal(params.strength, 10);
  assert.equal(migrateDocument(migrated), migrated, '当前 schema 幂等');
  assert.throws(
    () => migrateDocument({ ...migrated, schemaVersion: SCHEMA_VERSION + 1 }),
    /newer than supported/,
  );
});

test('S7 toDocument shape: FilmHalation schema v2 graph + bindings', () => {
  const params = createHalationParams({});
  const doc = toDocument(params, {
    bindings: {
      sourceLayer: { id: 1, name: 'Source', token: '' },
      targetLayer: { id: 2, name: 'Film Halation [x]', token: 'x' },
    },
  });
  assert.equal(doc.plugin, 'FilmHalation');
  assert.equal(doc.schemaVersion, 2);
  assert.equal(doc.engineVersion, '1.5.1');
  assert.deepEqual(doc.format, { gauge: '35mm', iso: 250 });
  assert.equal(doc.graph[0].id, 'halation-main');
  assert.equal(doc.bindings.sourceLayer.id, 1);
  assert.deepEqual(Object.keys(doc.graph[0].params), [
    'strength', 'sigma', 'sigmaUnits', 'threshold', 'thresholdUnits', 'thresholdSoftness',
    'sourceSoftness', 'backgroundSoftness', 'smoothness', 'backgroundThreshold',
    'sourceImpact', 'amplify', 'sourceExpansion', 'redTail', 'blueCompensation', 'colorDensity', 'sourceInteriorProtection',
    'hotSourceThreshold', 'hotCoreStrength', 'globalSourceThreshold',
    'spectralSensitivity', 'redLayerThresholdBias', 'redshift', 'sigmaRatio', 'globalDiffusion', 'centerAttenuation', 'blendMode', 'diffusionMode',
    'extraction', 'spillMix', 'rolloff', 'profile',
  ]);
});

test('S9 temporary source-threshold switch migrates to the continuous bias', () => {
  assert.equal(createHalationParams({ sourceThresholdMode: 'legacy' }).redLayerThresholdBias, 0);
  assert.equal(createHalationParams({ sourceThresholdMode: 'red-layer' }).redLayerThresholdBias, 1);
  assert.equal(
    createHalationParams({ sourceThresholdMode: 'red-layer', redLayerThresholdBias: 0.35 }).redLayerThresholdBias,
    0.35,
    'explicit continuous value wins over the temporary switch',
  );
});

test('S10 V1.6 graph persists format, grain seed, and minimum engine version', () => {
  const graph = createDefaultEffectGraph(createHalationParams({ strength: 20 }), 0x12345678);
  const doc = toDocument(graph[0].params, {
    graph,
    format: { gauge: '16mm', iso: 500 },
  });
  assert.equal(doc.engineVersion, '1.6.0');
  assert.equal(doc.minimumEngineVersion, '1.6.0');
  assert.deepEqual(doc.format, { gauge: '16mm', iso: 500 });
  assert.equal(doc.graph.find((node) => node.type === 'grain').params.seed, 0x12345678);
  const roundTrip = parseDocument(JSON.stringify(doc)).document;
  assert.equal(roundTrip.graph.length, 3);
  assert.equal(roundTrip.graph.find((node) => node.type === 'filmResolution').type, 'filmResolution');
});

test('S8 current schema rejects unknown effect nodes instead of silently dropping them', () => {
  const doc = toDocument(createHalationParams({}));
  doc.graph.push({ id: 'future', type: 'unknownFutureNode', enabled: true, params: {} });
  assert.throws(() => normalizeDocument(doc), /Unknown effect node type/);
});
