# Film Halation — 技术设计文档（TDD）

| 项目 | 内容 |
|---|---|
| 产品 | Photoshop 胶片模拟插件（V1.0: Film Halation） |
| 文档版本 | 1.0 |
| 状态 | Draft（待评审） |
| 作者 | 首席技术架构师 |
| 上游文档 | `docs/PRD.md`（产品需求，已确认） |
| 关联产物 | `docs/architecture.md`、`docs/math.md`（PRD 引用，本文档合并承载，不再拆分） |
| 约定 | 本文档为 V1 工程实现依据；与 PRD 冲突处**以 PRD 为准**（裁决记录见 Engineering Decisions） |

> 本文档只做设计，不含实现代码。文中出现的 TypeScript 接口、公式、伪代码均为设计契约（specification），供后续工程实现直接落地。

---

# 1. System Overview

## 1.1 插件定位

专业级**胶片成像过程模拟插件**，非 Glow/Bloom 视觉特效滤镜。V1 只实现 Film Halation：模拟胶片乳剂内高光散射、防光晕层（anti-halation layer）反射与红色波长主导的回射，在 linear light 域完成计算，最终以线性 additive 叠加回原图。

## 1.2 整体架构

```
Photoshop
    │
    │ (host process, UXP runtime)
    ▼
UXP Plugin (manifest.json → panel)
    │
    ├── UI Layer           面板（Spectrum UXP 组件）：参数输入、预览显示、Apply
    │
    ├── Image Access Layer io/imageAccess.js：getPixels/putPixels、位深、tile
    │
    ├── Color Pipeline     io/color 侧：文档工作空间 → linear RGB（TRC decode）及反向
    │
    ├── Halation Core Engine  core/：纯算法（提取 → 扩散 → redshift → 合成），零 UXP 依赖
    │
    └── Storage Layer      storage/：document-state cache serializer + 可替换 backend（PluginStorage）
```

## 1.3 UXP 运行环境

- 插件形态：UXP panel（`manifest.json` 声明 `"type": "panel"`），运行于 Photoshop 进程内 UXP runtime。
- 技术边界（V1 如实告知用户，PRD §2.2）：UXP 无法注册自定义 Smart Filter；以「实时预览 + 独立效果图层 + PluginStorage 参数回读」实现近似非破坏。
- 像素访问：`imaging.getPixels / putPixels`（详见 §3）。
- 宿主能力依赖面刻意收窄：算法核心不接触任何 `photoshop.*` 模块（§6），保证可移植与可单测。

## 1.4 数据流

```
Photoshop 文档像素（8/16/32-bit，文档工作空间）
   │  imaging.getPixels(componentSize:32, colorProfile)
   ▼
Float32 RGBA（编码域，值域 [0, +∞)，HDR 不裁剪）
   │  Image Access Layer：RGBA→RGB、profile 解析
   ▼
Float32 RGB（编码域）
   │  Color Pipeline：TRC decode（sRGB / AdobeRGB / ProPhoto / linear）
   ▼
Linear Float32 RGB  ◄── core/ 唯一接受的输入形态
   │  processHalation()：extract → diffuse → redshift → composite
   ▼
Linear Float32 RGB 结果（HDR 可 > 1.0，不裁剪）
   │  Color Pipeline：TRC encode → 文档工作空间
   ▼
Float32 RGBA（编码域）
   │  imaging.putPixels(componentSize:32) → 效果图层 "Film Halation"
   ▼
Photoshop 文档（原图层像素不变，PRD §2.2）
```

## 1.5 模块职责

| 模块 | 职责 | 依赖 | 禁止依赖 |
|---|---|---|---|
| `core/` | 纯算法：TRC 表、指数扩散（卷积/IIR）、halation pipeline、参数契约 | 仅语言标准库 | UXP / Photoshop / DOM |
| `io/` | imaging API 封装、位深/通道布局、tile 分块、效果图层操作、预览降采样 | `core/` | — |
| `ui/` | 面板渲染、控件事件、参数状态、预览展示 | `core/` 参数契约、`io/` 渲染入口 | 算法细节 |
| `storage/` | 参数 ↔ JSON 序列化、version migration、PluginStorage cache 读写 | `core/` 参数契约 | UXP 之外的宿主 |
| `main.js` | UXP entry，装配 io/storage/ui | 全部 | — |

---

# 2. Technology Stack

## 2.1 Plugin Framework：选择 UXP

| 维度 | **UXP（选择）** | CEP | C++ Filter SDK |
|---|---|---|---|
| 架构 | Adobe 现行，HTML/CSS/JS + manifest，进程内 | 遗留 Chromium 内核，需 ExtendScript bridge | 原生插件（.8bi），宿主级 API |
| 像素访问 | `imaging.getPixels/putPixels`，8/16/32-bit float | 经 ExtendScript/AM 通道，慢 | 最强（Direct access, GPU） |
| 非破坏能力 | 无 Smart Filter；效果图层 + PluginStorage 参数回读近似非破坏（PRD §2.2） | 同左（也注册不了 Smart Filter） | ✅ 可注册自定义 Smart Filter（PRD §9 远期） |
| 开发/分发 | npm 工具链，.ccx 分发，迭代快 | 旧工具链，Adobe 已冻结投入 | 原生编译、签名、多平台维护，成本高 |
| 性能 | 中（CPU），可工程化达标（§10） | 低 | 最高 |

**决策理由**：V1 需求（像素级访问、面板 UI、实时预览、参数持久化、8/16/32-bit）UXP 全部覆盖；性能目标（预览 <500ms / 渲染 <5s）通过降采样 + IIR + 分块等工程手段达成（PRD §7.1）；`core/` 保持宿主无关，为远期 C++ SDK 版（PRD §9）保留直接迁移路径。

## 2.2 Language：TypeScript

- 采用 **TypeScript**，编译目标 ES2020（UXP 运行时支持），bundler 用 esbuild。
- 理由：接口即契约（§7 的参数/图像类型直接可执行校验）、重构安全、为 `core/` 的长期演进（grain/curve 模块）提供类型底座。
- 备选：若工具链成为负担，可退化为纯 JS + JSDoc 类型注解（接口不变）。

## 2.3 Testing：Node.js unit test

- 使用 Node 内置 `node:test`（或 Vitest），对 `core/` 直接做单测与 golden 对比（§11）。
- 前提：`core/` 零 UXP 依赖（§6），Node 中可直接 `require` 编译产物。

## 2.4 Build：npm + esbuild

