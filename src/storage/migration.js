// @ts-nocheck
/**
 * Film Emulation plugin-ID migration bundle.
 *
 * This module is deliberately host-independent: it does not use TextEncoder,
 * UXP storage or Photoshop APIs, so the wire format and CRC can be tested in
 * Node and reproduced identically in the UXP runtime.
 */
import { ENGINE_VERSION } from '../core/index.js';
import { normalizeDocument } from './serializer.js';

export const MIGRATION_KIND = 'FilmEmulationMigration';
export const MIGRATION_BUNDLE_VERSION = 1;
export const LEGACY_PLUGIN_ID = 'com.cheukwing.filmhalation';
export const CURRENT_PLUGIN_ID = 'com.cheukwing.filmemulation';
export const MIGRATION_EXTENSION = '.filmemulation-migrate.json';
export const MAX_MIGRATION_BYTES = 10 * 1024 * 1024;
export const MAX_MIGRATION_DOCUMENTS = 10_000;

/** UTF-8 encoder that works in UXP releases without TextEncoder. */
export function utf8Encode(value) {
  const text = String(value);
  const bytes = [];
  for (let i = 0; i < text.length; i++) {
    let cp = text.charCodeAt(i);
    if (cp >= 0xd800 && cp <= 0xdbff) {
      const low = text.charCodeAt(i + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        cp = 0x10000 + ((cp - 0xd800) << 10) + (low - 0xdc00);
        i++;
      } else {
        cp = 0xfffd;
      }
    } else if (cp >= 0xdc00 && cp <= 0xdfff) {
      cp = 0xfffd;
    }

    if (cp <= 0x7f) {
      bytes.push(cp);
    } else if (cp <= 0x7ff) {
      bytes.push(0xc0 | (cp >>> 6), 0x80 | (cp & 0x3f));
    } else if (cp <= 0xffff) {
      bytes.push(0xe0 | (cp >>> 12), 0x80 | ((cp >>> 6) & 0x3f), 0x80 | (cp & 0x3f));
    } else {
      bytes.push(
        0xf0 | (cp >>> 18),
        0x80 | ((cp >>> 12) & 0x3f),
        0x80 | ((cp >>> 6) & 0x3f),
        0x80 | (cp & 0x3f),
      );
    }
  }
  return Uint8Array.from(bytes);
}

export function utf8ByteLength(value) {
  return utf8Encode(value).length;
}

/** Standard CRC-32/ISO-HDLC, formatted as eight uppercase hexadecimal digits. */
export function crc32(value) {
  const bytes = typeof value === 'string' ? utf8Encode(value) : value;
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i];
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return ((crc ^ 0xffffffff) >>> 0).toString(16).toUpperCase().padStart(8, '0');
}

/** Stable JSON used only for checksumming; array order is significant. */
export function canonicalStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalStringify(item)).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalStringify(value[key])}`).join(',')}}`;
}

function payloadOf(bundle) {
  return {
    kind: bundle.kind,
    bundleVersion: bundle.bundleVersion,
    sourcePluginId: bundle.sourcePluginId,
    sourceEngineVersion: bundle.sourceEngineVersion,
    exportedAt: bundle.exportedAt,
    documents: bundle.documents,
  };
}

function assertFingerprint(fp) {
  if (!fp || typeof fp !== 'object') throw new Error('documentFingerprint is required');
  if (typeof fp.pathHash !== 'string' || !/^[0-9a-f]{1,8}$/i.test(fp.pathHash)) {
    throw new Error('documentFingerprint.pathHash is invalid');
  }
  if (typeof fp.fileName !== 'string' || fp.fileName.length > 1024) {
    throw new Error('documentFingerprint.fileName is invalid');
  }
  if (fp.unsaved && !(typeof fp.documentId === 'number' && Number.isFinite(fp.documentId))) {
    throw new Error('unsaved documentFingerprint requires a documentId');
  }
}

