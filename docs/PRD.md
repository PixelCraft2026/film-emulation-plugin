# Film Halation 产品需求文档

版本：1.5.0
状态：Implementation baseline
定位：Photoshop 静态胶片物理效果插件；颜色预设由 Photoshop 在插件运行前完成。

## 1. 产品目标

V1.5 模拟胶片乳剂内部散射和防光晕层回射，而不是通用 Glow/Bloom。输出必须具备红色远尾、近源弱橙色成分、暗侧局部可见性和中间调宽红层扩散，同时保持文档位深、工作空间及透明度。

本版本先完成 Halation 的正确性、非破坏性和性能基础。V1.6 以后才允许扩展其他胶片模块。

## 2. 用户工作流

- 输入必须是 RGB 像素层。智能对象应进入内容或先栅格化。
- 交互拖动只更新最长边 1024px 的面板预览。
- Apply 自动复制并验证像素层，只更新副本。
- 自动复制不可寻址时，Apply 阻止写入并给出手动复制指引。
- 参数修改和重开文档后均从绑定源层重新渲染，不能在旧效果上累积。
- 图层绑定有歧义时停止并要求重新选择，不按近似名称猜测。

## 3. Halation 模型

权威链路：

`编码 RGBA → 线性 sRGB → 光源/背景提取 → 光谱源场 → 双瓣多尺度 PSF → 局部暗侧门控 → 全局红层扩散 → HDR 安全合成 → 工作空间编码 → 位深量化`

### 3.1 光源和门控

- Source Softness 只控制高光源提取。
- Background Softness 只控制暗侧可见性。
- `thresholdUnits=stops` 时阈值为 `0.18 × 2^EV`，允许负 EV。
- Spill 选择 max RGB 后，扩散能量必须使用混合后的 source mask/辐射度，不能退回 luma mask。
- `softness=0` 是合法的精确阶跃，所有输出必须为有限数。
- alpha=0 的 RGB 不产生能量；半透明像素按覆盖率贡献。

### 3.2 光谱响应和 PSF

- 红、绿、蓝感光源分别从输入 RGB 构造；蓝色对红层的直接贡献不超过红源基准的弱比例。
- 绿层随曝光非线性增强，使近源比远尾更偏橙。
- 默认 PSF：`0.15·G(0.35σ) + 0.85·G(1.5σ)`；Smoothness 可连续改变两瓣尺寸与权重。
- Fast/Quality 必须计算相同两瓣，不能让 Fast 退化成单瓣。
- core 全分辨率；tail 根据有效 sigma 使用 1/2/4/8；Global Diffusion 使用 1/4–1/8。

### 3.3 Global Diffusion 与合成

- Global Diffusion 是宽半径、红层主导、中间调门控的独立层，不是白色 Bloom。
- 局部 dark-side gate 不得同时门控 Global Diffusion。
- Additive 为默认物理合成。
- Screen 在 0–1 使用余量增益；HDR >1 保持原值并以正增益继续叠加，绝不变暗。
- 8/16 位量化使用确定性零均值抖动；32 位不量化。

## 4. 非破坏与持久化

- 任何执行路径都禁止把源层 id 传给 `putPixels`。
- 写入前必须验证 target id 与 source id 不同，并先验证 target 可读取。
- schema v2：

```json
{
  "plugin": "FilmHalation",
  "schemaVersion": 2,
  "engineVersion": "1.5.0",
  "format": { "gauge": "35mm", "iso": 250 },
  "graph": [{ "id": "halation-main", "type": "halation", "enabled": true, "params": {} }],
  "bindings": { "sourceLayer": null, "targetLayer": null },
  "documentFingerprint": null
}
```

- v1 `FilmLab/effects.halation` 明确迁移到一个 graph 节点。
- 高于 v2 的 schema 拒绝加载。
- 未保存文档的 fingerprint 必须包含 document id。

## 5. 验收标准

- A1：暗背景高光形成红色衰减 halo，常量暗场不产生红雾。
- A2：8/16/32 位和透明/半透明图像完成 Photoshop 实机测试；alpha 原样保留。
- A3：参考机 24MP 16 位默认 Apply P95≤2s；1024px 预览 P95≤200ms；32 位单独报告，峰值插件内存≤600MB。
- A4：Preview/Apply/取消/重开/切文档后源层像素 hash 不变；重复 Apply 不叠加。
- A5：schema v1→v2、序列化往返、精确文档匹配和严格图层绑定通过。
- A6：Fast/Quality 线性 RMS≤1e-4、SSIM≥0.9995；视觉 corpus 的 99.9% 8 位显示差不超过 1 code value。
- 发布门禁：`test`、`typecheck`、`validate`、`bench`、`package` 全部成功，并完成 Photoshop 8/16/32 位实机表。

## 6. 后续版本

- V1.6：密度相关 Grain、Negative/Positive、ISO/片幅、Film Resolution/MTF。
- V1.7：独立 Bloom、Defringe、Save Lights/亮部保护和遮罩。
- V1.8：授权真实扫描素材与程序化 Damage、物理 Vignette。
- V1.9：8/16/35/65mm Overscan、片门、片孔和扫描边界。
- V2.0：统一 effect graph、节点预览/重排、格式和物理效果预设。

固定内部顺序：`Defringe → Vignette → Halation → Bloom → Highlight Protection → MTF → Grain → Damage → Overscan`。不包含 Film Breath/Gate Weave，也不复制第三方代码、参数或素材。
