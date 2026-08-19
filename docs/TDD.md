# Film Halation 1.5 技术设计

状态：实现依据
宿主：Photoshop UXP，最低 23.3
计算后端：Rust/WebAssembly，可验证的纯 JavaScript 回退

## 1. 分层和接口

- `core/`：纯线性图像算法、effect graph 执行器、WASM 后端抽象；不访问 UXP。
- `io/`：Photoshop Imaging API、RGBA、色彩、预览、瓦片和 WASM 文件加载。
- `storage/`：schema v2、v1 迁移、PluginStorage 精确匹配。
- `ui/`：Spectrum DOM 控件；只发送 partial params，不持有过期闭包。
- `main.jsx`：串行 modal 队列、安全副本绑定和文档切换。

公共核心接口：

```ts
processHalation(input: ImageBuffer, params: HalationParams): HalationResult;
processFilm(input: ImageBuffer, document: FilmLabDocument, context: RenderContext): RenderResult;

interface ImageBuffer {
  width: number;
  height: number;
  rgb: Float32Array;
  alpha?: Float32Array;
}

interface RenderContext {
  width?: number;
  height?: number;
  quality?: "fast" | "quality";
  seed?: number;
  signal?: AbortSignal;
}
```

V1.5 `processFilm` 只接受 halation 节点；未知未来节点明确报错。后续效果按固定物理顺序扩展。

## 2. RGBA 与色彩

`imaging.getPixels` 使用 `applyAlpha:false`。返回 3 或 4 分量均可接受：RGB 分离为编码域 float，alpha 归一化为独立 plane。源提取时乘 alpha，合成后 alpha 直接复制。写回 `createImageDataFromBuffer` 始终传 4 分量。

8 位归一化除数 255；Photoshop 16 位使用并严格 clamp 到 0..32768；32 位保留 HDR。TRC decode 后转换到线性 sRGB primaries，完成算法后逆转换和 TRC encode。面板 PNG 没有 ICC 标签，因此预览保持线性 sRGB primaries 并用 sRGB TRC 编码；Apply 才逆转换回文档工作空间。`targetSize` 请求的 sourceBounds 始终是原始区域，而不是目标像素尺寸；返回宽高必须与请求目标一致，否则回退完整读取。

## 3. 算法

提取输出 `Y/M/S/G/W/sourceR/sourceG/sourceB`：

- `S = mix(smoothstep(Y), smoothstep(maxRGB), spillMix) × alpha`
- `W = S × mix(Y,maxRGB,spillMix) / threshold`
- `sourceR = S × (0.82R + 0.16G + 0.02B) / threshold`
- `sourceG` 使用绿层权重并乘随曝光上升的 shoulder。
- `sourceB` 只保留弱能量。

每个光谱 plane 使用双瓣 PSF。核芯永远全分辨率；尾瓣使用面积降采样、中心对齐上采样，并只选择 1/2/4/8 比例。Quality 在低分辨率保持 sigma≥4，Fast 保持 sigma≥3。

局部 halo 在中心能量扣除后乘 `G`。Global Diffusion 由红层为主的 source 以 `max(12,4σ)` 扩散，并乘独立中间调 gate，最后按 `[1,0.12,0.025]` 加入。最终 blend 不再重复使用局部 gate。

Screen 增益：

```text
base <= 0 : 1
0 < base < 1 : 1-base
base >= 1 : 1/base
```

因此 halo 只会增加能量。

## 4. WASM ABI

Rust crate 位于 `native/film_core`，target 为 `wasm32-unknown-unknown`，无 wasm-bindgen 运行时。导出：

- `film_version()`
- `film_alloc_f32(length)` / `film_free_f32(pointer,length)`
- `film_box_blur3(pointer,pixels,width,height,sigma)`

一块线性内存包含 source/destination/tempA/tempB 四个 plane，JS 后端按最大处理尺寸复用分配。Fast 的每个 PSF lobe 优先调用 WASM；实例化、分配或执行任一失败即释放后端并在当前调用回退 JS。Quality 继续使用精确卷积/递归高斯，但物理 PSF 与 Fast 相同。

构建产物为 `assets/film_core.wasm`，bundle 时复制到 `dist/film_core.wasm`，CCX 必须包含它。UXP 通过 plugin folder 读取 binary 后 `WebAssembly.instantiate`。

## 5. 非破坏性编排

首次 Apply：

1. 解析或建立严格 source binding。
2. 创建独立空白像素效果层并赋唯一 token 名称；不调用 duplicate，避开 Photoshop UXP 的 duplicate + Imaging 剪贴板错误。
3. 验证 target 与 source 不同且为可寻址像素层；正式整图 `putPixels` 同时完成写入能力验证。
4. 从 source 读取完整 RGBA、处理、只向 target `putPixels`。
5. 保存 source/target binding 和 params。

重新渲染时 source binding 必须严格解析；id 命中但名称不一致视为失效，名称兜底必须全局唯一。target binding 失效或歧义时不猜测旧层，而是创建新的唯一空白效果层并更新绑定。代码库不保留写源层的 live preview API。

文档切换每 750ms 轻量检测，清除预览缓存并加载该文档的精确 storage key，不自动渲染或写入。

## 6. 缓存依赖

- Extract key：threshold、units、source/background softness、background threshold、extraction、spillMix。
- Diffuse key：sigma、sigmaRatio、redshift、smoothness、mode、工作尺寸。
- Halo key：center attenuation、global diffusion。
- Blend-only：strength、blendMode。

预览 sigma 先按原文档/对角线解析，再乘预览尺寸比例。

## 7. 测试与发布

- 单元：精确阈值、负 EV、spill、光谱泄漏、HDR screen、alpha、schema、binding、文档 fingerprint。
- 数值：impulse/edge、各向同性、Fast/Quality RMS≤1e-4 和 SSIM≥0.9995、瓦片/整图一致。
- WASM：同输入下 JS/WASM 输出 RMS 和最大误差；加载失败回退。
- 宿主：源/目标 hash、8/16/32 位、透明边缘、四个工作空间、取消和重开。
- 性能：2 次预热、10 次测量；记录 P50/P95、CPU、Photoshop、位深、峰值内存。

只有 Node 门禁与 Photoshop 实机门禁全部通过后，V1.5 才能标记为 release-ready 并开始 V1.6。
