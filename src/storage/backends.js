/**
 * storage/backends — 持久化后端抽象（TDD §9）。
 * Level 1：SidecarStorage（文档同目录 `<name>.film.json`，正式方案）；
 * Level 2/3（预留）：插件数据目录 / 云端——仅声明接口，不实现。
 * 算法与 UI 不感知后端，仅依赖本接口。
 */

/**
 * @typedef {{save:(name:string,content:string)=>Promise<void>,
 *            load:(name:string)=>Promise<string>,
 *            exists:(name:string)=>Promise<boolean>,
 *            remove:(name:string)=>Promise<void>}} StorageBackendLike
 */

/**
 * 抽象基类（子类必须实现全部方法）。
 */
export class StorageBackend {
  /** @returns {Promise<void>} */
  async save() {
    throw new Error('StorageBackend.save not implemented');
  }
  /** @returns {Promise<string>} */
  async load() {
    throw new Error('StorageBackend.load not implemented');
  }
  /** @returns {Promise<boolean>} */
  async exists() {
    throw new Error('StorageBackend.exists not implemented');
  }
  /** @returns {Promise<void>} */
  async remove() {
    throw new Error('StorageBackend.remove not implemented');
  }
}

/** 后端注册表（Level 2/3 扩展点）。 */
const backends = new Map();

/**
 * 注册后端。
 * @param {string} name
 * @param {StorageBackend} backend
 */
export function registerBackend(name, backend) {
  backends.set(name, backend);
}

/**
 * 取后端。
 * @param {string} name
 * @returns {StorageBackend}
 */
export function getBackend(name) {
  const b = backends.get(name);
  if (!b) throw new Error(`Storage backend not registered: ${name}`);
  return b;
}
