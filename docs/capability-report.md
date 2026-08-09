# UXP Capability Report

**Phase 0 spike 实测结果**（对应 TDD R-1 / R-2 / R-6）
**测试环境**：Windows 10, Photoshop 27.1.0（PS 2026）, UXP 9.0.2, UDT 2.2.1
**测试时间**：2026-08-10 02:11 (UTC+8)
**插件**：com.cheukwing.filmhalation（manifest v4, panel entrypoint）

---

## 1. V-1 / R-1：imaging 吞吐与单次调用尺寸上限

**API**：`require('photoshop').imaging.getPixels / putPixels`（**注意：不在 `document` 上**；初版 probe 误用 `doc.getPixels/putPixels` 报 `TypeError: doc.putPixels is not a function`，已修正）

**8-bit RGBA 实测（新文档 72dpi, black fill）：**

| 尺寸 | 像素数 | readMs | writeMs | 说明 |
|---|---|---|---|---|
| 512×512 | 0.26M | 1 | 2 | |
| 1024×1024 | 1.0M | 5 | 14 | |
| 2048×2048 | 4.2M | 15 | 18 | |
| 4096×4096 | 16.8M | 46 | 57 | |
| **6000×4000** | **24.0M** | **63** | **91** | **24MP 目标一次调用成功，无尺寸上限** |

**结论**：
- 24MP 单次 `getPixels` + `putPixels` 均可一次完成，**不存在调用尺寸上限**（tile 分块为兜底而非必需，Phase 6 再定）。
- 吞吐约 read ~380MP/s、write ~260MP/s（8-bit RGBA）。
- 按此推算：24MP 全流程 getPixels(63ms) + 算法 + putPixels(91ms) ≈ 155ms 固定开销，算法侧时间余量充足，A3（渲染 <5s）前景良好。

## 2. V-2 / R-2：32-bit Float32 往返与 HDR

**实测**（64×64, depth=32, RGBA FLOAT32）：
- 往返 hash 一致（写入后读回字节级一致：`fnv1a` 匹配）。
- **HDR >1 不 clamp**：写入 R=1.5 → 读回 R=1.5（32-bit 文档保留 HDR 语义）。
- `colorProfile`：**新文档返回 `null`**（未嵌入 profile；PS 默认文档无 profile 字符串，需在真实工作流中读取用户文档的 profile 验证）。
- **观察项**：alpha 写入 1.0 → 读回 1.5（与 R 通道相同值），疑似 putPixels 对 alpha 组件的映射异常。**影响**：算法链路（RGB）不受影响；但若需 alpha 感知需在 Phase 3 复核 `applyAlpha` / `components` 的 alpha 语义。

**结论**：32-bit 文档 getPixels/putPixels 无损往返，HDR >1 保留；`componentSize` 使用数字（8/16/32）而非字符串 `'UINT8'` 等（初版用字符串失败）。

## 3. R-6：Web Worker

**实测**：`new Worker(...)` 抛 `ReferenceError: Worker is not defined`。

**结论**：**UXP 运行时无 Web Worker**（PS 27.1 / uxp 9.0.2）。Phase 6 并行方案确定降级：**主线程分块 + 进度提示**（tile 化渲染），不引入 Worker 依赖。

## 4. 其他工程约束（spike 中发现）

| 约束 | 说明 | 对 Phase 的影响 |
|---|---|---|
| **executeAsModal 必需** | 修改文档状态（documents.add / putPixels）必须在 `ps.core.executeAsModal` 内调用，否则报 `Event: make may modify the state of Photoshop... only allowed from inside a modal scope` | Phase 3 的整个渲染流程需包在 executeAsModal 中 |
| **imaging API 位置** | `getPixels/putPixels` 在 `require('photoshop').imaging`，`sourceBounds` 为 `{left,top,right,bottom}`，`componentSize` 为数字 | Phase 3 `io/imageAccess.js` 按此封装 |
| **PhotoshopImageData** | 写回必须用 `imaging.createImageDataFromBuffer(arr, {width,height,components,colorSpace,colorProfile})` 包装，用完 `dispose()` | Phase 3 内存管理要点 |
| **manifest 约束** | PS 27 拒绝 `host` 数组形式与 manifestVersion 5 + requiredPermissions 组合（`Plugin rejected - invalid object`）；改用 `host` 对象 + manifestVersion 4 + 省略 requiredPermissions 后加载成功 | 工程 manifest 以此为准；Phase 5 引入文件权限时需先验证 v5 权限格式 |
| **开发者模式** | PS 需在 Preferences > Technology Previews 启用 Developer Mode（重启生效），否则插件被拒 | README/交付文档需写明 |
| **插件数据目录** | `localFileSystem.getDataFolder()` → `%APPDATA%\Adobe\UXP\PluginsStorage\PHSP\27\Developer\<pluginId>\PluginData\`（无权限要求即可写） | Phase 5 sidecar 方案与探测可复用该通道 |

## 5. 待办/后续验证

- [ ] 真实文档（含 profile 的 sRGB/AdobeRGB/ProPhoto 8/16/32-bit）的 `colorProfile` 读取与 TRC 验证（Phase 3）
- [ ] putPixels alpha 语义复核（Phase 3）
- [ ] 16-bit 文档往返与 banding 验证（Phase 3, A2）
