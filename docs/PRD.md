# Film Halation — 产品需求文档（PRD）

| 项目 | 内容 |
|---|---|
| 产品 | Photoshop 胶片模拟插件（Phase 1: Film Halation） |
| 版本 | 1.0 |
| 状态 | Draft（待评审） |
| 作者 | 产品经理 / 图像算法负责人 |
| 关联文档 | `docs/architecture.md`（技术架构）、`docs/math.md`（公式推导） |

---

## 1. 产品概述

### 1.1 产品定位

> 面向摄影师、调色师、电影后期人员的 **Photoshop 胶片成像过程模拟插件**，第一阶段实现 Film Halation（胶片卤化光晕）。

本插件**不是**"视觉效果插件"（Glow / Bloom / 特效辉光），而是**胶片成像过程模拟插件**：模拟的对象是胶片本身的物理成像环节——乳剂内部光散射、防光晕层（anti-halation layer）反射、红色波长偏移——从而让数字图像呈现出胶片特有的、物理上成立的光晕形态。

### 1.2 解决什么问题

1. **数字传感器天然没有 halation**：halation 是胶片独有现象（Wikipedia 已明确：模拟胶片成像时须在后期模拟），数字素材需要后期工具还原。
2. **Photoshop 自带 Glow / Bloom 物理不成立**：它们产生中性色柔光，与胶片"红光回射乳剂层"的机理无关，调不出胶片质感。
3. **AI 滤镜不可控**：参数不可解释、结果不可精确复现、不支持 16/32-bit 精度工作流。
4. **现有专业方案门槛高**：Dehancer 等为订阅制且绑定自身生态；本插件以轻量、透明参数、买断式路径切入。

### 1.3 与 Photoshop 自带 Glow / Bloom 的区别

| 维度 | Photoshop Glow / Bloom | 本插件 Film Halation |
|---|---|---|
| 光晕颜色 | 中性色（随高光色） | **红 / 暖色偏移**（redshift 通道增益） |
| 作用范围 | 全图高光扩散 | **仅高光能量源**（阈值提取后扩散） |
| 亮度衰减模型 | 高斯/柔光（无物理依据） | **Beer–Lambert 指数散射** `w(x)=exp(−|x|/σ)` |
| 扩散距离 | 单一模糊半径 | 波长相关（红光散射更远，可选） |
| 物理语义 | 视觉柔化 | 乳剂散射 + 防光晕层反射 |
| 混合方式 | screen / linear dodge | linear 域 additive，物理正确 |

### 1.4 与 AI 滤镜的区别

| 维度 | AI 滤镜 | 本插件 |
|---|---|---|
| 可解释性 | 黑盒 | 每阶段有物理模型与公式 |
| 可复现性 | 参数不可精确复现 | 确定性算法，参数全量可序列化 |
| 精度 | 常为 8-bit 消费级 | 8/16/32-bit 全流程 float 处理 |
| 工作流 | 一次性出图 | 非破坏 + 参数可回读调整 |

### 1.5 参考产品分析

| 产品 | 要点（已验证/待复核） | 对本产品的启示 |
|---|---|---|
| Dehancer | 官方技术文章《Halation and its simulation in Dehancer》已核实（2026-08-09 浏览器实测）：参数体系 = Defringe / Source Limiter / Background Gain / Smoothness / Local Diffusion / Global Diffusion / Amplify / Hue / Blue Comp. / Impact / Mask Mode，8 个 halation profiles；OFX + LR/PS 插件 + 独立版；订阅制 | 借鉴"光源/背景双门控 + 主光晕/二次眩光分层"的参数语义；差异化：轻量、透明参数、非订阅 |
| FilmConvert | 胶片 stock 预设 + 颗粒为核心；插件形态、实时预览、不破坏原始素材 | 验证"stock 预设"方向；本产品预留 `profile` 参数骨架 |
| DxO Nik Collection | 插件套件；在 Photoshop 中作**滤镜/智能对象**使用，非破坏可随时调整（已验证） | 确认非破坏工作流是专业用户基线，本产品沿用效果图层方案 |
| AlcedoStudio | 开源参考实现：spill 正差、exp 核、redshift (1.0, 0.05, 0.02)、additive（已源码级验证） | 采用其物理思想，改进：quality/fast 双模式、threshold-source 提取 |

