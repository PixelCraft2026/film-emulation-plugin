# AGENTS.md

本文件适用于整个仓库。后续代理在分析、修改、测试、打包或提交前，应先阅读本文件，并把这里的约束视为项目级默认规则。用户在当前任务中的明确指令优先于本文件。

## 1. 项目定位与当前真实状态

这是 Photoshop UXP 静态图像胶片物理效果插件，不是色彩胶片配置工具。输入图像应已完成 RAW 解码、曝光与 Photoshop 颜色预设；插件只负责 Halation，以及后续规划中的 MTF、Grain、Bloom、Damage、Overscan 等非色彩物理效果。

不要把产品版本、算法版本和序列化版本混为一谈：

| 项目 | 当前值 | 约束 |
|---|---|---|
| npm/package 版本 | `1.6.0` | 当前只是 V1.6 身份迁移基础，不代表 Grain/MTF 已完成 |
| 主插件 ID | `com.cheukwing.filmemulation` | V1.6 起固定使用 |
| 主面板名 | `Film Emulation` | 与仓库、README 和正式安装包统一 |
| entrypoint ID | `filmEmulationPanel` | 正式包使用；迁移桥保留旧 ID |
| Halation 引擎 | `1.5.1` | `src/core/film.js` 中的 `ENGINE_VERSION` |
| schema | v2 | `plugin: "FilmHalation"` 保留到 V1.9 |
| 旧 ID 迁移桥 | `com.cheukwing.filmhalation`, `filmHalationPanel`, V1.5.2 | 只能导出旧状态 |
| Photoshop 最低版本 | 23.3 | 不因 WASM 提高最低版本 |

当前 `processFilm()` 只支持 `halation` 节点。遇到 Grain 等未来节点必须明确报错，不能静默丢弃、改版本号或假装执行成功。

## 2. 事实来源与文档边界

按以下顺序判断当前实现事实：

1. 实际源码、测试、`manifest.json` 和 `package.json`。
2. 本文件与根目录 `README.md`。
3. 本机 `docs/` 中的技术路线、PRD、TDD、验收文档。
4. 用户手册只用于解释用户可见行为，不替代源码规格。

除 `docs/FilmHalation_V1.5.1_User_Manual.md` 外，`docs/` 内技术文档是本机内部资料，已被 `.gitignore` 排除。可以按任务需要读取和更新，但不得使用 `git add -f` 把它们上传 GitHub。根目录 `README.md` 和 `AGENTS.md` 属于项目元数据，不受该限制。

公开竞品资料只用于理解功能分类与物理思路。禁止复制 Dehancer、CineStill 或其他竞品的代码、参数表、预设、商标资产和扫描素材；任何相似观感只能由本项目独立算法和合法样本校准获得。

## 3. 目录职责

- `src/core/`：零宿主依赖的纯图像算法。不得导入 UXP、Photoshop、DOM、ICC 或文件系统 API。
- `src/io/`：Photoshop Imaging API、色彩空间、位深、分带、预览与写回。
- `src/storage/`：schema、PluginStorage、旧状态迁移和文档/图层绑定。
- `src/ui/`：Spectrum/DOM 控件、面板预览显示和用户交互。
- `src/main.jsx`：UXP 编排、modal scope、任务取消/去旧、Apply 和迁移入口。
- `native/film_core/`：Rust `wasm32-unknown-unknown` 加速核心。
- `assets/film_core.wasm`：随插件分发的已编译 WASM。
- `tests/unit/`：Node `node:test` 单元和数值一致性测试。
- `tests/bench/`：性能协议。
- `tests/visual/samples/`：固定视觉输入；不要随意替换。
- `dist/`、`node_modules/`、`native/film_core/target/`：生成物或依赖，均不提交。

公共 core API 统一从 `src/core/index.js` 导出。不要让调用方跨层深度导入内部实现，也不要在 serializer、UI 和 graph executor 中分别维护互相矛盾的效果清单。

## 4. 不可破坏的图像与宿主规则

### 4.1 非破坏性

