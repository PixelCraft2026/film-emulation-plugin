// @ts-nocheck
/**
 * io/colorPipeline — 色彩管理编排（唯一负责 TRC 与 profile 映射的模块）。
 * 职责：
 *  - 解析文档 color profile 名称 → TRC 枚举（sRGB/Display P3/AdobeRGB/ProPhoto/Rec.2020）；
 *  - 已知工作空间 → 按对应 TRC 处理；未标记 / 未知 profile → **不拒绝**，
 *    回退 sRGB TRC 并在元信息中注明（UXP 新建/未嵌入 profile 的文档很常见，
 *    直接拒绝会让插件完全不可用；sRGB 是 PS 默认 RGB 工作空间的安全回退）；
 *  - 提供整图批量 decode（显示编码→线性）与 encode（线性→显示编码），
 *    decode 不 clamp（保留 32-bit HDR >1），encode 不 clamp（HDR 语义留到写回时按位深量化）。
 */
import { getTRC, SPACE_TO_SRGB, SRGB_TO_SPACE } from '../core/index.js';

/**
 * canonical space（#7）：算法统一在线性 sRGB primaries 执行——
 * 返回 baseKey 对应的 primaries 转换矩阵（线性域；sRGB = null 表示无需转换）。
 * 32-bit linear 文档（profileKey='linear'）按 baseKey 的 primaries 转换。
 * @param {string|null} baseKey 'sRGB'|'DisplayP3'|'AdobeRGB'|'ProPhoto'|'Rec2020'
 * @returns {{toSRGB:Float32Array|null,fromSRGB:Float32Array|null}}
 */
export function primariesMatrices(baseKey) {
  if (!baseKey || baseKey === 'sRGB') return { toSRGB: null, fromSRGB: null };
  const toSRGB = SPACE_TO_SRGB[baseKey] ?? null;
  const fromSRGB = SRGB_TO_SPACE[baseKey] ?? null;
  return { toSRGB, fromSRGB };
}

/**
 * 工作空间基色 → 亮度（luma）系数（2.1 优化）。
 * 提取/门控的 Y 必须用工作空间自己的 primaries 的亮度权重，否则跨空间亮度语义漂移：
 *  - sRGB / Display P3 / Adobe RGB (1998)：算法转换到线性 sRGB 后使用 Rec.709；
 *  - Rec. 2020：BT.2020 luma（不同 primaries → 不同权重）；
 *  - ProPhoto (ROMM RGB, D50)：按 primaries 推导的亮度权重（蓝原色近光谱轨迹底，≈0）；
 *  - linear / 未知：回退 Rec.709。
 * @param {'sRGB'|'DisplayP3'|'AdobeRGB'|'ProPhoto'|'Rec2020'|'linear'|string|null} [profileKey]
 * @returns {[number,number,number]}
 */
export function lumaForProfileKey(profileKey) {
  if (profileKey === 'Rec2020') return [0.2627, 0.678, 0.0593];
  if (profileKey === 'ProPhoto') return [0.28804, 0.711953, 0.000007];
  return [0.2126, 0.7152, 0.0722]; // Rec.709（sRGB/AdobeRGB/linear/回退）
}

/**
 * profile 名称 → 基色 TRC 名称（不含 linear 检测；32-bit linear 由调用方单独处理）。
 * @param {string|null|undefined} profileName
 * @returns {'sRGB'|'DisplayP3'|'AdobeRGB'|'ProPhoto'|'Rec2020'|null}
 */
export function trcNameFromProfile(profileName) {
  if (!profileName) return null;
  const s = String(profileName).toLowerCase();
  if (s.includes('rec. 2020') || s.includes('rec.2020') || s.includes('rec2020') || s.includes('bt.2020')) {
    return 'Rec2020';
  }
  if (s.includes('display p3') || s.includes('display-p3') || s === 'p3') return 'DisplayP3';
  if (s.includes('srgb')) return 'sRGB';
  if (s.includes('adobe rgb') || s.includes('adobergb')) return 'AdobeRGB';
  if (s.includes('prophoto')) return 'ProPhoto';
  return null;
}

/**
 * 读取文档 color profile 名称。
 * UXP PS Document 的官方属性是 `colorProfileName`（`colorProfile` 不存在，
 * 早期实现误用导致恒为 undefined → 报 "Unsupported color profile: undefined"）。
 * @param {object} doc
 * @returns {string} 文档 profile 名（可能为空串表示未嵌入 profile）
 */
export function documentProfileName(doc) {
  const raw = doc?.colorProfileName ?? doc?.colorProfile ?? '';
  return String(raw).trim();
}

/**
 * TRC 枚举键 → 写回用的标准 ICC profile 名（createImageDataFromBuffer 参数）。
 * 写回必须声明与读取一致（的基色）profile，否则 PS 会把数据按错误空间解释并转换（色偏）。
 * 注意：32-bit linear 文档（profile 名带 "(Linear)"）应传基色名（文档要求去掉该后缀）。
 * @param {'sRGB'|'DisplayP3'|'AdobeRGB'|'ProPhoto'|'Rec2020'} key
 * @returns {string}
 */
export function standardProfileName(key) {
  if (key === 'DisplayP3') return 'Display P3';
  if (key === 'AdobeRGB') return 'Adobe RGB (1998)';
  if (key === 'ProPhoto') return 'ProPhoto RGB';
  if (key === 'Rec2020') return 'Rec. 2020';
  return 'sRGB IEC61966-2.1';
}

/**
 * Profile name accepted by createImageDataFromBuffer. Photoshop appends a
 * Linear RGB Profile suffix to 32-bit getPixels results, but Adobe requires
 * callers to remove that suffix when creating image data for putPixels.
 */
