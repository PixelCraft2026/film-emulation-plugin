# V1.5 Photoshop 实机验收记录

本文件只记录真实 Photoshop/UXP 运行结果。Node 单测、WASM 基准或旧版“写回源层”冒烟结果不能替代本表。

## 测试环境

| 字段 | 记录 |
|---|---|
| 日期/测试人 | Pending |
| Photoshop / UXP | Pending |
| OS / CPU / RAM | Pending |
| 插件包 SHA-256 | Pending |
| 文档位深 / profile | Pending |

## 非破坏性与绑定

每个用例前后都计算源层像素 hash；预期所有 source hash 完全相同。

| 用例 | 预期 | 结果 |
|---|---|---|
| 首次 Apply | 自动复制像素层；只写副本 | Pending |
| 自动副本不可寻址 | Apply 中止，无 `putPixels`；提示手动复制 | Pending |
| 修改参数后 Apply | 从绑定 source 重渲染同一 target，不重复烘焙 | Pending |
| 拖动参数 | 只更新面板 1024px 预览，不创建或修改画布图层 | Pending |
| 保存并重开 PSD | 恢复 source/target binding 后从 source 渲染 | Pending |
| 图层删除、重复或绑定歧义 | 阻止写入并要求重新绑定，不按名称猜测 | Pending |
| 切换两个文档 | 各自状态与绑定独立刷新 | Pending |

## 像素、透明度与色彩空间

对 8/16/32 位分别测试 sRGB、Display P3、Adobe RGB、ProPhoto RGB；Rec.2020 作为扩展覆盖。素材包含完全透明但 RGB 非零、半透明发丝边缘和 HDR 高光。

| 判据 | 结果 |
|---|---|
| 输出 alpha 与 source 逐字节相同 | Pending |
| 完全透明 RGB 不产生 Halation | Pending |
| 半透明源按覆盖率贡献光能 | Pending |
| 8/16 位抖动无可见色偏或条带 | Pending |
| 32 位不量化；HDR Screen 不使 >1 高光变暗 | Pending |
| 各工作空间往返无明显色相漂移 | Pending |

## 视觉金图

用同一参数记录输入、输出和局部 100% crop：白炽灯、蓝 LED、日光反光、肤色中间调、透明边缘。核验近源橙红、远端红尾、蓝光泄漏受限、Global Diffusion 不变成白色 Bloom。

当前状态：**Pending**。旧 V1.4 冒烟测试直接写入源图层，已从 V1.5 证据链中撤销；V1.5 代码路径禁止将 source 作为写入目标。

## 性能协议

24MP、16 位、默认参数先预热 2 次，再测量 10 次；分别记录 getPixels、算法、量化、putPixels、总时长及峰值内存。目标为 Apply P95≤2s、1024px 面板预览 P95≤200ms、峰值插件内存≤600MB。32 位另表记录。

未完成以上 Pending 项前，不得把 V1.5 标记为 release-ready，也不得开始 V1.6 发布分支。
