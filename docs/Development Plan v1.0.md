# Development Plan v1.0

**项目**：Film Halation — Photoshop 胶片模拟插件（V1.0）
**依据**：`docs/PRD.md`（v1.0，Draft）、`docs/TDD.md`（v1.0，Draft）
**用途**：指导后续分阶段开发（每 Phase 独立可测、可提交）
**冲突裁决**：与 PRD/TDD 冲突处，以 PRD 为准（沿用 TDD 约定）

---

## 第一部分：开发计划说明

### 1. 项目目标

**MVP 目标**：交付一款可在 Photoshop 2021+（UXP）运行的 Film Halation 插件——从文档图层取数，经 linear 域的「高光提取 → 指数扩散 → red shift → additive 混合」算法链路，生成独立效果图层，并以 sidecar JSON 保存参数实现近似非破坏工作流；满足 PRD §3.3 的 A1–A6 全部验收标准。

**V1 范围（In Scope，来自 PRD §3.1）**：
- Film Halation 完整算法链路（linear 化 → 高光提取 → 指数扩散 → 红色偏移 → additive 混合 → tone mapping）
- UXP 面板：`Strength` 滑块 + 降采样实时预览（fast 模式）
- Apply：生成效果图层 + sidecar JSON 参数持久化（含 fallback 层级）
- 8 / 16 / 32-bit 文档支持，working space 线性化（含 profile 检查闭环）
- 扩散双模式：quality（有限卷积）/ fast（IIR + 5σ 截断）
- 参数：Strength 可见；Sigma / Threshold / Threshold Softness / Background Threshold / Red Shift / Global Diffusion / Center Attenuation / Blend Mode / Diffusion Mode / Sigma Ratio 高级隐藏（PRD §4.2 全集）

**明确不包含（Out of Scope，来自 PRD §3.2）**：
- Film Grain、Film Curve、Bloom、Color Negative、Gate Weave、Dust
- Film Stock Preset 库（仅预留 `profile` 参数骨架，无 UI）
- 自定义 Smart Filter 注册（C++ SDK 远期）
- GPU 加速（v1 CPU 达标即可，架构预留）
- 批处理 / 动作（随 PS 命令可录制能力免费获得）

### 2. 开发阶段划分

依赖总览：Phase 0 → 1 → 2 → 3 → 4/5（4 与 5 可部分并行，5 依赖 4 的集成点）→ 6 → 7。各 Phase 与 TDD 验证项（V-1~V-6）挂钩，不确定项前置验证，避免返工。

1. **Phase 0：开发环境和 UXP 能力验证**
   - **目标**：解决「UXP 能力边界未验证」的最大未知（TDD R-1/R-2/R-6）：搭建可构建、可加载的工程骨架，并实测 imaging API 性能、32-bit 像素往返、Web Worker 可用性，产出数据供后续 Phase 决策。
   - **技术内容**：npm + TypeScript + esbuild 脚手架；最小 `manifest.json`（panel）+ 空面板；capability probe 脚本（24MP getPixels/putPixels 计时、单次调用尺寸上限、Float32 往返 hash、colorProfile 读取、Worker 探测）。
   - **输入**：PRD/TDD（已完成）；本计划；用户提供 Photoshop + UDT 环境。
   - **输出**：可被 UDT 加载的空面板插件；`docs/capability-report.md`（V-1/V-2/R-6 实测数据）。
   - **修改文件范围**：项目根（`package.json`、`tsconfig.json`、`esbuild.config.mjs`、`manifest.json`）、`src/main.jsx` 最小骨架、`docs/`。
   - **配合事项**：安装并确认 Photoshop 2021+ 与 UXP Developer Tool（UDT）；提供开发基准机配置；允许加载开发版插件（未签名）。
   - **验收标准**：
     - 功能验收：UDT 可加载插件、空面板可打开。
     - 技术验收：esbuild 打包通过、manifest 校验通过、TS 编译无错。
     - 测试验收：capability 报告含 24MP 计时、32-bit 往返 hash、Worker 探测三项结论（对应 R-1/R-2/R-6）。
   - **Git 提交建议**：`chore: scaffold UXP project + capability spike report`

