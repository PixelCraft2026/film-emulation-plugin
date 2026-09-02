# Film Emulation V1.7 Public Beta 1（package 1.7.0 / Halation Engine 1.5.1）

Photoshop UXP 胶片模拟插件。当前 npm/package 与 manifest 身份为 1.7.0，公开名称为 `Film Emulation V1.7 Public Beta 1`。本次公开 Beta 明确为 **Windows 测试版**：目标系统为 Windows 10/11，macOS 尚无实机环境，本版本不宣称完成 macOS 支持验证。它包含 Film Resolution/MTF、曝光相关 Film Grain、Defringe、Bloom、Highlight Protection 和通用亮度遮罩。V1.7 graph 使用 schema v2、固定坐标和线性色彩路径；新节点默认关闭。V1.5.1 Halation 引擎继续负责乳剂散射、红层回射、强光源保护和 HDR 安全合成。

Public Beta 1 已接入 PF-7～PF-12A：JS 参考路径、graph/transient 语义、cooperative kernel、step telemetry、确定性 spatial segments、resident frame materialization、热点 traversal/fusion 优化，以及共享 executor/kernel API 的 scalar 与 SIMD resident WASM。公开 Photoshop 包只使用 scalar WASM；SIMD 仍仅用于 Node QA。Public Beta 身份不表示实机矩阵已经完成，Windows 10/11 上的 Photoshop 23.3、物理 16GB 主机及 Photoshop 2024/2026 UDT 仍须继续验收。

产品名、manifest 名和 Photoshop 面板标签统一为 `Film Emulation`，entrypoint 为 `filmEmulationPanel`，插件 ID 为 `com.cheukwing.filmemulation`。这是第一个公开版本；已确认没有外部旧 ID 用户，也不需要导出开发者本机旧状态，因此发布流程只生成 `FilmEmulation.ccx`，不再分发迁移桥。

界面支持中文与英文。首次运行按 Photoshop/系统 locale 选择语言，底栏可即时切换；手动选择保存在插件全局偏好中，不写入文档 schema，也不改变 graph、seed 或图层绑定。

## V1.7 Public Beta 1 功能概览

当前 graph 的物理顺序固定为：

```text
Defringe → Vignette（未来） → Halation → Bloom → Highlight Protection → Film Resolution / MTF → Film Grain → Damage（未来） → Overscan（未来）
```

- 宽面板使用“领域导航—参数—预览”三栏布局；左侧只显示 `Halation`、`Defringe`、`Bloom`、`Resolution`、`Grain` 五个简洁名称，`Highlight Protection` 位于 Bloom 域。按钮只切换参数窗口，不改变物理处理顺序；内部阶段码不再重复显示。窄面板自动切换为上下布局。
- 面板支持中文 / English 即时切换。语言是插件全局偏好，不进入文档参数、graph、seed 或图层绑定；首次运行按宿主/系统 locale 选择。
- 预览提供 Fit 与 100% 两种模式。Halation/Bloom 默认 Fit，Defringe/Resolution/Grain 默认 100%/Actual。100% 使用左右同步的 Source/Preview 原生像素裁片，默认定位图层中央，可拖拽或用方向键检查其他区域；高 DPI 补偿读取 Photoshop `DisplayConfiguration.scaleFactor`（不依赖部分 UXP 版本中恒为 1 的 `window.devicePixelRatio`），使原图像素与物理屏幕像素点对点显示。
- 打开插件或真正切换文档时会载入状态并自动发起一次预览；首次轮询不会把同一文档误判为切换并清空刚生成的图像。渲染期间保留源图/占位图，过期请求不能覆盖新结果。
- Halation 的常用 `Strength`、`Sigma`、`Threshold` 位于 Basic；其余低频控制保留在 Advanced。
- Film Resolution 和 Grain 共享 Super 8、Super 16、Super 35 4-perf、65mm 5-perf 四种格式以及 ISO 25–3200 的物理尺度。默认是 Super 35 4-perf、ISO 250、Negative material。
- Film Resolution 提供非负权重的曝光相关 MTF 损失。`amount=0`、禁用节点或极小 sigma 保持逐浮点样本恒等；RGB 共用同一 PSF，alpha 原样保留。
- Film Grain 使用按完整图像绝对坐标寻址的确定性 hash 场，不依赖 `Math.random()`、时间或分带顺序。相同 seed 在 Preview、Apply、重开、分带以及 JS/WASM 回退时保持同一排列。
- 新文档默认包含六个节点（Defringe、Halation、Bloom、Highlight Protection、Resolution、Grain），只启用 Halation；其余标题旁的开关默认关闭。关闭时节点被跳过，输出逐样本保持不变，同时保留已调参数。读取较早 graph 时，V1.7 节点和 `mask` 只在内存中补齐，用户保存后才写回。
- 每个当前节点都有固定键序的 `mask`。`none` 覆盖整帧；`luma` 按 canonical linear sRGB Rec.709 的 EV 带通、softness 和 invert 生成遮罩。Defringe/Bloom/Highlight Protection 是 V1.7 的 opt-in 节点；非 `none` mask 同样使 graph minimum engine version 为 1.7.0。
- schema 仍为 v2、`plugin="FilmHalation"`；graph 语义版本为 `1.7.0`，Halation 算法常量 `ENGINE_VERSION=1.5.1`，npm/package/manifest 版本为 `1.7.0`，三者分开管理。

