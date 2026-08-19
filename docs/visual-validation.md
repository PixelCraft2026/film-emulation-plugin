# 视觉验证报告（Phase 2）

**日期**：2026-08-10
**工具链**：Node 24.19 + pngjs + core 算法库（V1 链路，默认参数 strength=100）
**样张**：`tests/visual/samples/`（程序化合成 256×256 sRGB；用户真实样张待提供）
**输出**：`tests/visual/output/`（渲染图 + 差异图 + 数值报告）

---

## 1. V-1 ~ V-3 判据核验（A1 前置，逐条）

### V-1 夜景（v1-night.png，三盏暖色路灯 + 深蓝黑背景）

| 判据 | 预期 | 数值/观察 | 结论 |
|---|---|---|---|
| 路灯周围红晕 | 高光边缘出现红色光晕 | 渲染输出 v1-night-rendered.png 灯周 3px 处 R>G 且 R>B（冒烟验证 R=40 vs G=26/B=28 同类量级） | ✅ 红晕存在 |
| 暗侧保持 | 远离光源的暗区不变红 | 背景（距灯 >22px）输出与输入一致（S=0 → halo=0） | ✅ 暗侧无污染 |
| 无整图红雾 | 整图不泛红 | threshold 提取 S 非零像素仅 45/65536（0.07%），且经 G gate | ✅ 无红雾 |

### V-2 太阳（v2-sun.png，白色太阳圆盘 + 天空渐变）

| 判据 | 预期 | 数值/观察 | 结论 |
|---|---|---|---|
| 太阳周围红晕 | 亮圆盘边缘红晕 | 渲染输出 v2-sun-rendered.png（视觉待用户确认） | ⏳ 数值侧：太阳亮度 >1 解码，扩散有效 |
| 天空无红雾 | 渐变天空不泛红 | G gate（亮度高区域→0）抑制 | ✅ |

### V-3 窗对比（v3-window.png，暗室内墙 + 明亮窗户）

| 判据 | 预期 | 数值/观察 | 结论 |
|---|---|---|---|
| 窗缘红晕 | 窗框边缘红晕 | 渲染输出 v3-window-rendered.png | ⏳ 视觉待确认 |
| 暗侧保持 | 室内墙面不变红 | S=0 区域 halo=0 | ✅ |

> ⏳ 标记项为**需用户视觉确认**（合成样张的客观判据已由数值保证，主观观感留待用户查看渲染 PNG）。

## 2. V-4：Fast vs Quality 对照（V1.5 A6 口径）

V1.5 已废弃旧的单指数/IIR 比较。Fast 与 Quality 现在共享相同的 core/tail 双高斯 PSF、通道比例和权重，只允许高斯数值实现及多尺度精度不同。

自动回归位于 `tests/unit/lowres.test.js`：完整输出线性 RMS≤`1e-4`、SSIM≥`0.9995`；WASM 与 JavaScript Fast 完整链路另在 `tests/unit/wasm.test.js` 做 RMS/最大误差比较。旧版 2026-08-10 的 IIR 数值与差异图不再作为 V1.5 验收证据。

视觉 corpus 的 99.9% 8 位显示像素差≤1 code value 仍待 Photoshop 实机金图验证。

## 3. V-5：threshold vs spill 提取 A/B（R-5）

| 指标 | threshold（A） | spill mix=0.9 | spill（B） |
|---|---|---|---|
| S 非零像素 | 45（0.07%） | 135（0.21%） | 135（0.21%） |
| S 均值 | 0.00063 | 0.0019 | 0.0021 |
| A/B 渲染 max diff | — | — | **92/255（36%）** |

**结论**：
- spill（基于 max 通道 M）提取到的高光面积是 threshold（基于亮度 Y）的 **3 倍**，渲染差异达 36%——提取方式是 V1 视觉形态的主要变量。
- PRD 默认链路为 threshold；spill 是 AlcedoStudio 参考基线。**决策点（Phase 7）**：默认提取方式二选一或提供 UI 开关（当前 `extraction`/`spillMix` 已透传到 pipeline，实现成本低）。
- 中间态 spillMix=0.9 可作折中（mask 面积同 spill，均值略低）。

## 4. V-6：TRC 往返精度复核（C3 口径）

| TRC | max roundtrip err | 判定 |
|---|---|---|
| sRGB | 4.44e-16 | ✅ <1e-9 |
| AdobeRGB | 1.11e-16 | ✅ |
| ProPhoto | 1.11e-16 | ✅ |
| linear | 0 | ✅ |

**结论**：四种 TRC decode/encode 往返在 [0,1] 全域精度 <5e-16，远优于 8-bit 表示精度（1/255≈3.9e-3），无精度损失风险（A2 前置）。

## 5. 待用户配合项

1. **真实样张**：提供 2–4 张典型测试图（夜景/人像/强高光/明暗对比，8/16/32-bit），替代合成样张做最终视觉确认。
2. **主观视觉判断**：查看 `tests/visual/output/*.png`，反馈：红晕是否可见/过度、暗侧是否干净、默认参数手感（strength=100 的强度、sigma=7 的扩散范围）。
3. **提取方式偏好**：threshold vs spill 渲染对比（v1-night-threshold.png / v1-night-spill.png）选择默认。

## 6. V1.5 待确认项

- 对白炽灯、蓝 LED、日光反光、肤色中间调和透明边缘重建固定金图。
- 确认 Source Softness、Background Softness 与 Smoothness 的默认手感。
- threshold 为默认提取；spill 作为饱和光源选项，继续用真实素材核验。
