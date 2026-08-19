# FilmLab 版本路线

后续版本按顺序进入；前一版本的自动与 Photoshop 实机门禁未通过时，下一版本不合入发布分支。

## V1.5 — Halation Foundation

双瓣光谱 Halation、多尺度/WASM、RGBA、非破坏副本、schema v2、严格绑定和性能协议。

## V1.6 — Film Grain & Resolution

- 曝光/密度相关颗粒，而非全局噪声叠加。
- 固定/随机 seed；预览、Apply、重开和批处理可复现。
- Negative/Positive、Analogue/Fast、ISO 与 8/16/35/65mm 格式档案。
- Film Resolution/MTF 与颗粒尺寸、格式联动。
- 节点：`filmResolution | grain`。

验收：颗粒功率谱、曝光分布、无系统色偏、seed 重现；斜边 MTF50 和振铃检查。

## V1.7 — Bloom & Optical Prep

独立 Bloom source limiter/diffusion/amplify/saturation/Save Lights，外加 Defringe、亮部保护和 mask。共享扩散基础设施，但禁止复用 Halation 光谱源或红层门控。

## V1.8 — Damage & Vignette

Dust/Hair/Scratch/Stain/Light Leak 使用已授权真实扫描素材和程序化变换；所有类别支持密度、尺寸、明暗、色度、变换和 seed。Vignette 模拟中心偏移、椭圆度、柔度和格式相关镜头落光。

## V1.9 — Overscan & Film Gate

8/16/35/65mm 片门、片孔、方向、边界曝光、柔焦、比例、旋转和偏移。节点位于最后，修改画布尺寸前显示目标尺寸并确认。

## V2.0 — FilmLab Suite

统一节点编辑、启用/重排/单独预览/局部 mask、格式/ISO/seed 和物理尺寸换算、旧文档迁移及插件内物理效果预设。颜色胶片配置继续由 Photoshop 预设负责。

固定顺序：`Defringe → Vignette → Halation → Bloom → Highlight Protection → MTF → Grain → Damage → Overscan`。静态版本不加入 Film Breath 或 Gate Weave。