详细操作和参数说明见 [Film Emulation V1.7 Public Beta 1 用户手册](docs/FilmHalation_V1.5.1_User_Manual.md)。文件名暂时沿用历史路径，标题和内容以当前 Public Beta 1 为准。

## V1.7 Beta 效果

- **Defringe**：在线性 YCoCg 中只修正 Cg，针对局部紫/绿边缘色差；Y、Co 和 alpha 保持不变。`Amount=0` 或 `Edge sensitivity=0` 是严格恒等。
- **Bloom**：独立提取高光，以 `0.62 / 0.28 / 0.10` 的 core / mid / tail 三瓣 PSF 生成正向 HDR 光能。半径按完整图像对角线和 preview scale 换算；Fast 与 Quality 保持相同瓣、尺度和能量，只改变数值核。`Save lights` 保护源高光。
- **Highlight Protection**：只修改 Bloom 的最终正贡献，不会重复提取或删除 Bloom 节点。它消费最近的前置 `bloomContribution`；没有 Bloom transient 时保持输入不变并给出 `missingBloomContribution` 提示。
- **通用亮度遮罩**：所有当前节点共享 `mode / lowEV / highEV / softnessEV / invert`。加性节点缩放贡献，替换节点混合输入与效果；遮罩不改变 alpha，也不为方便而裁剪 HDR。

V1.7 的 Preview 顺序是 Defringe（显示代理与效果代理同时处理）→ Halation → Bloom/Highlight Protection → Resolution → Grain。默认 Defringe 使用 100%/Actual 检查，Bloom 使用 Fit；其他领域沿用各自的 Fit/100% 习惯。

## 安装身份与首个公开版本

Public Beta 1 只发布 `FilmEmulation.ccx`：`com.cheukwing.filmemulation` / `filmEmulationPanel` / 1.7.0。公开构建没有 `Export Migration Package` 或 `Import V1.5 State` 入口，也不包含旧插件 ID。schema v2 对较早文档状态的解析兼容仍保留，这与 UXP 插件 ID 迁移无关。

标准 CCX 只携带 scalar `film_core.wasm`。虽然 SIMD 工件通过了 Node 固定向量和性能资格门禁，但 Photoshop 27.1 / UXP 9.0.2 实机 A/B 已确认加载当前 SIMD 工件会导致宿主进程退出，因此公开 UXP runtime 不读取、不实例化也不打包 SIMD，`Auto` 在宿主中保持 scalar。

