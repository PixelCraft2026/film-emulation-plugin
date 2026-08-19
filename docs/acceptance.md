# V1.5 验收状态

更新日期：2026-08-20
规则：Node 自动测试通过不等于 Photoshop 实机通过。未完成项保持 Pending，不以推测数据放行。

## 自动门禁

| 门禁 | 当前要求 | 状态 |
|---|---|---|
| Unit | 全部通过；含 alpha、spill、HDR screen、schema v2、bindings、A6 | 已实现，运行发布门禁时刷新数量 |
| Typecheck | `tsc --noEmit` 零错误 | 已实现 |
| Build | UXP bundle 生成 | 已实现；受控环境可能需要允许 esbuild 子进程读取工作区 |
| WASM | Rust release build；JS/WASM blur 与完整 Fast parity | 已实现并自动测试 |
| Manifest | 1.5.0 / PS 23.3 / manifest v4 | 已实现；最终门禁重跑 validate |
| Package | CCX 含 `dist/film_core.wasm` | 已实现；最终门禁重建并校验 |

## A1–A6

| 项 | 自动证据 | Photoshop 实机证据 | 判定 |
|---|---|---|---|
| A1 Halation 形态 | 暗常量恒等、点源红色衰减、光谱泄漏测试、视觉 golden | 白炽灯、蓝 LED、日光反光、肤色 corpus | Pending visual |
| A2 位深/透明度 | alpha 保留且透明 RGB 不发光；量化路径实现 | 8/16/32 位、透明/半透明、四工作空间 | Pending host |
| A3 性能 | Node 2+10：24MP P95=5642.4ms、RSS=529.9MB；1024px P95=100.6ms | 24MP 16 位 Apply P95≤2s；1024 preview P95≤200ms；32 位/内存另报 | **Apply 未通过** / host pending |
| A4 非破坏 | 写入编排只接受不同 target binding；严格 binding 单测 | Preview/Apply/重开/切文档源 hash 不变；重复 Apply 不叠加 | Pending host |
| A5 恢复 | v1→v2、往返、未来 schema 拒绝、Untitled 防碰撞 | 保存、重开、重命名/歧义、手动副本回退 | Pending host |
| A6 一致性 | Fast/Quality 同双瓣 PSF，RMS≤1e-4、SSIM≥0.9995 | 视觉 corpus 99.9% 像素≤1 code value | Automatic pass / visual pending |

## 必测 Photoshop 场景

1. 选中正常像素层首次 Apply：创建唯一命名副本，源 hash 不变。
2. 运行时复制不可寻址：无 putPixels，显示手动复制指引。
3. 绑定后连续调参：只更新 target，每次都从 source 读取。
4. 重开 PSD：恢复参数与 source/target；绑定歧义时阻止。
5. 8/16/32 位；透明棋盘、半透明边缘；sRGB/Adobe RGB/ProPhoto/Display P3 或 Rec.2020。
6. 24MP 16 位默认参数：2 次预热、10 次计时，记录 P50/P95 和峰值内存。

## 发布判定

当前实现不得标记 release-ready，直到本文件所有 Pending host/benchmark 项由真实 Photoshop 记录补齐。V1.6 功能开发在该门禁之前冻结。