- Preview 只更新插件面板内的 1024px 图像；拖动滑块不得写 Photoshop 主画布。
- Apply 必须从严格绑定的原始像素层重新渲染到独立效果像素层。
- 任何失败路径都不得把 source 当作 target，也不得修改源层像素、透明度或可见性。
- 不调用 `layer.duplicate()` 或剪贴板流程；这些组合曾在 UXP/Imaging API 中触发剪贴板和智能对象错误。
- source binding 的 id、name、token 必须严格验证。失效或歧义时要求 `Rebind Source`，不得按名称猜测。
- target binding 失效时可以创建新的唯一空白效果层，但不得猜测或覆盖不确定图层。
- 智能对象、文本、调整层和组不是直接像素源；应提示用户进入智能对象或先栅格化。

### 4.2 Modal scope 与资源生命周期

- 该项目所支持的 Photoshop/UXP 组合要求 `getPixels`、`putPixels` 和文档修改在 `ps.core.executeAsModal` 的安全范围内执行。
- Imaging API 对象用完立即 `dispose()`，异常路径也必须释放。
- 禁止把昂贵的整图渲染绑定到每个 slider input；交互预览使用缓存和 debounce，过期结果不得覆盖新参数。
- 任何新增长任务都应支持 `AbortSignal` 或等价取消检查。

### 4.3 色彩、位深和 alpha

- core 输入是线性 sRGB primaries、交错 `Float32Array` RGB；TRC/ICC 转换只在 `io/` 层进行。
- 面板 PNG 无 ICC 标签，最终必须编码为 sRGB；Apply 输出才转换回文档 primaries/TRC。
- 面板底图使用 Photoshop ICC 生成的 1024px sRGB 图，效果提取使用最长边 2048px 原生工作空间代理，并走与 Apply 相同的线性化路径。
- 8 位归一化范围为 0–255；Photoshop 16 位写回范围是 0–32768，不是 0–65535；32 位保留 HDR 浮点值。
- 中间 HDR 值不得为了方便裁到 0–1。Screen 合成不能让大于 1 的高光反向变暗。
- RGB 使用 straight alpha。源 alpha 必须逐样本保留；完全透明像素的隐藏 RGB 不得成为光源。
- 未知或未标记 profile 可以显式回退 sRGB并提示，但不得静默套用错误 gamma。

## 5. Halation 算法回归保护

当前权威思路为：

`线性化图像 → 高光/曝光提取 → 红绿感光层与光谱置信度 → 强弱光源分类 → 三瓣多尺度 PSF → 暗侧和源体保护 → 独立 Global Red Diffusion → HDR 安全合成 → rolloff/量化/抖动`

修改算法时必须维持以下行为：

- Fast 与 Quality 使用相同物理 PSF、瓣权重和通道比例，只允许改变数值近似与采样尺度。
- Source Softness、Background Softness 和 PSF Smoothness 是三个不同概念，不得重新耦合。
- `Red-Layer Threshold Bias` 是从 `BrightnessGate(E)` 到 `RedLayerGate(ER) × RedEmitterConfidence` 的连续混合，不要退回二值开关。
- 只抑制高饱和蓝/青 LED；略偏冷的白光仍应产生 Halation。
- 白色或暖色光源位于蓝天/青色背景时，仍应形成红色外晕；背景颜色不能被误当成发光体颜色。
- 蓝色发光体本身不得因邻近白光扩张或 Apply/Preview 色彩路径差异被重新染成红光源。
- 大面积白衣、灯箱和高亮反射面应保护内部颜色，主要在与较暗背景相接的外缘出现红晕。
- 紧凑强灯芯不能形成明显空心环；源本体应保持白色或原色，外围形成橙红肩和深红尾。
- 密集弱窗和小灯不能累积成连续红雾；强光源应比弱光源更扎实、更有冲击力。
- `Neutral / Legacy` 应克制但可见，避免全局红雾和蓝色霓虹染红。
- `Tungsten 800 No-Remjet` 是高强度实验性预设；除非任务明确要求，不要为了修 Neutral 而改变其现有效果。
- `strength=0` 以及未来每个节点效果量为零时必须逐浮点样本恒等。

