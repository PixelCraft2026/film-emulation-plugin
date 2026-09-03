# Film Emulation V1.7 Public Beta 1 用户手册

状态：第一个公开 Beta 版本（Windows 测试版）
适用版本：Film Emulation 1.7.0 package / V1.7 Public Beta 1
Halation 引擎版本：1.5.1
Photoshop 最低版本：23.3  
测试平台范围：Windows 10/11；macOS 未验证，不纳入本 Beta 的支持声明
最后核对：2026-09-03

> 文件名继续沿用 `FilmHalation_V1.5.1_User_Manual.md` 作为仓库历史路径；文档标题和内容以 Film Emulation V1.7 Public Beta 1 为准。本轮 Windows Photoshop 实机验收已由项目维护者汇总签核，但它仍是公开测试版，不等于正式稳定版。

## 1. 插件用途与边界

Film Emulation 是 Photoshop 静态图像胶片物理效果插件。当前 package 和 graph 语义版本均为 1.7.0，按固定物理顺序排列：

```text
Defringe → Vignette（未来） → Halation → Bloom → Highlight Protection → Film Resolution / MTF → Film Grain → Damage（未来） → Overscan（未来）
```

Halation 模拟胶片乳剂内部散射、片基层回射以及缺少防光晕层时形成的红橙色光晕；Defringe 修正局部紫/绿边缘色差；Bloom 模拟独立的高光散射；Highlight Protection 保护 Bloom 叠加后的高光；Film Resolution 模拟胶片材料、格式、ISO 与曝光区域造成的空间分辨率损失；Film Grain 模拟与胶片格式、ISO 和曝光相关的相关颗粒场。它们不是通用 Glow/锐化/数字噪声工具，也不是完整的胶片色彩配置。

- 输入图像应当已经完成 RAW 解码、曝光调整和 Photoshop 颜色预设。
- 插件只处理非色彩的胶片物理效果，不提供胶片色彩 LUT，也不复制任何第三方代码、参数或资产。
- `CineStill 800T` 只描述无 Remjet 胶片的视觉方向，是本项目独立模拟的项目预设标签，不是 CineStill 官方预设。
- 当前输入必须是 RGB 像素层。智能对象、文字、调整层和组需要先进入内容或栅格化。
- Apply 创建或更新独立效果像素层，绑定的源图层不会被写入。
- 新建文档默认包含六个节点（Defringe、Halation、Bloom、Highlight Protection、Resolution、Grain），只启用 Halation；其余节点默认关闭。关闭时不会执行对应计算，图像逐样本保持不变，同时保留该模块的参数。读取较早 graph 时，V1.7 节点和默认 `mask` 只在内存中补齐，用户保存后才写回。
- 所有当前节点都可使用共享的 Luma mask；默认 `mode=none`，因此读取较早状态不会隐式改变画面。未来的 Vignette、Damage、Overscan 在本 Beta 中仍明确拒绝执行。

## 2. 推荐工作流程

1. 在 Photoshop 中选中未经本插件处理的原始像素层。
2. 打开插件，用左侧的 `Defringe`、`Halation`、`Bloom`、`Resolution`、`Grain` 按钮切换当前调节领域；`Highlight Protection` 位于 Bloom 域。右侧预览保持不变。
3. 需要时先打开 Defringe，默认使用 100%/Actual 检查边缘；调节 `Amount`、`Radius`、色度阈值/柔化和 `Edge sensitivity`。
4. 在 Halation 页面选择预设，并用 Basic 区域中的 `Strength`、`Sigma`、`Threshold` 建立整体方向；这些常用参数无需展开 Advanced。需要限制效果作用的曝光范围时，再展开 Advanced 设置 `Halation output area`。
5. 打开 Bloom 后先调 `Threshold/Softness` 和按画面对角线换算的 `Radius`，再用 `Amplify`、`Saturation`、`Save lights` 塑形；Bloom 默认使用 Fit 预览。
6. 如需保护高光，在 Bloom 域打开 Highlight Protection。它只作用于最近的 Bloom contribution；没有前置 Bloom 时保持输入不变并显示缺失提示。
7. 在 Resolution 或 Grain 页面先设置共享的 `Film format` 与 `ISO`。默认是 Super 35 4-perf、ISO 250；按需要打开节点后再分别调 MTF 和颗粒。
8. 在面板预览确认总体方向后点击 Apply，在 Photoshop 画布 100% 缩放下检查最终颗粒、边缘和高光。适配屏幕缩放的预览不适合判断单像素颗粒。

如果文档曾保存过旧参数，Reload 插件不会自动覆盖它们。若要强制载入新版预设值，先切换到另一个预设，再重新选择目标预设。

### 2.1 首次公开安装与界面语言

Public Beta 1 是第一个公开版本。发布包只有 `FilmEmulation.ccx`，插件 ID 为 `com.cheukwing.filmemulation`；没有外部旧 ID 用户需要迁移，因此面板不提供旧状态导入/导出按钮，也不需要安装迁移桥。

首次运行会根据 Photoshop/系统 locale 选择中文或英文。底栏的 `界面语言 / Language` 可即时切换，选择会保存为插件全局偏好；它不写入文档 schema，不改变 graph、颗粒 seed、格式参数或源/目标图层绑定。标准 CCX 只携带 scalar `film_core.wasm`；SIMD 工件仅保留给 Node QA，不会被 Photoshop 包读取、实例化或分发。

## 3. 完整处理顺序与 Halation Pipeline

```text
Photoshop 编码 RGBA
        ↓
识别文档 TRC 与 RGB primaries
        ↓
解码到线性光，并转换到 canonical linear sRGB primaries
        ↓
Defringe：线性 YCoCg 边缘色差校正（默认关闭）
        ↓
高光提取：luma / spill、Red-Layer Threshold Bias、Threshold、Source Softness
        ↓
曝光重建：Source Impact、Strong Source Level
        ↓
光谱分层：Hue Response → 红层、绿层、残余蓝层源场
        ↓
强种子邻域扩张：Strong Source Expansion
        ↓
PSF 前能量缩放：Halation Amplify
        ↓
局部承载背景门控：Background Threshold、Background Softness、Blue Compensation
        ↓
三瓣多尺度 PSF：Sigma、PSF Smoothness、Red Tail、Sigma Ratio
        ↓
通道能量增益：Red Shift R/G/B
        ↓
局部光晕：Center Attenuation、Strong Core、Source Interior Protection
        ↓
独立宽红层：Global Source Level、Global Red Diffusion
        ↓
HDR 安全合成：Strength、Blend Mode、Halation Color Density
        ↓
Bloom：高光提取、三瓣 PSF、Save Lights 与正向 contribution（默认关闭）
        ↓
Highlight Protection：只修改最近 Bloom 的 contribution（默认关闭）
        ↓
Film Resolution：格式/ISO、材料、曝光相关 MTF
        ↓
Film Grain：格式/ISO、材料、曝光相关颗粒
        ↓
转换回文档 RGB primaries 与 TRC 编码
        ↓
输出软肩：Highlight Rolloff
        ↓
8/16 位抖动量化或 32 位浮点写回
        ↓
保留原 alpha，写入独立效果层
```

### 3.1 色彩与透明度

插件不会直接在显示编码的 RGB 数值上模糊。它先解码 TRC，再把 sRGB、Display P3、Adobe RGB、ProPhoto RGB 或 Rec.2020 转换到统一的线性 sRGB primaries。算法完成后再转换回文档工作空间。

这一步很重要：Halation 是光能扩散，必须在线性域计算。若直接在 gamma 编码值上模糊，暗部会被错误抬升，光晕强度和颜色也会随文档色域变化。

- 面板底图最长边为 1024px，并以 sRGB 显示。
- 光源提取使用最长边 2048px 的高分辨率代理，再把提取后的能量场降到 1024px 扩散。
- Apply 在源图层分辨率处理。
- 完全透明像素不产生光晕；半透明像素按 alpha 比例贡献光能。
- 输出 alpha 原样保留。

Defringe、Halation、Bloom 和 Highlight Protection 都在 canonical linear sRGB 中运行；显示编码 RGB 不会直接参与卷积或阈值判断。透明像素的隐藏 RGB 不会成为 Bloom 光源，Bloom 与 Halation 的所有正向贡献都按 alpha 参与。

### 3.2 高光提取与曝光重建

在线性 RGB 中，亮度近似为：

```text
Y = 0.2126R + 0.7152G + 0.0722B
M = max(R, G, B)
```

`luma (Y)` 使用 Y；`spill (max RGB)` 按 `Spill Mix` 在 Y 与 M 之间混合，形成亮度曝光场 E。插件同时构造深红层曝光 `ER=0.82R+0.16G+0.02B`。两条路径分别完成阈值、曝光响应和发光体色谱资格判断后，由 `Red-Layer Threshold Bias` 连续混合：

```text
BrightnessSource = Gate(E) × Response(E)
RedLayerSource   = Gate(ER) × Response(ER) × RedEmitterConfidence
Source           = (1-w) × BrightnessSource + w × RedLayerSource
```

其中 w 为滑块值。`w=0` 完整保留原有亮度提取；`w=1` 完全依据红层曝光和发光体置信度；中间值平滑过渡。随后源场乘以 alpha。