## Halation 1.5.1 核心行为

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
- 新文档默认使用 `CineStill 800T` 实验性高强度物理预设，目标是白芯、橙红肩和更浓郁的深红长尾，面向 CineStill 800T 式无 Remjet 观感（仅为本项目独立模拟，不是 CineStill 官方预设或色彩配置）；旧文档保持已保存参数。
- 透明度以 RGBA 读取并原样写回；完全透明 RGB 不产生光晕。
- Screen 使用 HDR 安全增益，输入大于 1 时不会被反向变暗。
- 8/16 位写回支持确定性量化抖动和可调胶片肩部；32 位 HDR 保留浮点结果。
- 默认启用多尺度 PSF；相同尺度的宽瓣共享一次降采样/上采样。Rust/WebAssembly 加速低层高斯和 Strong Source Expansion 最大滤波，失败自动回退纯 JavaScript。
- Apply 在渲染前按位深、像素数和可见设备内存执行预检：安全时使用 High Memory 单带路径，超预算时使用 Balanced 重叠分带；控制台输出读取、算法、量化和写回计时。底栏的 `Apply memory` 默认为 `Auto (safe)`；若 UXP 无法报告内存而机器确有至少 16GB RAM，可显式选择 `High (16 GB+)`，避免大半径 Halation/Bloom 在多个重叠 band 中重复计算。低内存或不确定时保持 Auto/Balanced。

## 非破坏性工作流

1. 选择原始像素图层。
2. 用左侧领域按钮依次调整 Defringe、Halation、Bloom、Resolution 和 Grain；Highlight Protection 位于 Bloom 域。面板使用 1024px Photoshop ICC 底图和缓存的 2048px 原生工作空间效果代理。Defringe 与高光提取先在对应代理上执行，避免小灯在缩图前后产生不一致。
3. 点击 Apply。插件创建独立空白像素效果层，从绑定源层完成整图渲染后只向效果层写入。
4. 后续调参始终重新读取绑定源层并更新同一副本，不会在已处理结果上叠加。

不调用 `layer.duplicate()`：该操作与 Imaging API 在部分 Photoshop/UXP 版本中组合使用会触发剪贴板错误。若 Photoshop 无法创建或寻址独立效果层，Apply 会停止；源层绝不作为写入目标。

智能对象、文本、调整层和组不能直接作为 Imaging API 像素源；请先进入智能对象内容或栅格化为像素层。

## Preview、Rebind 与性能

- 首次载入或绑定新源时，面板先显示色彩管理后的 1024px 源图，再异步替换为完整 Film graph 结果，避免效果计算期间出现黑色空窗。
- Fit 模式继续使用 1024px 整图和 graph 所需的 2048px 效果代理，并采用速度优先的 Fast 预览；100% 模式只读取当前可见原生裁片及 Defringe/Halation/Bloom 支持边界，不读取或渲染整张大图。发布前再裁回视窗尺寸，并按 Photoshop 显示器 `scaleFactor` 校正 CSS 尺寸，确保一个源图像素对应一个物理显示像素。
- 100% 模式的 Source 与 Preview 使用完全相同的文档坐标。Grain 继续以完整图像绝对坐标寻址，拖动、重新打开和 Apply 不改变颗粒相位。
- 100% 模式的 Source 与 Preview 共用 Photoshop ICC 转换后的 sRGB 显示底板，避免不同位深的原生 profile 标签造成明暗偏移；Defringe/Halation/Bloom 高光处理仍使用原生 profile 数据，Resolution/Grain 使用 Quality/Analogue 路径。五个 UI 领域只提交各自节点的参数，调整 Grain 或 Resolution 不会恢复或改写其他效果。
- 预览 PNG 优先使用 Blob URL，并在完全不透明时输出 RGB PNG，避免大型 Base64 字符串和不必要的 alpha 通道；宿主不支持时自动回退 Data URL。
- 同一源图层且 Photoshop 历史状态未改变时，重复 Rebind 复用源像素和效果缓存，不重复读取或渲染。
- Defringe、Halation 的提取/扩散/合成、Bloom 的高光与 transient、Resolution 的 Gaussian 结果，以及 Grain 的单位方差场分别缓存；缓存键还绑定 mask、profile、graph hash、坐标、generation 与 backend ABI。快速拖动会取消或丢弃过期 generation，旧结果不能覆盖新参数。
- 状态栏显示 `Panel preview total (read ..., render ...)`：`read` 反映 Photoshop Imaging API/ICC 代理读取，`render` 反映算法和预览编码，便于定位真实瓶颈。
- Apply 在创建效果层前完成内存预检；所有 band 成功后才执行一次最终 `putPixels`。任何失败路径都不会把源层作为写入目标。

