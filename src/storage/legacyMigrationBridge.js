// @ts-nocheck
/**
 * Retired pre-public ID bridge implementation.
 *
 * This module is intentionally isolated from pluginStorage/main so it cannot
 * enter the public FilmEmulation.ccx through static imports. It remains only
 * as one-cycle protocol evidence and for its existing Node regression test.
 */
import { parseDocument } from './serializer.js';
import { fingerprintKey, pluginStorage } from './pluginStorage.js';
import {
  MIGRATION_EXTENSION,
  createMigrationBundle,
  serializeMigrationBundle,
  parseMigrationBundle,
} from './migration.js';

export const migrationReceiptKey = (crc) => `migration-receipt-${String(crc).toLowerCase()}.json`;

export async function exportMigrationState() {
  const documents = [];
  const invalidEntries = [];
  for (const name of (await pluginStorage.listNames()).sort()) {
    try {
      const { document } = parseDocument(await pluginStorage.load(name));
      documents.push(document);
    } catch (error) {
      invalidEntries.push({ name, error: error instanceof Error ? error.message : String(error) });
    }
  }
  const bundle = createMigrationBundle(documents);
  const text = serializeMigrationBundle(bundle);
  const { localFileSystem } = require('uxp').storage;
  const file = await localFileSystem.getFileForSaving(
    `FilmEmulation-State${MIGRATION_EXTENSION}`,
    { types: ['json'] },
  );
  if (!file) return { cancelled: true, exported: 0, invalidEntries };
  if (!String(file.name || '').toLowerCase().endsWith(MIGRATION_EXTENSION)) {
    throw new Error(`Migration file name must end with ${MIGRATION_EXTENSION}`);
  }
  await file.write(text);
  return {
    cancelled: false,
    exported: documents.length,
    invalidEntries,
    crc32: bundle.crc32,
    fileName: file.name,
  };
}

export async function prepareMigrationImport() {
  const { localFileSystem } = require('uxp').storage;
  const selected = await localFileSystem.getFileForOpening({ types: ['json'], allowMultiple: false });
  const file = Array.isArray(selected) ? selected[0] : selected;
  if (!file) return { cancelled: true };
  if (!String(file.name || '').toLowerCase().endsWith(MIGRATION_EXTENSION)) {
    throw new Error(`Select a ${MIGRATION_EXTENSION} file`);
  }
  const parsed = parseMigrationBundle(await file.read());
  const receiptKey = migrationReceiptKey(parsed.crc32);
  if (await pluginStorage.exists(receiptKey)) {
    return { cancelled: false, repeated: true, parsed, receiptKey, fileName: file.name };
  }
  const fresh = [];
  const conflicts = [];
  for (const entry of parsed.documents) {
    const key = fingerprintKey(entry.document.documentFingerprint);
    const item = { ...entry, key, label: entry.document.documentFingerprint.fileName || key };
    (await pluginStorage.exists(key) ? conflicts : fresh).push(item);
  }
  return {
    cancelled: false,
    repeated: false,
    parsed,
    receiptKey,
    fileName: file.name,
    fresh,
    conflicts,
  };
}

export async function commitMigrationImport(plan, options = {}) {
  if (!plan || plan.cancelled || plan.repeated) throw new Error('Migration import plan is not writable');
  const overwriteKeys = new Set(options.overwriteKeys || []);
  let imported = 0;
  let overwritten = 0;
  let preserved = 0;
  for (const entry of plan.fresh) {
    await pluginStorage.save(entry.key, JSON.stringify(entry.document));
    imported++;
  }
  for (const entry of plan.conflicts) {
    if (!overwriteKeys.has(entry.key)) {
      preserved++;
      continue;
    }
    await pluginStorage.save(entry.key, JSON.stringify(entry.document));
    imported++;
    overwritten++;
  }
  const receipt = {
    kind: 'FilmEmulationMigrationReceipt',
    bundleCrc32: plan.parsed.crc32,
    importedAt: new Date().toISOString(),
    sourceEngineVersion: plan.parsed.sourceEngineVersion,
    imported,
    overwritten,
    preserved,
    invalid: plan.parsed.invalidEntries.length,
  };
  await pluginStorage.save(plan.receiptKey, JSON.stringify(receipt, null, 2));
  return { ...receipt, receiptKey: plan.receiptKey };
}