- `npm` 管理依赖与脚本；`esbuild` 打包 UXP bundle（含 `manifest.json` 校验、资源拷贝）。
- 脚本：`build`（打包）、`test`（core 单测）、`test:golden`（黄金对比）、`validate`（manifest/schema 校验）。

---

# 3. Photoshop Integration Design

## 3.1 Image Access

### 3.1.1 imaging API 使用方式

- 取数：`imaging.getPixels({ documentID | layerID, componentSize: 32, colorProfile })` → `{ pixelData: ArrayBuffer, ... }`。
- 写回：`imaging.putPixels({ ... }, pixelData)` → 效果图层。
- 统一策略：**进出均请求 `componentSize: 32`（Float32）**，并显式解析文档 color profile。**任何情况下都不假设 `componentSize=32` 自动等于 linear**——32-bit 文档同样可能携带 TRC（如带 gamma 的 32-bit 工作空间），必须按 profile 做 TRC decode（§4）。

### 3.1.2 位深支持

| 位深 | 取数形态 | 处理 | 写回 |
|---|---|---|---|
| 8-bit | `componentSize:8` → Uint8ClampedArray [0,255] | `/255 → [0,1] → TRC decode → linear` | 由 PS 转换 + dither（PRD §6.1），抑制 banding |
| 16-bit | `componentSize:16` → Uint16Array [0,65535] | `/65535 → [0,1] → TRC decode → linear` | 同上；注意 PS 16-bit 内部 15+1 编码的 API 表现（见 Engineering Decisions 风险 R-3） |
| 32-bit HDR | `componentSize:32` → Float32Array（可 >1） | 按 profile：linear 直通 / 非 linear 则 TRC decode | linear 数据直通，**>1 不裁剪** |

### 3.1.3 Image Access Layer 职责（io/imageAccess.js）

1. **取数**：按文档位深/尺寸选择 tile 分块策略（§10），请求 `componentSize:32`；
2. **归一化**：RGBA → RGB（alpha 分离保留，写回原样）、位深量化 → [0,1]（8/16）或原值（32）；
3. **Profile 解析**：读 `document.colorProfileName` / 模式，映射到已知 TRC（§4.2 表）；未知 profile → 拒绝处理并提示（不静默假设）；
4. **TRC decode**：编码域 → linear RGB（`core/color/trc.js` 纯函数）；
5. **写回**：linear RGB → TRC encode → RGBA → `putPixels`。

**契约**：`io/` 输出（进入 core 的）必须是 **Linear Float32 RGB**；`core/` 只认这一种形态，其他一切（位深、通道布局、profile）都在 `io/` 一次解决（PRD §6.2 统一原则）。

---

# 4. Color Management Architecture

## 4.1 定义

- **输入**：Photoshop 文档像素，处于文档工作色彩空间（含 TRC 编码）。
- **中间表示**：linear RGB（与文档工作空间同基色、linear-light）。Halation 计算**全部在 linear light 进行**。
- **输出**：linear RGB 结果 → TRC encode → 文档工作空间 → 文档位深 → 效果图层。

## 4.2 工作空间 → linear 转换（TRC decode）

| 工作空间 | TRC decode `L = f(E)` | 说明 |
|---|---|---|
| sRGB | `E ≤ 0.04045: L = E/12.92`；否则 `L = ((E+0.055)/1.055)^2.4` | 分段 |
| Adobe RGB | `L = E^2.19921875` | 纯幂 |
| ProPhoto RGB | `L = E^1.8` | 纯幂 |
| ACES（PS 32-bit） | `L = E` | linear 直通 |
| 未知 | 拒绝 + 提示 | 不静默假设（R-2） |

encode 为对应逆函数；8/16-bit 先量化归一化到 [0,1] 再解码；32-bit 按 profile 判定（**不假设 32 = linear**）。

## 4.3 为什么不能在 sRGB/gamma 域 blur 或混合

1. **Jensen 不等式系统性偏亮**：gamma 编码 `E=f(L)` 是凹函数。Blur 是线性算子（均值）。对凹函数，`f(mean(L)) ≥ mean(f(L))`：在 gamma 域做 blur，暗区被系统性提亮、亮区被压缩，等效于"扩散系数随亮度变化"，破坏 Beer–Lambert 指数散射的线性性。
2. **Additive 混合必须是光叠加**：线性域加法是光子能量的叠加；gamma 域相加会错误压缩高光（`(0.9+0.1)` 的物理能量被编回错误的中间值）。
3. **Redshift 是乘性通道增益**：`r ⊙ D` 描述"波长依赖的吸收/反射"，只有 linear 光子通量下才有物理意义。
4. **阈值提取的曝光语义**：Threshold（PRD 默认 0.7）是"乳剂曝光阈值"，必须在 linear 域定义，否则阈值随亮度漂移。

## 4.4 位深与精度

- 全流程 float32 中间表示，无中间 8-bit 步骤（PRD §7.3）。
- 16/8-bit 写回由 PS 负责位深转换 + dither，无 banding（A2 验收）。
- Profile 检查闭环：取数 → 解析 profile → TRC decode → 计算 → encode → 写回；任一环节 profile 未知即中止（R-2）。

---

# 5. Halation Algorithm Design

## 5.0 V1 Pipeline 总览（linear 域，全公式）

以 PRD §5.2 为准的完整链路（`⊙` 表示逐元素/逐通道乘）：

```
输入 O ∈ R^{H×W×3}（linear RGB，HDR 允许 >1）

(1) Highlight Extraction       Y = 0.2126R + 0.7152G + 0.0722B
                               M = smoothstep(T0, T1, Y)          T0=Threshold−Softness/2, T1=Threshold+Softness/2
                               S = RGB ⊙ M                        （光晕源）
(2) Background Gating          G = 1 − smoothstep(BT0, BT0+s, Y)  （仅暗背景承载光晕）
(3) Exponential Diffusion      D = E(S, σ)                        E = 指数扩散算子（§5.2）
(4) Spectral Response          Halo = r ⊙ D                       r = (1.0, 0.05, 0.02)
(5) Center Attenuation         Halo = max(Halo − k·S, 0)          k = CenterAttenuation（spill 语义）
(6) Secondary Glare            Halo += g·E(S, σ_g·σ) ⊙ r          g = GlobalDiffusion, σ_g ≈ 3–5
(7) Composite                  O' = O + α·(Halo ⊙ G)              α = (strength/100)·additiveScale，默认 additive

输出 O'（linear，HDR 不裁剪）
```

## 5.1 Highlight Extraction