当前 scalar Node 报告使用 6000×4000、16 位、Quality、Balanced、2 次预热 + 10 次正式测量，并关闭细粒度 resident profiler。2026-09-02 的源码 fingerprint 为 `e1c5592c…`：完整 graph P50/P95 为 29.229/29.858s，峰值 RSS 约 3.01GB，backend 为 `wasm-resident-scalar`，没有 fallback。它与冻结的 `080124b3…` 基线保持相同 checksum `7818973`、graph hash `bfba75d0`、plan hash `65a3921f` 和 scalar WASM SHA-256，说明本轮 UI/发布改动没有改变算法输出。此前 qualified SIMD 的 P50/P95 26.153/26.389s 只作为独立 Node QA 基线保留，不能与新指纹合并宣称重新认证；Photoshop 标准包仍禁止 SIMD。当前 scalar 继续通过 Decision B 的 59.3s 门槛。正式 scalar 结果见 [`tests/performance-data.json`](tests/performance-data.json)，历史 SIMD、资格与 Preview 报告见 [`tests/performance-baselines/pf12-qualified-24mp-simd.json`](tests/performance-baselines/pf12-qualified-24mp-simd.json)、[`tests/performance-baselines/pf12-qualified-24mp-qualification.json`](tests/performance-baselines/pf12-qualified-24mp-qualification.json) 和 [`tests/performance-baselines/pf12-preview-qualified.json`](tests/performance-baselines/pf12-preview-qualified.json)。本轮未重跑 profiler on/off 或 Preview 性能协议；这些 Node 数据也不是 Photoshop 实机计时，不能据此标记 release-ready。

Gate 0 的冻结 HEAD 基线（同一 6000×4000、2+10 协议）单独保存在 [`tests/performance-baselines/0121b64-gate0.json`](tests/performance-baselines/0121b64-gate0.json)，包含 git/WASM SHA-256、dirty 状态和源码 fingerprint。PF-8 报告额外记录 resident step latency、node/phase 归因、读写/卷积访问量、band input amplification、pixel visit factor、RSS/ArrayBuffers 及 allocation/generation；PF-8 阶段归因合计误差为 0%，band input amplification 为 7.86×、pixel visit factor 为 1223.565×。这些数据驱动了下面的 PF-9 stage-local halo segment；算法参数、schema、预设和视觉常数未改变。

PF-9 将图拆为 `Defringe | Halation | Bloom + Highlight Protection | Film Resolution | Grain`，在 segment 内反向累积输入 halo，并将 Grain 的 generated-field halo 隔离；Bloom transient 与 Highlight Protection 保持同一 segment，identity 节点只保留逻辑统计。PF-10 先按内存合法性和 kernel visits 选择 whole-frame/resident-segmented/legacy-banded 候选；resident-segmented 只上传一次 canonical RGB/alpha，使用持久 Frame A/B 和 segment-local frames，所有 core 完成后原子交换并只执行一次最终 `putPixels`。取消不会 fallback 或交换稳定帧，执行错误才从保留的 canonical source 完整 JS 重算。

## 参数和状态

