# Film Emulation 1.6.0（Halation Engine 1.5.1）

Photoshop UXP 胶片模拟插件。当前 1.6.0 包先完成插件身份迁移，面板仍提供 V1.5.1 Halation 引擎；Film Grain 与 Film Resolution/MTF 将在后续 V1.6 功能迭代中加入。V1.5.1 引擎在非破坏性 V1.5 基础上修正夜景弱光源连成红雾、强光源核芯过软的问题，并增加面向无 Remjet 胶片观感的强光邻域扩张、红层长尾和亮度安全色密度合成。

当前正式插件 ID 为 `com.cheukwing.filmemulation`。为避免 UXP 按插件 ID 隔离的旧参数丢失，仓库同时生成仍使用 `com.cheukwing.filmhalation` 的 V1.5.2 迁移桥接包。

## 从旧插件迁移

1. 先安装或加载 `FilmHalation-MigrationBridge.ccx`，它会以旧 ID 更新原插件并继续访问原数据目录。
2. 在面板点击 **Export Migration Package**，保存扩展名为 `.filmemulation-migrate.json` 的文件。
3. 再安装或加载 `FilmEmulation.ccx`。
4. 在新插件面板点击 **Import V1.5 State**，选择刚才导出的文件。
5. 如新插件已有同一文档的参数，默认保留新状态；只有勾选的冲突项才会被旧状态覆盖。

迁移包使用 schema v2 逐项校验、规范化 UTF-8 CRC32、10MB/10000 文档限制及导入回执。损坏文件会被拒绝；单个无效文档不会阻止其余有效文档；旧插件目录和导出文件不会被删除。导入的图层绑定仍须通过现有严格验证，存在歧义时应选择原始像素层并点击 **Rebind Source**。

## V1.5 核心行为

- 在线性 sRGB primaries 中执行光源提取、曝光档位响应、光谱响应、三瓣 PSF、门控和合成。
- Fast 与 Quality 使用同一个核芯/肩部/尾部三高斯 PSF；差异只限数值近似和多尺度精度。
- 光源能量和强光分类都在 Threshold 到数字白点之间重建为 0..1 高光坐标，再由 Source Impact 非线性驱动；刚过阈值的弱光源保持收敛，clipped white 仍能被 Strong Core 识别，HDR 高光从白点继续按曝光档增强。
- Strong Source 和 Strong Core 将强光源从弱窗户中分离，并在强光处降低中心衰减，形成更扎实的橙红核芯。
- Global Source Level 是全局红层扩散的独立重建高光门槛；密集光源采用软饱和聚合，避免窗户阵列无界叠加成红雾。
- 红、绿感光源分别建立，蓝光向红层的泄漏受到限制；Global Diffusion 是独立的宽半径红层扩散，不是白色 Bloom。
- Hue Response 以连续色相曲线调节三个返回光源场：暖白/红/黄更强，严格模式下青/蓝接近零，绿层只在高曝光附近形成橙色核芯。
- 光源色谱与承载背景分开判断：只有色纯度较高的蓝/青发光体进入严格抑制，略偏冷的白光保持正常长波响应；白色或暖色强光落在蓝天/青色背景时，背景的红层余量和已扩散红层能量允许形成红晕，不再被总亮度门控误杀。
- Strong Source Expansion 只允许已通过色谱筛选的强光种子吸收邻近较低亮度的光学 glow；不会让孤立的弱窗阵列或纯蓝/青灯跨过阈值。
- Halation Amplify 在 PSF 之前提高乳剂回射能量；Red Tail 只把深红层的能量从核芯重新分配到肩部/长尾，绿、蓝层仍保持原 PSF。
- Blue Compensation 提高红晕在冷色承载背景上的可见性，但不放松蓝/青发光体的光谱拒绝；Halation Color Density 用不降低线性亮度的方式增强橙红色密度。
- Source Interior Protection 使用 `max(PSF(S)-S,0)` 型外缘残差抑制大面积白色反射面内部的局部红染，并以源场占用、周围亮度和强种子支持区分白衣与紧凑灯芯：暗环境中的冷白灯可保持连续实心 halo，大面积反射面仍只在外缘显色。Neutral 默认开启，No-Remjet 为兼容既有效果保持关闭。
- 新文档默认使用 `Tungsten 800 No-Remjet` 实验性高强度物理预设，目标是白芯、橙红肩和更浓郁的深红长尾，面向 CineStill 800T 式无 Remjet 观感（不是 CineStill 官方预设或色彩配置）；旧文档保持已保存参数。
- 透明度以 RGBA 读取并原样写回；完全透明 RGB 不产生光晕。
- Screen 使用 HDR 安全增益，输入大于 1 时不会被反向变暗。
- 8/16 位写回支持确定性量化抖动和可调胶片肩部；32 位 HDR 保留浮点结果。
- 默认启用多尺度 PSF；相同尺度的宽瓣共享一次降采样/上采样。Rust/WebAssembly 加速低层高斯和 Strong Source Expansion 最大滤波，失败自动回退纯 JavaScript。
- Apply 在渲染前按位深、像素数和可见设备内存执行预检：安全时使用 High Memory 单带路径，超预算时使用 Balanced 重叠分带；控制台输出读取、算法、量化和写回计时。