### 5.1.1 V1 默认方案（以 PRD 为准）：luminance soft-threshold mask

```
Y = 0.2126·R + 0.7152·G + 0.0722·B          （Rec.709 luma，linear 域）
t  = clamp((Y − T0) / (T1 − T0), 0, 1)
M  = t·t·(3 − 2·t)                           （smoothstep）
S  = RGB ⊙ M                                （逐通道乘 mask）
```

参数：`Threshold`（默认 0.7，范围 0–1）、`ThresholdSoftness`（默认 0.1，即 `T1−T0`，范围 0–0.5）。

**物理意义**：乳剂中只有被充分曝光的区域才产生足量散射光子，阈值即"曝光阈值"；低于阈值不产生光晕（与 Dehancer Source Limiter 语义对标，PRD §4.2）。`smoothstep` 软化阈值边缘，模拟乳剂响应曲线的渐近过渡，避免硬边产生伪影。

### 5.1.2 Background Gating（PRD 链路第 2 步）

```
G = 1 − smoothstep(BT0, BT0 + s, Y)
```

`BackgroundThreshold` 默认 0.8；`s` 为门控软化宽度（V1 复用 ThresholdSoftness 或独立常量，待定，见 Engineering Decisions D-6）。物理：halation 只在**暗背景侧**可见（强光源衬暗背景），背景亮于阈值则光晕被抑制（对标 Dehancer Background Gain）。`G` 在合成阶段逐像素门控（§5.4）。

### 5.1.3 与 Alcedo spill difference 的关系（决策记录）

用户提示词建议 V1 默认 `S = max(blur(O) − O, 0)`（spill 正差，Alcedo 实际实现）。**按"冲突以 PRD 为准"裁决**：V1 默认采用 PRD 的 threshold mask 提取；spill 语义由 §5.4 Center Attenuation 步骤 `Halo = max(D − k·S, 0)`（k=0.9 默认）保留——"扩散后能量扣除源能量"即 spill 正差思想的工程化。两种提取方式的 A/B 视觉对照列为后续验证项（V-5），若 spill 形态明显更优且经评审，可在 V1.x 以参数/默认值切换（不改变接口）。

## 5.2 Diffusion Model

### 5.2.1 核定义

一维指数核（Beer–Lambert 散射，PRD §1.3/§5.1）：

$$w(x) = \exp\!\left(-\frac{|x|}{\sigma}\right)$$

离散化（σ 单位为像素）：`a = exp(−1/σ)`，`w[n] = c·a^{|n|}`，归一化常数 `c = (1−a)/(1+a)` 保证 DC 增益 = 1。

**可分离性**：`w(x,y) = w(x)·w(y)`（乘积核，指数函数性质），二维扩散 = 先沿行、再沿列两次一维扩散，结果精确等价。注：径向核 `exp(−√(x²+y²)/σ)` 不可分离，本设计**不采用**（与 Alcedo 一致）。

### 5.2.2 实现方案比较

| | 方案 A：有限卷积（finite convolution） | 方案 B：IIR 递归（recursive filter） |
|---|---|---|
| 复杂度 | O(N·R)，R=2·ceil(3σ)+1，随 σ 线性增长 | **O(N)，与 σ 无关** |
| 精度 | 截断近似：radius=3σ 时截断能量 ≈ 3–5%（需重归一化补偿） | **对指数核精确**（非近似；高斯核的 IIR 才是近似） |
| 内存 | 需整幅核缓冲（可忽略）与临时图 | 仅需 1 行/列递归缓冲 |
| 边界 | clamp / reflect + 重归一化 | 零初始化 + 镜像扩展（§5.2.4） |
| 实现 | 直接、易测、可作黄金基准 | 需注意递归方向与初始化 |

### 5.2.3 选择与定位（以 PRD 为准：双模式保留）

- **quality 模式（出图默认，PRD §4.2/§8）**：方案 A 有限卷积，`radius = ceil(3σ)`，权重重归一化，边界 clamp（对标 Alcedo）。
- **fast 模式（实时预览，PRD §7.1）**：方案 B 双向一阶递归 IIR + 5σ 边界扩展。
- 架构师建议（记录于 Engineering Decisions）：指数核 IIR 数学精确、O(N)、σ 无关，若 A6 与视觉验证（V-4）通过，后续可将 IIR 提升为唯一生产实现，卷积保留为测试黄金基准。

### 5.2.4 IIR 数学定义（fast 模式）

**forward pass（因果）**：`f[n] = x[n] + a·f[n−1]`，`f[0] = x[0]`

**backward pass（反因果）**：`b[n] = x[n] + a·b[n+1]`，`b[N−1] = x[N−1]`

**合成与归一化**：

$$y[n] = c·(f[n] + b[n] − x[n]), \quad a = e^{-1/\sigma}, \quad c = \frac{1-a}{1+a}$$

推导依据：`f = x ∗ g_f`（`g_f[n]=aⁿ·u[n]`）、`b = x ∗ g_b`（`g_b[n]=a^{|n|}·u[−n]`），且 `g_f + g_b − δ = a^{|·|}`，故上式精确实现 `y = x ∗ c·a^{|·|}`。

**DC 增益验证**：常数输入 `x[n]=1` → `f=b=1/(1−a)` → `y = c·(2/(1−a) − 1) = c·(1+a)/(1−a) = 1` ✓

**二维**：`D = E_cols(E_rows(S))`（顺序可交换），归一化常数取 `c²`（两个方向各一次）。

**边界处理**：有效域外镜像扩展 `E = ceil(5σ)` 像素（reflect 填充），在扩展域上零初始化递归，完成后裁剪回有效域。镜像扩展保证边界处散射连续（图像边缘物体如窗口高光也产生正确光晕），边界外残留误差 `< exp(−5) ≈ 0.67%`（PRD A1 "5σ 截断生效"）。若不做镜像扩展（零边界），图像边缘光晕强度系统性减弱——V1 默认启用镜像扩展。

**退化性质**：σ→0 时 `a→0, c→1, y→x`（恒等），与卷积一致。

### 5.2.5 卷积数学定义（quality 模式）

```
权重      w[t] = exp(−|t|/σ),   t = −R..R,   R = ceil(3σ)
归一化    norm = 1 / (1 + 2·Σ_{t=1}^{R} w[t])        （DC 增益 = 1）
卷积      y[n] = norm · Σ_{t=−R}^{R} w[t]·x[n+t]
边界      clamp（对标 Alcedo）
复杂度    O(H·W·(2R+1))；σ=7 → R=21 → 43 taps/通道/方向
```