- Defringe：标题旁的开关默认关闭；提供 `Amount`、`Radius`、色度阈值/柔化和 `Edge sensitivity`。只修正局部紫/绿边缘，不改 Y、Co 或 alpha。
- Bloom：标题旁的开关默认关闭；提供高光 `Threshold/Softness`、按画面对角线的 `Radius`、`Amplify`、`Saturation` 和 `Save lights`。其正向贡献单独传给 Highlight Protection。
- Highlight Protection：位于 Bloom 域，默认关闭；只衰减 Bloom contribution 的亮部，不改变源图或其他节点。没有前置 Bloom 时是安全 no-op，并显示缺失提示。
- Film Resolution：标题旁的开关默认关闭；开启后提供 `Material`、`Resolution loss`、`MTF response`、`Shadow loss`、`Highlight loss`。Amount 0–1 从源图混合到目标 MTF，1–1.5 继续过渡到 2.2σ 的宽响应，不产生锐化负瓣。
- Film Grain：标题旁的开关默认关闭；开启后提供 `Material`、`Correlation`、`Amount`、`Size`、`Roughness`、`Chroma` 与 `Randomize grain`。Analogue 使用 fine/medium/coarse 三尺度，Fast 合并 fine/medium 并保留 coarse。
- Film format 与 ISO 是 Resolution/Grain 的共享参数；较小格式和较高 ISO 会得到更明显的颗粒尺度和分辨率损失。
- 所有当前节点仍支持共享 Luma mask，但控件默认收进各模块的 `Advanced`。UI 使用面向结果的命名：普通节点为 `Effect area`，Halation/Bloom 为 `Halation output area` / `Bloom output area`，Highlight Protection 为 `Protection area`。`Entire image` 等于全覆盖；选择 `Exposure range` 后才显示上下 EV 边界、边缘柔化和范围内/外选项。遮罩只缩放该节点的贡献/替换混合，不改变 alpha；Bloom output area 不改变高光源提取。
- Source Softness、Background Softness 与 PSF Smoothness 已分别建模。
- Source Impact 控制曝光响应指数；Strong Source/Strong Core 控制重建高光坐标上的强光分类和核芯密度；Global Source 独立限制全局扩散源。
- Halation Amplify 控制 PSF 前的返回能量；Strong Source Expansion 控制强光对邻近光学 glow 的招募范围；Red Tail 控制红层肩部/长尾分配。
- Blue Compensation 只补偿冷背景可见性；Halation Color Density 只调节亮度安全的红橙覆盖强度。
- Source Interior Protection 控制源体内部保护；1 适合人物白衣、灯箱等大面积高亮边缘，0 保留旧版实心强光核芯行为。
- Hue Response 控制光源色相选择性；0 保持 V1.5 兼容响应，1 使用严格乳剂光谱近似并抑制纯蓝/青 LED。
- Preset 提供 `CineStill 800T`、`Neutral / Legacy` 和参数修改后的 `Custom` 状态。Neutral 现为克制的通用预设：Sigma 按画面对角线缩放，只保留窄范围强源扩张和短红尾；普通 SDR 窗户不进入全局扩散，明亮高纯度蓝/青灯体受到目标侧保护，避免城市夜景累积成红雾。
- Threshold/Background Threshold 支持 linear 或以 0.18 中灰为基准的 stops；stops 允许负值。
- Red-Layer Threshold Bias 以 0–1 连续混合两条完整光源提取路径：0 为 `BrightnessGate(E)`，逐值保持现有效果；1 为 `RedLayerGate(0.82R+0.16G+0.02B) × RedEmitterConfidence`，使长波强光更容易进入主阈值，同时拒绝高饱和蓝/青 LED。中间值平滑控制两者倾向。
- schema v2 使用有序 `graph`、格式档案和严格 source/target layer bindings。
- v1 `FilmLab/effects.halation` 文档会迁移成单个 halation 节点；比当前更新的 schema 会被拒绝。
- 参数保存在 UXP PluginStorage。已保存文档按规范化路径精确匹配；未保存文档额外使用 Photoshop document id，避免 Untitled 冲突。
- 当前公开包可创建、保存并执行 V1.7 graph；标准 Photoshop/UXP bundle 的 `Auto` 固定选择 scalar resident，Node QA 仍可显式加载独立 SIMD 工件。执行失败会丢弃整带结果、从保留的 canonical 输入完整 JS 重算，并在本请求中禁用后续 resident 尝试；取消不会触发 fallback。

## 构建与验证

```powershell
npm install
npm run typecheck
npm run test:quick
npm test
npm run build:wasm
npm run build
npm run qa:simd -- tests/performance-data.json tests/performance-baselines/pf12-qualified-24mp-simd.json tests/performance-baselines/pf12-qualified-24mp-qualification.json
npm run bench
npm run validate
npm run package
```