> ✅ 信息分级（2026-08-09 更新）：Dehancer 参数体系已通过浏览器访问 dehancer.com 官方学习文章《Halation and its simulation in Dehancer》逐项核实（含物理原理与参数语义）；help.dehancer.com 仍不可达，滑块数值区间（如 Local Diffusion 的像素范围）未获取，PRD 以本产品参数为准，不做逐值对标。

---

## 2. 用户工作流程

### 2.1 主流程

```
打开 Photoshop
  → 打开图片 / 选中目标图层
  → 打开插件面板（Film Halation）
  → 拖动 Strength（实时预览刷新）
  → （可选）展开高级参数微调
  → 点击 Apply
  → 生成 "Film Halation" 效果图层，原图不变
  → 再次打开面板可回读参数、调整后重新渲染
```

### 2.2 非破坏性

- **原图层像素永不修改**：所有输出写入独立效果图层 `Film Halation`。
- **参数可回读（sidecar JSON）**：Apply 时参数经 serializer 写入 sidecar JSON（正式方案，见 §2.4）；再次打开面板自动载入，可调整后重渲覆盖效果图层。
- **v1 边界（如实告知用户）**：UXP 无法注册自定义 Smart Filter，做不到 Lightroom 式"像素永不落盘、参数随时回调"；v1 以"预览实时 + 效果图层 + sidecar 参数"实现近似非破坏。

### 2.3 Smart Object 支持

| 场景 | v1 支持 |
|---|---|
| 对 Smart Object 内容图层应用 | ✅ 渲染为 SO 内部新像素图层，SO 智能对象性质保持 |
| 作为可调参数的非破坏 Smart Filter | ❌ 需 C++ SDK，列入远期路线 |

### 2.4 参数持久化架构（已决策）

效果参数**不依赖 Photoshop 图层名 / 注释 / document metadata**（用户复制、合并图层、导出 PSD 或跨软件打开都会导致丢失），采用 **sidecar JSON 正式方案**，带分层 fallback：

| Level | 存储后端 | 状态 |
|---|---|---|
| Level 1 | `SidecarStorage` — 与文档同目录的 `<文件名>.film.json` | **正式方案（首选）** |
| Level 2 | `LayerAnnotationStorage` — 图层注释 / 图层名编码 | 临时兼容 fallback |
| Level 3 | `PhotoshopMetadataStorage` — UXP document metadata API | 未来可靠时迁移 |

sidecar JSON 定位为**插件项目文件**，可保存完整 effect graph 与 hidden defaults 版本，支撑后续多模块（Halation / Grain / Film Curve / Bloom / Film Stock Preset）：

```json
{
  "plugin": "FilmLab",
  "version": "1.0",
  "effects": {
    "halation": {
      "strength": 40,
      "sigma": 12,
      "threshold": 0.7,
      "redshift": [1, 0.05, 0.02]
    }
  }
}
```

**架构分层**（算法层不依赖存储方式）：

```
core/ effect params
      ↓
serializer（JSON 序列化 + version migration）
      ↓
storage backend（可替换）
  SidecarStorage / PhotoshopMetadataStorage / LayerAnnotationStorage
```

**MVP 范围**：不要求完整自动恢复；优先验证 ① effect parameter serialization ② preset save/load ③ version migration。

---

## 3. MVP 范围（Phase 1）

### 3.1 包含（In Scope）

- Film Halation 完整算法链路：linear 化 → 高光提取 → 指数扩散 → 红色偏移 → additive 混合 → tone mapping。
- UXP 面板：`Strength` 滑块 + 降采样实时预览（fast 模式）。
- Apply：生成效果图层 + sidecar JSON 参数持久化（含 fallback 层级，见 §2.4）。
- 8 / 16 / 32-bit 文档支持，working space 线性化（含 profile 检查闭环）。
- 扩散双模式：quality（有限卷积）/ fast（IIR + 截断）。
- 参数：Strength（用户可见）；Sigma / Threshold / Background Threshold / Red Shift / Global Diffusion / Blend Mode 等（高级，默认隐藏）。

### 3.2 不包含（Out of Scope）

- Film Grain、Film Curve、Bloom、Color Negative、Gate Weave、Dust（见 §9 路线图）。
- Film Stock Preset 库（v1 仅预留 `profile` 参数骨架，无 UI）。
- 自定义 Smart Filter 注册（C++ SDK 远期）。
- GPU 加速（v1 CPU 即可达标；架构预留）。
- 批处理 / 动作：随 PS 命令可录制能力免费获得，不单独开发。