2. **Phase 1：独立 Halation 核心算法库**
   - **目标**：实现 `core/` 纯算法库（零 UXP 依赖、Node 可直测），让算法在接 Photoshop 之前先被数学验证（开发原则 #2）。
   - **技术内容**：`core/params.js`（HalationParams 契约+默认值+校验）；`core/color/trc.js`（sRGB/AdobeRGB/ProPhoto/linear TRC decode/encode）；`diffuse/conv.js`（quality，radius=ceil(3σ) 可调 5σ，重归一化，clamp）；`diffuse/iir.js`（fast，双向一阶 IIR + 5σ 镜像扩展）；`extract.js`（Y/M/S/G：smoothstep + background gating）；`redshift.js`（r⊙D + SigmaRatio）；`composite.js`（Halo=max(D−k·S,0) + Secondary Glare + additive/screen）；`pipeline.js` 编排 + `core/index.js` 唯一出口；`tests/unit/`（T1–T8、C1–C4）+ `tests/golden/` 黄金基准。
   - **输入**：Phase 0 骨架；PRD §5、TDD §5/§7。
   - **输出**：`src/core/` 全量、单测全绿、golden 基准输出。
   - **修改文件范围**：`src/core/**`、`tests/unit/**`、`tests/golden/**`。
   - **配合事项**：无（纯 Node）；可顺手提供 8/16/32-bit 样张供 Phase 2 使用。
   - **验收标准**：
     - 功能验收：`processHalation(input, params)` 完整链路可用，quality/fast 双模式可选。
     - 技术验收：`core/` 无任何 UXP/Photoshop/DOM import（依赖方向检查）；非破坏契约（不改 input.rgb）；HDR 不裁剪。
     - 测试验收：T1–T8、C1–C4 全绿；fast/quality 0–3σ 有效区 L2 < 1e-4（A6 前置，T5）。
   - **Git 提交建议**：`feat(core): params & trc` → `feat(core): exponential diffusion (conv + iir)` → `feat(core): halation pipeline + tests`（可分 3 个 commit）

3. **Phase 2：算法测试工具和视觉验证**
   - **目标**：在 Node 环境完成视觉验证（无需 Photoshop），闭环 V-4/V-5/V-6 并定稿 core 默认值，为 Photoshop 集成锁定算法基线（开发原则 #2、#3）。
   - **技术内容**：`scripts/render.js` 命令行渲染工具（图片 + 参数 JSON → 显示编码 PNG）；四类样张（夜景 V-1 / 太阳高光 V-2 / 窗对比 V-3 / 人像 V-4）；IIR vs conv 视觉对照（V-4）；threshold vs spill 提取 A/B（V-5）；TRC 往返精度复核（V-6）；`docs/visual-validation.md` 验证报告。
   - **输入**：Phase 1 core；用户样张或确认采用合成样张。
   - **输出**：渲染工具、样张集、视觉验证报告与 V-4/V-5 结论（必要时回写 Phase 1 微调默认值）。
   - **修改文件范围**：`scripts/**`、`tests/visual/**`、`docs/`。
   - **配合事项**：提供 2–4 张典型测试图（夜景、人像、强高光、明暗对比）；对渲染结果做主观视觉判断；反馈默认参数手感。
   - **验收标准**：
     - 功能验收：任意样张 + 参数 JSON 可一键渲染输出 PNG；参数可复现。
     - 技术验收：渲染工具确定性、golden 文件版本化入库。
     - 测试验收：V-1~V-4 判据逐条核验（红晕、暗侧可见、指数衰减、无整图红雾）；V-4/V-5 有结论记录。
   - **Git 提交建议**：`test(visual): render tool + sample set + validation report`

4. **Phase 3：Photoshop UXP Image Pipeline**
   - **目标**：打通「Photoshop 文档 → linear → core → 效果图层」闭环，让 io/ 成为唯一接触宿主 API 的层（TDD §3/§4/§10）。
   - **技术内容**：`io/imageAccess.js`（getPixels/putPixels、位深归一化、tile 分块）；`io/colorPipeline.js`（profile 解析 → TRC decode/encode 编排，未知 profile 拒绝）；`io/layerOps.js`（效果图层创建/更新/定位，不依赖图层名）；`io/preview.js`（1024 降采样 + fast 渲染）；`main.jsx` 装配（硬编码参数触发：文档 → 处理 → 效果图层，无 UI）；真机冒烟（A2/A4、C4）。
   - **输入**：Phase 1 core；Phase 0 capability 结论；用户提供 8/16/32-bit 测试图各一。
   - **输出**：`src/io/` 全量、真机冒烟记录 `docs/smoke-test.md`。
   - **修改文件范围**：`src/io/**`、`src/main.jsx`。
   - **配合事项**：在 Photoshop 中运行冒烟测试；提供 8/16/32-bit 测试图；核对 A2（无 banding）与 A4（原图层 hash 不变）。
   - **验收标准**：
     - 功能验收：8/16/32-bit 全流程无错误；效果图层生成、原图层不变（A4）；未知 profile 拒绝并提示。
     - 技术验收：依赖方向正确（core 未接触 UXP）；32-bit 非 linear 文档正确 TRC decode（C4）。
     - 测试验收：A2 通过；32-bit >1 值往返 hash 对比通过（V-2 复核）。
   - **Git 提交建议**：`feat(io): photoshop image pipeline + smoke test`