为了让被限制在 0–1 的 8/16 位高光仍有足够动态范围，插件把阈值 T 到数字白点 1 重建为强光坐标 U：

```text
T < E ≤ 1 : U = (E-T)/(1-T)
E > 1     : U = 1 + log2(E)
T ≥ 1     : U = max(0, log2(E/T))
```

因此 clipped white 的 U 仍为 1，而刚刚越过阈值的窗户仍接近 0。`Source Impact` 再以 `1 + 1.5×Impact` 的指数拉开弱光和强光。

### 3.3 光谱源场

插件分别建立深红层、绿/橙核芯层和弱蓝残余层。基础长波源偏重 R/G，B 对红层的直接贡献很低；`Hue Response` 再根据光源色相和色纯度调整响应。饱和度低于 0.35 的冷白光保持原始响应，0.35–0.80 之间平滑过渡，达到 0.80 后才完整使用严格色相曲线。

严格 Hue Response 下的大致顺序为：

```text
暖白、红、黄：高响应
品红：中高响应
绿：较弱响应
青、蓝：接近零
中性灰轴：保持中性光响应
```

因此“蓝天中的白灯”“略偏冷的白灯”和“纯蓝 LED”会得到不同判断：前两者可以形成红晕，只有高色纯度的蓝/青 LED 被严格拒绝。

### 3.4 强种子邻域扩张

真实照片中的灯芯通常已经带有镜头 glow、衍射或传感器高光扩散。只提取最亮像素会得到很细、很弱的红边。`Strong Source Expansion` 使用迟滞式两级判断：

1. 只有通过 Hue Response 且达到 `Strong Source Level` 的长波强光才能成为种子。
2. 种子在一个与 Sigma 成比例的邻域内寻找较低阈值候选。
3. 每个候选还会按自身色纯度复核：邻近的白色、暖色或低饱和冷白光学 glow 可以被吸收到 Halation 源场，高饱和蓝/青像素会被拒绝。
4. 孤立弱窗、纯蓝灯和纯青灯不能自行成为扩张种子，也不能仅因旁边存在白光种子而继承红层许可。
5. 内部保护开启时，只有“种子合格且候选复核合格”的许可会保留，使灯芯外已有的 optical glow 连续进入红晕，同时保护真实光源本体颜色。

这与简单降低 Threshold 不同：降低 Threshold 会让整片弱光参与；Source Expansion 只扩大合格强光周围的源体。

### 3.5 三瓣 PSF

每个光谱源场都使用 core、shoulder、tail 三个高斯瓣：

```text
PSF(x) = wc·G(σc) + ws·G(σs) + wt·G(σt)
wc + ws + wt = 1
```

默认附近的形态约为：

```text
core     : 0.617 · G(0.235σ)
shoulder : 0.282 · G(0.6575σ)
tail     : 0.101 · G(1.4325σ)
```

`PSF Smoothness` 会连续改变三瓣的权重和半径。`Red Tail` 只把深红层的一部分 core 能量重新分配到更宽的 shoulder/tail，并在最后重新归一化；绿层仍保持较窄，所以近源偏橙，远端逐渐转红。

窄 core 始终全分辨率。较宽的 shoulder/tail 会根据有效 sigma 自动在 1/2、1/4 或 1/8 分辨率计算，再中心对齐上采样。

### 3.6 局部光晕与全局红层

局部光晕近似为：

```text
Local Halo = max(Diffused Source - Attenuation × Source, 0) × Background Gate
```

`Center Attenuation` 决定从扩散结果中扣除多少原始光源中心。`Strong Core` 会只对被 `Strong Source Level` 分类为强光的区域降低这项扣除，让强光保持扎实核芯，而弱窗仍然收敛。

`Source Interior Protection` 另有一条自适应路径：源场局部占用率和较宽的环境亮度共同区分“大面积亮反射面”与“黑夜中的紧凑灯芯”。白衣、灯箱等连续亮面以及实际灯芯本体仍只保留越过外轮廓的残差；暗环境中经复核的低阈值 optical glow 会局部放开保护，使原始光学 glow 与外缘红晕保持连续。明亮、高饱和蓝/青 LED 还有目标侧保护，不会被附近其他白灯的红晕覆盖成紫红色；较暗蓝天不会触发该保护，白灯仍能在蓝天背景上形成红晕。

`Global Red Diffusion` 是另一条独立路径。它只接收超过 `Global Source Level` 的强光，以 `max(12px, 4×Sigma)` 的宽半径扩散，并主要落在中间调区域。密集源采用软饱和聚合，避免窗户阵列无限叠加成红雾。

### 3.7 合成与输出

最终效果量为：

```text
α = Strength / 100 × 2
```

Additive 直接增加正光能。Screen 在 0–1 范围按剩余高光余量增加，在 HDR >1 时使用正的递减增益，禁止把原始高光反向变暗。

`Halation Color Density` 只根据红层相对绿/蓝的正超额能量生成橙红色度覆盖。它保护白色灯芯；若色度调整会降低线性亮度，算法会补回中性亮度。因此该参数本身不会制造暗环。

输出先转换回文档 RGB primaries 并按文档 TRC 编码。`Highlight Rolloff` 非零时在编码域、写回前主动压缩接近 1 和超过 1 的值。8/16 位随后使用确定性零均值抖动量化；32 位保留浮点值。

### 3.8 V1.7 候选效果与亮度遮罩

#### Defringe

Defringe 先把线性 RGB 变换到 YCoCg，只对 Cg 做局部边缘校正，保留亮度 Y 与红蓝差异 Co。边缘门控由 Y 的局部变化和 Cg 的色差共同决定，因此主要处理紫/绿边缘，不会把整幅图洗成中性灰。`Amount=0` 或 `Edge sensitivity=0` 时逐 Float32 样本恒等，alpha 始终引用原输入。

#### Bloom

Bloom 从输入亮度中独立提取高光，以固定三瓣 PSF 生成正向光能：

```text
core  0.62 · G(0.22σ)
mid   0.28 · G(0.75σ)
tail  0.10 · G(2.40σ)
```

半径按完整图像对角线和 preview scale 换算，而不是按当前分带尺寸换算。Fast 与 Quality 保持相同三瓣、半径和总能量，仅改变数值核。Bloom 会把 `bloomBase`（节点输入）和已经应用 Saturation、Save Lights、Amplify 的 `bloomContribution`（最终正向贡献）放入 transient bus，供后面的 Highlight Protection 使用；HDR 高光不会因 Bloom 变暗。

#### Highlight Protection

Highlight Protection 不重新提取高光，也不修改源图。它只对最近一个前置 Bloom 的 `bloomContribution` 按亮度阈值衰减，并保留 `bloomBase` 与输入关系。若图中没有可用 Bloom transient，节点保持输入不变，状态会记录 `missingBloomContribution`；节点不会被静默删除。

#### 通用 Luma mask

每个当前节点都有固定键序的 `mask`：

```text
{ mode: "none" | "luma", lowEV, highEV, softnessEV, invert }
```

`mode=none` 等于全覆盖；`mode=luma` 在节点输入亮度上按 canonical linear sRGB Rec.709 计算：

```text
EV = log2(max(Y, 2^-24) / 0.18)
```

`lowEV`/`highEV` 范围为 -16..16 且必须满足 `lowEV < highEV`，`softnessEV` 范围为 0.1..4。两侧 smoothstep 形成带通，`invert` 后再应用。Defringe、Film Resolution 等替换型节点执行 `mix(input, effected, mask)`；Bloom、Halation 等加性节点只缩放自己的正向 contribution。mask 不改变 alpha，也不裁剪 HDR；全零 mask 必须逐样本恒等。

### 3.9 V1.7 候选的执行后端

当前 Beta 已接入 transient bus、RenderPlan 的真实 physical layout/liveness alias、command-buffer v1、executor ABI v1、Frame A/B、只读 alpha、预留 scratch、容量/偏移/finite 检查、取消、Debug dual-run 和整带 JS 回退。`Defringe → Halation → Bloom → Highlight Protection → Resolution → Grain` 已可在同一 scalar resident segment 中执行；每个连续 band 只上传一次 RGB/alpha、下载一次 RGB，Bloom contribution 保留在 transient arena 内，release 路径不会把中间帧复制回 JS。逻辑 RenderPlan 保留完整 alias/lifetime 高水位，resident 执行器根据节点互斥生命周期使用 planner 生成的 compact scratch arena，避免跨 band 递增扩容。每次 `film_executor_step` 的预算按 pixel-visits 解释并限制在 262,144，节点内部保存当前阶段/通道/lobe/row cursor；取消会 reset 并且不触发耗时 fallback。独立 `film_core_simd.wasm` 只用于 Node QA；Photoshop `Auto` 固定使用 scalar，公开包不包含 SIMD 工件。

## 4. Halation 预设说明

### 4.1 Neutral / Legacy

克制但可见的通用 Halation。Sigma 随画面对角线缩放，使用较高光源门槛、窄范围 Source Expansion、短红尾和近乎关闭的 Global Diffusion；它优先保护光源本体和高纯度蓝/青 LED，避免城市窗户阵列累积成红雾，也不追求 CineStill 800T（无 Remjet 方向）的浓重深红尾。