### 3.3 MVP 验收标准

| # | 验收项 |
|---|---|
| A1 | 夜景点光源样张：halation 呈红色、紧贴高光边缘、仅在暗背景侧可见、无整图红雾（fast 模式 5σ 截断生效） |
| A2 | 8/16/32-bit 各一张测试图全流程无错误、16/8-bit 写回无可见 banding |
| A3 | 24MP 图：预览 < 500ms，最终渲染 < 5s（开发基准机） |
| A4 | Apply 后原图层像素 hash 不变（非破坏验证） |
| A5 | sidecar 参数序列化往返：Apply → 重开 → 参数恢复一致（MVP 至少验证 serialization / preset save-load / version migration，见 §2.4） |
| A6 | `diffusionMode=fast` 与 `quality` 在 0–3σ 范围内数值一致（L2 误差 < 1e-4） |

---

## 4. 用户参数设计

### 4.1 基础模式（默认仅此一项）

| 参数 | 范围 | 默认 | 说明 |
|---|---|---|---|
| `Strength` | 0–100% | 0 | 唯一暴露参数；经 `amount = strength/100 × additiveScale` 映射为混合系数 |

### 4.2 高级模式（默认隐藏，面板可展开）

| 参数 | 范围 | 默认 | 物理语义 | 对标（Dehancer） |
|---|---|---|---|---|
| `Sigma` | 1–100 px | 7.0 | 主光晕扩散半径（乳剂内散射距离） | Local Diffusion |
| `Threshold` | 0–1（linear） | 0.7 | 光源亮度阈值，低于不产生光晕 | Source Limiter |
| `Threshold Softness` | 0–0.5 | 0.1 | 阈值软化宽度（`T1−T0`） | — |
| `Background Threshold` | 0–1（linear） | 0.8 | 背景暗度门控：背景亮于该值则光晕不可见（halation 只在暗背景侧） | Background Gain |
| `Red Shift` | 通道增益 (r,g,b) | (1.0, 0.05, 0.02) | 光晕颜色：r 为红层主能量，g 控制橙色成分（越高越橙） | Amplify + Hue |
| `Global Diffusion` | 0–1 | 0.15 | 二次眩光强度：大 σ 低强度红层反射，暖化中间调与肤色（可关=0） | Global Diffusion |
| `Center Attenuation` | 0–1 | 0.9 | 扣除扩散源能量 `k`，k→1 纯散射层，k→0 退化为 bloom | — |
| `Blend Mode` | additive / screen | additive | 混合方式 | Impact（≈ 不透明度） |
| `Diffusion Mode` | quality / fast | quality | 出图质量模式；预览自动用 fast | — |
| `Sigma Ratio`（波长相关 σ） | (k_R, k_G, k_B) | (1.0, 0.85, 0.7) | 红光散射更远，halo 边缘偏红（可关） | Hue 空间渐变的近似 |

**默认隐藏的理由**：80% 用户只需调 `Strength`；高级参数决定物理正确性，暴露给专业用户（调色师/后期）作为进阶入口。

### 4.3 预设骨架（v1 预留）

`profile` 参数组（如 `Vision3`）在 v1 绑定 redshift / sigmaRatio / sigma 的组合默认值，**不开放 UI**；V2.0 升级为 Film Stock Preset 库。

---

## 5. 胶片模拟方向（算法规格）

### 5.1 物理模型三要素

| 胶片物理现象 | 模拟手段 |
|---|---|
| 乳剂分层成像：蓝（浅）→绿→红（最深）；反射光滤除蓝绿高频、主要回照红色层 | redshift 通道增益 `(1.0, 0.05, 0.02)`（红晕为主，绿/蓝近零） |
| 反射能量强时透入绿色层 → 光晕橙化（近源橙、远处红） | `Red Shift` 的 g 通道（对标 Hue）+ 波长相关 σ 产生空间红移渐变 |
| 防光晕层非绝对黑 → 弱反射二次眩光，暖化中间调与肤色 | `Global Diffusion`：大 σ 低强度红光层（对标 Dehancer Global Diffusion） |
| 光晕仅在暗背景侧可见（强光源衬暗背景） | `Background Threshold` 暗背景门控（对标 Dehancer Background Gain） |
| 乳剂内指数散射衰减（Beer–Lambert） | 指数扩散核 `w(x)=exp(−|x|/σ)`，可分离，双向 IIR / 有限卷积 |
| 片幅影响：16mm 光晕相对大、65mm 相对小 | 路线图：片幅 profile（V2.0 preset 库） |