### 5.2.6 双模式一致性（A6 验收）

A6（PRD §3.3）：fast 与 quality 在 0–3σ 范围内数值一致（L2 误差 < 1e-4）。**风险点**：卷积 3σ 截断 + 重归一化会使近端系数系统性偏大约截断能量量级（σ=7 时约 3–5%），与 IIR 精确核存在系统性差异，直接影响 A6 达标。**工程对策**（见 Engineering Decisions R-4 / V-4）：将 quality 卷积半径提高至 `ceil(5σ)`（截断 <0.7%）或统一两模式的归一化基准；验收口径以"同 σ、同边界策略、0–3σ 有效区"为准。

## 5.3 Red Shift Model

### 5.3.1 默认增益（PRD §4.2 已确认）

$$H = r \odot D, \qquad r = (1.0,\ 0.05,\ 0.02)$$

即 R 通道全通（主能量），G 保留 5%，B 保留 2%。

**物理解释**：胶片乳剂分层成像——蓝层最浅、绿层居中、红层最深。高光穿透乳剂后经防光晕层反射，回程光先穿过蓝/绿层被大量吸收，主要能量回到红色层 → 红光主导；残余 G/B 贡献暖橙色调，避免纯红（对标 Alcedo redshift 与 Dehancer Hue，PRD §5.1）。HDR 下 `r·D` 允许 >1（高光邻近），不裁剪。

### 5.3.2 波长相关扩散（高级可选，非默认路径）

`SigmaRatio = (1.0, 0.85, 0.7)`（PRD §4.2）：红光散射更远，产生"近源橙、远处红"的空间红移渐变。启用时按通道独立扩散：`D_c = E(S_c, σ·k_c)`（c ∈ {R,G,B}）。V1 默认**不启用**（单 σ 扩散 + 恒定增益），作为高级参数预留。

## 5.4 Composite

### 5.4.1 Halation Layer 成形

```
Halo = max(D − k·S, 0),   k = CenterAttenuation（默认 0.9）
```

物理：扣除扩散源的直射能量，只保留"散射净增"（防光晕层反射的净贡献）。`k→1` 纯散射层（本产品默认语义）；`k→0` 退化为 bloom（PRD §5.3 明确**不作为**默认）。该式即 spill 正差思想的工程形态（§5.1.3）。

### 5.4.2 Secondary Glare（防光晕层弱反射）

```
Halo += g · E(S, σ_g·σ) ⊙ r,   g = GlobalDiffusion（默认 0.15）, σ_g ≈ 3–5
```

大 σ 低强度红光层二次扩散，暖化中间调与肤色（对标 Dehancer Global Diffusion；`g=0` 可关）。

### 5.4.3 Blend

**默认（additive，PRD §4.2）**：

$$O' = O + \alpha·(Halo \odot G), \qquad \alpha = \frac{strength}{100} \times \text{additiveScale}$$

`strength` 0–100%（PRD §4.1）；`additiveScale` 为内部映射常量（建议 2.0，对标 Alcedo `amount = strength/100 × 2.0`，待视觉验证，见 D-7）。`G` 为 §5.1.2 背景门控。

**HDR 语义**：linear additive 是光的物理叠加，`O'` 允许 >1，**不裁剪**；写回阶段由 io/PS 按文档位深决定（32-bit 直通保持，16/8-bit 由 PS 转换）。

**Blend Mode 可选值**：`screen`（`O' = 1 − (1−O)(1−α·Halo⊙G)`），软叠加、压缩高光，V1 非默认（PRD §4.2 保留开关）。

---

# 6. Software Architecture

## 6.1 目录结构

```
film-halation/
├── manifest.json              # UXP 清单（panel 声明）
├── package.json / tsconfig.json / esbuild.config.mjs
├── src/
│   ├── main.jsx               # UXP entry：装配 io/storage/ui
│   ├── ui/                    # UI Layer（Spectrum UXP 组件，无算法）
│   │   ├── panel.jsx          # 面板布局：Strength + Advanced 折叠区
│   │   ├── controls/          # 控件（滑块/数字输入/下拉），与参数双向绑定
│   │   └── i18n/              # v1 英文文案 + i18n 骨架（PRD §7.2）
│   ├── core/                  # Halation Core Engine：纯算法，零 UXP 依赖
│   │   ├── halation/
│   │   │   ├── pipeline.js    # processHalation 编排（§5.0 链路）
│   │   │   ├── extract.js     # Y/M/S/G（§5.1）
│   │   │   ├── diffuse/
│   │   │   │   ├── iir.js     # 一维 IIR + 镜像扩展（§5.2.4）
│   │   │   │   └── conv.js    # 有限卷积 + 重归一化（§5.2.5，黄金基准）
│   │   │   ├── redshift.js    # r ⊙ D、SigmaRatio 通道扩散（§5.3）
│   │   │   └── composite.js   # Halo 成形 + Secondary Glare + Blend（§5.4）
│   │   ├── color/
│   │   │   └── trc.js         # TRC decode/encode 纯函数（§4.2）
│   │   ├── params.js          # HalationParams 契约 + 默认值 + 校验
│   │   └── index.js           # core 公共出口（唯一被外部 import 的面）
│   ├── io/                    # Image Access + Color Pipeline（宿主侧）
│   │   ├── imageAccess.js     # getPixels/putPixels、位深、tile（§3）
│   │   ├── colorPipeline.js   # 编码域 ↔ linear 的编排（§4）
│   │   ├── layerOps.js        # 效果图层创建/更新/定位
│   │   └── preview.js         # 降采样预览渲染（§10）
│   └── storage/
│       ├── serializer.js      # params ↔ JSON、version migration（§9）
│       ├── pluginStorage.js  # PluginStorage（Level 1，document-state cache）
│       └── backends.js        # backend 抽象（Level 2/3 预留，PRD §2.4）
└── tests/
    ├── unit/                  # core 单测（Node）
    ├── golden/                # 黄金参考输出（§11）
    └── visual/                # 四张样张 + 主观验收记录（§11）
```

## 6.2 模块职责与依赖方向

- **依赖方向**：`main → ui → io → core`；`main → storage → core`。**`core/` 不 import 任何 UXP / Photoshop / DOM 模块**——这是"core 可移植、Node 可直测"的硬约束（PRD §7.4）。
- `io/` 是唯一接触 `photoshop.*` / `imaging` 的层；`storage/` 是唯一接触文件系统的层。
- `core/index.js` 为唯一公共出口，防外部绕过约束。

