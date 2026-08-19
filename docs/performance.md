# V1.5 性能设计与基准协议

## 目标

- 参考机 24MP、16 位、默认参数 Apply P95≤2s。
- 最长边 1024px 面板预览 P95≤200ms。
- 32 位 HDR 单列数据；24MP 峰值插件内存≤600MB。
- 每组 2 次预热、10 次测量，记录 CPU、内存、Photoshop/UXP、位深和工作空间。

## 当前架构

- 双瓣 PSF 的窄 core 全分辨率。
- tail 只选择 1/2/4/8，多尺度阈值：Fast sigma≥3、Quality sigma≥4。
- Global Diffusion 使用宽单瓣 1/4–1/8。
- Fast 的每个单瓣优先使用 Rust/WASM 三盒高斯；失败自动调用同算法 JS 实现。
- Quality 使用有限卷积或 van Vliet 递归高斯，但两种模式的瓣参数、通道比例和尺度规则一致。
- 大图以行带降低中间工作集；整图编码 RGB/alpha 和一次性 putPixels buffer 仍计入峰值。

## Node 基准

`npm run bench` 输出默认 Fast 的 24MP 流式 Apply、1024px 预览、P50/P95、WASM/JS 后端状态以及峰值 RSS/arrayBuffers。协议固定为 2 次预热和 10 次测量；可用 `FILM_BENCH_WARMUPS`、`FILM_BENCH_RUNS` 做不进入发布证据的快速诊断。Fast/Quality 与 JS/WASM 的数值一致性由单元测试独立验证，避免把精度门禁与机器耗时混为一项。

Node 数据只用于算法回归，不作为 Photoshop A3 最终证据。

## Photoshop 基准

在插件日志中分段记录：

1. `getPixels` source RGBA。
2. TRC/primaries decode。
3. extract。
4. core/tail/global diffusion。
5. composite/encode/quantize。
6. `putPixels` target。

面板预览应单独记录 targetSize 读取、算法、PNG 编码。若 targetSize 返回非请求尺寸或非预期 level，记录回退原因。

## 放行规则

禁止通过关闭 Quality、缩小默认 sigma、改成单瓣、降低位深或写源层来达标。若参考机仍超过 2s，优先优化 WASM 内存复用、行带 I/O 和上采样；达标前保持 V1.5 为预发布状态。

## 当前 Node 基准

2026-08-20 在 Intel Family 6 Model 151 / Node 24.19 上按 2 次预热＋10 次测量得到：24MP Fast P50=`5466.7ms`、P95=`5642.4ms`、峰值 RSS=`529.9MB`；1024px 预览 P50=`92.3ms`、P95=`100.6ms`。预览和内存目标通过 Node 前置门槛，Apply 时长未达到 2s，因此当前包仍是预发布候选。完整样本见 `tests/performance-data.json`；最终放行仍以 Photoshop 实机 getPixels/putPixels 总时长为准。