适合：

- 普通夜景和城市灯光；
- 不希望画面出现大片深红尾部；
- 作为手动调参的起点；
- 已有较强色彩风格、只需增加适度物理质感的照片。

### 4.2 CineStill 800T

高能量、强种子扩张、强红层长尾和较高色密度的实验性物理预设。目标形态是“白芯—橙红肩—深红尾”。

适合：

- 钨丝灯、路灯、灯牌等夜景强光；
- 希望获得类似无 Remjet 胶片的浓郁红晕；
- 蓝天、青色暮光背景中的白色强光；
- 强光突出、弱窗需要保持收敛的城市照片。

### 4.3 Custom

`Custom` 不是一套可加载的固定参数。只要用户修改了当前预设中的任一参数，面板就用 Custom 标记当前状态。

### 4.4 当前预设参数对照

| 参数 | Neutral / Legacy | CineStill 800T |
|---|---:|---:|
| Strength（强度） | 68 | 82 |
| Sigma（半径 Sigma） | 3.6 diagonal units | 5.2 diagonal units |
| Threshold（阈值） | 0.74 linear | 0.86 linear |
| Red-Layer Threshold Bias（红色感光层阈值偏移） | 0.00 | 0.00 |
| Source Softness（光源柔和度） | 0.04 | 0.03 |
| Background Softness（背景柔和度） | 0.10 | 0.24 |
| PSF Smoothness（PSF 平滑度） | 0.14 | 0.14 |
| Background Threshold（背景阈值） | 0.36 | 0.48 |
| Source Impact（光源影响） | 0.88 | 1.00 |
| Halation Amplify（胶片光晕增益） | 1.65 | 2.20 |
| Strong Source Expansion（强光源扩张） | 0.16 | 0.85 |
| Red Tail（红色尾部） | 0.28 | 0.80 |
| Blue Compensation（蓝色补偿） | 0.35 | 0.90 |
| Halation Color Density（胶片光晕色彩密度） | 0.045 | 0.68 |
| Source Interior Protection（光源内部保护） | 1.00 | 0.00 |
| Strong Source Level（强光源级别） | 0.42 | 0.45 |
| Strong Core（强光核心） | 0.62 | 0.90 |
| Global Source Level（全局光源级别） | 1.05 | 0.78 |
| Hue Response（色相响应） | 1.00 | 1.00 |
| Red Shift R/G/B（红移 R/G/B） | 1.08 / 0.10 / 0.01 | 1.25 / 0.12 / 0.00 |
| Sigma Ratio R/G/B（Sigma 比例 R/G/B） | 1.05 / 0.50 / 0.28 | 1.15 / 0.42 / 0.18 |
| Global Red Diffusion（全局红色扩散） | 0.008 | 0.05 |
| Center Attenuation（中心衰减） | 0.45 | 0.35 |
| Blend Mode（混合模式） | additive | additive |
| Diffusion（扩散模式） | fast | fast |
| Highlight Extraction（高光提取） | spill | spill |
| Spill Mix（溢出混合） | 0.55 | 0.70 |
| Highlight Rolloff（高光滚降） | 0 | 0 |

`5.2 diagonal units` 在当前实现中表示对角线的 5.2‰，即 0.52%，不是 5.2%。

## 5. Halation 参数详细说明

以下顺序按照算法 pipeline 分组，而不是完全照搬面板排列顺序。
本节中的参数均采用“English（中文菜单名）”写法；括号内名称与插件当前菜单一致，便于在中英文界面之间对应。

### 5.1 Preset（预设）

类型：`Neutral / Legacy`、`CineStill 800T`、`Custom`。

- 选择内置预设会一次性载入完整参数组合。
- 修改任一参数后状态变为 Custom。
- 切换回内置预设会覆盖当前 Custom 数值。
- 文档保存的旧参数优先于新版内置值；需要重新选择预设才能刷新。

### 5.2 Strength（强度）

范围：0–100。阶段：最终合成。

- 0：输出与输入一致，关闭最终 Halation。
- 调大：按比例提高所有已生成局部/全局光晕的最终混合量。
- 不改变：哪些像素被提取、PSF 形状、强弱光分类。
- 与 `Halation Amplify` 的区别：Strength 是最后的输出 Impact；Amplify 在 PSF 之前改变乳剂返回能量，可能进一步影响色密度和空间可见性。

建议先用 Amplify 把光晕形态调正确，再用 Strength 做最终总量微调。

### 5.3 Threshold Units（阈值单位）

类型：`linear` 或 `stops (EV)`。阶段：高光提取与背景门控。

- linear：Threshold 直接表示线性亮度值。
- stops：换算公式为 `T = 0.18 × 2^EV`。
- EV 示例：-2 = 0.045，0 = 0.18，+1 = 0.36，+2 = 0.72。
- 主 Threshold 的 +3–+4 控件区间是 HDR 头部肩部：它从 +3 EV 连续加速延伸到更高的有效曝光阈值，并在 +4 进入“无光源”；Background Threshold 仍按显示值直接换算。
- 切换单位时，当前 Threshold 和 Background Threshold 数字不会自动换算，必须重新调整。

### 5.4 Highlight Extraction（高光提取）

类型：`luma (Y)` 或 `spill (max RGB)`。阶段：高光提取。

`luma (Y)`：

- 依据感知亮度选择光源；
- 对白灯和中性高光稳定；
- 高饱和红、蓝霓虹可能因为亮度 Y 较低而较难进入。

`spill (max RGB)`：

- 允许最亮单通道参与；
- 更容易提取红色灯牌、饱和霓虹和单通道接近剪切的高光；
- 必须配合 Hue Response，避免蓝/青数字光源错误产生红晕。

### 5.5 Spill Mix（溢出混合）

范围：0–1。仅在 Highlight Extraction=`spill` 时生效。

- 0：等价于纯 luma。
- 1：完全使用 max RGB。
- 调大：饱和单色光源更容易进入；红色招牌通常更明显。
- 过大副作用：彩色反射、彩灯和传感器单通道噪点也更容易被选中。

一般建议从 0.4–0.7 开始，并与 Hue Response 联动。

### 5.5a Red-Layer Threshold Bias（红色感光层阈值偏移）

范围：0–1。阶段：两条高光源场完成各自阈值和曝光响应之后、进入光谱分层之前。

- 0：完全参考 `BrightnessGate(E)`，逐值保留原有 luma/maxRGB 提取；旧文档缺少该字段时使用此值。
- 0.25–0.50：轻度向红层曝光倾斜，红/橙灯牌更容易进入，但整体仍接近旧版外观。
- 0.60–0.85：明显强调长波发光体，适合希望获得更强红敏感乳剂倾向的夜景。
- 1：完全参考 `RedLayerGate(ER) × RedEmitterConfidence`。深红、橙红和钨丝光按深红层曝光判断；高饱和蓝/青 LED 的置信度趋近零。

这不是 R 通道硬阈值。低饱和冷白光的 `RedEmitterConfidence` 保持 1，因此仍可正常产生 Halation；只有高色纯度的蓝/青发光体会随滑块向右而被更严格抑制。中性白的 E 与 ER 标尺一致，所以两端不会产生无理由的白光强度跳变。

调整该滑块会把当前状态标记为 `Custom`。建议先确定倾向，再调整 Threshold 和 Source Impact，因为它会同时影响基础源场、Strong Source 与 Global Source 的曝光坐标。此前短期版本保存的 `legacy` 开关自动迁移为 0，`red-layer` 自动迁移为 1。

### 5.6 Threshold（阈值）

范围：linear 0–1；stops 界面范围 -4–+4 EV。阶段：高光提取。

- 调低：更多中等亮度、窗户、反射和灯光进入；画面更容易形成连续红雾。
- 调高：只保留更亮的灯芯；弱光收敛，但可能只剩很细的高光点。
- linear 0–0.9 保留原有线性阈值；0.9–1 是高精度 HDR 头部肩部，向右连续覆盖越来越高的浮点亮度，因此从最右向左移动时会先出现最高的 HDR 峰，再逐渐扩大到较低的高光区域。
- 最右端（linear 1 或 +4 EV）是明确的“无光源”端点：所有有限的 32 位 HDR 高光都被排除，Halation 输出逐样本保持输入；端点之前仍按连续的 HDR 曝光坐标响应。
- 它决定“谁能参与”，不直接决定最终光晕有多红或多宽。

如果强灯不够明显但弱窗已经很多，不要继续降低 Threshold；优先提高 Amplify、Source Expansion 或 Strong Core。

### 5.7 Source Softness（光源柔和度）

范围：0–1。阶段：高光提取边缘。

- 0：精确阶跃，Threshold 以下不参与、以上立即参与。
- 调大：阈值附近的过渡更宽，光源遮罩边缘更柔和。
- 过小：可能出现硬圈、量化敏感或参数轻微变化时效果突然跳变。
- 过大：大量临界亮度区域逐渐参与，弱光容易连接成雾。

它只软化光源提取，不改变 PSF 模糊半径。

### 5.8 Source Impact（光源影响）

范围：0–1。阶段：曝光响应。

内部指数为 `1 + 1.5×Source Impact`。