---

# 7. Core API Design

## 7.1 类型契约（TypeScript，设计契约非实现）

```ts
// core/params.ts
interface HalationParams {
  strength: number;              // 0–100（UI %），默认 0；映射 α = strength/100 × additiveScale
  sigma: number;                 // 1–100 px，默认 7.0
  threshold: number;             // 0–1（linear），默认 0.7
  thresholdSoftness: number;     // 0–0.5，默认 0.1
  backgroundThreshold: number;   // 0–1（linear），默认 0.8
  redshift: [number, number, number];          // 默认 [1.0, 0.05, 0.02]
  sigmaRatio: [number, number, number];        // 可选，默认 [1.0, 0.85, 0.7]（§5.3.2）
  globalDiffusion: number;       // 0–1，默认 0.15（0 = 关闭 Secondary Glare）
  centerAttenuation: number;     // 0–1，默认 0.9
  blendMode: 'additive' | 'screen';            // 默认 'additive'
  diffusionMode: 'quality' | 'fast';           // 默认 'quality'（预览自动 'fast'）
  additiveScale: number;         // 内部常量，默认 2.0（D-7，可被预设覆盖）
}

// core/image.ts
interface LinearImage {
  rgb: Float32Array;             // H*W*3，linear，允许 >1（HDR）
  width: number;
  height: number;
}

// core/index.ts —— 唯一公共入口
function processHalation(input: LinearImage, params: HalationParams): LinearImage;
```

## 7.2 语义约束

- **输入/输出分离**：`processHalation` 不修改 `input.rgb`（非破坏契约）；返回新 `LinearImage`（可复用调用方 buffer，见 §10 就地策略）。
- **纯函数 + 确定性**：同输入同参数 → 逐位相同输出（可复现，PRD §1.4）。
- **HDR 不裁剪**：`>1` 全程保留；不 clamp、不 NaN。
- **参数校验**：NaN/Inf 拒绝；越界 clamp 到定义域（strength/sigma/threshold 等）；尺寸校验（W·H·3 与 buffer 长度一致）。
- **错误策略**：参数非法抛 `TypeError`/`RangeError`；计算中不吞错。
- **可移植性**：core 编译产物为纯 ESM/CommonJS，Node 直接可测；未来可迁移 WASM/C++（PRD §9 远期）。

---

# 8. UXP UI Architecture

## 8.1 面板结构

- manifest 声明 `"type": "panel"`、`mainPath`、`"id": "filmHalation.panel"`。
- 面板布局：顶部 Strength 主滑块 → 折叠区"Advanced" → 底部 Apply 按钮 + 状态行（进度/错误/位深提示）。

## 8.2 控件清单（以 PRD §4.1/§4.2 为准）

| 分组 | 控件 | 参数 | 默认 | 可见性 |
|---|---|---|---|---|
| Basic | Strength 滑块 0–100% | `strength` | 0 | 默认 |
| Advanced | Sigma 滑块 1–100 px | `sigma` | 7.0 | 折叠 |
| Advanced | Threshold 滑块 0–1 | `threshold` | 0.7 | 折叠 |
| Advanced | Threshold Softness 滑块 0–0.5 | `thresholdSoftness` | 0.1 | 折叠 |
| Advanced | Background Threshold 滑块 0–1 | `backgroundThreshold` | 0.8 | 折叠 |
| Advanced | Red Shift（R/G/B 三个数字输入或复合） | `redshift` | (1.0, 0.05, 0.02) | 折叠 |
| Advanced | Global Diffusion 滑块 0–1 | `globalDiffusion` | 0.15 | 折叠 |
| Advanced | Center Attenuation 滑块 0–1 | `centerAttenuation` | 0.9 | 折叠 |
| Advanced | Blend Mode 下拉 | `blendMode` | additive | 折叠 |
| Advanced | Diffusion Mode 下拉 | `diffusionMode` | quality | 折叠 |

## 8.3 UI 与算法解耦

- **单一参数状态对象**：UI 只持有/编辑一个 `HalationParams` 实例（含默认值，`core/params.js` 提供），不接触算法实现。
- **交互流**：控件事件 → debounce(~100ms) → `io/preview.js`（降采样 + fast 模式）→ 显示预览；`Apply` → quality 全分辨率 → `io/layerOps.js` 效果图层 + `storage/` 写 document-state cache。
- **事件订阅**：文档/图层切换、位深变化时刷新面板与预览；渲染期间禁用 Apply（进度展示）。
- 预览/渲染的编排在 `io/`，UI 只负责触发与展示 → 算法替换不影响 UI（A/B 验证期可切换实现，见 V-4/V-5）。

---

# 9. Storage Design

## 9.1 正式方案：PluginStorage document-state cache（V1，machine-local）

> **决策（2026-08-10）**：PS UXP 无法写入文档同目录 sidecar JSON（storage 模块仅提供对话框式访问与沙箱目录，无按绝对路径的 File I/O API）。**Sidecar JSON 方案移除**，V1 采用 PluginStorage document-state cache。

