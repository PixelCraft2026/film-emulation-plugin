import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LEGACY_PLUGIN_ID,
  MAX_MIGRATION_BYTES,
  MAX_MIGRATION_DOCUMENTS,
  canonicalStringify,
  crc32,
  createMigrationBundle,
  parseMigrationBundle,
  serializeMigrationBundle,
  utf8Encode,
} from '../../src/storage/migration.js';
import { createHalationParams } from '../../src/core/index.js';
import { toDocument } from '../../src/storage/serializer.js';
import { commitMigrationImport, pluginStorage } from '../../src/storage/pluginStorage.js';

const fingerprint = (name = 'photo.psd') => ({
  pathHash: 'a12bc34d',
  fileName: name,
  fileSize: null,
  mtimeMs: null,
  documentId: 42,
  unsaved: false,
});

const documentFor = (name = 'photo.psd') => toDocument(createHalationParams({ strength: 47 }), {
  documentFingerprint: fingerprint(name),
  bindings: { sourceLayer: { id: 7, name: 'Source', token: 'source-7' }, targetLayer: null },
});

const resign = (bundle) => {
  const { crc32: ignored, ...payload } = bundle;
  return { ...payload, crc32: crc32(canonicalStringify(payload)) };
};

test('M1 manual UTF-8 encoder handles ASCII, BMP and surrogate pairs', () => {
  assert.deepEqual([...utf8Encode('A©中😀')], [65, 194, 169, 228, 184, 173, 240, 159, 152, 128]);
  assert.deepEqual([...utf8Encode('\ud800')], [239, 191, 189], 'unpaired surrogate becomes U+FFFD');
});

test('M2 CRC32 uses the standard ISO-HDLC vector', () => {
  assert.equal(crc32('123456789'), 'CBF43926');
});

test('M3 migration bundle roundtrips canonical schema-v2 state', () => {
  const bundle = createMigrationBundle([documentFor()], {
    sourceEngineVersion: '1.5.1',
    exportedAt: '2026-08-25T00:00:00.000Z',
  });
  const parsed = parseMigrationBundle(serializeMigrationBundle(bundle));
  assert.equal(bundle.sourcePluginId, LEGACY_PLUGIN_ID);
  assert.equal(parsed.crc32, bundle.crc32);
  assert.equal(parsed.documents.length, 1);
  assert.equal(parsed.documents[0].document.documentFingerprint.fileName, 'photo.psd');
  assert.equal(parsed.documents[0].document.engineVersion, '1.5.1');
});

test('M4 corruption, wrong source and unsupported bundle versions are rejected', () => {
  const bundle = createMigrationBundle([documentFor()]);
  const corrupted = JSON.parse(JSON.stringify(bundle));
  corrupted.documents[0].document.graph[0].params.strength = 99;
  assert.throws(() => parseMigrationBundle(JSON.stringify(corrupted)), /CRC32 mismatch/);

  assert.throws(
    () => parseMigrationBundle(JSON.stringify(resign({ ...bundle, sourcePluginId: 'other.plugin' }))),
    /source plugin/,
  );
  assert.throws(
    () => parseMigrationBundle(JSON.stringify(resign({ ...bundle, bundleVersion: 2 }))),
    /bundle version/,
  );
});

test('M5 invalid document entries are isolated after package integrity succeeds', () => {
  const bundle = createMigrationBundle([documentFor('good.psd')]);
  bundle.documents.push({ document: { plugin: 'Other', schemaVersion: 2 } });
  const parsed = parseMigrationBundle(JSON.stringify(resign(bundle)));
  assert.equal(parsed.totalDocuments, 2);
  assert.equal(parsed.documents.length, 1);
  assert.equal(parsed.invalidEntries.length, 1);
  assert.equal(parsed.invalidEntries[0].index, 1);
});

test('M6 missing or unsafe fingerprints are isolated', () => {
  const bundle = createMigrationBundle([documentFor()]);
  bundle.documents[0].document.documentFingerprint = null;
  const parsed = parseMigrationBundle(JSON.stringify(resign(bundle)));
  assert.equal(parsed.documents.length, 0);
  assert.match(parsed.invalidEntries[0].error, /documentFingerprint/);
});

test('M7 migration limits are enforced before processing', () => {
  assert.throws(
    () => createMigrationBundle(new Array(MAX_MIGRATION_DOCUMENTS + 1)),
    /exceeds 10000 documents/,
  );
  assert.throws(
    () => parseMigrationBundle('x'.repeat(MAX_MIGRATION_BYTES + 1)),
    /maximum/,
  );
});

test('M8 import commit preserves unselected conflicts and writes a CRC receipt', async () => {
  const originalSave = pluginStorage.save;
  const writes = [];
  pluginStorage.save = async (name, content) => writes.push({ name, content });
  try {
    const doc = documentFor();
    const result = await commitMigrationImport({
      cancelled: false,
      repeated: false,
      receiptKey: 'migration-receipt-deadbeef.json',
      parsed: { crc32: 'DEADBEEF', sourceEngineVersion: '1.5.1', invalidEntries: [] },
      fresh: [{ key: 'fresh.film.json', document: doc }],
      conflicts: [
        { key: 'overwrite.film.json', document: doc },
        { key: 'preserve.film.json', document: doc },
      ],
    }, { overwriteKeys: ['overwrite.film.json'] });
    assert.equal(result.imported, 2);
    assert.equal(result.overwritten, 1);
    assert.equal(result.preserved, 1);
    assert.deepEqual(writes.map((item) => item.name), [
      'fresh.film.json',
      'overwrite.film.json',
      'migration-receipt-deadbeef.json',
    ]);
  } finally {
    pluginStorage.save = originalSave;
  }
});
