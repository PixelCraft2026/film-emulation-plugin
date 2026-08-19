# Film Halation — 独立验证程序（Standalone）

脱离 Photoshop 运行的核心算法验证工具。把以下**两个文件**复制到你的图片文件夹：

- `halation-cli.standalone.cjs`（自包含单文件：核心算法 + 图片编解码全部打包，无外部依赖）
- `run.bat`（双击入口）

双击 `run.bat`，同文件夹中所有 JPG/PNG 图片会被处理成 halation 效果并
**重命名保存**（`<原名>_halation.<ext>`），**不覆盖原图**。

## 用法

| 操作 | 效果 |
|---|---|
| 双击 `run.bat` | 处理本文件夹（脚本所在目录）中所有 `.jpg/.jpeg/.png` |
| 把图片文件**拖到** `run.bat` 上 | 只处理拖入的图片 |
| 命令行：`node halation-cli.standalone.cjs a.jpg b.png` | 处理指定图片 |
| 命令行：`node halation-cli.standalone.cjs --strength 60` | 调整强度 0–100（默认 80） |
| 命令行：`node halation-cli.standalone.cjs --diffusion quality` | 用 quality 卷积模式（更慢更精确，默认 fast） |

示例输出：

```
=== Film Halation (standalone) ===
params: strength=80, sigma=7, diffusion=fast
files: 3
[ok] photo1.jpg -> photo1_halation.jpg (6000x4000, algo 2451ms, total 2903ms)
[ok] photo2.png -> photo2_halation.png (2048x1536, algo 412ms, total 540ms)
Done. 2/3 processed. Outputs saved as *_halation.jpg/png in the same folder.
```

## 说明

- **支持格式**：JPG/JPEG/PNG（8-bit）。输出保持原格式（JPG 质量 92）。
- **色彩处理**：按 sRGB 假设线性化 → 核心算法（高光提取 → 指数扩散 → 红色偏移 →
  additive 混合，与 Photoshop 插件完全同一套 `core/` 代码）→ 编码回 sRGB。
  因此插件里看到的效果应与本工具一致。
- **参数**：默认 `strength=80, sigma=7, threshold=0.7, diffusion=fast`；可在
  `halation-cli.js`（源码）顶部 `parseArgs` 的 `opts` 中改默认值，然后执行
  `npm run build:standalone` 重新打包。
- **内存与分辨率上限**：>800 万像素自动行带分块渲染（与整图数值一致，L2<1e-6）；
  `run.bat` 以 `--expose-gc --max-old-space-size=16384`（16GB 堆，适配 32GB 内存机器）运行，
  并在编码前显式回收大缓冲。已实测：**131MP（14016×9344）约 45s、200MP（16000×12500）
  约 53s**（fast 模式）。jpeg-js 解码限制已调高（分辨率 ≤1024MP、内存 ≤8GB）。
  内存参考：32GB → 16384（默认）、16GB → 12288、8GB → 8192（改 `run.bat` 中的数值）。
- **依赖**：需要 Node.js（双击模式自动查找 `node`，找不到会提示）。standalone
  文件是自包含 bundle，用户机器只需有 Node.js、无需安装任何 npm 包。

## 文件

- `halation-cli.standalone.cjs` — 自包含可执行文件（用户复制此文件 + `run.bat`）
- `halation-cli.js` — 源码（开发用，`import` 项目内 `src/core`）
- `run.bat` — Windows 双击入口
- `build-standalone.mjs` — 用 esbuild 重新打包 standalone（`npm run build:standalone`）

## 验证核心算法的建议测试

1. **夜景街灯图**：灯 → 红晕 → 黑（红晕紧贴高光边缘、仅暗背景侧可见、无整图红雾）。
2. **普通日景照片**：高光边缘轻微暖红晕，中间调/肤色不应整体变红。
3. 把 `_halation` 输出与原图并排对比，检查光晕是否只出现在高光周围、颜色偏红而非中性灰。
