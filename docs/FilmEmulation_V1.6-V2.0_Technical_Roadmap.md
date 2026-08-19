# Film Emulation V1.6–V2.0 技术路线与实现规格

> 状态：待审批  
> 文档版本：1.0  
> 编制日期：2026-08-20  
> 实现基线：当前 V1.5.0 工作区  
> 适用范围：V1.5.1 迁移桥接版及 V1.6–V2.0 后续版本

## 1. 文档目的与证据边界

本文档给出 Film Emulation 插件从 V1.6 到 V2.0 的决策完整技术路线，用于后续代码实现、测试、验收和发布。实现者应当把本文档视为未来版本的规格，而不是当前 V1.5 已实现功能的描述。

当前 V1.5 基线具有以下事实：

- UXP manifest ID 为 `com.cheukwing.filmhalation`，最低 Photoshop 版本为 23.3。
- `processFilm()` 和 schema v2 已存在，但当前只执行一个 Halation 节点。
- 当前公共效果顺序为 `Defringe → Vignette → Halation → Bloom → Highlight Protection → Film Resolution → Grain → Damage → Overscan`。
- 图像算法以线性 sRGB primaries 的浮点 RGB 工作；Imaging API 层负责文档色彩空间和位深转换。
- 文档参数和图层绑定保存在 `getDataFolder()` 对应的插件专属数据目录中。
- 当前工作区含有未提交的 V1.5 修改，后续开发不得覆盖、重置或丢弃这些修改。

研究依据分为三类：

1. Kodak 等胶片厂商资料用于理解 sensitometry、granularity、MTF、画幅和片孔的测量语义。
2. 论文和公开算法资料用于建立可复现的 MTF、颗粒功率谱、色差和暗角模型。
3. Dehancer、FilmConvert 等竞品的公开资料只用于确认功能分类、用户可见行为和控制维度。其内部代码、素材、参数和预设均视为未知且不可复制。

主要参考资料：

