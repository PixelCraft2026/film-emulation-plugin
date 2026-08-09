# 验收报告（Phase 7，V1.0 发布前）

**日期**：2026-08-10
**范围**：PRD §3.3 验收标准 A1–A6 逐项判定（最终用户视觉确认项已标注）

---

## A1 — 夜景红晕 / 暗侧 / 无整图红雾

| 判据 | 证据 | 判定 |
|---|---|---|
| 高光周围红色光晕 | T4（impulse 红晕存在 R>B 且衰减）+ `tests/visual/output/v1-night-rendered.png`（灯周 R 主导） | ✅ |
| 暗侧保持 | T3（暗常量图不变）+ V-1 判据（距灯 >22px 无污染） | ✅ |
| 无整图红雾 | threshold 提取 S 非零像素仅 0.07%（V-5）+ G gate | ✅ |
| 主观观感 | 渲染样张（`tests/visual/output/*.png`） | ⏳ 用户视觉确认 |

## A2 — 8/16/32-bit 无 banding

| 判据 | 证据 | 判定 |
|---|---|---|
| 三 bit 深度全流程 | 真机冒烟（smoke-test.md）：8/16/32 ok，applyMs 30–117ms | ✅ |
| 精度 | V-6：四种 TRC 往返误差 <5e-16（远优于 8-bit 的 1/255≈3.9e-3） | ✅ |
| 写回量化 | imageAccess 按 `doc.bitsPerChannel` 量化（8/255、16/32768、32 直通） | ✅ |
| banding 视觉 | 8/16-bit 梯度样张目测 | ⏳ 用户真实样张确认 |

## A3 — 预览 <500ms / 渲染 <5s @24MP

| 判据 | 证据 | 判定 |
|---|---|---|
| 渲染 <5s | **fast 3.47s**（bench，A3 决策：Apply 默认 fast） | ✅ |
| quality 模式 | 19.6s（5σ 核；可选高精度，UI 提示更慢） | ℹ️ 记录（非默认） |
| 预览 <500ms | fast + 1024 降采样（Node 侧 <200ms 量级） | ⏳ 真机面板计时待确认 |
| 内存 | V-3：峰值 ≈3 份 3n（732MB @24MP 理论）；tile 兜底（>16MP 自动，quality L2=0） | ✅ |

## A4 — 原图层 hash 不变

| 判据 | 证据 | 判定 |
|---|---|---|
| 源图层不变 | **部分受阻**：PS 27 UXP imaging 无法访问运行时新建图层 id（getPixels/putPixels 均 Unknown layer/invalid target sheet，详见 smoke-test.md §3.1） | ⚠️ 受阻 |
| 临时方案 | Apply 写回源图层（可 Ctrl+Z 撤销）；冒烟 writeToSource 模式 | ℹ️ 替代 |
| 正式验收 | 待效果图层方案（batchPlay 写像素 / PS 更新 / 用户复制图层工作流） | 阻塞项 |

## A5 — 参数往返恢复一致

| 判据 | 证据 | 判定 |
|---|---|---|
| Apply→重开→恢复 | PluginStorage 自检 PASS（strength 77 保存→载入一致，真机 PS 27.1.0） | ✅ |
| 确定性序列化 | S1（serialize(parse(json))===json）+ 键序规范化 | ✅ |
| 限制 | machine-local；文档移动后需重新关联（fingerprint） | 记录 |

## A6 — fast/quality 数值一致性（0–3σ 内 L2 < 1e-4）

| 判据 | 证据 | 判定 |
|---|---|---|
| quality 3σ 口径 | L2 = 9.57e-5 < 1e-4 | ✅ |
| quality 5σ 口径（V1 定稿） | L2 = 1.22e-5（8 倍余量） | ✅ |
| tile 一致性 | quality L2=0；fast 3.4e-6 | ✅ |

---

## 回归基线

- 测试：**26/26 pass，0 fail**（T1–T8、C1–C4、S1–S7、F1–F4、tile×2）
- golden：`tests/golden/halation-default.json`（quality=b47e557d, fast=cc4dedab，与当前实现一致）
- 构建：esbuild 51.7kb + typecheck 零错误

## 已知限制（发布说明）

1. **A4 受阻**：效果图层运行时创建在 PS 27 UXP 不可用（imaging 限制）；Apply 临时写回源图层（Ctrl+Z 可撤销）。
2. 文档需 sRGB / Adobe RGB (1998) / ProPhoto profile（未知 profile 拒绝）。
3. 参数缓存 machine-local（PluginStorage，文档移动需重新关联）。
4. quality 模式 24MP 约 20s（可选高精度）。
5. UXP 无 Web Worker（并行降级为主线程分块）。

## 发布判定

**V1.0 可发布（功能完整），但 A4 记为受限项**——若 A4 为硬性验收，需先解决效果图层方案（见 smoke-test.md §3.1 候选路线）。