涉及以上行为时，应补充或更新合成输入测试，并同时检查 Preview/Apply 一致性。不能只凭单张截图调整常数。

## 6. Schema、状态与插件 ID 迁移

- schema v2 使用固定键序、一个 `halation-main` 节点、格式档案和 source/target bindings。
- 继续接受旧 `FilmLab/effects.halation` 状态迁移；高于当前版本或未知节点必须拒绝。
- 重新打开、切换文档和重复 Apply 都必须从 fingerprint 对应的源状态恢复，不能重复烘焙。
- 未保存文档 fingerprint 必须包含 Photoshop document id，避免多个 Untitled 文档冲突。

UXP `getDataFolder()` 按插件 ID 隔离，因此 ID 迁移必须保持双包流程：

1. `FilmHalation-MigrationBridge.ccx`：旧 ID、V1.5.2、`export` 角色。
2. 导出 `.filmemulation-migrate.json`。
3. `FilmEmulation.ccx`：新 ID、V1.6.0、`import` 角色。

迁移协议不得弱化：10MB、最多 10,000 文档、项目内 UTF-8 编码、不依赖 `TextEncoder`、规范化 payload CRC32、逐文档校验、冲突默认保留新状态、CRC 回执阻止重复导入。迁移包不得包含图像像素或可执行内容。

不要只修改 `manifest.json` 的 ID；任何再次改 ID 的方案都必须先处理 PluginStorage 可达性和迁移路径。

## 7. V1.6–V2.0 扩展边界

固定默认物理顺序为：

`Defringe → Vignette → Halation → Bloom → Highlight Protection → Film Resolution/MTF → Grain → Damage → Overscan`

当前下一阶段是 V1.6 Film Resolution/MTF 与曝光相关 Grain。实现未来随机效果时：

- 禁止使用 `Math.random()`、当前时间、band 顺序或 tile 编号作为随机源。
- 随机值必须由固定 seed 和完整图像绝对坐标寻址，使 Preview、Apply、重开、批处理、分带和 JS/WASM 回退一致。
- 只允许降采样扩散/统计场；源 RGB、alpha、最终合成和需要精确定位的遮罩保持正确坐标。
- 格式、ISO 和物理尺寸是共享参数，不得在每个效果中各自维护不一致副本。
- Damage 素材只能使用项目自有、公共领域或明确商业授权内容；禁止运行时抓取未知素材。
- 本路线只处理静态图像，不加入 Film Breath 或 Gate Weave。
- 颜色模拟继续由 Photoshop 预设完成，不在本插件重复实现胶片色彩配置。

内部详细规格位于本机忽略文件 `docs/FilmEmulation_V1.6-V2.0_Technical_Roadmap.md`。若文件不存在，应根据源码和用户指示继续，不得凭空补造竞品参数。

## 8. 性能与内存

- 目标机器为 16–32GB 内存；`auto` 模式在安全时选 High Memory，否则使用 Balanced 重叠分带。
- 当前实现中，16GB 预算约 4GB、24GB 以上约 6GB；未知设备使用保守预算。调整预算时必须同步测试峰值 TypedArray、WASM memory、PhotoshopImageData 和写回 buffer。
- 24MP、16 位默认 Apply 当前允许约十秒量级；V1.5.1 门槛是 P95 不超过 12 秒且相对基线改善。2 秒仍是长期目标，不得通过关闭 Quality、减小默认半径或破坏位深达成。
- 面板缓存后 1024px 算法预览目标 P95 不超过 500ms；首次 2048px Photoshop 读取另行记录。
- 性能测量为 2 次预热、10 次正式测量，并记录 P50/P95、CPU、Photoshop 版本、位深、内存档和峰值内存。
- 优化必须保持全图/分带、Fast/Quality、JS/WASM 在规定误差内一致，并检查 band seam 和底边相位。

## 9. 编码约定

