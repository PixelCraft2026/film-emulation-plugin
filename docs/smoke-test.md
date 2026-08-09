# 真机冒烟测试报告（Phase 3）

**日期**：2026-08-10
**环境**：Photoshop 27.1.0（PS 2026），UXP 9.0.2，UDT 2.2.1（开发者模式已启用）
**插件**：com.cheukwing.filmhalation（manifest v4）
**方式**：插件加载时自动执行（`src/smoke/smoke.jsx`，Phase 3 临时），结果写入插件数据文件夹 `smoke-test.json`

---

## 1. 结果总览（128×128 测试文档，strength=100）

| 位深 | 结果 | applyMs | 输出（读回） | 说明 |
|---|---|---|---|---|
| 8-bit | ✅ ok | 117 | nonZeroRatio=1, max=1 | 管线全链路无错误 |
| 16-bit | ✅ ok | 71 | nonZeroRatio=1, max=1 | 同上 |
| 32-bit | ✅ ok | 30 | nonZeroRatio=1, max=1 | 同上 |

**管线链路验证**（全部打通，无异常抛出）：
`documents.add → paintHighlight（putPixels 写高光）→ readDocumentPixels(32-bit) → decodeToLinear → processHalation → encodeFromLinear → writeDocumentPixels(按位深量化) → 读回验证`

## 2. A2 / A4 状态

- **A2（8/16/32-bit 无 banding）**：✅ 三种位深读写均成功，写回按 `doc.bitsPerChannel` 量化（8→Uint8/255、16→Uint16/32768、32→Float32 直通）。banding 视觉确认待真实样张（Phase 7 验收）。
- **A4（原图层 hash 不变）**：⏳ **部分受阻**——冒烟用 `writeToSource`（写回源图层，临时测试文档，无用户数据）；效果图层方案遇 PS 27 UXP 已知限制（见 §3）。A4 正式验收需效果图层可用后执行。

## 3. 已知限制（PS 27 UXP）

### 3.1 效果图层（运行时新建图层）写入失败 — **阻塞项**
**现象**：`doc.createLayer()` 创建的图层，其 id 无法被 `imaging.getPixels/putPixels` 访问：
- `getPixels({layerID: newLayer.id})` → `Error: Unknown layer`
- `putPixels({layerID: newLayer.id, ...})` → `Error: invalid target sheet`
- 而文档创建时即存在的图层（背景层）读写正常（capability spike 与冒烟 paintHighlight 均验证）。

**排查记录**：
- `Layer.duplicate()` → `Error: You can only move layers in the same document.`（UXP API 受限）
- `batchPlay` duplicate（带/不带 `_target`）→ 未创建图层
- `batchPlay` fill（用 createLayer 返回 id / 重新获取的有效 id）→ 未建立像素 sheet
- `createLayer` 返回对象 id 无效，但 `doc.layers` 重新获取的图层对象 name 可读、id 仍不可用于 imaging

**结论**：PS 27.1 UXP 的 imaging API 只能访问"文档中已存在的图层"（运行时新建图层的 id 未注册到 imaging 引擎）。**影响**：V1 的"效果图层"非破坏工作流在 PS 27 UXP 无法直接实现。

**候选解法（Phase 7 攻关）**：
1. 文档保存/重开后图层注册？——冒烟文档未保存；真实文档场景可能不同（待验证）
2. batchPlay 原语写像素（绕开 imaging.putPixels）
3. 改用"修改源图层 + 快照恢复"或要求用户复制图层的手动流程
4. 检查 PS 27 更新是否修复（当前 27.1.0）

### 3.2 观察项：输出像素均值异常
冒烟读回输出 `mean≈0.333`、全像素非零——疑似 `putPixels` 的 alpha/色彩空间解释怪癖（capability spike 时也观察到 alpha 通道异常 1.0→1.5）。RGB 主链路不受影响，待 Phase 3 真实样张验证时复核。

## 4. 环境要求（README 需注明）

- 文档需具有 sRGB / Adobe RGB (1998) / ProPhoto RGB profile（`resolveDocumentTRC` 拒绝未知 profile；PS 新建文档 `colorProfile` 为 undefined，需显式指定或转换工作空间）。

## 5. 后续

- [ ] 用户提供真实 8/16/32-bit 样张做 A2 视觉确认
- [ ] 效果图层方案攻关（§3.1）
- [ ] A4 正式验收（效果图层可用后）