5. **Phase 4：插件 UI**
   - **目标**：Spectrum UXP 面板完整交互：Strength 实时预览 + Advanced 折叠 + Apply（TDD §8、PRD §4）。
   - **技术内容**：`ui/panel.jsx`（布局：Basic + Advanced 折叠 + Apply + 状态行）；`ui/controls/`（滑块/数字输入/下拉，与单一 HalationParams 实例双向绑定）；实时预览（debounce ~100ms → preview 管线）；Apply 流程（quality 全分辨率 → 效果图层 → 状态提示）；文档/图层/位深切换事件刷新；`ui/i18n/` 英文文案 + i18n 骨架。
   - **输入**：Phase 3 io/；Phase 1 参数契约。
   - **输出**：功能完整的交互 UI（未做视觉美化）。
   - **修改文件范围**：`src/ui/**`、`src/main.jsx`。
   - **配合事项**：真机操作反馈（滑块流畅度、参数语义是否直观）；预览质量主观判断。
   - **验收标准**：
     - 功能验收：Strength 拖动实时刷新预览；Apply 生成效果图层；全部控件可操作。
     - 技术验收：UI 零算法细节（只持有参数对象）；debounce 生效；渲染期间 Apply 禁用。
     - 测试验收：面板真机冒烟清单全量通过（控件逐项操作无错误）。
   - **Git 提交建议**：`feat(ui): halation panel with live preview + apply`

6. **Phase 5：参数管理和项目保存**
   - **目标**：sidecar JSON 持久化闭环（serializer + Level 1 SidecarStorage + version migration），实现 A5 参数恢复（TDD §9、PRD §2.4）。
   - **技术内容**：`storage/serializer.js`（确定性序列化、NaN/Inf 拒绝、键序规范化、`serialize(parse(json))===json` 往返不变量）；version migration 钩子（v1.0 空迁移路径）；`storage/sidecar.js`（`<文件名>.film.json`，不绑定图层名）；`storage/backends.js`（backend 抽象，Level 2/3 预留）；集成：Apply 写 sidecar、面板打开时载入恢复参数。
   - **输入**：Phase 4 UI（集成点）；core 参数契约。
   - **输出**：`src/storage/` 全量、serializer 单测、真机 A5 验证记录。
   - **修改文件范围**：`src/storage/**`、`src/ui/`（载入/保存集成点）、`tests/`（serializer 单测）。
   - **配合事项**：真机验证「Apply → 重开 → 参数恢复一致」（A5）；测试含特殊字符文件名等边界。
   - **验收标准**：
     - 功能验收：A5 参数恢复一致；preset save/load 往返；migration 空路径可执行。
     - 技术验收：往返不变量成立；storage backend 可替换、算法层不感知。
     - 测试验收：serializer 单测全绿；真机 sidecar 往返通过。
   - **Git 提交建议**：`feat(storage): sidecar persistence + version migration`

7. **Phase 6：性能优化**
   - **目标**：达到 A3（预览 <500ms、渲染 <5s @24MP）与内存 ≤3 份全分辨率缓冲（PRD §7.1、TDD §10）。
   - **技术内容**：内存就地化收口（S→D→Halo 链式复用、M/G 复用单缓冲）；tile 兜底（128–512 行带、边缘重叠 ceil(5σ) 镜像）；worker/行并行（Phase 0 确认可用则接入，否则主线程分块 + 进度条）；增量重算（sigma 不变缓存 S/M/G，只重算扩散与合成）；`tests/bench/` 性能基准脚本（24MP 预览/渲染计时、峰值内存测量）。
   - **输入**：Phase 3/4 全链路；Phase 0 capability 数据。
   - **输出**：`docs/performance.md` 基准报告（达标或降级决策记录）。
   - **修改文件范围**：`src/io/**`、`src/core/**`（就地化）、`tests/bench/**`。
   - **配合事项**：提供 24MP 测试图；在开发基准机运行基准脚本；确认达标或认可降级方案（如预览分辨率降至 768）。
   - **验收标准**：
     - 功能验收：A3 达标（或记录经确认的降级决策）。
     - 技术验收：峰值内存 ≤3 份缓冲（V-3）；worker 可用性结论落地。
     - 测试验收：基准脚本可重复运行、数据入库；A6 复核通过。
   - **Git 提交建议**：`perf: in-place buffers + tile + parallel + benchmark`