- 调低：阈值以上的弱光和强光响应更接近线性，更多普通窗户可见。
- 调高：弱源被相对压低，最亮光源更突出。
- 1：最强的强弱光非线性分离，适合灯牌和 clipped white。

如果出现“所有窗户强度差不多”，提高 Source Impact；如果只有最亮灯芯有反应，适当降低。

### 5.9 Hue Response（色相响应）

范围：0–1。阶段：光谱源场。

- 0：V1.5 兼容矩阵，不进行严格的饱和色相选择。
- 调大：暖白、红、黄响应增强；绿减弱；青和蓝逐渐被抑制。
- 1：完整光谱近似，纯蓝/青发光体对红层接近零。
- 中性白光和略偏冷的低饱和白光不因 Hue Response=1 而被拒绝；只有高色纯度光源进入色相抑制。

如果纯蓝 LED 出现红晕，提高 Hue Response。若希望蓝紫霓虹也产生风格化红边，可降低，但这不再是严格物理模式。

### 5.10 Strong Source Level（强光源级别）

范围：0–4。阶段：强光分类。

它在重建坐标 U 上工作，而不是直接使用原始 RGB：

- 调低：更多高光被视为强源；Strong Core 和 Source Expansion 更容易启动。
- 调高：只有最亮、接近白点或 HDR 的光源成为强源。
- 8/16 位 clipped white 的 U=1，因此 Level 小于 1 时仍可被识别。

Strong Source Level 不决定高光是否进入基础源场；那是 Threshold 的职责。

### 5.11 Strong Source Expansion（强光源扩张）

范围：0–1。阶段：强种子邻域扩张。

- 0：关闭迟滞扩张，只使用原始阈值源。
- 调大：强光周围已有的白色/暖色镜头 glow 被纳入 Halation，肩部更厚、更有冲击感。
- 只允许通过 Hue Response 的强种子扩张，纯蓝/青灯不会因此恢复红晕。
- 保护开启时，强种子许可会沿扩张支持场传播，使略偏冷路灯的灯芯和外围 glow 不出现空心断层。
- 扩张半径与 Sigma 成比例；Sigma 越大，同一个 Expansion 的空间影响也越大。
- 过大：大型灯牌或相邻强灯可能融合，局部出现大片红块。

如果高亮只出现细红线而没有扎实肩部，提高它；如果弱窗连成片，先提高 Strong Source Level，而不是只降低 Expansion。

### 5.12 Halation Amplify（胶片光晕增益）

范围：0–4。阶段：PSF 之前的乳剂返回能量。

- 0：关闭返回源能量。
- 1：兼容能量。
- 大于 1：优先放大红层；绿层和蓝层按较弱比例增加，避免变成白色 Bloom。
- 调大不仅使结果更亮，也会让 Color Density 的非线性遮罩更容易达到较高覆盖。
- 过大：红通道可能在 8/16 位输出中剪切，灯周形成纯红实块。

Strength 与 Amplify 都会增强效果，但推荐把 Amplify 用于建立“乳剂能量感”，把 Strength 用于最后总量。

### 5.13 Background Threshold（背景阈值）

范围：与 Threshold Units 相同。阶段：局部承载背景门控。

局部门控主要查看背景长波占用 `0.82R+0.18G`：

- 调低：更多背景被判断为已经较亮/长波饱和，局部 Halation 更受抑制。
- 调高：更多背景允许承载红晕，亮部和中间调周围效果增加。
- 它不会改变光源本身是否被提取。

如果暗天空的红晕正常、但建筑亮表面完全看不到效果，可适当提高；如果整片暖色墙面泛红，应降低。

### 5.14 Background Softness（背景柔和度）

范围：0–1。阶段：局部承载背景门控。

- 0：背景门控接近硬切换。
- 调大：从允许 Halation 到抑制 Halation 的过渡更渐进。
- 过小：亮暗背景交界处可能出现门控边界。
- 过大：门控影响范围变宽，可能使红晕在大面积背景上显得平淡。

它与 Source Softness 完全独立：前者控制承载背景，后者控制发光源。

### 5.15 Blue Compensation（蓝色补偿）

范围：0–1。阶段：局部门控和色密度合成。

- 0：只依据长波背景余量。
- 调大：白色/暖色光源在蓝天、青色暮光和冷色建筑背景上的红晕更容易显现。
- 它不会取消 Hue Response 对纯蓝/青发光体的拒绝。
- 同时会适度提高冷背景上的 Color Density 能量。
- 过大：冷色背景上的红晕可能比暖背景更抢眼。

“蓝色背景中的白灯无红晕”应提高本参数；“纯蓝灯出现红晕”应提高 Hue Response，而不是降低 Blue Compensation。

### 5.16 Sigma Units（Sigma 单位）

类型：`pixels` 或 `% of diagonal`。阶段：空间尺度换算。

`pixels`：

- Sigma 直接表示源文档像素；
- 在不同分辨率照片上视觉比例会变化；
- 适合固定尺寸输出或精确像素调试。

`% of diagonal`：

- 当前实际公式为 `sigmaPixels = Sigma / 1000 × imageDiagonal`；
- 因而数值 1 表示对角线的 0.1%，5.2 表示 0.52%；
- 更适合跨分辨率照片保持相似视觉比例。

切换单位不会自动把当前 Sigma 数字换算成等效值，需要重新调整。

### 5.17 Sigma（半径 Sigma）

范围：pixels 模式 0.5–50；diagonal 模式 0.1–10。阶段：PSF 基准半径。

- 调小：紧贴光源的细边、核芯更集中。
- 调大：肩部和尾部扩散更远。
- 它还影响 Strong Source Expansion 的邻域以及 Global Diffusion 的宽半径。
- 过大：相邻灯光融合，细节被大面积红雾覆盖。

Sigma 不是最终可见半径。最终各通道半径还要乘 Sigma Ratio 和 PSF 各瓣比例。

### 5.18 PSF Smoothness（PSF 平滑度）

范围：0–1。阶段：三瓣 PSF 形态。

- 调低：core 权重更高，形态紧实、边缘有冲击感。
- 调高：shoulder/tail 权重与半径增加，过渡更柔和。
- 与 Sigma 的区别：Sigma 统一改变尺度；Smoothness 同时重新分配 core/shoulder/tail 的能量。
- 过高：强光可能变成通用柔光雾，失去胶片 Halation 的扎实内圈。

希望图像更宽但仍有实体感时，优先提高 Red Tail 或 Sigma，不要只把 Smoothness 拉满。

### 5.19 Red Tail（红色尾部）

范围：0–1。阶段：深红层专属 PSF。

- 0：红、绿、蓝层使用相同三瓣形态。
- 调大：红层 core 的部分权重转移到更宽的 shoulder/tail，远端更红。
- 绿层不继承该加宽，因此近源仍可保持橙色。
- PSF 总权重会重新归一化，Red Tail 主要重排空间能量，而不是简单增加总能量。
- 过大：小光源可能出现过长红尾，城市灯光之间开始相互连接。

### 5.20 Sigma Ratio R / G / B（Sigma 比例 R / G / B）

范围：每通道 0.1–2。阶段：逐通道 PSF 半径。

```text
σR = Sigma × Sigma Ratio R
σG = Sigma × Sigma Ratio G
σB = Sigma × Sigma Ratio B
```

- R 较大：红晕扩散更远。
- G 较小：橙色成分集中在近源区域。
- B 通常最小：防止远端变成白色/紫色 Bloom。
- 三者接近：光晕趋向中性 Glow。
- G 或 B 过大：红尾的光谱层次减弱。

典型物理顺序为 `R > G > B`。

### 5.21 Red Shift R / G / B（红移 R / G / B）

范围：每通道 0–2。阶段：扩散后的通道能量增益。

名称虽然叫 Red Shift，但当前实现不是色相角旋转，而是：

```text
Diffused R × Red Shift R
Diffused G × Red Shift G
Diffused B × Red Shift B
```

- 提高 R：整体红层能量增加。
- 提高 G：近源更黄/橙，可能逐渐接近暖白。
- 提高 B：加入蓝/紫成分，一般不符合传统红色 Halation。
- B=0：完全移除扩散后的蓝残余层。
- 过高的 R 与高 Amplify/Strength 叠加时容易剪切。

先用 Sigma Ratio 调空间层次，再用 Red Shift 调每层的相对亮度。

### 5.22 Center Attenuation（中心衰减）

范围：0–1。阶段：局部光晕中心扣除。

- 0：不扣除源中心，结果更像实心扩散光团。
- 调大：从扩散结果中扣除更多原始源，效果逐渐集中到边缘和暗侧。
- 1：普通弱源的中心扣除最强，容易形成明显环状边缘。
- Strong Core 会对强源抵消一部分扣除。

如果光晕像柔焦 Bloom，适当提高；如果灯芯外围出现空心红圈，降低。

### 5.22a Source Interior Protection（光源内部保护）

范围：0–1。阶段：局部光晕源体内部保护。