export function imageDataWriteProfile(profileName) {
  return String(profileName || '')
    .replace(/\s*\((?:linear\s+rgb\s+profile|linear\s+profile)\)\s*$/i, '')
    .trim();
}

/**
 * 从 PS 可用 profile 名单（app.getColorProfiles('RGB') 的返回）中按 baseKey 匹配写回名。
 * PS 返回的名字必然可传给 createImageDataFromBuffer（真机证明硬编码名如 "Rec. 2020"
 * 会报 "Unknown color profile"）。规则：完全匹配标准名优先 → 非 linear 变体子串匹配 →
 * 任意变体。排除 "(Linear)" 变体（32-bit linear 文档要求传基色名）。
 * @param {Array<string>} list profile 名单
 * @param {'sRGB'|'DisplayP3'|'AdobeRGB'|'ProPhoto'|'Rec2020'} baseKey
 * @returns {string|null}
 */
export function matchProfileName(list, baseKey) {
  if (!Array.isArray(list) || list.length === 0) return null;
  const arr = list.map(String);
  const exact = arr.find((p) => p === standardProfileName(baseKey));
  if (exact) return exact;
  const test = (name) => {
    const s = name.toLowerCase();
    if (baseKey === 'Rec2020') return (s.includes('rec') || s.includes('bt')) && s.includes('2020');
    if (baseKey === 'DisplayP3') return s.includes('display') && s.includes('p3');
    if (baseKey === 'AdobeRGB') return s.includes('adobe rgb');
    if (baseKey === 'ProPhoto') return s.includes('prophoto');
    return s.includes('srgb');
  };
  const nonLinear = arr.filter((p) => !/linear/i.test(p));
  // 优先非 linear 变体（32-bit linear 文档要求写基色名）；仅剩 linear 变体时也返回
  //（PS 可能多转一次 gamma，但不会报 Unknown；比硬编码名更稳）。
  return nonLinear.find(test) ?? arr.find(test) ?? null;
}

/**
 * 解析文档 TRC；未知 / 未标记 profile 回退 sRGB（不再抛错）。
 * 32-bit linear 文档（profile 名含 "linear"/"Linear"）→ TRC 恒等（像素即线性）。
 * 返回的 trc 对象附加元信息：profileKey / baseKey / profileName / assumed / note。
 * @param {object} doc Photoshop Document
 * @returns {{name:string,decode:(v:number)=>number,encode:(v:number)=>number,
 *            profileKey:'sRGB'|'DisplayP3'|'AdobeRGB'|'ProPhoto'|'Rec2020'|'linear',baseKey:string,
 *            profileName:string,assumed:boolean,note:string}}
 */
export function resolveDocumentTRC(doc) {
  const profileName = documentProfileName(doc);
  const s = profileName.toLowerCase();
  // profile 名含 "linear" 的文档（PS 32-bit 工作空间常见，如 "Rec. 2020 (Linear)" /
  // "ProPhoto RGB (Linear)"）像素为线性编码 → TRC 恒等（不做 gamma 解码）。
  const isLinear = s.includes('linear');
  const base = trcNameFromProfile(profileName); // 基色匹配（不含 linear）
  const baseKey = base ?? 'sRGB';
  const trcKey = isLinear ? 'linear' : baseKey;
  const trc = getTRC(trcKey);
  const assumed = !base;
  const note = assumed
    ? `Unsupported/untagged profile "${profileName || 'none'}" — assuming ${isLinear ? 'linear' : 'sRGB'}. Convert to sRGB/Adobe RGB/ProPhoto for exact color.`
    : `Working space: ${profileName} (${isLinear ? 'linear ' : ''}${baseKey}).`;
  return { ...trc, profileKey: trcKey, baseKey, profileName, assumed, note };
}

/** Resolve the TRC/primaries of pixels actually returned by Imaging API. */
export function resolvePixelTRC(doc, pixelProfileName) {
  const profileName = String(pixelProfileName || '').trim();
  return profileName ? resolveDocumentTRC({ colorProfileName: profileName }) : resolveDocumentTRC(doc);
}

/**
 * 批量 decode：显示编码 RGB → 线性 RGB（保留 HDR >1）。
 * @param {Float32Array} rgb 显示编码（w*h*3）
 * @param {{decode:(v:number)=>number}} trc
 * @returns {Float32Array} 线性（新数组，不改输入）
 */
export function decodeToLinear(rgb, trc) {
  const out = new Float32Array(rgb.length);
  for (let i = 0; i < rgb.length; i++) out[i] = trc.decode(rgb[i]);
  return out;
}

/**
 * 批量 encode：线性 RGB → 显示编码 RGB（不 clamp，HDR 语义交给写回量化）。
 * @param {Float32Array} rgb 线性（w*h*3）
 * @param {{encode:(v:number)=>number}} trc
 * @returns {Float32Array} 显示编码（新数组，不改输入）
 */
export function encodeFromLinear(rgb, trc) {
  const out = new Float32Array(rgb.length);
  for (let i = 0; i < rgb.length; i++) out[i] = trc.encode(rgb[i]);
  return out;
}

/** Encode canonical linear-sRGB pixels for an untagged panel PNG. */
export function encodePanelPreviewSRGB(rgb) {
  if (!(rgb instanceof Float32Array) || rgb.length % 3 !== 0) {
    throw new TypeError('Panel preview encoder requires an interleaved Float32 RGB buffer');
  }
  return encodeFromLinear(rgb, getTRC('sRGB'));
}