8. **Phase 7：视觉调参与发布准备**
   - **目标**：默认值定稿、A1–A6 全量验收回归、文档与 .ccx 打包，交付 V1.0（TDD Phase 5、PRD §3.3）。
   - **技术内容**：视觉调参定稿（strength 映射与 additiveScale=2.0 验证 D-7；gating 软化宽度 s 是否独立参数裁决 D-6；sigma/threshold 手感）；`profile` 参数骨架预留（无 UI，PRD §4.3）；全量验收回归（A1–A6）；README（安装/使用/已知限制：UXP 无 Smart Filter 的非破坏边界）；打包脚本（esbuild 产物 → .ccx 或开发版 zip）。
   - **输入**：Phase 4–6 全部；用户视觉反馈。
   - **输出**：V1.0 发布包、`docs/acceptance.md` 验收报告、README。
   - **修改文件范围**：`docs/`、`manifest.json`、打包脚本、项目根收尾。
   - **配合事项**：逐参数视觉 A/B 验收；确认默认值与发布渠道（UDT 加载 vs 签名 .ccx）。
   - **验收标准**：
     - 功能验收：A1–A6 全部通过；默认值定稿。
     - 技术验收：.ccx 可安装运行；README 完整；`profile` 骨架存在且无 UI。
     - 测试验收：全量回归脚本一次通过。
   - **Git 提交建议**：`release: v1.0.0`（tag）

---

## 第二部分：任务清单

> 每项粒度适合一次 Codex 执行（可独立完成 + 验证 + 提交）。

### Phase 0：开发环境和 UXP 能力验证

- [ ] 确认 Node/npm 环境，安装并验证 Photoshop 2021+ 与 UXP Developer Tool（UDT）
- [ ] 初始化工程：`package.json` / `tsconfig.json` / `esbuild.config.mjs` / `.gitignore`
- [ ] 编写最小 `manifest.json`（panel 声明）与 `src/main.jsx` 空面板
- [ ] 配置 `build` / `test` / `validate` npm 脚本（esbuild 打包 UXP bundle）
- [ ] UDT 加载插件，验证空面板可打开（真机）
- [ ] Spike：24MP getPixels/putPixels 计时与单次调用尺寸上限（V-1）
- [ ] Spike：32-bit Float32 像素往返 hash 一致性 + colorProfile 读取（V-2/R-2）
- [ ] Spike：UXP Web Worker 可用性探测（R-6）
- [ ] 输出 `docs/capability-report.md`（三项实测结论）
- [ ] 完成第一次 commit

### Phase 1：独立 Halation 核心算法库

- [ ] 创建 `src/core` 目录结构（params / halation / color / index）
- [ ] 实现 `core/params.js`：HalationParams 契约 + 默认值 + 校验
- [ ] 实现 `core/color/trc.js`：sRGB / AdobeRGB / ProPhoto / linear decode + encode
- [ ] 实现 `diffuse/conv.js`：有限卷积 + 重归一化 + clamp（quality / golden）
- [ ] 实现 `diffuse/iir.js`：双向一阶 IIR + 5σ 镜像扩展（fast）
- [ ] 实现 `extract.js`：Y / M / S / G（smoothstep + background gating）
- [ ] 实现 `redshift.js`：r⊙D + SigmaRatio 通道扩散
- [ ] 实现 `composite.js`：Halo=max(D−k·S,0) + Secondary Glare + additive/screen
- [ ] 实现 `pipeline.js`（processHalation 编排）与 `core/index.js` 唯一出口
- [ ] 添加 unit test：T1–T8（identity / zero / constant / impulse / golden / spill / redshift / additive）
- [ ] 添加 color test：C1–C4（HDR>1 / negative / profile 往返 / 32bit 非 linear）
- [ ] 生成 golden 基准输出（tests/golden）
- [ ] 完成核心库 commit（可拆 3 个：params+trc / diffuse / pipeline）