- 0：保持旧版 `扩散场 − Center Attenuation×源场` 行为，强源内部可以保留实体红橙核芯。
- 1：大面积亮反射面与实际光源本体使用 `扩散场 − Red Shift×源场` 的外缘残差；算法同时观察源场局部占用和更宽的环境亮度。暗环境中经光谱复核的低阈值扩张 glow 会自适应放开保护，使亮度轮廓连续；白衣褶皱、灯箱纹理和灯芯原色仍保持内部保护。明亮高纯度蓝/青灯体还会拒绝落在其本体上的外来红晕。
- 0–1：在兼容核芯和纯外缘之间连续混合。
- 只作用于局部 Halation；Global Red Diffusion 仍可让高亮内部产生轻微、宽范围的暖色偏移。

人物白衣、大面积高亮或灯芯内部出现粉红块时提高它。当前算法通过保留原始底图光源并只在外围加入红层扩散，避免保护核心被误解为亮度空洞；需要无 Remjet 式全面实体核芯时再降低。Neutral 默认为 1，CineStill 800T 默认为 0。

### 5.23 Strong Core（强光核心）

范围：0–1。阶段：强源局部核芯。

- 0：强源与普通源使用相同 Center Attenuation。
- 调大：只对超过 Strong Source Level 的强光保留更扎实的扩散核芯，并放松其周围的局部门控。
- 不直接抬升弱窗。
- 过大且 Strong Source Level 过低：很多普通窗户都可能变成实心红点。

它与 Center Attenuation 是一对控制：Center Attenuation 决定普通源扣除量，Strong Core 决定强源能保留多少实体感。

### 5.24 Global Source Level（全局光源级别）

范围：0–4。阶段：独立全局红层源选择。

- 调低：更多光源进入 Global Red Diffusion。
- 调高：只有最亮强光产生宽红层。
- 与 Strong Source Level 独立，不影响局部核芯和 Source Expansion。
- 过低：密集窗户虽然经过软饱和，仍可能形成大范围红雾。

### 5.25 Global Red Diffusion（全局红色扩散）

范围：0–1。阶段：独立宽红层。

- 0：关闭全局红层，只保留局部 Halation。
- 调大：在强光周围增加更宽、以红色为主、主要落在中间调的扩散。
- 不是白色 Bloom；通道比例固定为红主导。
- 宽半径约为 `max(12px, 4×Sigma)`。
- 过大：画面对比度感下降，多个强光可能形成大面积红色空气感。

建议先用局部 PSF 调出正确形状，最后只添加少量 Global Red Diffusion。

### 5.26 Halation Color Density（胶片光晕色彩密度）

范围：0–1。阶段：最终合成前的亮度安全色度覆盖。

- 0：纯 RGB 正光能加法，不额外改变原图底色。
- 调大：肩部和尾部的红橙色更浓、更接近染料密度覆盖，而不只是透明红光。
- 白色灯芯受到保护，效果主要落在灯芯外部。
- 算法会补回色度调整造成的线性亮度损失，因此本参数不会主动把图像变暗。
- 过大：红色趋向厚重实块，渐变层次减少。

如果光晕宽度正确但仍像淡红色透明雾，提高它；如果已经出现纯红剪切，先降低它，再考虑降低 Amplify。

### 5.27 Blend Mode（混合模式）

类型：`additive` 或 `screen`。阶段：最终合成。

`additive`：

- 直接增加光能；
- 是默认物理模式；
- 更容易获得有冲击力的强光；
- 8/16 位可能更快到达通道上限。

`screen`：

- 在 0–1 范围根据剩余余量增加；
- 高光区域更收敛；
- HDR >1 使用正增益，原始高光不会反向变暗；
- 视觉上通常比 additive 柔和。

### 5.28 Diffusion（扩散模式）

类型：`fast` 或 `quality`。阶段：高斯 PSF 数值实现。

- 两种模式使用相同三瓣 PSF、通道比例和参数。
- fast：优先使用 WASM 三盒高斯，失败自动回退 JavaScript；速度优先。
- quality：窄 sigma 使用精确可分离高斯，宽 sigma 使用递归高斯；多尺度选择更保守。
- Fit 面板预览固定使用 fast，以保持整图调参响应；100% 原生像素检查会遵循当前 quality 设置并使用与 Apply 相同的数值路径。
- Apply 尊重用户选择。

在当前验收标准下两种模式应非常接近。只有在高分辨率细边、极大 Sigma 或需要最终输出时才有必要使用 quality。

### 5.29 Highlight Rolloff（高光滚降）

范围：0–1。阶段：输出编码/写回前软肩。

- 0：不使用软肩；8/16 位超过范围的结果最终硬裁剪。
- 调大：软肩起点从 1 向 0.5 移动，更多高光被渐进压向 1。
- 优点：减少白灯和红通道突然剪切，保留更柔和的亮部层次。
- 副作用：高光冲击力和局部亮度下降，可能被误认为插件把图像变暗。
- 32 位不量化，但当前实现中非零 Rolloff 仍会执行用户指定的软肩函数。

若希望完全保留 HDR 能量，应保持 0。

## 6. 参数之间最重要的关系

### 6.1 Threshold（阈值）、Source Impact（光源影响）、Strong Source Level（强光源级别）

三者职责不同：

```text
Threshold           → 哪些像素能成为光源
Source Impact       → 弱源与强源的能量差距
Strong Source Level → 哪些已提取光源触发强核芯和邻域扩张
```

城市弱窗过多时，先提高 Threshold 或 Source Impact。只有强灯太软时，提高 Strong Core 或降低 Strong Source Level。

### 6.2 Sigma（半径 Sigma）、PSF Smoothness（PSF 平滑度）、Red Tail（红色尾部）

```text
Sigma          → 整个 PSF 的基础尺度
PSF Smoothness → core/shoulder/tail 的共同权重与柔度
Red Tail       → 只把深红层能量推向更宽的肩和尾
```

需要“宽而扎实”时，提高 Sigma/Red Tail，并保持较低 Smoothness；需要“柔和雾化”时才提高 Smoothness。

### 6.3 Halation Amplify（胶片光晕增益）、Strength（强度）、Halation Color Density（胶片光晕色彩密度）

```text
Halation Amplify（胶片光晕增益） → PSF 前的乳剂返回能量
Strength（强度）                 → 最后的线性混合量
Halation Color Density（胶片光晕色彩密度） → 红橙覆盖的浓度与厚度
```

推荐顺序：Amplify 建立能量 → Color Density 建立质感 → Strength 做总量微调。

### 6.4 Background Threshold（背景阈值）、Blue Compensation（蓝色补偿）、Hue Response（色相响应）

```text
Background Threshold（背景阈值） → 背景是否允许承载局部红晕
Blue Compensation（蓝色补偿）    → 冷色背景上的可见性补偿
Hue Response（色相响应）         → 发光体本身是否能激发红/绿层
```

蓝天里的白灯应调 Blue Compensation；纯蓝 LED 的红泄漏应调 Hue Response。不要混淆背景颜色和光源颜色。

### 6.5 Center Attenuation（中心衰减）、Strong Core（强光核心）、Strong Source Expansion（强光源扩张）、Source Interior Protection（光源内部保护）

```text
Center Attenuation（中心衰减） → 普通光源中心扣除量
Strong Core（强光核心）        → 强光源保留的实体核芯
Strong Source Expansion（强光源扩张） → 强光周围已有光学 glow 的吸收范围
Source Interior Protection（光源内部保护） → 把局部效果从高亮内部移到源体外缘
```

“细红线”通常需要 Source Expansion；“空心红圈”需要降低 Center Attenuation；“强灯不够扎实”需要提高 Strong Core；“白衣内部变粉但轮廓外没有红晕”应提高 Source Interior Protection。

## 7. 典型调参配方

以下数值是调整方向，不是固定标准。建议从内置预设出发做相对修改。

### 7.1 自然、克制的普通胶片感

从 Neutral / Legacy 开始：

- Strength（强度）：55–70
- Halation Amplify（胶片光晕增益）：1.1–1.4
- Strong Source Expansion（强光源扩张）：0.10–0.25
- Red Tail（红色尾部）：0.15–0.30
- Halation Color Density（胶片光晕色彩密度）：0.05–0.20
- Global Red Diffusion（全局红色扩散）：0–0.03

### 7.2 浓郁无 Remjet 红晕

从 CineStill 800T 开始：

- 保持较高 Threshold（阈值）和 Source Impact（光源影响），避免弱窗成雾；
- Halation Amplify（胶片光晕增益）：1.8–2.5；
- Strong Source Expansion（强光源扩张）：0.65–0.90；
- Red Tail（红色尾部）：0.65–0.90；
- Halation Color Density（胶片光晕色彩密度）：0.45–0.75；
- Hue Response（色相响应）：0.9–1；
- Strength（强度）最后微调。

### 7.3 蓝色天空背景中的白色路灯

- Hue Response（色相响应）：0.9–1，保证纯蓝灯仍被拒绝；
- Blue Compensation（蓝色补偿）：0.7–1；
- Strong Source Expansion（强光源扩张）：0.5–0.85，吸收白灯已有 glow；
- Strong Source Level（强光源级别）：确保灯芯能成为种子；
- 如果只有淡白光、没有红色厚度，再提高 Halation Color Density（胶片光晕色彩密度）。

略偏冷但仍接近白色的路灯不应被 Hue Response 拒绝。若只有高饱和蓝色 LED 被抑制而冷白灯正常，这是预期行为。

