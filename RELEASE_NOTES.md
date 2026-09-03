# Film Emulation V1.7 Public Beta 1

发布日期：2026-09-03
发布范围：Windows 10/11 测试版
安装包：`FilmEmulation.ccx`

这是 Film Emulation 的第一个公开版本。它已经完成本轮 Windows Photoshop 实机验收，但仍以 Beta 形式发布，用于继续收集不同设备、文档和工作流中的反馈。macOS 尚未实机验证。

## 本版包含

- 中文 / English 双语界面，语言偏好会自动保存。
- Halation、Defringe、Bloom、Highlight Protection、Film Resolution / MTF 和曝光相关 Film Grain。
- `CineStill 800T` 与 `Neutral / Legacy` 两个 Halation 预设。
- Fit 与 100% 检查预览，100% 支持拖动和同步源图比较。
- 非破坏性 Apply：从严格绑定的源像素层重新计算，只写独立效果层。
- 8/16/32 位、常见 RGB 工作空间、透明边缘和 HDR 路径。
- Auto、Balanced 和 High 内存模式；公开包固定使用稳定的 scalar WASM。

## Beta 前已修复

- 修复首次打开或重新载入插件后，预览短暂显示 Rendering 随后黑屏的问题。
- 切换中英文时保留当前模块，并且不重新渲染或改变预览。
- 重新设计底部内存模式与语言菜单，避免选择框铺满面板。
- 将 `Tungsten 800 No-Remjet` 更名为更直观的 `CineStill 800T`。
- 修复 32 位 HDR 预览的色彩异常；面板使用仅供显示的 HDR 到 SDR 映射，Apply 仍保留 HDR 浮点路径。
- 修复 Halation Threshold 在 HDR 右端的突变：高光会随阈值逐步纳入，最右端仍严格不选择任何光源。
- 用户手册中的英文参数名称增加与菜单一致的中文名称。

## 已知问题

- macOS 未验证，不在本 Beta 的支持范围内。
- 智能对象、文字、调整层和组不能直接作为源，需要进入内容或栅格化。
- 32 位 HDR 面板预览是 SDR 显示映射，极端高光可能与 Photoshop HDR 画布的显示观感略有不同。
- 24MP、大半径或完整效果图可能需要数十秒；实际耗时取决于 CPU、内存、位深和参数。
- Film Emulation 不提供胶片色彩 LUT；请先完成 RAW、曝光和色彩调整。

## 安装与升级

双击 `FilmEmulation.ccx` 并通过 Creative Cloud 完成本地安装。第三方 CCX 可能显示未经 Adobe 验证的提示，请只使用项目 GitHub Release 提供的文件。

本版是第一个公开版本，没有外部旧 ID 用户，也不发布迁移桥。更新失败时，请在 Creative Cloud 的 Manage plugins 中卸载旧版，再安装新版。

## 验证状态

- 自动门禁：typecheck、Node 单元/数值测试、manifest validation、bundle、QA 代理矩阵和单包策略均通过。
- Windows 实机：由项目维护者于 2026-09-03 汇总确认完成；未逐项录入独立 PASS 记录。
- macOS：未验证。

### 最终构建指纹

| 项目 | 值 |
|---|---|
| 源码版本 | GitHub 标签 `v1.7.0-public-beta.1`（提交哈希以该标签为准） |
| 源码 fingerprint | `93b34eb61e923f3372ed32398178b1fc2179fc4425e2200a839800df69c282fe` |
| `FilmEmulation.ccx` SHA-256 | `7282ECD05338AA426D5370C256BE4D18F0A23FC3ABD27B3F8A3B9F9FB1636A27` |
| scalar `film_core.wasm` SHA-256 | `94814EFBDB90366778F0DB6921041C888871B25CAAC34DF05C273A756EAB8F7B` |

CCX 包含 `LICENSE`、`manifest.json`、`index.html`、`dist/main.js`、`dist/main.js.map` 和 scalar `dist/film_core.wasm`；不包含 SIMD、迁移桥或旧插件 ID。

### 当前 Node 性能基线

6000×4000、16-bit、sRGB、Quality、Balanced、2 次预热 + 10 次正式测量：

- 默认发布配置 P50/P95：14.935 / 15.126 秒，峰值 RSS 约 2.63GB。
- 完整六节点 graph P50/P95：30.749 / 31.077 秒，峰值 RSS 约 3.01GB。
- 完整 graph 的 1024px 缓存预览 P50/P95：189.8 / 246.4ms；首次未缓存预览为 1017.8 / 1107.1ms。

这些是 Node 回归数据，不是 Photoshop 端到端 Apply 计时；Photoshop 实机结论以维护者的汇总签核为准。

## 反馈

请使用仓库的 GitHub Issue 模板，并提供 Photoshop/Windows/UXP 版本、文档位深与色彩空间、复现步骤、参数和截图。不要上传未获授权或包含隐私的原始照片。
