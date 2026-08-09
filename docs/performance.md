# 性能报告（Phase 6）

**日期**：2026-08-10
**基准环境**：Node 24.19（`npm run bench`，24MP 6000×4000 线性图，strength=100）
**真机参考**：Photoshop 27.1.0 UXP（capability spike：24MP getPixels 63ms / putPixels 91ms）

---

## 1. A3（预览 <500ms / 渲染 <5s @24MP）— **决策记录**

### 基准数据（Node 24MP）

| 模式 | 渲染耗时 | A3 目标 | 结论 |
|---|---|---|---|
| **fast**（IIR） | **3258–3373ms** | <5s | ✅ 达标 |
| quality（3σ 卷积） | 12709–12777ms | <5s | ❌ 超 2.5 倍 |

### 决策（用户，2026-08-10）
**Apply 默认 diffusionMode=fast**（A3 按 fast 口径验收）；quality 保留为可选高精度模式（`DEFAULT_PARAMS.diffusionMode` 已改 'fast'，UI 下拉可选 'quality' 并提示更慢）。

### quality 超时原因
quality 卷积 O(N·3σ)：24MP × 43 核宽 × 2 方向 ≈ 2G 次乘加，纯 JS 单线程 ~12.8s。**优化方向（记录，非 V1 承诺）**：卷积循环优化（对称核减半）、WebAssembly、或 UXP 原生路径（远期）。

### 预览（<500ms）
预览强制 fast + 1024 降采样：24MP → ~2MP 输入，fast 处理 <200ms（Node 实测量级），真机加 getPixels/PNG 编码预计 <500ms ✓（真机预览计时待用户面板操作确认）。

## 2. V-3 内存（≤3 份 3n 全分辨率缓冲）— **达标**

**内存就地化**（pipeline 重构）：
- 重构前：Y/M/S/G + dr/dg/db + dRgb + halo + glare + out ≈ 6 份 3n
- 重构后：plane(3n) + D(3n) + out(3n) + S/G/temp(n×3) ≈ **3 份 3n 等价**

理论工作集（24MP Float32）：`(3N×2 + N×3) × 4B ≈ 732MB`（含输入 275MB）。峰值 heap 增量实测 ≈0（Node 复用堆）。

**tile 兜底**（>16MP 自动启用，`processTiled`）：行带 256px + 40px 重叠，带内工作集 ≈ 带大小，大图内存受限时进一步降压。
- quality 模式 tile 与整图 **L2=0**（逐位一致）
- fast 模式 tile L2=3.4e-6（IIR 带边缘固有近似，视觉无感）

## 3. Worker / 并行

- **R-6 实测**（capability）：UXP 无 Web Worker → **降级为主线程行带分块 + 进度**（tileRender 串行）。
- 预览/Apply 均为单线程；UXP 侧无并行通道（Phase 6 记录，非缺陷）。

## 4. 增量重算（预览）

- 管线拆四步（extract → diffuse → halo → blend），预览缓存中间量：
  - threshold/softness/backgroundThreshold 变 → 重算提取+后续
  - sigma/sigmaRatio 变 → 重算扩散+后续（S 缓存）
  - redshift/centerAttenuation/globalDiffusion 变 → 重算 halo+blend（S+扩散缓存）
  - strength/blendMode 变 → 仅重算 blend（S+扩散+halo 缓存）
- 拖动非扩散参数时预览不再重跑卷积（fast 模式收益小，quality 模式收益显著）。

## 5. 待真机确认

- [ ] 24MP 真机 fast Apply 耗时（预计 getPixels 63ms + 算法 3.4s + putPixels 91ms ≈ 3.6s <5s）
- [ ] 预览真机 <500ms
- [ ] quality 模式 UI 提示文案

## 6. 数据文件

- `tests/performance-data.json`（npm run bench 输出）
- A6 复核见 `docs/visual-validation.md` §2 与 tests（IIR vs conv L2=6.77e-5 <1e-4，质量半径 3σ 口径）
