# Film Halation — Photoshop UXP Plugin (V1.0)

胶片感红色光晕（halation）模拟插件。基于线性域的「高光提取 → 指数扩散 → 红色偏移 → additive 混合」算法链路（PRD §5 / TDD）。

## 功能

- **实时预览**：面板内显示（1024 降采样 + fast 扩散 + 增量重算），不触碰文档
- **Apply**：全分辨率渲染写入效果图层（见「已知限制」）
- **参数**：Strength（Basic）+ Advanced（sigma / threshold / background gating / red shift / glare / blend / diffusion）
- **参数持久化**：PluginStorage document-state cache（同机器跨会话恢复）

## 安装（开发模式）

1. 启用 Photoshop 开发者模式：Preferences → Technology Previews → Enable Developer Mode（重启生效）。
2. 使用 **UXP Developer Tool**：Add Plugin → 选择本目录 `manifest.json` → Load & Watch。
3. 打开 PS 的 Plugins → Film Halation 面板。

## 从源码构建

```bash
npm install
npm run build     # esbuild → dist/main.js
npm test          # 单元测试（26 项）
npm run bench     # 24MP 性能基准
npm run package   # 产出 dist/FilmHalation.ccx
```

## 使用

1. 打开带 sRGB / Adobe RGB (1998) / ProPhoto profile 的文档（未知 profile 会被拒绝）。
2. 面板中调整 Strength 实时预览。
3. Apply：生成 "Film Halation" 效果图层（内容为纯效果，叠加在源图层上方）。

## 已知限制

- **A4（源图层不变）受限**：Photoshop 27 UXP 的 imaging API 无法访问运行时新建图层（报 Unknown layer / invalid target sheet）。V1 的 Apply **临时写回源图层**（可 Ctrl+Z 撤销）；效果图层方案待解决（候选：batchPlay 写像素、PS 更新、用户复制图层工作流）。
- **参数缓存 machine-local**：存在插件数据目录（`%APPDATA%\Adobe\UXP\PluginsStorage\...`），文档移动/改名后可能需重新关联；不支持跨机器同步（XMP metadata 为未来增强方向）。
- **quality 模式较慢**：24MP 约 20s（可选高精度）；默认 fast（约 3.5s）。
- 文档需具有受支持的色彩 profile（未知 profile 拒绝，避免色彩错误）。

## 文档

- `docs/PRD.md` — 产品需求
- `docs/TDD.md` — 技术设计（含 Parameter Persistence 决策：PluginStorage）
- `docs/Development Plan v1.0.md` — 开发计划
- `docs/capability-report.md` / `smoke-test.md` / `visual-validation.md` / `performance.md` / `acceptance.md` — 各阶段验证报告