- 项目使用 ES modules、ES2020、JavaScript + JSDoc，TypeScript 只做 `checkJs`；不要无故改写为另一套构建系统。
- 仅宿主兼容文件在确有需要时保留现有 `// @ts-nocheck`，不要把它扩散到纯算法新模块。
- 新 core 逻辑优先写成纯函数，输入明确、无隐式全局状态，Node 可直接测试。
- 保持确定性键序、浮点边界和错误信息；不要静默修正 NaN、Infinity、未知 schema 或未知节点。
- WASM 采用低层 ABI、复用线性内存；初始化或执行失败必须安全回退 JS。
- 新依赖应有明确必要性。运行时用户不应安装 Rust、Node 或下载额外组件。
- 查找文件/文本优先使用 `rg` / `rg --files`。修改前先检查 Git 状态，保留不相关的用户改动。

## 10. 测试与验证

常规代码修改至少执行：

```powershell
npm run typecheck
npm test
npm run validate
```

涉及 bundle/UI 时再执行：

```powershell
npm run build
```

涉及 Rust/WASM 时执行：

```powershell
npm run build:wasm
npm test
```

涉及性能时执行：

```powershell
npm run bench
```

涉及安装包或插件 ID 迁移时执行：

```powershell
npm run package
npm run package:migration
```

并核对：

- 主包 manifest：`com.cheukwing.filmemulation`, V1.6.0, import 角色。
- 桥接包 manifest：`com.cheukwing.filmhalation`, V1.5.2, export 角色。
- 两包都包含 `dist/film_core.wasm`，且迁移代码不出现 `new TextEncoder`。

推荐按改动范围选择重点测试：

- Halation/预设：`halation.test.js`、golden、`lowres.test.js`。
- 色彩/位深：`color*.test.js`、`primaries.test.js`、`bitDepth.test.js`。
- 预览一致性：`preview-source.test.js`、`pngEncoder.test.js`。
- 分带/性能：`tileRender.test.js`、`tiles.test.js`、bench。
- WASM：`wasm.test.js`。
- schema/迁移：`serializer.test.js`、`migration.test.js`、`fingerprint.test.js`。
- 图层安全：`layerOps.test.js`。

Node 测试不能替代 Photoshop 实机验收。涉及 Imaging API、modal scope、色彩 profile、16/32 位写回、透明边缘、文档切换、Apply、Rebind 或文件选择器时，最终报告必须明确标注 UDT/Photoshop 实机测试是否完成；未完成时不得声称 release-ready。

## 11. Git、发布与工作区安全

- 开始工作前查看 `git status`。该仓库可能包含用户尚未提交的实验调整，不得 reset、checkout、覆盖或顺手格式化无关文件。
- 禁止 `git reset --hard`、`git clean -fdx` 和大范围删除。清理生成物时先核对绝对路径，只处理明确可再生目录。
- 未经用户明确要求，不创建提交、标签、发布或推送远端。
- GitHub 远端为 `https://github.com/PixelCraft2026/film-emulation-plugin.git`。
- GitHub 当前 `docs/` 只允许跟踪 `FilmHalation_V1.5.1_User_Manual.md`；不要强制加入内部技术文档。
- `dist/*.ccx` 是本地交付物并被忽略。若用户要求 GitHub Release，需要另行获得明确授权后作为 release asset 上传，不要直接提交到源码树。
- 提交前检查 `git diff --check`、暂存清单和 `git diff --cached --name-only -- docs`。

## 12. 完成标准与交付说明

完成一次修改时，应向用户说明：

1. 实际改变了什么，以及是否影响算法、宿主层、schema、插件 ID 或预设。
2. 执行了哪些自动测试，结果如何。
3. 是否生成 CCX，具体路径和包内身份。
4. 哪些 Photoshop 实机验证仍待用户执行。
5. 工作区中是否保留了未提交或被 Git 忽略的内部资料。

遇到测试与实机截图冲突时，以可复现的 Photoshop 行为为问题证据，但修复必须补充自动化回归；不要通过只调预设掩盖色彩路径、尺度、门控或源层安全问题。