### 7.4 城市弱窗连成红雾

按顺序处理：

1. 提高 Threshold（阈值）；
2. 提高 Source Impact（光源影响）；
3. 提高 Strong Source Level（强光源级别）；
4. 提高 Global Source Level（全局光源级别）或降低 Global Red Diffusion（全局红色扩散）；
5. 必要时降低 Strong Source Expansion（强光源扩张）；
6. 最后才降低 Strength（强度）。

只降低 Strength 会让强灯和弱窗一起变弱，不能真正改善强弱分离。

### 7.5 强光红晕太软、缺乏冲击力

- 降低 PSF Smoothness（PSF 平滑度）；
- 提高 Strong Core（强光核心）；
- 降低 Center Attenuation（中心衰减）；
- 适度提高 Strong Source Expansion（强光源扩张）；
- 用 Red Tail（红色尾部）增加远端红色，而不是把 PSF Smoothness 拉高。

### 7.6 纯蓝或青色灯出现红晕

- 提高 Hue Response（色相响应）；
- 检查 Highlight Extraction（高光提取）是否为高 Spill Mix（溢出混合）；
- 不要通过降低 Blue Compensation（蓝色补偿）解决，因为它主要处理承载背景；
- 若追求严格物理响应，可把 Hue Response（色相响应）设为 1。

这里的“蓝/青灯”指高色纯度 LED。带少量蓝偏色但 R/G 通道仍充足的白灯会继续产生 Halation，不应通过进一步收紧 Hue Response 把它误杀。

### 7.7 红晕变成纯红色实块

按顺序处理：

1. 降低 Halation Color Density（胶片光晕色彩密度）；
2. 降低 Halation Amplify（胶片光晕增益）；
3. 降低 Red Shift R（红移 R）；
4. 降低 Strong Source Expansion（强光源扩张）；
5. 8/16 位输出可少量增加 Highlight Rolloff（高光滚降）；
6. 最后再降低 Strength（强度）。

## 8. V1.7 Public Beta 1 界面布局与共享胶片设置

宽面板分成三个区域：左侧领域导航、中间参数页、右侧检查预览。左侧只显示 `Halation`、`Defringe`、`Bloom`、`Resolution`、`Grain` 五个名称，不再把 `HAL / 30` 等内部阶段码拼接到模块名后；Highlight Protection 位于 Bloom 域。点击按钮只切换参数页，不会改变物理处理顺序；实际执行顺序始终是 Defringe、Halation、Bloom/Highlight Protection、Resolution、Grain。各效果标题右侧有 On/Off 开关，新节点默认关闭；关闭时跳过该模块且不改变图像，重新打开会继续使用已保存参数。窄停靠状态会自动改为上下布局。

当前 package 在 Photoshop 中显示为 `Film Emulation`，唯一面板 entrypoint 为 `filmEmulationPanel`。底栏提供 `中文 / English` 选择；首次运行按宿主/系统语言选择，手动选择会跨会话保留，但不会写入文档状态。

Halation 页的 Basic 区域直接显示 Preset、Strength、Sigma 和 Threshold。其余低频参数继续位于 Advanced。Defringe 页默认切换到 100%/Actual，便于检查边缘；Bloom 页默认 Fit，便于检查整体高光扩散。Resolution 与 Grain 共用 `Film stock` 设置：

预览顶部提供 `Fit` 与 `100%` 两个小按钮：

- Halation 初始使用 Fit，完整展示整张缩略图，便于判断光晕整体分布。
- Resolution 和 Grain 初始使用 100%，左侧显示 Source，右侧显示 Preview，便于直接比较解析度和颗粒。
- 每个领域记住本次面板会话中最后选择的模式；用户可随时手动切换。
- 100% 初次进入时定位源图层中央。按住预览拖动可检查其他区域；方向键每次移动 64px，按住 Shift 时每次移动 256px。

| Film format（胶片格式） | 内部有效画幅 | 典型视觉倾向 |
|---|---:|---|
| Super 8 | 5.79 × 4.01 mm | 同分辨率下颗粒最大、解析度损失最明显 |
| Super 16 | 12.52 × 7.41 mm | 颗粒和柔化较明显 |
| Super 35 4-perf | 24.89 × 18.66 mm | 默认、均衡 |
| 65mm 5-perf | 52.15 × 23.07 mm | 颗粒较细、细节保留较多 |

`ISO（ISO）` 范围为 25–3200，默认 250。提高 ISO 会同时增大颗粒尺度与强度，并轻微降低目标分辨率。Film format（胶片格式）和 ISO（ISO）是共享物理设置；在 Resolution 页修改后，Grain 页会使用相同值，反之亦然。

每个效果的 Luma mask 能力保留，但默认收在 `Advanced` 中。UI 不再直接使用内部名 `Luma mask`：普通节点显示 `Effect area（效果区域）`，Halation/Bloom 显示 `Halation output area（胶片光晕输出区域）` / `Bloom output area（泛光输出区域）`，Highlight Protection 显示 `Protection area（保护区域）`。`Apply to（应用于）: Entire image（整张图像）` 时整帧生效；选择 `Exposure range（曝光范围）` 后才显示 `Lower bound（下限）`、`Upper bound（上限）`、`Edge softness（边缘柔和度）` 和 `Inside/Outside EV range（EV 范围内/外）`。Bloom output area 只限制扩散结果落在哪里，不改变哪些高光被提取成 Bloom 光源。mask 默认关闭，不会改变旧图；启用曝光范围后，当前节点的最小 engine version 会提升为 1.7.0。

## 9. Film Resolution / MTF

Film Resolution 在线性 RGB 中对三个通道使用同一空间响应，不会造成彩边；alpha 不参与模糊并原样保留。它模拟胶片记录材料的有限 MTF，而不是锐化滤镜。参数在正常范围内只做非负权重的细节损失，不生成锐化负瓣、暗边或明显过冲。
本节参数同样采用“English（中文菜单名）”写法。

### 9.1 参数速查

| 参数 | 范围 | 默认值 | 作用 |
|---|---:|---:|---|
| Material（材料） | Negative / Positive | Negative | Negative 解析度较高；Positive / print 更柔和 |
| Resolution loss（解析度损失） | 0–1.5 | 1.00 | 总体分辨率损失；0 为逐样本关闭 |
| MTF response（MTF 响应） | 0.5–2.0 | 1.00 | 越高越保留细节，越低越柔和 |
| Shadow loss（暗部损失） | 0–1 | 0.25 | 增加暗部趾部的分辨率损失 |
| Highlight loss（高光损失） | 0–1 | 0.15 | 增加高光肩部的分辨率损失 |

### 9.2 Resolution loss（解析度损失）

- `0`：关闭 Film Resolution，输出与该节点输入逐浮点样本一致。
- `0–1`：从原始细节连续混合到目标胶片 MTF。
- `1`：完整应用由 Material、Film format、ISO 和 MTF response 决定的目标响应。
- `1–1.5`：进一步向更宽的胶片响应过渡，适合明显的低解析度风格，但不会转成锐化或产生负权重。

### 9.3 MTF response（MTF 响应）

该参数改变胶片材料的目标 MTF50。向右调高会保留更多高频细节；向左调低会增加柔化。它不是后期锐化 Amount，因此不会恢复源图中不存在的细节。

### 9.4 Shadow loss（暗部损失）与 Highlight loss（高光损失）

胶片在曝光曲线趾部和肩部的细节响应通常不同于中间调。Shadow loss 只额外影响较暗区域，Highlight loss 只额外影响较亮区域；中间调保持接近基础 Resolution loss。

建议先把两者设为 0，确定整体 MTF response 和 Resolution loss，再逐渐加入曝光相关损失。判断最终效果时应在 Photoshop 100% 缩放下查看发丝、织物、建筑细线和高光边缘。

## 10. Film Grain

Film Grain 使用与完整图像绝对坐标绑定的固定随机场。相同文档、节点和 seed 在 Preview、Apply、重新打开、不同分带高度以及 JavaScript/WASM 回退时保持同一颗粒排列。它不使用当前时间或 `Math.random()`，因此重复 Apply 不会无故改变纹理。

颗粒以线性光中的曝光相关密度变化合成，并保持统计平均亮度。RGB 共享大部分颗粒结构，再按 Chroma 加入少量独立通道成分；这与把彩色数字噪点直接叠在图像上不同。
本节参数同样采用“English（中文菜单名）”写法。

### 10.1 参数速查

| 参数 | 范围 | 默认值 | 作用 |
|---|---:|---:|---|
| Material（材料） | Negative / Positive | Negative | 选择负片或正片/印片的曝光响应分布 |
| Correlation（相关模式） | Analogue / Fast | Analogue | 颗粒尺度组合与速度模式 |
| Amount（数量） | 0–2 | 1.00 | 颗粒总体强度；0 为逐样本关闭 |
| Size（尺寸） | 0.5–2 | 1.00 | 物理颗粒直径倍率 |
| Roughness（粗糙度） | 0–1 | 0.55 | 细颗粒与粗颗粒的比例 |
| Chroma（色度） | 0–1 | 0.18 | RGB 独立颗粒成分比例 |

### 10.2 Material（材料）

