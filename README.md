# Film Halation 1.5

Photoshop UXP 胶片 Halation 模拟插件。V1.5 将现有实现改造成非破坏性的光谱散射管线，并为后续 Grain、MTF、Bloom、Damage 与 Overscan 建立 effect graph 基础。

## V1.5 核心行为

- 在线性 sRGB primaries 中执行光源提取、光谱响应、双瓣 PSF、门控和合成。
- Fast 与 Quality 使用同一个双高斯 PSF；差异只限数值近似和多尺度精度。
- 红、绿感光源分别建立，蓝光向红层的泄漏受到限制；Global Diffusion 是独立的宽半径红层扩散，不是白色 Bloom。
- 透明度以 RGBA 读取并原样写回；完全透明 RGB 不产生光晕。
- Screen 使用 HDR 安全增益，输入大于 1 时不会被反向变暗。
- 8/16 位写回支持确定性量化抖动和可调胶片肩部；32 位 HDR 保留浮点结果。
- 默认启用多尺度 PSF；可选 Rust/WebAssembly 数值后端，加载失败自动回退纯 JavaScript。

## 非破坏性工作流

1. 选择原始像素图层。
2. 调整参数；拖动期间只生成最长边 1024px 的面板预览。
3. 点击 Apply。插件创建独立空白像素效果层，从绑定源层完成整图渲染后只向效果层写入。
4. 后续调参始终重新读取绑定源层并更新同一副本，不会在已处理结果上叠加。

不调用 `layer.duplicate()`：该操作与 Imaging API 在部分 Photoshop/UXP 版本中组合使用会触发剪贴板错误。若 Photoshop 无法创建或寻址独立效果层，Apply 会停止；源层绝不作为写入目标。

智能对象、文本、调整层和组不能直接作为 Imaging API 像素源；请先进入智能对象内容或栅格化为像素层。

## 参数和状态

- Source Softness、Background Softness 与 PSF Smoothness 已分别建模。
- Threshold/Background Threshold 支持 linear 或以 0.18 中灰为基准的 stops；stops 允许负值。
- schema v2 使用有序 `graph`、格式档案和严格 source/target layer bindings。
- v1 `FilmLab/effects.halation` 文档会迁移成单个 halation 节点；比当前更新的 schema 会被拒绝。
- 参数保存在 UXP PluginStorage。已保存文档按规范化路径精确匹配；未保存文档额外使用 Photoshop document id，避免 Untitled 冲突。

## 构建与验证

```powershell
npm install
npm run typecheck
npm test
npm run build:wasm
npm run build
npm run bench
npm run validate
npm run package
```

`build:wasm` 需要开发机安装 Rust stable 和 `wasm32-unknown-unknown` target；生成的 `assets/film_core.wasm` 会自动复制到 UXP bundle 和 CCX。插件用户不需要 Rust。

## Photoshop 支持

- Photoshop 最低版本：23.3。
- RGB 文档：8/16/32 位。
- 已实现 sRGB、Display P3、Adobe RGB、ProPhoto RGB 和 Rec.2020 的 TRC/primaries 处理；未知或未标记工作空间回退 sRGB 并提示。
- 运行时写入和性能仍必须按 `docs/smoke-test.md` 在真实 Photoshop 中验收；Node 测试不能替代宿主层验证。

## 后续路线

- V1.6：曝光/密度相关 Film Grain 与 Film Resolution/MTF。
- V1.7：独立 Bloom、Defringe、亮部保护。
- V1.8：Film Damage 与 Vignette。
- V1.9：Overscan 与 Film Gate。
- V2.0：统一 FilmLab 效果图、格式档案和物理效果预设。

颜色预设在插件外先应用。插件内固定物理顺序为：

`Defringe → Vignette → Halation → Bloom → Highlight Protection → MTF → Grain → Damage → Overscan`

静态插件不计划加入 Film Breath 或 Gate Weave。