### Phase 2：算法测试工具和视觉验证

- [ ] 编写 `scripts/render.js`：图片 + 参数 JSON → 显示编码 PNG（确定性渲染）
- [ ] 收集/合成四类样张：夜景（V-1）、太阳高光（V-2）、窗对比（V-3）、人像（V-4）
- [ ] 建立 `tests/visual` 目录与验证报告模板（参数、输出、判据逐条）
- [ ] 执行 V-6：TRC 各 profile 往返精度复核（C3 口径）
- [ ] 执行 V-4：IIR vs conv 视觉对照 + A6 数值口径复核（质量半径 3σ vs 5σ）
- [ ] 执行 V-5：threshold vs spill 提取 A/B 对照（含 k=0.9 中间态）
- [ ] 输出 `docs/visual-validation.md`（V-1~V-4 判据逐条核验）
- [ ] 按结论微调 core 默认值（如有，回 Phase 1 修订并更新单测）
- [ ] 完成视觉验证 commit

### Phase 3：Photoshop UXP Image Pipeline

- [ ] 实现 `io/imageAccess.js`：getPixels/putPixels 封装 + 位深归一化（8/16/32）
- [ ] 实现 `io/colorPipeline.js`：profile 解析 + TRC decode/encode 编排（未知 profile 拒绝）
- [ ] 实现 `io/layerOps.js`：效果图层创建/更新/定位（不依赖图层名）
- [ ] 实现 `io/preview.js`：1024 最长边降采样 + fast 渲染
- [ ] 实现 tile 分块（行带 + 边缘重叠 ceil(5σ) 镜像）
- [ ] 装配 `main.jsx`：文档 → linear → core → 效果图层（硬编码参数触发）
- [ ] 真机冒烟：8/16/32-bit 各一张全流程无错误（A2）
- [ ] 验证原图层像素 hash 不变（A4）与未知 profile 拒绝
- [ ] 输出 `docs/smoke-test.md` 冒烟记录
- [ ] 完成 image pipeline commit

### Phase 4：插件 UI

- [ ] 实现 `ui/panel.jsx` 布局：Strength + Advanced 折叠 + Apply + 状态行
- [ ] 实现 `ui/controls/` 控件（滑块/数字输入/下拉）与 HalationParams 双向绑定
- [ ] 实现实时预览：debounce(~100ms) → preview 管线 → 面板显示
- [ ] 实现 Apply 流程：quality 全分辨率 → 效果图层 → 状态提示（渲染中禁用 Apply）
- [ ] 实现文档/图层/位深切换事件刷新
- [ ] 添加 `ui/i18n/` 英文文案 + i18n 骨架
- [ ] 真机冒烟：控件全量操作一遍无错误
- [ ] 完成 UI commit

### Phase 5：参数管理和项目保存

- [ ] 实现 `storage/serializer.js`：确定性序列化 + NaN/Inf 拒绝 + 往返不变量
- [ ] 实现 version migration 钩子（v1.0 空迁移路径）
- [ ] 实现 `storage/sidecar.js`：SidecarStorage（Level 1，`<文件名>.film.json`）
- [ ] 实现 `storage/backends.js`：backend 抽象（Level 2/3 预留）
- [ ] 添加 serializer 单测（往返不变量、非法值拒绝、键序规范化）
- [ ] 集成：Apply 写 sidecar；面板打开时载入并恢复参数
- [ ] 真机验证 A5：Apply → 重开 → 参数恢复一致（含特殊字符文件名边界）
- [ ] 完成 storage commit

### Phase 6：性能优化

- [ ] 内存就地化收口：S→D→Halo 链式复用、M/G 复用单缓冲
- [ ] tile 兜底接入渲染路径（128–512 行 + 5σ 重叠）
- [ ] worker/行并行接入；不可用则主线程分块 + 进度条 fallback
- [ ] 增量重算：sigma 不变时缓存 S/M/G，只重算扩散与合成
- [ ] 编写 `tests/bench/` 性能基准脚本（24MP 预览/渲染计时）
- [ ] 峰值内存测量与 ≤3 缓冲验证（V-3）
- [ ] 输出 `docs/performance.md`（A3 达标或降级决策）
- [ ] A6 复核（fast/quality 数值一致性）
- [ ] 完成性能优化 commit

### Phase 7：视觉调参与发布准备