### 5.2 算法链路（线性域）

```
Input
→ Color Management（getPixels 32f + profile 检查 → Linear RGB，HDR 不裁剪）
→ Highlight Extraction：Y = 0.2126R+0.7152G+0.0722B；M = smoothstep(T0,T1,Y)；S = RGB ⊙ M
→ Background Gating：G = 1 − smoothstep(BT0, BT0+s, Y)；仅暗背景像素承载光晕（对标 Dehancer Background Gain）
→ Exponential Diffusion：D = expBlur(S)
→ Film Spectral Response：redshift ⊙ D
→ Halation Layer：Halo = max(D − k·S, 0)（center attenuation）
→ Secondary Glare：Halo += g·expBlur(S, σ_g·σ)·redshift（大 σ 低强度，对标 Global Diffusion，可关）
→ Blend：O' = O + α·(Halo ⊙ G)
→ Tone Mapping：Linear → 文档工作空间 → 文档位深
```

### 5.3 边界定义：是 halation，不是别的

| 效果 | 特征 | 本产品是否 |
|---|---|---|
| Halation | 红/暖色、仅高光源、紧贴高光边缘、指数衰减 | ✅ 目标 |
| Bloom | 中性色、全高光柔化扩散 | ❌（k→0 的退化形态也不作为默认） |
| Glow | 中性柔光、常作用于暗部提亮 | ❌ |
| Lens flare | 镜头光学鬼影/光斑、几何形状 | ❌ |

**主观验收测试**：夜景街灯 → 期望"灯 → 红晕 → 黑"，红晕宽度与 sigma 匹配、无整图红雾、无中性灰光晕。

---

## 6. 支持格式与色彩空间

### 6.1 位深

| 位深 | 支持 | 处理说明 |
|---|---|---|
| 8-bit | ✅ | 内部仍按 32f 线性处理；写回由 PS 转换 + 可选 dither 抑制 banding |
| 16-bit | ✅ | 同上 |
| 32-bit HDR | ✅ | 线性 Float32 直通，`>1.0` 高光不裁剪 |

### 6.2 色彩空间

| 色彩空间 | 支持 | 说明 |
|---|---|---|
| sRGB | ✅ | 工作空间 TRC 解码 → 线性 |
| Adobe RGB | ✅ | gamma 2.19921875 解码 |
| ProPhoto RGB | ✅ | gamma 1.8 解码 |
| ACES（PS 32-bit） | ✅ | 线性数据直通，无需 TRC 解码 |

**统一原则**：`core/` 只认线性 RGB；所有空间差异在 `io/imageAccess.js`（取数时请求转换或按 TRC 解码）一次解决。

---

## 7. 非功能需求

### 7.1 性能目标（24MP ≈ 6000×4000 基准）

| 指标 | 目标 | 实现手段 |
|---|---|---|
| 实时预览 | **< 500 ms** | 降采样最长边 1024 + fast 模式（IIR O(N)）+ 参数变更增量重算 |
| 最终渲染 | **< 5 s** | quality 模式全分辨率；行并行多线程；IIR 成本与 σ 无关 |
| 内存 | 工作集 ≤ 3 份全分辨率缓冲（≈ 850 MB @24MP 32f） | 控制中间缓冲数量，就地运算 |

### 7.2 兼容性

- Photoshop 2021+（UXP 基线）。
- Windows 10/11 x64、macOS 11+。
- 语言：v1 英文 UI，预留 i18n 骨架（中文跟进）。

### 7.3 质量与精度

- 全流程 float 32，无中间 8-bit 步骤。
- 阈值 / 背景门控 / 扩散 / 混合全部在 linear 域（避免 sRGB 域导致的阈值漂移、σ 随亮度失真）。
- fast 与 quality 在 0–3σ 内数值一致（A6 验收）。
- 16/8-bit 写回 dither，无 banding。

### 7.4 可测试性

- `core/` 零 UXP 依赖纯函数 → Node 单测（DC 增益=1、TRC 往返精度、双模式一致性）。
- 真机冒烟清单：8/16/32-bit 测试图各一。