- **存储位置**：UXP 插件数据目录（`localFileSystem.getDataFolder()`，零权限要求、跨会话持久）：`%APPDATA%\Adobe\UXP\PluginsStorage\PHSP\<ver>\<pluginId>\PluginData\`。
- **DocumentFingerprint（cache 键）**：由 5 个字段构成（非简单 path hash）：
  - `pathHash`：normalized 文档路径的 hash（大小写/分隔符规范化后 FNV-1a）；
  - `fileName`：文件名（含扩展名）；
  - `fileSize`：文件大小（字节）；
  - `mtimeMs`：文件修改时间（epoch ms）；
  - `documentId`：可选 Photoshop document identifier（cloud/内部 id）。
  加载时计算当前文档 fingerprint，与 cache 逐项比对（`pathHash`+`fileName` 主匹配；`fileSize`+`mtimeMs` 强校验，任一变化视为"文档已修改"，可触发重新关联/不自动恢复）。
- **定位**：**machine-local document state cache**（同机器、跨会话的参数恢复缓存），非文档旁可移植文件。
- **限制**（UI/README 如实告知）：
  - 文档移动/改名/修改后 fingerprint 变化，可能需要重新关联（旧 cache 保留但不再自动匹配）；
  - 不支持跨机器同步（cache 在本机插件数据目录）；
  - 删除 cache 或换机后参数不随文档保留。
- **不绑定 layer name**：参数权威源是 PluginStorage cache（fingerprint 键控）；效果图层定位不依赖名称。
- **未来增强方向（Level 2/3 预留）**：Photoshop XMP metadata（参数写入 PSD 自定义 schema，随文档保存/移动，真正"随文档走"）——V1 不实现，仅保留 `StorageBackend` 抽象扩展点。
- 存储后端抽象：`PluginStorage`（Level 1 正式，fingerprint cache）→ XMP metadata（Level 2 未来）→ 云端（Level 3 未来）；`core/` 参数契约不感知存储方式（PRD §2.4 分层）。

## 9.2 Schema（以 PRD §2.4 为准）

```json
{
  "plugin": "FilmLab",
  "version": "1.0",
  "effects": {
    "halation": {
      "strength": 40,
      "sigma": 12,
      "threshold": 0.7,
      "thresholdSoftness": 0.1,
      "backgroundThreshold": 0.8,
      "redshift": [1.0, 0.05, 0.02],
      "globalDiffusion": 0.15,
      "centerAttenuation": 0.9,
      "blendMode": "additive",
      "diffusionMode": "quality"
    }
  }
}
```

> 与用户提示词 `{ version, pipeline: [{type:"halation", params:{}}] }` 的关系（决策记录）：V1 以 PRD schema 为准（单模块时 `effects.halation` 与 `pipeline[0] = {type:"halation", params}` 等价映射）；用户提案的 `pipeline[]` 数组形态作为 **V2 effect graph** 扩展方向（有序 effect 链，PRD §2.4 "可保存完整 effect graph"），version migration 预留（§9.3）。

## 9.3 Serializer

- `params ↔ JSON`：单向确定性序列化（NaN/Inf 拒绝；数组通道增益定长校验）。
- **version migration 钩子**：`v1.0` schema 固定；后续 `version` 升级时按迁移表逐级转换（MVP 至少覆盖 v1.0 → v1.x 的空迁移路径，PRD §2.4 MVP 范围）。
- 往返不变量：`serialize(parse(json)) === json`（键序规范化）。

## 9.4 未来扩展（多模块 / 预设）

- `effects.grain` / `effects.curve` / `effects.filmStock` 各为独立命名空间（PRD §2.4/§9 路线：V1.1 Grain、V1.2 Curve、V2.0 Film Stock Preset 库）。
- 预设 = 整条 `effects` 的命名快照（`profile` 参数骨架 V1 预留、无 UI，PRD §4.3）。
- 模块间共享：同一 `serializer` + `storage backend`，无需改动算法层。

---

# 10. Performance Design

## 10.1 内存账（24MP = 6000×4000 基准，Float32）

单通道 6000×4000×4B = 96MB；RGB 三通道 = 288MB/图。

| Buffer | 用途 | 大小 | 备注 |
|---|---|---|---|
| O | 输入 linear RGB | 288MB | io 层分配 |
| S | 光晕源（RGB ⊙ M） | 288MB | 可复用为 D 的就地 buffer |
| M / G | 亮度 mask / 背景门控 | 96MB（单通道） | 可复用同一 buffer |
| D | 扩散结果 | 复用 S（就地） | IIR 行/列 pass 仅需 O(W)/O(H) 递归缓冲 |
| Halo | 成形光晕 | 复用 S/D | |
| O' | 输出 | 288MB | 可复用 O 就地（若调用方允许） |

**峰值 ≈ 3 份全分辨率 RGB buffer ≈ 864MB + 辅助**（与 PRD §7.1 "≤3 份 ≈ 850MB" 一致）。α/门控 mask 均就地复用，不新增 288MB 级缓冲。

## 10.2 优化手段（不假设 GPU，CPU 为基线）

1. **Typed array 全程**：Float32Array，无装箱、无中间对象；通道交错的 RGB 布局与 imaging API 对齐（避免布局转换）。
2. **就地运算**：S→D→Halo 链式复用；IIR 行/列 pass 读写原 buffer + 单行/列暂存。
3. **Tile processing**：内存超限或 UXP 单次 getPixels 限制时按行带分块（tile 高度 ≈ 128–512 行），**tile 边缘重叠 `ceil(5σ)` 行**（镜像），消除块间边界伪影；扩散的 σ 不随 tile 变化。
4. **Worker / 并行**：UXP Web Worker 可用性**未验证**（R-6）；可用则按行带并行 IIR（quality 渲染）；不可用则主线程分块 + 进度条。**不依赖 GPU**。
5. **预览管线**：最长边 1024 降采样 → fast 模式（IIR O(N)）→ <500ms 目标（PRD §7.1）；参数变更时仅重算受影响阶段（sigma 不变则缓存提取结果 S/M/G，只重算扩散与合成——增量重算）。

## 10.3 目标（PRD §7.1）

| 指标 | 目标 | 手段 |
|---|---|---|
| 实时预览 | < 500ms | 1024 降采样 + fast IIR + 增量重算 |
| 最终渲染 | < 5s | quality 全分辨率 + 行并行 + IIR O(N)（σ 无关） |
| 内存 | ≤ 3 份全分辨率缓冲 | §10.1 就地复用 + tile 兜底 |

---

# 11. Testing Strategy

测试分四层：算法单测（Node 直测 core）→ 颜色测试 → 黄金/视觉测试 → 真机冒烟（PRD §7.4）。全部可复现、确定性。

## 11.1 Algorithm Tests（core，Node unit test）

| # | 用例 | 断言 |
|---|---|---|
| T1 | **identity**：σ 极小（σ→0，如 0.5）且 strength=0 | 输出与原图逐元素相等（≤ 浮点容差 1e-6） |
| T2 | **zero strength**：strength=0，任意 σ | `O' === O`（α=0 → 混合项消失） |
| T3 | **constant image**：全图常数 c（如 c=0.5） | Y=c 低于阈值 → S=0、Halo=0 → 输出恒等（验证 DC 增益与阈值交互） |
| T4 | **impulse highlight**：单像素高光脉冲（O 中一点 = 1000，其余 0） | 光晕各向同性、按 `exp(−d/σ)` 衰减（对数域线性斜率）、无方向偏差；总能量 = α·r·Σw（归一化正确） |
| T5 | **IIR vs convolution golden**（A6）：小图直接卷积（大半径全核） vs IIR | L2 误差 < 1e-4（0–3σ 有效区），边界区（镜像扩展）单独断言 |
| T6 | **spill / center attenuation**：构造亮核 + 暗背景 | `Halo = max(D−k·S, 0)` 逐元素成立；k=0 与 k=1 的退化行为符合 §5.4.1 |
| T7 | **redshift 通道比**：R 单通道输入 | 光晕通道比 = (1.0 : 0.05 : 0.02) |
| T8 | **composite 加法性**：`O' = O + α·(Halo⊙G)` 逐元素验证；HDR 输入输出 >1 保留 |