- `Negative`：默认负片曝光包络，较宽范围的阴影和中间调具有可见颗粒。
- `Positive / print`：颗粒更集中在特定中间调曝光区域，适合正片或印片方向。

Material 只改变颗粒随曝光分布的方式，不替代胶片色彩预设。

### 10.3 Correlation（相关模式）

- `Analogue`：分别组合 fine、medium、coarse 三个相关尺度，结构最完整。
- `Fast`：把 fine 与 medium 合并为一个等效尺度并保留 coarse，减少计算量；颗粒仍由相同的确定性坐标随机源产生。

Fit 整图预览会采用速度优先路径；100% 原生像素检查与 Apply 使用当前选择和渲染质量。需要最终输出时优先使用 Analogue，快速整图调参或批量工作可使用 Fast。

### 10.4 Amount（数量）、Size（尺寸）、Roughness（粗糙度）与 Chroma（色度）

- `Amount` 控制颗粒强度，不改变固定 seed 对应的排列。只调整 Amount 时，预览可以复用已经生成的单位颗粒场。
- `Size` 改变物理颗粒直径。小格式和高 ISO 会在此基础上进一步放大可见颗粒。
- `Roughness` 越高，细尺度权重越大、纹理更密；越低，粗尺度相对更多、颗粒团块感更明显。
- `Chroma=0` 时 RGB 完全共享颗粒结构，观感最接近中性亮度颗粒；向右调高会增加通道差异。过高可能呈现彩色数字噪声感。

### 10.5 Randomize grain（随机化颗粒）

点击 `Randomize grain` 会生成下一组确定性 seed，并立即更新预览。新 seed 会随文档状态保存；重新打开后仍得到相同颗粒。Randomize 只改变颗粒排列，不改变 Amount、Size、Roughness、Chroma、格式或 ISO。

## 11. Preview、Apply 与非破坏性行为

### 11.1 面板预览

- Fit 模式的显示底图最长边为 1024px，完整画面以 `object-fit: contain` 显示。
- 光源提取来自最长边 2048px 的效果代理，不是先把原图缩到 1024px 再找光源。
- Source Expansion 使用 2048px 代理尺度的 sigma。
- PSF 扩散使用 1024px 显示尺度的 sigma。
- Defringe 同时处理显示代理与原生效果代理，然后才进行 Halation 高光提取；Bloom/Highlight Protection 在 Halation 合成后执行，Film Resolution 与 Grain 最后执行。
- Film Resolution 与 Grain 在前序 graph 输出之后执行，并按原图尺寸、预览比例、Film format 和 ISO 换算物理尺度。
- Fit 使用速度优先的 graph 渲染质量，Halation、Defringe 和 Bloom 使用对应的 fast 数值近似；100% 的左右画面共用 Photoshop ICC 转换后的 sRGB 显示底板，同时使用 Quality/Analogue 路径和完整物理尺度。Fast 与 Quality 保持相同效果语义、PSF 瓣和坐标。
- 预览按 sRGB TRC 编码显示，不把 Rec.2020 数值直接当作 sRGB。
- 首次打开插件、读取文档或绑定新源时，面板会自动发起预览，先显示色彩管理后的 1024px 源图，并提示 `Source loaded. Refining film effects…`，随后替换为完整效果。文档轮询已登记首个活动文档，不会在约 750ms 后把同一文档误判为切换并清空图像。
- 同一源图层且 Photoshop 历史状态未改变时，再次 Rebind 会复用读取和效果缓存。
- 完成后状态显示 `Panel preview 总时间 (read 读取时间, render 渲染时间)`。`read` 主要反映 Photoshop Imaging API 和色彩代理读取；`render` 包含 Defringe、Halation、Bloom/Highlight Protection、Resolution、Grain 与预览编码。
- 快速连续拖动时，旧渲染会被取消或丢弃，不会覆盖最新参数的结果。

100% 模式不把整张大图读入面板。插件按每个左右视窗的实际尺寸与 Photoshop `DisplayConfiguration.scaleFactor` 读取当前原生像素裁片；这是因为部分 UXP 版本的 `window.devicePixelRatio` 会错误地恒为 1。插件在四周额外读取当前 graph 的卷积/颗粒支持范围，算法在带边界的局部帧上完成后，只发布中央可见区域。因此：

- Source 和 Preview 始终对应同一文档坐标；
- 不对可见裁片插值，并按高 DPI 比例把一个源像素映射到一个物理显示像素，适合检查单像素 Grain、细线和 MTF；
- Grain hash 仍使用完整图像绝对坐标，移动视窗不会重新随机颗粒；
- Halation 即使在裁片边缘附近也能接收视窗外光源的扩散贡献；
- 极大的 Halation Sigma 会需要更宽支持边界，100% 首次渲染可能比普通 Grain 检查更慢，因此 Halation 默认使用 Fit。

### 11.2 Apply

- 第一次 Apply 创建独立的效果像素层。
- 后续 Apply 重新读取绑定源层并更新效果层，不在旧效果上重复叠加。
- Apply 始终按 `Defringe → Halation → Bloom → Highlight Protection → Film Resolution → Grain` 的顺序从绑定源层重新计算；未来 Vignette、Damage、Overscan 节点在当前 build 会明确报错，不会静默跳过。
- 插件不会把源图层 ID 传给 `putPixels`。
- 图层绑定失效或存在歧义时会停止或创建新的安全目标，不按相似名称静默猜测。
- 内存预检在创建效果层之前执行；硬预算不足时不会创建图层或写入像素。
- 面板底栏的 `Apply memory` 默认为 `Auto (safe)`。Photoshop/UXP 有时不提供可用内存信息，此时 Auto 会保守使用 Balanced。只有在确认系统至少有 16GB RAM 时，才选择 `High (16 GB+)`：它允许单带处理，能避免大半径 Halation/Bloom 的重叠区域被重复渲染，但会显著增加峰值内存。`Balanced` 始终强制分带。
- 所有分带完成后才执行最终写回。取消或渲染失败不会把部分结果写入源层。
- JS Preview/Apply 调度按目标时间片检查取消/generation；resident 以 16K–262K pixel-visits 自适应预算在节点安全边界保存 stage/channel/lobe/row cursor，取消会 reset 并直接结束本次请求，不走耗时 fallback。native kernel 只在完整安全边界发布帧，避免半成品进入 Preview 或 Apply。WASM 出错时仅当前请求禁用 resident backend，并从保留的 canonical band 输入完整 JS 重算。

### 11.3 Rebind Source

当源图层被删除、重命名、复制，或打开旧文档后绑定不再唯一时：

1. 选中真正的原始像素层；
2. 点击 Rebind Source；
3. 等待源图和完整效果预览依次出现；
4. 确认 Defringe、Halation、Bloom/Highlight Protection、Resolution、Grain 及 Film format/ISO；
5. 点击 Apply。

不要把已经带有效果的 Film Emulation 输出层绑定为新源，否则会人为形成重复烘焙。同一源图层的重复 Rebind 应直接复用缓存；若源像素已经改变，请先让 Photoshop 生成新的历史状态，再等待预览刷新。

### 11.4 Public Beta 验证状态

当前代码进入 `V1.7 Public Beta 1` Windows 测试版：typecheck、Node 单元/数值测试、manifest validation、bundle build、QA 代理矩阵和单包策略均纳入门禁；公开安装身份为 `com.cheukwing.filmemulation` / `filmEmulationPanel` / 1.7.0，唯一安装包为 `FilmEmulation.ccx`。2026-09-03 源码 fingerprint `93b34eb6…` 的 24MP、16-bit、Quality、Balanced、2+10 scalar Node 结果为：默认发布配置 P50/P95 14.935/15.126s、完整六节点 graph 30.749/31.077s，完整 graph 峰值 RSS 约 3.01GB，无 fallback；缓存 1024px 完整预览 P50/P95 为 189.8/246.4ms。scalar WASM SHA-256 为 `94814efb…`，Photoshop 标准包固定使用 scalar。HDR Threshold 的右端响应是本轮有意的算法修复，不能把旧版在该范围的输出当作应保持不变的 golden。项目维护者已确认 Windows Photoshop 实机矩阵完成；由于采用汇总签核，没有逐项保存独立 PASS 和逐次计时记录。该结论足以进入 Windows Public Beta 分发，但不等同于正式稳定版。macOS 未验证，不纳入本 Beta 的支持声明。

## 12. 位深、工作空间与输出注意事项

### 12.1 8 位

- 动态范围有限，强 Amplify、Strength、Color Density 更容易剪切；
- 使用确定性抖动降低量化带状；
- 必要时使用少量 Highlight Rolloff。

### 12.2 16 位

- Photoshop 使用 0–32768 的整数范围表示 0–1；
- 插件在写回前严格 clamp 到该范围并使用确定性抖动；
- 是当前推荐的主要工作位深。

### 12.3 32 位

