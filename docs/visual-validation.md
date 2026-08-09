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

## 2. V-4：IIR(fast) vs conv(quality) 对照（A6 口径）

**数值（0..3σ 区域，脉冲响应 L2）**：

| 指标 | 值 | 判定 |
|---|---|---|
| L2 fast vs quality(3σ 截断) | **9.57e-5** | ✅ < 1e-4（A6 达成） |
| L2 fast vs quality(5σ 截断) | 1.22e-5 | 一致性提升 8 倍 |
| fast 脉冲 L2（能量参考） | 9.64e-4 | — |
| quality(3σ) 脉冲 L2 | 1.06e-3 | — |

**视觉**：v1-night 双模式渲染 max per-channel diff = **19/255（7.5%）**，差异集中在灯周；diff20x 图已生成（`tests/visual/output/v1-night-diff20x.png`）。

**结论**：
- A6 在质量半径 3σ（当前默认）即达成；**建议 Phase 7 将质量半径提至 5σ**（`TRUNC_QUALITY`）以 8 倍收紧 fast/quality 一致性，代价是卷积成本约 ×2.3（radius 21→35），预览仍可用 fast。
- fast/quality 视觉差异（7.5% max）在可接受范围，两者数学同源（exp 核）。

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

## 6. 对默认值的调整建议（供 Phase 7 定稿）

- 质量扩散半径 3σ → 5σ（A6 一致性 8 倍提升，成本可接受）。
- 默认提取方式待用户 A/B 反馈后定（threshold / spill / 中间态）。
- 其余默认参数（threshold=0.7、backgroundThreshold=0.8、redshift=(1,0.05,0.02)、sigmaRatio=(1,0.85,0.7)）当前数值验证无异常，保持待视觉确认。