## 11.2 Color Tests

| # | 用例 | 断言 |
|---|---|---|
| C1 | **HDR >1**：输入含 8.0 等高光 | 输出 >1 保留、不裁剪、无 NaN/Inf（全 pipeline） |
| C2 | **negative values**：非法负值输入 | 输出有限（容错策略：提取/门控阶段按 `max(x,0)` 语义处理，记录不吞错） |
| C3 | **profile 往返**：sRGB / AdobeRGB / ProPhoto TRC decode→encode | 往返误差 < 1e-5（float 精度）；8/16/32-bit 归一化路径一致 |
| C4 | **32bit 非 linear 文档**：带 gamma 的 32-bit profile | 正确 TRC decode（验证"32 ≠ linear"假设，R-2） |

## 11.3 Visual Tests（黄金样张 + 主观验收）

| 样张 | 场景 | 验收点（PRD §3.3 A1 扩展） |
|---|---|---|
| V-1 night light | 夜景街灯（暗背景强光源） | 红晕紧贴高光边缘、**仅暗背景侧可见**、无整图红雾（5σ 截断生效）；"灯 → 红晕 → 黑"三段 |
| V-2 sun highlight | 太阳/强高光（HDR 样张） | 大范围指数衰减红晕、无中性灰光晕、无过曝中心双重影 |
| V-3 window contrast | 窗外亮、室内暗 | 光晕出现在室内侧（暗背景侧，Background Gating 生效） |
| V-4 skin highlight | 人像皮肤高光 | 轻微暖晕，不过度（防止"红脸"）；Global Diffusion 暖化中间调可调 |

**Halation ≠ Glow 量化判据**：① 光晕主通道比 ≈ 1 : 0.05 : 0.02（非中性灰）；② 光晕只源于高光区且经背景门控（暗侧可见）；③ 衰减为指数（对数域线性）而非高斯；④ 无全局提亮（flat field 不受影响，T3 佐证）。

## 11.4 真机冒烟（Photoshop）

- 8/16/32-bit 测试图各一全流程无错误、写回无 banding（A2）。
- Smart Object 内部图层应用（A 类场景，PRD §2.3）；Apply 后原图层像素 hash 不变（A4）。
- PluginStorage 往返：Apply → 重开 → 参数恢复一致（A5）；fast/quality 一致性（A6）。
- 性能基准脚本：24MP 预览/渲染计时（A3）。

---

# 12. Development Roadmap

V1.0 工程实施拆分（与 PRD §9 产品版本路线并存：本表为 V1.0 内部阶段）。

| Phase | 内容 | 交付物 | 验收映射 |
|---|---|---|---|
| **Phase 1 — core algorithm** | 脚手架（npm+TS+esbuild+test）；TRC 表；指数扩散（conv + IIR）；pipeline（extract/gating/redshift/composite）；参数契约 | `core/` 全量 + 单测 + golden 基准（纯 Node，无需 Photoshop） | T1–T8, C1–C4 |
| **Phase 2 — UXP integration** | manifest/panel 骨架；`io/`（getPixels/putPixels、位深、profile、效果图层、tile）；`storage/`（serializer + pluginStorage） | 可运行的 UXP 插件（无 UI 美化）+ 真机冒烟 | A2, A4, A5, R-1/R-2 实测 |
| **Phase 3 — UI** | 面板 UI（Strength + Advanced 折叠）、实时预览管线（1024 + fast）、Apply 流程、i18n 骨架 | 完整交互 UI | A1（视觉主观）、A3（预览） |
| **Phase 4 — optimization** | 内存就地化收口、tile 兜底、worker/行并行、增量重算、性能基准脚本 | 性能达标 + 基准报告 | A3（<500ms / <5s）、A6 |
| **Phase 5 — presets & release** | 预设 save/load、`profile` 骨架（无 UI）、文档、打包发布（.ccx） | V1.0 发布版 | A5 完整闭环、PRD §4.3 |

阶段依赖：Phase 2 依赖 1（core 稳定后接宿主）；Phase 3 依赖 2；Phase 4 可与 3 并行（性能与 UI 独立）；Phase 5 依赖全部。

---

# Engineering Decisions

## E-1 已确定方案（Decided）

| # | 决策 | 依据 |
|---|---|---|
| D-1 | 采用 **UXP**（非 CEP / C++ SDK） | §2.1；PRD §8；远期 C++ 版保留 core 可移植性 |
| D-2 | 像素进出统一 `componentSize:32` + **显式 TRC decode**；不假设 32 = linear | §3.1/§4；用户提示词强调点 + PRD §6.2 |
| D-3 | V1 算法 = PRD §5.2 全链路：threshold 提取（smoothstep）+ Background Gating + 指数扩散（双模式）+ redshift (1.0, 0.05, 0.02) + Center Attenuation + Secondary Glare + additive | §5；**冲突裁决**：用户提示词"spill difference 为默认" vs PRD"soft threshold 为默认" → 以 PRD 为准；spill 语义经 `Halo=max(D−k·S,0)` 保留（k=0.9） |
| D-4 | 扩散双模式：quality=有限卷积（radius=ceil(3σ)，clamp）/ fast=双向一阶 IIR + 5σ 镜像扩展 | §5.2；PRD §8/§7.1 |
| D-5 | 存储：**PluginStorage document-state cache 正式方案**（fingerprint 键控，schema 按 PRD §2.4 `{plugin, version, effects:{halation}}`，不绑定 layer name）；XMP metadata 为未来增强 | §9；2026-08-10 决策（UXP 无文档同目录文件 API） |
| D-6 | Background Gating 软化宽度 `s`：V1 复用 `thresholdSoftness`（待视觉验证后可独立） | §5.1.2；PRD §5.2 未给 s 值 |
| D-7 | `additiveScale = 2.0`（内部常量，`α = strength/100 × 2.0`） | 对标 Alcedo（amount=strength/100×2.0，源码验证）；待视觉验证 |
| D-8 | `core/` 零 UXP 依赖、纯函数、Node 可直测；UI/io/storage 分层解耦 | §6/§7；PRD §7.4 |
| D-9 | 内存 ≤3 份全分辨率缓冲；就地复用 + tile（边缘重叠 5σ）+ 不依赖 GPU | §10；PRD §7.1 |