export function createMigrationBundle(documents, options = {}) {
  if (!Array.isArray(documents)) throw new TypeError('Migration documents must be an array');
  if (documents.length > MAX_MIGRATION_DOCUMENTS) {
    throw new Error(`Migration package exceeds ${MAX_MIGRATION_DOCUMENTS} documents`);
  }
  const normalized = documents.map((value) => {
    const { document } = normalizeDocument(value?.document ?? value);
    assertFingerprint(document.documentFingerprint);
    return { document };
  });
  const payload = {
    kind: MIGRATION_KIND,
    bundleVersion: MIGRATION_BUNDLE_VERSION,
    sourcePluginId: LEGACY_PLUGIN_ID,
    sourceEngineVersion: String(options.sourceEngineVersion || ENGINE_VERSION),
    exportedAt: String(options.exportedAt || new Date().toISOString()),
    documents: normalized,
  };
  return { ...payload, crc32: crc32(canonicalStringify(payload)) };
}

export function serializeMigrationBundle(bundle) {
  const text = JSON.stringify(bundle, null, 2);
  const bytes = utf8ByteLength(text);
  if (bytes > MAX_MIGRATION_BYTES) {
    throw new Error(`Migration package is ${bytes} bytes; maximum is ${MAX_MIGRATION_BYTES}`);
  }
  return text;
}

export function parseMigrationBundle(text) {
  const bytes = utf8ByteLength(text);
  if (bytes > MAX_MIGRATION_BYTES) {
    throw new Error(`Migration package is ${bytes} bytes; maximum is ${MAX_MIGRATION_BYTES}`);
  }
  let raw;
  try {
    raw = JSON.parse(String(text).replace(/^\uFEFF/, ''));
  } catch (error) {
    throw new Error(`Invalid migration JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid migration package');
  if (raw.kind !== MIGRATION_KIND) throw new Error(`Unsupported migration kind: ${String(raw.kind)}`);
  if (raw.bundleVersion !== MIGRATION_BUNDLE_VERSION) {
    throw new Error(`Unsupported migration bundle version: ${String(raw.bundleVersion)}`);
  }
  if (raw.sourcePluginId !== LEGACY_PLUGIN_ID) {
    throw new Error(`Migration source plugin is not ${LEGACY_PLUGIN_ID}`);
  }
  if (typeof raw.sourceEngineVersion !== 'string' || !raw.sourceEngineVersion) {
    throw new Error('Migration sourceEngineVersion is missing');
  }
  if (typeof raw.exportedAt !== 'string' || !raw.exportedAt) throw new Error('Migration exportedAt is missing');
  if (!Array.isArray(raw.documents)) throw new Error('Migration documents must be an array');
  if (raw.documents.length > MAX_MIGRATION_DOCUMENTS) {
    throw new Error(`Migration package exceeds ${MAX_MIGRATION_DOCUMENTS} documents`);
  }
  if (typeof raw.crc32 !== 'string' || !/^[0-9A-Fa-f]{8}$/.test(raw.crc32)) {
    throw new Error('Migration CRC32 is missing or invalid');
  }
  const expected = crc32(canonicalStringify(payloadOf(raw)));
  if (expected !== raw.crc32.toUpperCase()) {
    throw new Error(`Migration CRC32 mismatch (expected ${expected}, got ${raw.crc32})`);
  }

  const documents = [];
  const invalidEntries = [];
  for (let index = 0; index < raw.documents.length; index++) {
    try {
      const { document } = normalizeDocument(raw.documents[index]?.document);
      assertFingerprint(document.documentFingerprint);
      documents.push({ index, document });
    } catch (error) {
      invalidEntries.push({ index, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return {
    crc32: raw.crc32.toUpperCase(),
    sourceEngineVersion: raw.sourceEngineVersion,
    exportedAt: raw.exportedAt,
    documents,
    invalidEntries,
    totalDocuments: raw.documents.length,
  };
}