## 非破坏性工作流

1. 选择原始像素图层。
2. 调整参数；面板使用 1024px Photoshop ICC 底图和缓存的 2048px 原生工作空间效果代理。Threshold/Hue Response 先在高分辨率代理上提取，再把光源场降到 1024px 扩散，避免小灯在提取前被缩图抹除。宽面板使用左参数、右大预览，窄停靠状态自动改为上下布局。
3. 点击 Apply。插件创建独立空白像素效果层，从绑定源层完成整图渲染后只向效果层写入。
4. 后续调参始终重新读取绑定源层并更新同一副本，不会在已处理结果上叠加。

不调用 `layer.duplicate()`：该操作与 Imaging API 在部分 Photoshop/UXP 版本中组合使用会触发剪贴板错误。若 Photoshop 无法创建或寻址独立效果层，Apply 会停止；源层绝不作为写入目标。

智能对象、文本、调整层和组不能直接作为 Imaging API 像素源；请先进入智能对象内容或栅格化为像素层。

## 参数和状态

- Source Softness、Background Softness 与 PSF Smoothness 已分别建模。
- Source Impact 控制曝光响应指数；Strong Source/Strong Core 控制重建高光坐标上的强光分类和核芯密度；Global Source 独立限制全局扩散源。
- Halation Amplify 控制 PSF 前的返回能量；Strong Source Expansion 控制强光对邻近光学 glow 的招募范围；Red Tail 控制红层肩部/长尾分配。
- Blue Compensation 只补偿冷背景可见性；Halation Color Density 只调节亮度安全的红橙覆盖强度。
- Source Interior Protection 控制源体内部保护；1 适合人物白衣、灯箱等大面积高亮边缘，0 保留旧版实心强光核芯行为。
- Hue Response 控制光源色相选择性；0 保持 V1.5 兼容响应，1 使用严格乳剂光谱近似并抑制纯蓝/青 LED。
- Preset 提供 `Tungsten 800 No-Remjet`、`Neutral / Legacy` 和参数修改后的 `Custom` 状态。Neutral 现为克制的通用预设：Sigma 按画面对角线缩放，只保留窄范围强源扩张和短红尾；普通 SDR 窗户不进入全局扩散，明亮高纯度蓝/青灯体受到目标侧保护，避免城市夜景累积成红雾。
- Threshold/Background Threshold 支持 linear 或以 0.18 中灰为基准的 stops；stops 允许负值。
- Red-Layer Threshold Bias 以 0–1 连续混合两条完整光源提取路径：0 为 `BrightnessGate(E)`，逐值保持现有效果；1 为 `RedLayerGate(0.82R+0.16G+0.02B) × RedEmitterConfidence`，使长波强光更容易进入主阈值，同时拒绝高饱和蓝/青 LED。中间值平滑控制两者倾向。
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
npm run package:migration
```

`npm run package` 生成新 ID 的 `dist/FilmEmulation.ccx`。`npm run package:migration` 一次生成 `dist/FilmHalation-MigrationBridge.ccx` 和 `dist/FilmEmulation.ccx`，并保证工作区中的 `dist/main.js` 最终对应新插件导入版。

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