## E-2 未确定风险（Open Risks）

| # | 风险 | 影响 | 缓解 |
|---|---|---|---|
| R-1 | **UXP imaging API 实际性能**（32-bit getPixels/putPixels 吞吐、单次调用限制） | A3 达标风险 | 降采样 + tile 分块；超标降级预览分辨率（PRD R3）；Phase 2 即做基准实测 |
| R-2 | **32-bit 色彩管线验证**：带 TRC 的 32-bit 文档、>1 值经 putPixels 往返是否 clamp | 精度/HDR 语义风险 | C4 + 真机冒烟（32-bit 样张 >1 往返 hash 对比） |
| R-3 | **大图内存占用**：3×288MB 峰值在 UXP/宿主限制下的行为；16-bit 15+1 编码的 API 表现 | 崩溃/banding 风险 | tile 兜底；基准机实测峰值；16-bit 写回 dither 验证 |
| R-4 | **IIR vs Alcedo 卷积的数值与视觉差异**：3σ 截断重归一化 vs 精确指数核（近端系数差 3–5%），直接影响 A6 | A6 验收风险 | quality 半径提高至 ceil(5σ) 或统一归一化基准；V-4 A/B 对照 |
| R-5 | SigmaRatio（波长相关 σ）与 Secondary Glare 的 σ_g 取值未定 | 视觉手感风险 | 默认关闭/默认值 + 视觉样张调参 |
| R-6 | UXP Web Worker 可用性未验证 | 行并行落地风险 | 主线程分块 + 进度条 fallback |
| R-7 | Threshold Softness 与 Background Gating 共用 `s` 的耦合 | 语义模糊 | 待定项，视觉验证后独立参数 |

## E-3 后续验证项（Experiments / Spike）

| # | 验证项 | 时机 | 判定 |
|---|---|---|---|
| V-1 | **UXP imaging API 实际性能**：24MP getPixels/putPixels 计时、单次调用尺寸上限、tile 最优尺寸 | Phase 2 | 数据进入性能基准 |
| V-2 | **32-bit color pipeline**：带 TRC 32-bit 文档 decode 正确性、>1 值往返一致性、16-bit 15+1 表现 | Phase 2 | C4 + hash 对比通过 |
| V-3 | **大图内存占用**：峰值测量（含 tile 触发点）、UXP 内存上限实测 | Phase 4 | ≤3 buffer 目标达成 |
| V-4 | **IIR blur 视觉质量与 Alcedo 卷积差异**：同参数 A/B 样张（边缘、截断、光晕形状）+ A6 数值口径复核 | Phase 1/4 | 决定 quality 半径与 IIR 是否升为唯一生产实现 |
| V-5 | **threshold 提取 vs spill 提取 A/B**（D-3 冲突裁决的实证） | Phase 4 | 若 spill 显著更优 → V1.x 参数/默认切换 |
| V-6 | TRC decode/encode 精度、各 profile 往返误差 | Phase 1 | C3 < 1e-5 |

## E-4 与提示词冲突的裁决记录（按"以文档为准"）

1. **Highlight extraction 默认方案**：提示词主张 spill difference 默认；PRD §5.2 以 soft-threshold mask（smoothstep）为 V1 链路 → **PRD**。spill 形态经 Center Attenuation 保留，A/B 见 V-5。
2. **Storage schema**：提示词 `{version, pipeline[]}`；PRD §2.4 `{plugin, version, effects{}}` → **PRD**；pipeline 数组形态留作 V2 effect graph（§9.2）。
3. **UI 高级参数范围**：提示词仅列 Sigma/Threshold/Red Shift；PRD §4.2 高级参数全集（含 Background Threshold、Global Diffusion、Center Attenuation、Blend Mode、Diffusion Mode、Threshold Softness、Sigma Ratio）均为 V1 In Scope → **PRD 全集**（默认隐藏）。
4. **扩散实现**：提示词要求"方案 A/B 二选一并说明理由"；PRD 已确认双模式（quality=卷积 / fast=IIR）→ **PRD 双模式**，§5.2 给出完整比较与各自数学定义，并记录架构师建议（IIR 数学上更优，V-4 决定是否收口）。
5. **V1 功能边界**：未引入 PRD V1 范围之外的新功能；grain/curve/filmStock 仅出现在 storage 扩展位与 roadmap 映射（PRD §9）。

---

## 附录 A：参考实现（AlcedoStudio）对照

本文档算法与 PRD 一致；与参考实现 `zidage/AlcedoStudio`（源码级核验，2026-08-09）的对照：

| 环节 | AlcedoStudio 实际实现 | 本产品 V1（PRD） |
|---|---|---|
| 空间 | display-encoded 输入 → EOTF 解到 linear | 文档工作空间 TRC decode → linear（含 8/16/32-bit） |
| 扩散 | 整图可分离指数卷积（radius=ceil(3σ)，clamp），**单次扩散** | 双模式：quality 卷积 / fast IIR；对光晕源 S 扩散 |
| 提取 | `spill = max(blur − original, 0)`（threshold 参数为死参数） | smoothstep soft-threshold 提取 + Center Attenuation（spill 语义） |
| redshift | 逐通道增益 (1.0, 0.05, 0.02) | 同（含 SigmaRatio 可选通道扩散） |
| 合成 | `result = original + spill·(amount·redshift)`，amount = strength/100×2.0 | `O + α·(Halo⊙G)`，α = strength/100×2.0（建议值） |
| 差异点 | — | 增加 Background Gating、Center Attenuation、Secondary Glare（PRD §4.2 高级参数）；CPU 实现（Alcedo 仅 GPU 后端） |

## 附录 B：术语表

| 术语 | 定义 |
|---|---|
| Halation | 胶片卤化光晕：强光穿透乳剂经防光晕层反射回红色乳剂层产生的红晕 |
| Anti-halation layer | 防光晕层：乳剂底部吸光层，未完全吸收的光反射回乳剂产生 halation |
| Spill | 散射溢出：`max(blur − original, 0)`，Alcedo 的提取方式 |
| TRC / EOTF | 色调响应曲线 / 电光转换函数（gamma 解码） |
| IIR | 无限冲激响应递归滤波（本产品指数核的 O(N) 精确实现） |
| Working space | Photoshop 文档工作色彩空间（sRGB / Adobe RGB / ProPhoto RGB / ACES） |
| PluginStorage | 插件数据目录的 document-state cache（DocumentFingerprint 键控），machine-local |