- [ ] 视觉调参：默认值定稿（additiveScale=2.0 验证、gating 软化宽度 s 独立判定、sigma/threshold 手感）
- [ ] 全量验收回归 A1–A6
- [ ] `profile` 参数骨架预留（无 UI，仅默认值组合）
- [ ] 编写 README：安装 / 使用 / 已知限制（UXP 非破坏边界）
- [ ] 配置打包脚本并产出 .ccx（或开发版 zip），安装验证
- [ ] 输出 `docs/acceptance.md` 验收报告
- [ ] 发布 v1.0.0 commit + tag

---

## 第三部分：风险管理

### Technical Risks

| # | 风险 | 风险描述 | 发生概率 | 影响 | 缓解方案 |
|---|---|---|---|---|---|
| TR-1 | **UXP imaging API 限制** | 32-bit getPixels/putPixels 吞吐未知、单次调用尺寸上限未知、Web Worker 可用性未验证（TDD R-1/R-6） | 高（三项均未验证） | 预览/渲染性能目标（A3）不达标；并行方案落空 | Phase 0 前置 spike 实测并写报告；降采样（最长边 1024→768 兜底）+ tile 分块；主线程分块 + 进度条作为 worker 不可用时的 fallback |
| TR-2 | **Photoshop 色彩管理差异** | 32-bit 文档可能携带 TRC（不能假设 32=linear）；16-bit 内部 15+1 编码的 API 表现；>1 值经 putPixels 往返可能被 clamp（TDD R-2） | 中高 | HDR 语义破坏、精度损失、banding（A2 风险） | 显式 profile 解析 + TRC decode/encode（不假设 32=linear）；C3/C4 单测 + 真机 32-bit >1 往返 hash 对比；16/8-bit 写回由 PS dither |
| TR-3 | **大尺寸图片性能** | 24MP 全分辨率 quality 渲染 >5s；单次 getPixels 调用受尺寸限制（TDD R-1/R-3） | 中 | A3 渲染目标不达标 | IIR O(N)（σ 无关）+ 行并行 + tile 分块 + 增量重算；Phase 0 先测吞吐、Phase 6 基准先行；超标时降级预览分辨率并记录决策 |
| TR-4 | **Float32 内存占用** | 峰值 3×288MB ≈ 864MB @24MP，可能触碰 UXP/宿主内存上限（TDD R-3/D-9） | 中 | 崩溃 / OOM | 就地复用（S→D→Halo 链式）控制 ≤3 缓冲；tile 兜底（128–512 行带）；Phase 6 峰值实测（V-3） |
| TR-5 | **算法视觉效果偏差** | fast 3σ 截断与精确核的近端系数差 3–5%；threshold 与 spill 提取形态差异；默认参数手感（additiveScale、gating 宽度、sigma）不符预期（TDD R-4/R-5、V-4/V-5） | 高（主观性强） | A1/A6 验收风险；用户感知偏差 | Phase 2 在 Node 前置视觉验证（不接 Photoshop 即可 A/B）；quality 半径提高至 ceil(5σ) 或统一归一化基准；以 PRD 链路为基线、视觉验证后微调默认值；质量模式兜底 |

---

## 第四部分：开发原则

1. **算法核心与 UXP 完全解耦**：`core/` 零 UXP/Photoshop/DOM 依赖、纯函数、Node 可直测；`io/` 是唯一接触宿主 API 的层；`core/index.js` 为唯一公共出口。
2. **优先验证数学模型，再接 Photoshop**：Phase 1（算法）→ Phase 2（Node 视觉验证）完成前不进入 Phase 3（UXP 集成），未验证项（V-1~V-6）前置。
3. **保持 AlcedoStudio halation 作为 V1 参考基线**：spill 正差、exp 核、redshift (1.0, 0.05, 0.02)、additive（amount=strength/100×2.0）作为数值与视觉对照基准；偏离之处（Background Gating、Center Attenuation、Secondary Glare）按 PRD 语义保留并记录 A/B 结论。
4. **不提前增加高级胶片模拟功能**：Grain / Curve / Bloom / Color Negative / Preset 库仅出现在 storage 扩展位与 roadmap，不进入 V1 实现；`profile` 骨架仅预留默认值组合、无 UI。
5. **每个 Phase 必须可以独立测试和提交 Git**：每个 Phase 有独立验收标准（功能/技术/测试三项）与建议 commit 节点；任一 Phase 结束时代码处于可运行、测试全绿、可回滚状态。