---

## 8. 技术方案摘要

- 架构：**UXP** 插件；像素经 `imaging.getPixels/putPixels(componentSize:32)` 以线性 Float32 进出；算法核心 `core/` 与宿主解耦（可移植 WASM/C++/Metal）。
- 扩散：指数核，**quality = 有限卷积（radius=ceil(3σ)）/ fast = 双向一阶递归 IIR + 5σ 截断**。
- 非破坏：效果图层 + sidecar JSON（serializer + 可替换 storage backend，见 §2.4）。
- 详见 `docs/architecture.md`。

---

## 9. 后续扩展路线（Roadmap）

| 版本 | 功能 | 说明 |
|---|---|---|
| **V1.0** | Film Halation | 本 PRD |
| V1.1 | Film Grain | 胶片颗粒（含彩色颗粒，luminescence + color grain 分离） |
| V1.2 | Film Curve | 负片特性曲线 / print film LUT（hue-shift 的 tone mapping） |
| V1.3 | Bloom | 独立软光效工具（与 halation 共享扩散基础设施，中性色；可与 halation 叠加成复合光晕，对标 Dehancer Halation & Bloom 组合） |
| V1.4 | Color Negative | C-41 负片反相 + 色罩（orange mask）模拟 |
| V1.5 | Gate Weave / Dust | 机械抖动与脏污模拟 |
| **V2.0** | Film Stock Preset 库 | 全参数绑定的 stock 预设（对标 Dehancer 8 个 halation profiles / FilmConvert），含片幅 profile（8/16/35/65mm 光晕相对大小）；`profile` 骨架正式 UI 化 |
| 远期 | C++ SDK 版 | 自定义 Smart Filter 级非破坏、GPU 加速 |

**排序依据**：halation 打底并沉淀可复用基础设施（线性化、扩散、参数系统）→ grain/curve 构成胶片感核心 → bloom 复用扩散模块 → 预设库收口全参数。

---

## 10. 风险与开放问题

| # | 风险 / 问题 | 影响 | 缓解 |
|---|---|---|---|
| R1 | Dehancer 参数语义已核实（官网文章，2026-08-09）；help.dehancer.com 数值区间仍不可达 | 逐值对标不精确（不影响算法正确性） | 对标定位为"语义级"；实现以本 PRD 参数为准 |
| R2 | ~~UXP metadata 写能力未验证~~ **已决策**：sidecar JSON 正式方案 | 无（决策闭环） | Level 1 sidecar JSON → Level 2 图层注释 fallback → Level 3 UXP metadata API（未来迁移）；storage backend 抽象可替换，算法层不感知 |
| R3 | UXP 32-bit getPixels 性能 | 预览/渲染目标达标风险 | 降采样 + 分块读取；超标则降级预览分辨率 |
| R4 | Smart Object 内部图层处理边界 | 用户预期落差 | 真机测试清单覆盖 SO 场景；文档明示 v1 边界 |
| R5 | fast 模式截断是否产生可见过渡 | 验收 A1 风险 | 5σ 截断权重 <0.7%，跳变不可见；质量模式兜底 |

---

## 11. 术语表

| 术语 | 定义 |
|---|---|
| Halation | 胶片卤化光晕：强光穿透乳剂后经防光晕层反射回红色乳剂层产生的红晕 |
| Anti-halation layer | 防光晕层：乳剂底部的吸光层，未完全吸收的光反射回乳剂产生 halation |
| Bloom / Glow | 中性色柔光扩散效果（视觉特效，非胶片物理） |
| UXP | Adobe 现行插件架构（HTML/JS + manifest） |
| IIR | 无限冲激响应递归滤波（本产品中实现指数核的 O(N) 方法） |
| TRC / EOTF | 色调响应曲线 / 电光转换函数（gamma 解码） |
| Source Limiter / Background Gain | Dehancer 参数：光源亮度阈值 / 背景暗度门控（本产品对应 Threshold / Background Threshold） |
| Global Diffusion | 二次眩光：防光晕层弱反射的低强度大范围红晕，暖化中间调与肤色 |
| Local Diffusion | Dehancer 参数：主光晕扩散半径（本产品对应 Sigma） |
| Working space | Photoshop 文档工作色彩空间（sRGB / Adobe RGB / ProPhoto RGB） |