- [Kodak VISION3 500T 5219/7219 Technical Information](https://www.kodak.com/content/pdfs/motion/KODAK-VISION3-500T-5219-7219-technical-information.pdf)
- [Kodak Film Format Choices](https://www.kodak.com/content/products-brochures/Film/Film-Format-Choices-Infographic.pdf)
- [Kodak Essential Reference Guide for Filmmakers](https://www.kodak.com/content/products-brochures/Film/kodak-essential-reference-guide-for-filmmakers.pdf)
- [Photographic Wiener Spectrum](https://opg.optica.org/josa/abstract.cfm?uri=josa-52-6-669)
- [A Practical Model for Photographic Film](https://www.impa.br/~lvelho/ip02/papers/sigg97.pdf)
- [IPOL Chromatic Aberration Correction](https://www.ipol.im/pub/art/2023/443/)
- [Single-Image Vignetting Correction](https://grail.cs.washington.edu/projects/vignette/vign.iccv05.pdf)
- [Dehancer Grain](https://www.dehancer.com/learn/article/grain)
- [Dehancer Grain Algorithm Overview](https://www.dehancer.com/learn/articles/how-does-film-grain-work-in-dehancer-ofx-plugin)
- [Dehancer Bloom](https://www.dehancer.com/learn/articles/bloom-how-it-works)
- [Dehancer Film Damage](https://www.dehancer.com/learn/articles/dehancer-film-damage)
- [Dehancer Overscan](https://www.dehancer.com/learn/articles/dehancer-overscan-tool)
- [Dehancer Halation and Defringe](https://www.dehancer.com/learn/articles/halation-in-dehancer)
- [Adobe Photoshop UXP Imaging API](https://developer.adobe.com/photoshop/uxp/2022/ps-reference/media/imaging/)

本文给出的档案常数是本项目的初始工程参数，不宣称复刻某一真实胶片库存。正式发布前必须使用实拍或合法扫描样本进行校准，并把校准来源记录在档案 metadata 中。

## 2. 产品边界与不可破坏的处理规则

插件接收已经完成 ACR、Photoshop 预设或其他调色的图像，只模拟胶片成像中的光学、乳剂、颗粒、机械损伤和扫描边界效果，不提供胶片色彩配置。

默认物理处理顺序：

```text
外部颜色预设
→ Defringe
→ Vignette
→ Halation
→ Bloom
→ Highlight Protection
→ Film Resolution / MTF
→ Grain
→ Damage
→ Overscan
```

所有版本必须遵守以下规则：

- 输入在 `io/` 层转换为线性 sRGB primaries；输出前才转换回 Photoshop 文档工作空间及 TRC。
- `core/` 不得读取 ICC、UXP、Photoshop、DOM 或文件系统。
- RGB 使用 straight RGB，不使用预乘 alpha。
- alpha 在 V1.6–V2.0 中逐样本保持；完全透明像素不得参与光源、颗粒和损伤生成。
- 除 Overscan 外，所有节点保持宽高不变。
- 禁止使用 `Math.random()`、当前时间、处理顺序或瓦片编号作为渲染随机源。
- Fast 与 Quality 只能改变采样精度、尺度数量和计算后端，不能改变效果定义和物理参数。
- 用户把效果量设为零时，节点必须逐浮点样本恒等。
- 中间 HDR 值不得为了方便而裁到 0–1；只允许在掩模计算、量化和 Photoshop 位深边界处按规格限制。
- 所有效果必须支持取消；过期的异步预览结果不得覆盖更新后的参数。
- Apply 始终从绑定源层重新计算，不得在上一次效果层上重复叠加。

## 3. 插件身份与 V1.5.1 迁移桥接

### 3.1 V1.6 起的插件身份

从 V1.6.0 起，UXP manifest ID 固定为：

```json
{
  "id": "com.cheukwing.filmemulation"
}
```

配套规则：

- `package.json.name` 改为 `film-emulation`。
- V1.6–V1.9 面板显示名暂时保留 `Film Halation`，避免把品牌改名和引擎扩展混成一次变更。
- V2.0 面板显示名改为 `FilmLab`。
- V1.6 保留 entrypoint ID `filmHalationPanel`，不额外改变面板标识。
- schema v2 的 `plugin: "FilmHalation"` 保留到 V1.9，以维持序列化格式兼容。
- V2 schema v3 改为 `plugin: "FilmEmulation"`，并接受 `FilmHalation` 和 `FilmLab` 作为迁移来源。

### 3.2 为什么需要 V1.5.1

UXP 的 `getDataFolder()` 按插件 ID 隔离。改为新 ID 后，新插件不能直接读取旧 ID `com.cheukwing.filmhalation` 的缓存。因此必须先发布一个仍使用旧 ID 的 V1.5.1 迁移桥接版。

迁移顺序：

1. V1.5.1 使用旧 ID，只增加迁移导出功能，不加入新效果。
2. 用户在 V1.5.1 中执行 `Export Migration Package`。
3. V1.6.0 使用新 ID，并提供 `Import V1.5 State`。
4. V1.6 把导入状态写入新插件的数据目录；旧目录及导出文件不删除。
5. 导入的图层绑定只作为候选绑定，打开文档时仍须严格验证。

迁移文件结构：

```ts
interface MigrationBundleV1 {
  kind: "FilmEmulationMigration";
  bundleVersion: 1;
  sourcePluginId: "com.cheukwing.filmhalation";
  sourceEngineVersion: string;
  exportedAt: string;
  documents: Array<{
    document: FilmLabDocumentV2;
  }>;
  crc32: string;
}
```

迁移安全规则：

- 文件扩展名固定为 `.filmemulation-migrate.json`。
- 最大文件大小 10MB，最多 10,000 个文档条目。
- UTF-8 编解码使用项目内实现，不依赖 UXP 中可能缺失的 `TextEncoder`。
- CRC32 对不含 `crc32` 字段的规范化 UTF-8 payload 计算，用于检测损坏，不作为安全签名。
- 每个文档独立执行 schema 迁移和严格校验，一个条目失败不阻止其他有效条目。
- 相同 fingerprint 已存在时默认保留新插件当前状态，UI 允许用户逐项选择导入覆盖。
- 导入后保存 bundle CRC32 回执，重复导入时提示，不自动再次覆盖。
- layer id、name 和 token 必须同时按现有严格绑定策略验证；歧义时要求 Rebind。
- 迁移包不得包含图像像素、缩略图、WASM、Damage 素材或任意可执行内容。

## 4. 公共架构与数据模型

### 4.1 效果注册表

新增唯一的效果注册表。serializer、UI、graph 执行器、缓存和测试均从注册表读取节点信息，禁止分别维护不一致的效果列表。

```ts
type EffectType =
  | "defringe"
  | "vignette"
  | "halation"
  | "bloom"
  | "highlightProtection"
  | "filmResolution"
  | "grain"
  | "damage"
  | "overscan";

interface EffectDefinition<P> {
  type: EffectType;
  introducedIn: string;
  physicalStage: number;
  defaults: Readonly<P>;
  validate(raw: unknown): P;
  estimateMemory(
    frame: FrameGeometry,
    params: P,
    context: RenderContext
  ): MemoryEstimate;
  process(
    input: RenderFrame,
    params: P,
    context: RenderContext
  ): NodeRenderResult;
}
```

默认 stage：

| Stage | 节点 |
|---:|---|
| 10 | Defringe |
| 20 | Vignette |
| 30 | Halation |
| 40 | Bloom |
| 50 | Highlight Protection |
| 60 | Film Resolution |
| 70 | Grain |
| 80 | Damage |
| 90 | Overscan |

V1.6–V1.9 保存时把 graph 规范化为默认顺序。V2 允许受约束重排：

- Defringe 必须在 Halation 和 Bloom 之前。
- Vignette 必须在 Halation 之前。
- Highlight Protection 必须紧随其绑定的 Bloom。
- Film Resolution 必须在 Grain 之前。
- Damage 必须在 Grain 之后。
- Overscan 永远最后。
- Halation 与 Bloom 可以交换相对顺序。
- 同类型的多个节点可以自由重排。
- 非法拖动立即回弹并显示违反的依赖关系，不得保存非法 graph。

### 4.2 图像和执行接口

```ts
interface ImageBuffer {
  width: number;
  height: number;
  rgb: Float32Array;
  alpha?: Float32Array;
}

interface RenderFrame extends ImageBuffer {
  transient: {
    bloomBase?: Float32Array;
    bloomContribution?: Float32Array;
  };
}

interface FilmFormatProfile {
  id: "super8" | "super16" | "super35-4perf" | "65mm-5perf";
  gauge: "8mm" | "16mm" | "35mm" | "65mm";
  stockWidthMm: number;
  apertureWidthMm: number;
  apertureHeightMm: number;
  framePitchMm: number;
  perforation: PerforationProfile;
}

interface RenderContext {
  width: number;
  height: number;
  fullWidth: number;
  fullHeight: number;
  originX: number;
  originY: number;
  quality: "fast" | "quality";
  seed: number;
  format: FilmFormatProfile;
  previewScale: number;
  memoryPlan: MemoryPlan;
  signal?: AbortSignal;
}

interface NodeStats {
  id: string;
  type: EffectType;
  backend: "js" | "wasm";
  elapsedMs: number;
  scratchBytes: number;
  warnings: string[];
}

interface RenderResult extends ImageBuffer {
  stats: {
    engineVersion: string;
    effectiveSeed: number;
    nodes: NodeStats[];
    peakTrackedBytes: number;
    outputGeometryChanged: boolean;
  };
}
```

`originX/originY` 表示当前分带在完整图像中的绝对坐标。所有随机效果必须以完整坐标寻址，确保 band height、执行顺序和 JS/WASM 后端不改变结果。

### 4.3 共享物理格式

首批格式档案：

| 档案 | 胶片宽度 | 有效画幅 | 帧距/帧高 |
|---|---:|---:|---:|
| Super 8 | 8.00mm | 5.79 × 4.01mm | 4.234mm |
| Super 16 | 16.00mm | 12.52 × 7.41mm | 7.620mm |
| Super 35 4-perf | 35.00mm | 24.89 × 18.66mm | 19.000mm |
| 65mm 5-perf | 65.00mm | 52.15 × 23.07mm | 23.750mm |

所有物理尺寸统一通过以下方式换算：

```text
pixelsPerMm = fullWidth / apertureWidthMm
pixelsPerMicron = pixelsPerMm / 1000
physicalRadiusPx = radiusMicron × pixelsPerMicron
```

格式档案改变颗粒、MTF、Damage 和 Overscan 的空间换算，不改变外部颜色预设。

### 4.4 Schema 策略

V1.6–V1.9 继续使用 schema v2，逐版本扩大允许的节点联合类型：

```ts
interface FilmLabDocumentV2 {
  plugin: "FilmHalation";
  schemaVersion: 2;
  engineVersion: string;
  minimumEngineVersion: string;
  format: {
    gauge: "8mm" | "16mm" | "35mm" | "65mm";
    iso: number;
  };
  graph: EffectNodeV2[];
  bindings: {
    sourceLayer: LayerBinding | null;
    targetLayer: LayerBinding | null;
  };
  documentFingerprint: DocumentFingerprint | null;
}
```

规则：

- 未知 schemaVersion 必须拒绝。
- 已知 schema 但含当前引擎不支持的节点时，报告节点和所需最低引擎版本。
- 禁止旧版本在失败后重贴版本号、丢弃未知节点或覆盖原缓存。
- 每个节点具有稳定 UUID；迁移来的 Halation 可保留 `halation-main`。
- 所有数值拒绝 `NaN`、`Infinity` 和越界值。
- serializer 使用固定键序，同一状态产生逐字节一致 JSON。
- schema v2 的 `plugin` discriminator 不因 manifest ID 改变。

V2 升级至 schema v3，用于节点蒙版、受约束重排和统一预设。

## 5. 内存分档、分带与预检

Adobe Imaging API 文档会对约 600MB 的插件内存使用发出警告，因此放宽目标不能代替分带、减少临时 plane 和及时 `dispose()`。600MB 不再作为整个产品的硬发布门槛，但仍是必须记录和响应的诊断阈值。

运行时档位：

| 档位 | 目标机器 | Soft budget | Hard budget |
|---|---|---:|---:|
| Balanced，默认 | 16GB | 1.0GiB | 1.5GiB |
| High Memory | 32GB 或以上 | 1.5GiB | 2.5GiB |

预算计算包括插件可追踪的 JS TypedArray、WASM linear memory、待写回 buffer 和 `PhotoshopImageData` 估算，不等同于 Photoshop 全进程内存。

```ts
interface MemoryPolicy {
  mode: "balanced" | "high";
  softLimitBytes: number;
  hardLimitBytes: number;
  minimumBandHeight: 64;
  safetyMargin: 0.15;
}

interface MemoryPlan {
  bandHeight: number;
  overlapTop: number;
  overlapBottom: number;
  estimatedPeakBytes: number;
  lowResolutionScales: Record<string, 1 | 2 | 4 | 8>;
}
```

自动计划规则：

1. 默认使用 Balanced，不解析不稳定或本地化的系统信息字符串。
2. 用户可在全局设置启用 High Memory；该设置不写入文档和预设。
3. 每次 Preview、Apply 和 Overscan 前计算峰值：`live planes + WASM pages + I/O staging + kernel/cache + 15% margin`。
4. 初始 band height 为 1024 行，超过 soft budget 时依次降为 512、256、128、64。
5. overlap 等于当前节点最大有效 PSF 半径；写出时裁掉 overlap。
6. 宽 PSF plane 优先降至 1/2、1/4 或 1/8；源 RGB、alpha、mask 和最终合成保持全分辨率。
7. 进入约 600MB 警告区时释放面板预览缓存、旧节点缓存和失效 WASM view，但不静默降低 Quality。
8. 最小 64 行仍超过 hard budget 时，在任何图层写入前终止，报告估算峰值和解决建议。
9. `PhotoshopImageData` 复制完数据后立即 `dispose()`；节点结束后清空不再需要的 transient 引用。
10. 常规 24MP、16位默认图仍应尽量接近或低于 600MB；更高预算主要服务于 32位、超高分辨率和 Overscan。

## 6. V1.6 — Film Grain & Resolution

### 6.1 实现顺序

1. 扩展 schema v2、格式档案、效果注册表和 deterministic seed。
2. 完成纯 JavaScript 权威参考实现和单元测试。
3. 完成全图/分带一致性和视觉金图。
4. 将卷积、随机场和密度合成移入 WASM。
5. 接入 UXP Preview/Apply 和内存预检。
6. 最后开放 UI，避免参数先于可验证算法出现。

### 6.2 Film Resolution / MTF

```ts
interface FilmResolutionParams {
  amount: number;        // 0..1.5, default 1
  response: number;      // 0.5..2, default 1
  toeLoss: number;       // 0..1, default 0.25
  shoulderLoss: number;  // 0..1, default 0.15
  profile: "negative" | "positive";
}
```

基础 MTF50：

```text
negativeBase = 56 cycles/mm
positiveBase = 42 cycles/mm

isoFactor = clamp((250 / iso)^0.10, 0.75, 1.25)
f50Mm = clamp(base × isoFactor × response, 12, 120)
f50Px = f50Mm / pixelsPerMm
sigmaPx = sqrt(ln(2)) / (sqrt(2) × π × max(f50Px, 1e-4))
```

Gaussian MTF：

```text
MTF(f) = exp(-2π²σ²f²)
```

算法：

1. 对线性 RGB 三通道使用完全相同的 Gaussian PSF，避免色边。
2. `sigmaPx < 0.15` 时视为恒等。
3. 曝光 `x = log2(max(Y, 1e-6) / 0.18)`。
4. Toe 权重 `toe = 1 - smoothstep(-6, -2, x)`。
5. Shoulder 权重 `shoulder = smoothstep(2, 6, x)`。
6. `a = clamp(amount × (1 + toeLoss×toe + shoulderLoss×shoulder), 0, 1.5)`。
7. 当 `a≤1`：`out = input + a×(blur-input)`。
8. 当 `a>1`：先应用完整第一层，再把 `a-1` 作为权重混入 `Gaussian(2.2σ)`；所有权重保持非负。
9. 不使用反遮罩锐化、负瓣 kernel 或高频增益。
10. alpha 不参与卷积且逐样本复制。

### 6.3 密度相关 Film Grain

```ts
interface GrainParams {
  amount: number;       // 0..2, default 1
  size: number;         // 0.5..2, default 1
  roughness: number;    // 0..1, default 0.55
  chroma: number;       // 0..1, default 0.18
  profile: "negative" | "positive";
  mode: "analogue" | "fast";
  seedMode: "fixed" | "randomOnCreate";
  seed: number;         // uint32
}
```

Seed 规则：

- `fixed` 直接保存用户 seed。
- `randomOnCreate` 只在创建节点时生成一次 uint32 并写入文档；每次 Preview/Apply 不再变化。
- `Randomize` 按钮显式生成并保存新 seed。
- 重开、批处理、撤销重做和 JS/WASM 回退必须复现。

随机场使用无状态坐标哈希：

```text
h = hash32(seed, nodeIdHash, absoluteX, absoluteY, scaleIndex, channelIndex)
uniform = h / 2^32
gaussianApprox = sum(12 independent uniform values) - 6
```

不使用依赖不同平台超越函数精度的 Box–Muller 实现。

物理尺度：

```text
isoSizeFactor = clamp((iso / 250)^0.28, 0.65, 2.2)
baseDiameter = 7.5 microns × isoSizeFactor × size

fine   = 0.65 × baseDiameter
medium = 1.35 × baseDiameter
coarse = 2.80 × baseDiameter
```

Analogue 模式：

- 使用 fine、medium、coarse 三个随机场。
- 默认方差权重 `[0.46, 0.38, 0.16]`。
- roughness 在 fine 和 coarse 之间连续重分配，保持总方差不变。
- 每个场按物理直径换算并执行 Gaussian correlation。
- 通道噪声由共享场和独立场组成：

```text
sharedWeight = sqrt(1 - 0.35 × chroma)
independentWeight = sqrt(0.35 × chroma)
Nc = sharedWeight × Nshared + independentWeight × Nchannel
```

Fast 模式：

- 只使用 medium、coarse 两尺度。
- 提高共享场占比，减少通道独立卷积。
- 与 Analogue 保持相同均值、总方差和主要功率谱峰，允许高频尾部不同。

曝光包络：

```text
x = log2(max(Y, 1e-6) / 0.18)

negativeEnvelope =
  0.42 + 0.58 × exp(-0.5 × ((x + 0.5) / 2.0)^2)

positiveEnvelope =
  0.35 + 0.75 × exp(-0.5 × ((x - 0.3) / 1.4)^2)
```

密度合成：

```text
sigmaD = 0.085 × amount × sqrt(iso / 250) × exposureEnvelope
z = ln(2) × sigmaD × Nc
gain = exp(z - 0.5 × variance(z))
outChannel = inputChannel × gain
```

`-0.5×variance` 用于均值修正。其他规则：

- 不把噪声直接叠加到编码域 RGB。
- 不先裁掉 HDR 再生成颗粒。
- 半透明像素使用 `mix(input, grained, alpha)`；alpha 为零时 RGB 保持输入。
- 最终负值只在量化边界处理，不用粗暴 clamp 改变中间均值。
- Grain 不得改变均匀中性灰的平均色度。

### 6.4 V1.6 验收

- 相同 seed、尺寸、参数和 origin 下输出逐样本一致。
- 不同 band height、瓦片顺序、JS/WASM 的 RMS ≤ `1e-5`。
- 18%、50%、90% 灰场平均亮度漂移 ≤ 0.1%。
- 中性灰平均 `R-G`、`B-G` 偏移 ≤ `1e-4`。
- 四种格式的颗粒表观尺寸按 `pixelsPerMm` 缩放，误差 ≤ 5%。
- ISO 翻倍后的方差和颗粒尺度与公式误差 ≤ 5%。
- 功率谱主峰与目标尺度误差 ≤ 10%，无规则网格或瓦片周期峰。
- MTF50 实测与目标误差 ≤ 10%。
- 细线响应无负值，无超过输入峰值 0.5% 的过冲。
- 24MP、16位、Balanced、默认 V1.6 graph：Apply P95 ≤ 4秒。
- 1024px Preview P95 ≤ 250ms。

## 7. V1.7 — Bloom & Optical Preparation

### 7.1 Defringe

```ts
interface DefringeParams {
  amount: number;           // 0..1, default 0.65
  radiusPx: number;         // 0.5..4, default 1.5
  threshold: number;        // 0..1, default 0.08
  softness: number;         // 0.01..0.5, default 0.12
  edgeSensitivity: number;  // 0..2, default 1
}
```

使用线性 YCoCg：

```text
Y  = (R + 2G + B) / 4
Co = (R - B) / 2
Cg = (-R + 2G - B) / 4
```

算法：

1. `Yblur = Gaussian(Y, radiusPx)`。
2. `CgBlur = Gaussian(Cg, radiusPx)`。
3. `edge = abs(Y-Yblur)`。
4. `fringe = abs(Cg-CgBlur)`。
5. `Medge = smoothstep(0.01/edgeSensitivity, 0.08/edgeSensitivity, edge)`。
6. `Mchroma = smoothstep(threshold, threshold+softness, fringe)`。
7. `M = Medge × Mchroma × alpha`。
8. `CgOut = mix(Cg, CgBlur, amount×M)`，保留 Y 和 Co。
9. 使用精确逆矩阵恢复 RGB。
10. 中性边缘因 `fringe≈0` 不得被模糊。

Defringe 只抑制紫/绿轴的局部异常，不充当全局降饱和或 RGB 模糊。

### 7.2 Bloom

```ts
interface BloomParams {
  thresholdEV: number; // -2..8, default 2
  softnessEV: number;  // 0.1..4, default 1
  radius: number;      // 0.05..5 % diagonal, default 0.7
  amplify: number;     // 0..4, default 0.55
  saturation: number;  // 0..1.5, default 0.85
  saveLights: number;  // 0..1, default 0.45
}
```

提取：

```text
T = 0.18 × 2^thresholdEV
gate = smoothstep(T, T × 2^softnessEV, max(R,G,B))
source = RGB × gate × alpha
```

色彩控制：

```text
sourceY = luminance(source)
sourceColor = mix([sourceY,sourceY,sourceY], source, saturation)
```

三瓣 PSF：

| Lobe | sigma | weight |
|---|---:|---:|
| Core | `0.22 × radiusPx` | 0.62 |
| Mid | `0.75 × radiusPx` | 0.28 |
| Tail | `2.40 × radiusPx` | 0.10 |

- Core 全分辨率。
- Mid 根据有效 sigma 使用 1/2 或 1/4。
- Tail 使用 1/4 或 1/8。
- 使用面积降采样和中心对齐插值。
- Bloom 不读取 Halation 光谱 source，不使用红移或暗侧门控。
- 贡献采用线性 additive HDR 合成，不得使像素变暗。

Save Lights：

```text
lightMask = smoothstep(T, T × 2^softnessEV, maxRGB)
savedContribution = bloomContribution × (1 - saveLights × lightMask)
output = input + amplify × savedContribution
```

### 7.3 Highlight Protection

```ts
interface HighlightProtectionParams {
  amount: number;       // 0..1, default 0.5
  thresholdEV: number;  // 0..8, default 2.5
  softnessEV: number;   // 0.1..4, default 1
}
```

Bloom 在 transient bus 保存 `bloomBase` 和尚未合成的 `bloomContribution`。Highlight Protection 只调制这一贡献：

```text
T = 0.18 × 2^thresholdEV
P = smoothstep(T, T × 2^softnessEV, maxRGB(bloomBase))
output = bloomBase + bloomContribution × (1 - amount×P)
```

如果前面没有 Bloom contribution：

- 返回输入不变。
- stats 添加 `missingBloomContribution`。
- UI 显示当前无作用，但不删除节点。

### 7.4 V1.7 内置亮度遮罩

```ts
interface LumaMask {
  mode: "none" | "luma";
  lowEV: number;
  highEV: number;
  softnessEV: number;
  invert: boolean;
}
```

- mask 在节点输入的线性亮度上计算。
- additive 效果乘贡献量。
- replacement 效果使用 `mix(input,effected,mask)`。
- mask 不写回 alpha。
- Photoshop 图层蒙版绑定留到 V2。

### 7.5 V1.7 验收

- 中性黑白边缘 Defringe 差异 RMS ≤ `1e-5`。
- 紫/绿合成色边异常色度降低至少 60%，亮度边缘 MTF50 损失不超过 5%。
- Bloom impulse PSF 非负、归一、径向单调且无红色偏移。
- Bloom 对等能量红、绿、蓝输入的亮度增益误差 ≤ 2%。
- `amplify=0`、`amount=0` 和空 mask 均逐样本恒等。
- Bloom 永不使 HDR 高光变暗。
- Save Lights 和 Highlight Protection 不回滚 Halation 或 Vignette。
- 24MP、16位默认完整 graph P95 ≤ 6秒。
- 1024px Preview P95 ≤ 350ms。

## 8. V1.8 — Vignette & Film Damage

### 8.1 物理 Vignette

```ts
interface VignetteParams {
  amountStops: number;  // 0..4, default 0.65
  edgeAngleDeg: number; // 10..70, default 38
  softness: number;     // 0.05..1, default 0.65
  roundness: number;    // -1..1, default 0
  centerX: number;      // -1..1, default 0
  centerY: number;      // -1..1, default 0
}
```

算法：

1. 使用完整画幅坐标，不使用当前 band 局部坐标。
2. `roundness` 调整椭圆横纵比例并保持中心增益为 1。
3. 令 `r=1` 对应较短方向画幅边缘。
4. `theta = atan(r × tan(edgeAngle))`。
5. 基础透射率 `T = cos(theta)^4`。
6. 计算 `r=1` 时的 `Tedge`。
7. `exponent = amountStops / max(-log2(Tedge), 1e-6)`。
8. `w = smoothstep(max(0,1-softness), 1, r)`。
9. `gain = exp2(exponent × log2(max(T,1e-6)) × w)`。
10. `output = input × gain`。

Vignette 对三通道使用相同 gain，不加入色偏，并在 Halation/Bloom 之前执行。

### 8.2 Damage 数据模型

```ts
interface DamageParams {
  amount: number; // 0..2, default 0.35
  seed: number;
  dust: DustParams;
  hairs: HairParams;
  scratches: ScratchParams;
  stains: StainParams;
  lightLeaks: LightLeakParams;
  assetMix: number; // 0..1, default 0.4
}
```

共同规则：

- 所有尺寸、密度和位置使用毫米坐标。
- 根据完整画幅生成一次 deterministic object list，再按 spatial bin 分配给 band。
- 禁止每个 band 独立生成对象。
- 预览使用同一 seed 和毫米坐标，可减少对象数；Apply 使用完整对象集。
- Damage 位于 Grain 之后。
- 暗损伤使用密度/透射率合成，亮划痕和漏光使用线性曝光增量。
- alpha 不变。

Dust：

- 数量来自 `Poisson(densityPerMm2 × frameAreaMm2)`。
- 椭圆半径 8–180μm，使用截断 log-normal 分布。
- SDF 边缘加入低频扰动，避免规则圆点。
- 支持 dark/bright polarity 比例。

Hairs：

- 使用 2–5 个控制点的 cubic Bézier。
- 宽度 12–90μm，沿路径渐细。
- 曲率、旋转、长度和透明度由坐标哈希确定。
- 抗锯齿使用解析 coverage 或至少 4× 子采样。

Scratches：

- 主方向沿胶片传送方向，可在 ±12° 内偏移。
- 长度为画幅高度的 5%–120%。
- 宽度 4–45μm。
- 由主线、间断 mask 和低频横向漂移组成。
- 支持 dark emulsion scratch 和 bright base scratch。

Stains：

- 使用低频 value/Worley field 与椭圆 envelope。
- 物理直径 0.2–8mm。
- 不得产生明显周期纹理。

Light Leaks：

- 从片门边缘生成 1–3 个曝光源。
- 使用宽 Gaussian 或 Voigt-like 非负扩散。
- 支持 neutral/warm/cool；默认 warm 只能轻微提高红通道。
- HDR additive，不使原图变暗。

合成：

```text
darkDensity >= 0
transmission = exp(-darkDensity)
darkResult = input × transmission

brightExposure >= 0
output = darkResult + brightExposure
```

### 8.3 扫描素材包

开发期允许程序化占位素材；V1.8 正式发布必须包含项目自有或明确商业授权的真实扫描素材。

```ts
interface DamageAssetManifestEntry {
  id: string;
  kind: "dust" | "hair" | "scratch" | "stain" | "lightLeak";
  path: string;
  sha256: string;
  scanWidthMm: number;
  scanHeightMm: number;
  bitDepth: 8 | 16;
  source: string;
  licenseId: string;
  licenseTextPath: string;
  commercialUse: true;
  attribution?: string;
}
```

发布门禁：

- 素材位于 `assets/damage/`。
- SHA-256 必须匹配。
- 必须提供 license、来源和 `commercialUse:true`。
- CI 发现缺项立即失败。
- 禁止运行时从竞品或未知 URL 下载纹理。
- 高分辨率检查不得出现规则 tile seam。
- 素材只允许旋转、镜像、缩放、裁切、密度和色调变换，不无限放大低分辨率素材。

### 8.4 V1.8 验收

- Vignette 中心增益为 1，径向增益非增，默认角落衰减误差 ≤ 0.05 stop。
- 中心偏移和 roundness 在四种格式下符合几何金图。
- Damage 相同 seed 完全可复现。
- band height 不改变对象位置。
- 四种格式下对象的毫米尺寸保持一致。
- Dust/Hair/Scratch 密度误差处于泊松置信范围。
- 均匀输入无瓦片边界或固定网格。
- 素材缺失或损坏时回退程序化实现并警告；正式 package gate 不允许缺少授权素材。
- 24MP、16位默认完整 graph P95 ≤ 8秒。
- 1024px Preview P95 ≤ 350ms。

## 9. V1.9 — Overscan & Film Gate

### 9.1 非破坏输出

Overscan 不改变当前文档画布。Apply 流程：

1. 计算目标几何和峰值内存。
2. 显示目标宽高、像素数、预计内存、位深和工作空间。
3. 用户明确确认。
4. 新建 Photoshop 文档，沿用源文档位深和颜色配置。
5. 在新文档中创建效果像素层并写入结果。
6. 源文档及全部图层保持不变。
7. 失败或取消时关闭未完成的空白新文档，不保存到磁盘。

### 9.2 几何规划接口

```ts
interface OverscanPlan {
  outputWidth: number;
  outputHeight: number;
  outputBoundsMm: Rect;
  apertureBoundsMm: Rect;
  imageTransform: AffineTransform;
  estimatedPeakBytes: number;
}

interface OverscanParams {
  borderScale: number; // 0.8..1.5, default 1
  rotationDeg: number; // -5..5, default 0
  offsetXmm: number;
  offsetYmm: number;
  gateSoftnessMm: number; // 0..0.5
  edgeExposure: number;   // 0..2
  showPerforations: boolean;
  perforationMode: "backlit" | "black" | "transparent";
  background: "black" | "transparent";
  orientation: "vertical" | "horizontal";
}
```

默认保持源图物理采样密度：

```text
pixelsPerMm = sourceWidth / apertureWidthMm
outputWidth = evenCeil(stockWidthMm × pixelsPerMm × borderScale)
outputHeight = evenCeil(framePitchMm × pixelsPerMm × borderScale)
```

限制：

- 任一边超过 Photoshop 可创建上限时，在创建新文档前拒绝。
- 估算峰值超过当前 hard budget 时拒绝。
- 输出超过 200MP 时显示额外警告，但仍服从 hard budget 和 Photoshop 上限。
- 旋转后的图像不得被自动裁掉，计划阶段必须计算完整 bounding box。
- 几何先使用毫米坐标计算，最后一次性换算并 rounding。

### 9.3 片门和片孔

初始 perforation 数据：

| 格式 | 孔尺寸起始值 | 孔距 | 默认侧 |
|---|---:|---:|---|
| Super 8 | 0.914 × 1.143mm | 4.234mm | 单侧 |
| Super 16 | 1.829 × 1.270mm | 7.620mm | 单侧 |
| Super 35 | 2.794 × 1.981mm | 4.750mm | 双侧 |
| 65mm | 2.794 × 1.981mm | 4.750mm | 双侧 |

实现要求：

- 片门和片孔使用解析 rounded-rectangle/SDF，不使用低分辨率 PNG 边框。
- 使用至少 4× 子像素 coverage 或等价解析抗锯齿。
- `gateSoftnessMm` 只作用于片门边界。
- `edgeExposure` 是边界附近的非负曝光泄漏，不模糊整个画面。
- `backlit` 使用中性、非负且高于黑边的扫描背光值。
- `transparent` 令片孔和胶片外区域 alpha 为零；画幅内部保留源 alpha。
- `black` background 为不透明线性黑。
- 方向切换同时旋转片门、片孔排列和 scratch 主方向语义。

### 9.4 V1.9 验收

- 四种格式具有毫米坐标和最终像素几何金图。
- 计划尺寸与新文档实际宽高逐像素一致。
- 源文档、源层和原效果层 hash 不变。
- 取消确认不创建文档。
- 中途失败不留下半成品图层或无标题文档。
- 透明背景和片孔 alpha 正确。
- 任意允许的旋转、偏移均不裁切输入。
- 撤销只影响新文档写入。
- 24–40MP Overscan 输出 P95 ≤ 12秒。

## 10. V2.0 — FilmLab Suite

### 10.1 Schema v3

```ts
interface FilmLabDocumentV3 {
  plugin: "FilmEmulation";
  schemaVersion: 3;
  engineVersion: string;
  minimumEngineVersion: string;
  format: {
    profileId: "super8" | "super16" | "super35-4perf" | "65mm-5perf";
    iso: number;
  };
  seed: number;
  graph: EffectNodeV3[];
  bindings: {
    sourceLayer: LayerBinding;
    targetLayer: LayerBinding | null;
  };
}

interface EffectNodeV3 {
  id: string;
  type: EffectType;
  enabled: boolean;
  params: unknown;
  mask?: NodeMask;
}

interface NodeMask {
  source: "none" | "luma" | "photoshopLayerMask";
  layer?: LayerBinding;
  kind?: "user" | "vector";
  invert: boolean;
  density: number;
  featherPx: number;
}
```

迁移规则：

- schema v1 `effects.halation` → schema v2 单节点 → schema v3 graph。
- schema v2 的 format、seed、binding 和节点 UUID 全部保留。
- schema v2 亮度 mask 转成 v3 `source:"luma"`。
- `FilmHalation` 和 `FilmLab` discriminator 可迁移。
- schema 高于 3 必须拒绝。
- future node 不得在读取后被丢弃并保存。

### 10.2 Photoshop 图层蒙版

V2 使用 Imaging API `getLayerMask()` 直接读取用户或矢量蒙版，不创建临时通道，不修改蒙版所属图层。

流程：

1. 用户选择一个 Photoshop 图层及其 mask。
2. 保存 owner layer 的严格 `LayerBinding` 和 mask `kind`。
3. Preview 使用与图像相同的 `targetSize`。
4. Apply 按当前 band 的 `sourceBounds` 读取 mask。
5. 复制单通道数据后立即 `dispose()`。
6. 归一化为 0–1。
7. invert 使用 `1-mask`。
8. Photoshop 风格 density：`mask = 1 - density×(1-mask)`。
9. `featherPx>0` 时执行中心对齐 Gaussian。
10. replacement 节点使用 `mix(input,effected,mask)`；additive 节点乘 contribution。
11. layer 或 mask 不存在、绑定不一致或匹配歧义时阻止 Apply 并要求重新绑定。
12. 不按当前选中图层静默替换失效 mask。

### 10.3 统一节点编辑器

UI 由 effect registry 生成，禁止为每个节点复制一套状态管理代码。

功能：

- 节点启用、添加、删除和 Reset。
- 在物理约束内拖动重排。
- 单节点 Preview 和 Before/After。
- 亮度 mask 或 Photoshop layer mask。
- 统一 format、ISO 和 seed。
- 参数搜索和高级参数折叠。

单节点预览语义：

- 先执行该节点所有必需上游节点。
- 只显示所选节点相对于直接输入的变化。
- 不能在原始图像上错误地孤立执行依赖上游状态的节点。
- Overscan 单节点预览只在面板显示，不创建文档。

### 10.4 物理效果预设

```ts
interface PhysicalPresetV1 {
  kind: "FilmEmulationPhysicalPreset";
  presetVersion: 1;
  name: string;
  description: string;
  format: FilmLabDocumentV3["format"];
  seedPolicy: "keepDocumentSeed" | "usePresetSeed";
  seed?: number;
  graph: Array<Omit<EffectNodeV3, "mask">>;
}
```

规则：

- 预设包含物理效果节点、format、ISO 和 seed policy。
- 不包含 Photoshop layer id、document fingerprint 或 source/target binding。
- 不包含 LUT、ICC、曲线、ACR profile 或胶片色彩配置。
- 应用预设默认保留当前文档 seed。
- 内置预设使用描述性名称，不冒用竞品或真实胶片库存名称。
- 用户预设使用确定性 serializer，并支持导入导出。

### 10.5 V2 验收

- 所有 schema v1/v2 金样本可迁移至 v3。
- 未知 schema 和未知 node 不被静默改写。
- 非法节点顺序无法保存。
- Photoshop layer mask 的 Preview/Apply 尺寸、翻转、density 和 feather 一致。
- 删除或替换 mask layer 后 Apply 被阻止。
- 单节点预览包含必需上游结果且不执行下游节点。
- 预设导出不包含图层、路径或文档身份。
- 完整 graph 重开后结果与保存前一致。
- 24MP、16位默认 V2 graph，不含 Overscan：Apply P95 ≤ 10秒。
- 1024px 单节点 Preview P95 ≤ 350ms；完整 graph Preview P95 ≤ 700ms。

## 11. WASM、缓存与取消协议

### 11.1 WASM ABI 扩展

保持低层 ABI，不引入 wasm-bindgen 运行时。逐版本增加：

```text
film_gaussian_blur_f32
film_hash_field_f32
film_apply_grain_f32
film_defringe_f32
film_bloom_composite_f32
film_vignette_f32
film_rasterize_damage_f32
film_rasterize_gate_f32
```

要求：

- JS 是权威参考实现，WASM 必须通过数值一致性测试后启用。
- ABI 使用标量和线性内存 offset，不直接传 JS 对象。
- 一次实例化并复用 capacity；扩容按 64KiB page 对齐。
- `memory.grow` 后重建所有 TypedArray view。
- 执行失败时释放失效 backend，并从该节点的原始输入重新以 JS 执行。
- 不允许在 WASM 部分写坏输出后继续后续节点。
- JS/WASM 的哈希、边界 extension、降采样相位和常量必须相同。

### 11.2 缓存键

缓存键至少包含：

```text
node id
node type
validated params hash
input revision
full geometry
origin
preview scale
format profile
ISO
effective seed
quality
mask revision
color pipeline revision
```

- format、ISO、seed、mask 或上游节点变化使依赖节点失效。
- 只改变 Grain amount 时可复用单位方差随机场。
- 只改变 Bloom amplify/Save Lights 时可复用 source 和 PSF。
- 只改变 Vignette amount 时可复用径向基础透射率。
- 切换文档清除全部图像 plane 缓存。
- 进入内存警告区时按 LRU 释放 Preview 缓存，不释放当前 Apply 所需 buffer。

### 11.3 取消协议

- 每个 band、每个 PSF lobe、每 4096 个 Damage 对象检查一次 `AbortSignal`。
- 取消 Preview 只丢弃结果。
- 取消 Apply 不调用最终 `putPixels`，或回滚当前 modal history state。
- 取消 Overscan 时清理尚未完成的新文档。
- 渲染完成后比较 render generation；过期结果不得显示或写入。

## 12. 测试资产与发布门槛

### 12.1 固定测试图

在现有夜景、太阳、窗口和人像样本基础上增加：

- 线性灰阶和 HDR step wedge。
- 18%、50%、90% 均匀灰。
- 单像素 impulse。
- 黑白斜边。
- Zone plate 和细线图。
- 中性边缘及紫/绿合成色边。
- 红、绿、蓝、白高光。
- 白炽灯、蓝色 LED、日光反光。
- 肤色中间调。
- 透明和半透明高亮边缘。
- 四种格式的 gate/perforation 几何图。
- 高分辨率 Damage 重复纹理检查图。

每个测试输入和期望结果记录：

```text
engineVersion
schemaVersion
working profile
bit depth
format
ISO
seed
quality
expected dimensions
expected hash or metric
```

### 12.2 通用自动门禁

每个版本必须通过：

```text
npm test
npm run typecheck
npm run validate
npm run bench
npm run package
```

并覆盖：

- 参数边界、NaN、Infinity、空图和 1×1 图。
- 8/16/32位量化和 HDR。
- alpha 逐样本不变。
- 全图/分带/预览坐标一致性。
- Fast/Quality 物理参数一致性。
- JS/WASM 数值一致性和失败回退。
- 缓存失效。
- AbortSignal 和过期 render generation。
- schema 迁移和未来 schema 拒绝。
- 新旧插件 ID 迁移包往返。
- Balanced/High Memory 预检和 hard-budget 拒绝。

### 12.3 Photoshop 实机矩阵

| 维度 | 取值 |
|---|---|
| Photoshop | 23.3、当前稳定版 |
| 位深 | 8、16、32 |
| 色彩空间 | sRGB、Adobe RGB、Display P3、Rec.2020 |
| alpha | 无、透明、半透明 |
| RAM | 16GB Balanced、32GB High Memory |
| 图像 | 24MP、45–60MP、Overscan 扩展图 |
| 后端 | WASM、强制 JS fallback |

验证：

- 源图层 hash 永远不变。
- 同一参数重复 Apply 不重复烘焙。
- 参数变化始终从绑定源层重算。
- Preview 和 Apply 色彩、亮度一致。
- 所有 `PhotoshopImageData` 均释放。
- 出现约 600MB UXP 警告时记录日志和实际峰值。
- hard budget 之前不得发生崩溃、白图、彩噪或部分写入。
- V1.5 已修复的 unknown profile、16位范围和 protected target 等问题不得回归。

## 13. 版本交付顺序

| 版本 | 发布内容 |
|---|---|
| V1.5.1 | 旧 ID 迁移包导出、迁移说明、旧数据不删除 |
| V1.6.0 | 新 ID、迁移包导入、registry、format/ISO、MTF、Grain、内存分档 |
| V1.7.0 | Defringe、独立 Bloom、Highlight Protection、亮度 mask |
| V1.8.0 | Vignette、程序化 Damage、授权扫描素材包 |
| V1.9.0 | Overscan 几何、新文档输出、片门和片孔 |
| V2.0.0 | schema v3、FilmLab UI、受约束 graph、Photoshop layer mask、物理预设 |

任何版本只有在自动测试、视觉金图、内存测试和 Photoshop 实机矩阵全部通过后，才能更新 manifest、package、README、TDD、验收文档和发布标签。

不得通过以下方式达到性能指标：

- 降低默认效果强度。
- 静默关闭 Quality。
- 减小物理半径。
- 把 16/32位路径降为 8位。
- 破坏 HDR、alpha 或色彩管理。
- 忽略失败节点并继续写入不完整结果。

## 14. 实施者完成定义

一个版本只有同时满足以下条件才算完成：

1. 公共参数、默认值、校验和 serializer 已实现并有单元测试。
2. JS 权威算法通过数学、数值和视觉测试。
3. WASM 与 JS 在规定误差内一致，并有强制失败回退测试。
4. 分带、预览和完整 Apply 使用相同坐标、物理尺度和 seed 语义。
5. 8/16/32位及四个目标工作空间通过 Photoshop 实机测试。
6. 源层不变、绑定严格、重复 Apply 不叠加。
7. 内存预检、取消和错误回滚完成。
8. 当前版本的专项验收指标全部通过。
9. 文档、manifest、package 和发布标签只在全部门禁通过后统一更新。
10. 不存在 TypeScript 错误、无效 UI 参数、未释放 Imaging 对象或未授权资产。