`npm run test:quick` 是编辑循环用的跨层快速集；`npm test` 仍运行全部单元与数值回归，但默认使用紧凑 dot reporter，失败时再用 `npm run test:verbose` 查看逐项名称。分带接缝、Fast/Quality、迁移上限和 JS/WASM 一致性测试不会从完整门禁中删除。

`npm run package` 生成唯一公开安装包 `dist/FilmEmulation.ccx`。打包脚本会校验 V1.7 Beta 文案，只复制 scalar `film_core.wasm`；迁移桥已退出发布脚本。

`build:wasm` 需要开发机安装 Rust stable 和 `wasm32-unknown-unknown` target；它会生成 scalar `assets/film_core.wasm` 和独立的 Node QA 工件 `assets/film_core_simd.wasm`。`npm run build` 只把 scalar 复制到 UXP bundle，CCX 也只携带 scalar；插件用户不需要 Rust。SIMD 的 capability、ABI/layout hash、固定向量和性能资格仍由 Node QA 保留，但在完成新的 Photoshop/UXP 宿主兼容认证前不得进入标准包或 `Auto`。

`npm run qa:matrix -- --out=tests/qa-matrix-report.json` 运行不含像素的 EA-2 Node 代理矩阵（36 个深度/profile/alpha 组合，逐行覆盖 JS/primitive/scalar，并附 16-bit sRGB forced-SIMD anchor、取消、故障回退和文档切换探针），输出明确列出 Photoshop 2024/2026 UDT、23.3 和物理 16GB 的待测缺口。该 JSON 是本地诊断产物，不属于发布包。

PF-11/PF-12 的 Node 代码门禁中，`npm run build:wasm`、`npm test`、`npm run typecheck`、`npm run validate`、`npm run build`、`npm run qa:matrix`、`npm run qa:simd` 和 `git diff --check` 曾通过；当前源码的正式无 profiler full-graph 24MP 2+10 已通过 Decision B，SIMD 也通过 Node 10% 性能资格门禁。该结论不代表 UXP 宿主兼容：Photoshop 27.1 / UXP 9.0.2 的 A/B 结果要求标准包保持 scalar-only，完整 Photoshop 实机矩阵仍是后续 Beta 门禁。

## Photoshop 支持

- 本 Beta 的已声明测试平台仅为 Windows 10/11；macOS 尚未验证，不纳入 Public Beta 1 的支持声明。
- Photoshop 最低版本：23.3。
- RGB 文档：8/16/32 位。
- 已实现 sRGB、Display P3、Adobe RGB、ProPhoto RGB 和 Rec.2020 的 TRC/primaries 处理；未知或未标记工作空间回退 sRGB 并提示。
- V1.7 的 8/16/32 位、四种 profile、透明边缘、文档切换、取消、失败回滚和 PF-6/EA-2 性能矩阵仍待真实 Photoshop/UDT 验收；Node 测试不能替代 Imaging API、modal scope、色彩 profile、16/32 位写回与 Apply 实机验证。在该矩阵和性能门禁完成前不标记 release-ready。

## 路线状态

- V1.7 Public Beta 1：Film Resolution/MTF、曝光相关 Film Grain、Defringe、Bloom、Highlight Protection、通用 luma mask、transient graph、PF-9 spatial segments、PF-10 persistent resident frames、PF-11 physical fusion/traversal reduction、≤262,144 pixel-visits 的 resident 协作调度和 generation-safe 取消均已实现；Node 24MP Decision B 已通过。PF-12A SIMD 仅保留为 Node QA 工件，标准 Photoshop 包固定使用 scalar。Photoshop 2024/2026 UDT、23.3、物理 16GB、Preview/Apply/cancel 与宿主绝对性能矩阵仍待完成。
- V1.8 以后：Vignette、Film Damage、Overscan 与 Film Gate 尚未实现；本轮不会静默接受这些未来节点。
- V2.0：统一 FilmLab 效果图、格式档案和物理效果预设，尚未开始。

颜色预设在插件外先应用。插件内固定物理顺序为：

`Defringe → Vignette → Halation → Bloom → Highlight Protection → MTF → Grain → Damage → Overscan`

静态插件不计划加入 Film Breath 或 Gate Weave。
