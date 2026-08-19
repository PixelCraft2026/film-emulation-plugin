// @ts-nocheck
/**
 * storage/pluginStorage — PluginStorage document-state cache（TDD §9.1，V1 machine-local）。
 * 存储：UXP 插件数据目录（getDataFolder，零权限、跨会话）；文件按 DocumentFingerprint 命名。
 * 依赖：serializer（schema 序列化）、backends（StorageBackend 抽象）。
 *
 * DocumentFingerprint（cache 键）：
 *  - pathHash：normalized 文档路径 hash（大小写/分隔符规范化 + FNV-1a）
 *  - fileName：文件名（含扩展名）
 *  - fileSize / mtimeMs：预留（UXP 无文件 stat API，V1 填 null；未来 XMP/其他通道可补）
 *  - documentId：可选 Photoshop document identifier
 *
 * 限制（README/UI 告知）：machine-local；文档移动/改名后 fingerprint 变化需重新关联；不支持跨机器。
 */
import { StorageBackend } from './backends.js';
import { serializeParams, parseDocument } from './serializer.js';

function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

/** 路径规范化：统一分隔符 + 小写（Windows 大小写不敏感）。 */
function normalizePath(p) {
  return String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/**
 * 计算文档 fingerprint。
 * @param {object} doc Photoshop Document（含 path/name/id）
 * @returns {{pathHash:string,fileName:string,fileSize:number|null,mtimeMs:number|null,documentId:number|null}}
 */
export function computeFingerprint(doc) {
  const savedPath = normalizePath(doc.path || '');
  const fileName = doc.name || '';
  const documentId = doc.id ?? null;
  // 未保存文档没有路径；把当前 document id 纳入虚拟路径，避免所有 Untitled 文档碰撞。
  const identity = savedPath || `unsaved://${documentId ?? 'unknown'}/${String(fileName).toLowerCase()}`;
  return {
    pathHash: fnv1a(identity),
    fileName,
    fileSize: null, // UXP 无 stat API；预留
    mtimeMs: null, // 预留
    documentId,
    unsaved: !savedPath,
  };
}

/** cache 文件名（fingerprint 序列化为紧凑键）。 */
export function fingerprintKey(fp) {
  return `doc-${fp.pathHash}-${(fp.fileName || 'unnamed').replace(/[^\w.\-]/g, '_')}.film.json`;
}

/** 主匹配：pathHash + fileName 一致（文档未移动/改名）。 */
export function fingerprintMatches(a, b) {
  if (!a || !b || a.pathHash !== b.pathHash || a.fileName !== b.fileName) return false;
  if (a.unsaved || b.unsaved) return a.documentId === b.documentId;
  return true;
}

/**
 * PluginStorage：document-state cache 后端（Level 1）。
 * @implements {StorageBackend}
 */
export class PluginStorage extends StorageBackend {
  constructor() {
    super();
    this._folder = null;
  }

  async _getFolder() {
    if (!this._folder) {
      const { localFileSystem } = require('uxp').storage;
      this._folder = await localFileSystem.getDataFolder();
    }
    return this._folder;
  }

  /** @param {string} name @returns {Promise<void>} */
  async save(name, content) {
    const folder = await this._getFolder();
    const file = await folder.createFile(name, { overwrite: true });
    await file.write(content);
  }

  /** @param {string} name @returns {Promise<string>} */
  async load(name) {
    const folder = await this._getFolder();
    const entry = await folder.getEntry(name);
    if (!entry || !entry.isFile) throw new Error(`Cache entry not found: ${name}`);
    return entry.read();
  }

  /** @param {string} name @returns {Promise<boolean>} */
  async exists(name) {
    try {
      const folder = await this._getFolder();
      const entry = await folder.getEntry(name);
      return !!(entry && entry.isFile);
    } catch {
      return false;
    }
  }

  /** @param {string} name @returns {Promise<void>} */
  async remove(name) {
    const folder = await this._getFolder();
    const entry = await folder.getEntry(name);
    if (entry) await entry.delete();
  }

  /** 列出全部 cache 文件（fingerprint 匹配用）。 @returns {Promise<string[]>} */
  async listNames() {
    const folder = await this._getFolder();
    const entries = await folder.getEntries();
    return entries.filter((e) => e.isFile && e.name.endsWith('.film.json')).map((e) => e.name);
  }
}

/** 默认实例。 */
export const pluginStorage = new PluginStorage();

/**
 * 保存文档参数（fingerprint 键控）。
 * @param {object} doc
 * @param {object} params HalationParams
 * @returns {Promise<{key:string,fingerprint:object}>}
 */
export async function saveParamsForDoc(doc, params, state = {}) {
  const fp = computeFingerprint(doc);
  const key = fingerprintKey(fp);
  await pluginStorage.save(key, serializeParams(params, {
    format: state.format,
    bindings: state.bindings,
    documentFingerprint: fp,
  }));
  return { key, fingerprint: fp };
}

/**
 * 按 fingerprint 载入文档参数；无匹配返回 null。
 * @param {object} doc
 * @returns {Promise<{params:object,version:string,key:string}|null>}
 */
export async function loadParamsForDoc(doc) {
  const fp = computeFingerprint(doc);
  const key = fingerprintKey(fp);
  if (!(await pluginStorage.exists(key))) return null;
  const text = await pluginStorage.load(key);
  const { params, version, document } = parseDocument(text);
  const storedFingerprint = document.documentFingerprint;
  if (storedFingerprint && !fingerprintMatches(storedFingerprint, fp)) return null;
  return { params, version, key, document, bindings: document.bindings, format: document.format };
}

/** 供 Node 测试：纯 fingerprint 计算（不触碰 UXP）。 */
export const _test = { normalizePath, fnv1a, fingerprintMatches };