- 保留浮点 HDR 值，不执行整数抖动量化；
- Threshold 仍然在线性光语义下工作；
- E>1 的高光按曝光档继续扩展，不会压成与 clipped white 完全相同；
- 面板 PNG 是无 ICC 的 SDR 图像，因此 Preview 会把 32 位线性像素按源图白点执行仅用于显示的保色相 HDR→SDR 映射并编码为 sRGB；该映射不会写入 graph、源图层或 Apply 的浮点结果；
- 即使某些 Photoshop/UXP 版本没有在 `getPixels` 返回的 profile 名中附加 `Linear`，插件也会按 32 位 Imaging API 像素契约处理，避免重复 gamma 解码；
- 若 Highlight Rolloff 非零，当前实现仍会应用用户指定的输出软肩。

### 12.4 Rec.2020 与其他宽色域

插件读取文档实际 profile/TRC，转换到 canonical linear sRGB 计算，再转换回原空间。面板预览与 Apply 不应该因为 Rec.2020、Display P3、Adobe RGB 或 ProPhoto 而出现整体 gamma 变暗。

如果遇到未知或未标记 profile，插件会回退到 sRGB 假设并给出提示。最终颜色仍应以 Photoshop 画布和正确显示器 ICC 为准。

## 13. 常见问题

### 13.1 调整参数后预设显示为 Custom

这是正常行为，表示当前值已经偏离内置预设。重新选择内置预设会恢复其全部参数。

### 13.2 Reload 后预设看起来还是旧强度

文档存储的参数会恢复。先切换到另一个预设，再重新选择目标预设。

### 13.3 预览和 Apply 有轻微差异

Fit 预览是 1024px，并固定使用速度优先路径，因此与全分辨率 Apply 可能存在细微差异。100% 模式读取原生裁片，按设备像素比点对点显示；Source 与 Preview 共用 Photoshop ICC 管理后的显示底板，避免左右整体明暗不一致，同时使用用户选择的 Diffusion/Correlation。它与 Apply 仍可能因面板 PNG 与 Photoshop 画布显示/输出位深不同而有极轻微量化差异。最终确认时可将插件 100% 的 Preview 与 Photoshop 100% 画布并排比较。

### 13.4 图像看起来变暗

Additive、HDR-safe Screen 和 Color Density 本身不会降低线性亮度。优先检查：

- Highlight Rolloff 是否非零；
- 是否在比较不同缩放比例或不同 Photoshop 色彩管理预览；
- 输入/输出 profile 是否一致；
- 是否把效果层设成了非正常混合模式或降低了图层不透明度。

### 13.5 为什么蓝光没有红晕，而蓝天上的白灯有

Hue Response 判断发光体本身的色谱；Blue Compensation 判断背景承载条件。白灯含有足够长波能量，可以在蓝天上形成红晕；纯蓝 LED 的长波返回接近零，因此仍被抑制。

### 13.6 Rebind Source 后预览短暂显示原图

这是当前 Beta 的渐进预览行为。插件先显示已经完成色彩管理的源图，避免读取和物理效果计算期间出现黑色空窗；状态显示 `Refining film effects…` 时仍在计算，完成后会自动替换为 Defringe、Halation、Bloom/Highlight Protection、Resolution 和 Grain 的最终预览。

如果预览长时间保持全黑或不再更新：

1. 确认选中的是可读取的 RGB 像素层，而不是组、智能对象、文本或调整层；
2. 查看状态栏是否显示失败信息；
3. 切换到另一个文档再返回，或重新打开插件面板；
4. 记录状态栏中的 read/render 时间与 Photoshop 版本，用于问题诊断。

### 13.7 为什么预览接近 3 秒

新状态栏把耗时拆成 read 和 render：

- `read` 较高：瓶颈通常在 Photoshop 读取、ICC 转换或源图层状态；复杂文档、宽色域和较旧 Photoshop 版本可能更慢。
- `render` 较高：瓶颈通常在 2048px 的 Defringe/Halation/Bloom 光源与扩散、Resolution 或 Grain。先确认 WASM 已正常加载，并避免在每次拖动后立刻点击 Apply。
- 同一源和相同参数的第二次预览应明显更快，因为颜色转换、Halation/Bloom transient、MTF 模糊结果和单位颗粒场都可以复用；mask、graph hash 或 backend 改变会主动失效相关缓存。

不要用降低文档位深、半径或效果强度作为最终性能规避。交互时可以暂用 Grain Fast，最终输出再切回 Analogue。当前同机 Node 协议的 6000×4000、16 位、Quality Balanced、2 次预热 + 10 次正式测量为：shipping-default Halation graph P50/P95 约 9.958/10.201s（2 个 band）；完整 V1.7 graph P50/P95 约 165.475/179.487s、峰值 RSS 约 2.90GB（16 个 band）。每个 band 均只上传一次 RGB/alpha、下载一次 RGB，完整 resident 段未触发 JS fallback；逻辑 RenderPlan 保留完整 liveness/alias 记录，resident 执行器按节点互斥生命周期使用 compact scratch arena，避免后续 band 扩容陷阱。缓存 1024px Preview P50/P95 约 162.1/179.4ms；未缓存 1024px Preview 本轮约 343.9/388.7ms，P95 略高于 ≤350ms 目标。完整图仍未通过 Apply P95 ≤6s 门禁。以上不能替代 Photoshop 实机计时。

### 13.8 Randomize 后颗粒为什么与之前不同

这是预期行为。Randomize 会推进并保存 seed；之后 Preview、Apply 和重新打开仍会使用新的固定排列。如果只调整 Amount，排列不会变化。若没有点击 Randomize 却出现颗粒整体跳动，请记录操作顺序并报告。

### 13.9 为什么 Highlight Protection 没有产生变化

Highlight Protection 只消费最近前置 Bloom 的 `bloomContribution`。如果 Bloom 关闭、位于它后面，或当前请求没有可用 transient，节点会保持输入不变并显示 `missingBloomContribution`。请先打开同一 graph 中位于前面的 Bloom，再检查 Threshold、Amount 和 Luma mask。

### 13.10 Luma mask 为什么看起来没有覆盖整张图

`mode=none` 才是全覆盖。`mode=luma` 使用线性 sRGB Rec.709 的 EV 带通；请确认 `Low EV < High EV`，并注意 softness 会在两侧形成渐变。加性效果只缩放贡献，替换效果则在输入与效果之间混合；alpha 不受 mask 改变。

### 13.11 为什么名称是 Public Beta 1

当前 package/manifest 与 graph 均为 1.7.0，公开名称使用 `Film Emulation V1.7 Public Beta 1` 来明确发布通道，并在界面和文档中标注为 Windows 测试版。自动门禁和本轮 Windows Photoshop 实机验收均已完成，可以进入 Public Beta 分发；由于仍需收集更多真实设备和工作流反馈，因此尚不称为正式稳定版。macOS 暂不在本 Beta 的支持声明内。

## 14. 推荐调参顺序速查

```text
1. Film format（胶片格式） + ISO（ISO）（Resolution / Grain 共享）
2. Defringe 开关、Amount（数量） + Radius（半径）（先用 100%/Actual 检查）
3. Defringe Chroma threshold（色度阈值）/Chroma softness（色度柔和度） + Edge sensitivity（边缘灵敏度）
4. Halation Preset（预设）
5. Threshold Units（阈值单位） / Sigma Units（Sigma 单位）
6. Highlight Extraction（高光提取） + Spill Mix（溢出混合）
7. Red-Layer Threshold Bias（红色感光层阈值偏移）
8. Threshold（阈值） + Source Softness（光源柔和度）
9. Source Impact（光源影响） + Strong Source Level（强光源级别）
10. Hue Response（色相响应）
11. Strong Source Expansion（强光源扩张）
12. Sigma（半径 Sigma） + PSF Smoothness（PSF 平滑度） + Red Tail（红色尾部）
13. Sigma Ratio（Sigma 比例） + Red Shift（红移）
14. Center Attenuation（中心衰减） + Strong Core（强光核心） + Source Interior Protection（光源内部保护）
15. Background Threshold（背景阈值） + Blue Compensation（蓝色补偿）
16. Global Source Level（全局光源级别） + Global Red Diffusion（全局红色扩散）
17. Halation Amplify（胶片光晕增益） + Halation Color Density（胶片光晕色彩密度）
18. Strength（强度） + Blend Mode（混合模式） + Highlight Rolloff（高光滚降）
19. Threshold (EV)（阈值（EV））/Softness (EV)（柔和度（EV）） + Radius (% diagonal)（半径（对角线百分比））
20. Amplify（增益） + Saturation（饱和度） + Save lights（保留高光）
21. Amount（数量） + Threshold (EV)（阈值（EV））/Softness (EV)（柔和度（EV））
22. 各节点 Luma mask（需要局部曝光范围时）
23. Resolution loss（解析度损失） + MTF response（MTF 响应）
24. Shadow loss（暗部损失） + Highlight loss（高光损失）
25. Grain Amount（数量） + Size（尺寸）
26. Grain Roughness（粗糙度） + Chroma（色度） + Correlation（相关模式）
27. Randomize grain（随机化颗粒）（需要另一套排列时）
```

这套顺序先决定物理画幅和感光度，再处理边缘色差，接着决定“谁产生 Halation/Bloom”和“光晕长什么样”，随后确定高光保护、解析度和颗粒，最后固定随机排列。mask 适合在效果方向确定后收窄曝光范围；这样比一开始反复拉 Strength 或 Grain Amount 更容易获得可控、可重复的结果。
