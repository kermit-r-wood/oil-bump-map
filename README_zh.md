# Oil-Texture Bump Map (UV-Print Ready)

[English](README.md) | **简体中文**

---

**在线试用:** [https://kermit-r-wood.github.io/oil-bump-map/](https://kermit-r-wood.github.io/oil-bump-map/)

这是一个单页面网页应用，能将任何照片或画作转换为可直接用于 **Eufy Make E1** 打印的凹凸深度图。该算法管线专门针对打印机切片时的平滑处理进行了优化，以保留油画般的凹凸纹理。

仅提供一种核心模式：**`scan_replica`**。它能模拟油画真实 3D 扫描的效果（以中灰色为基准线，根据笔触密度生成凸起的边缘，并结合亮度进行高度偏移）。

该管线**仅依赖 RGB 信息，完全在浏览器中运行**：无需单目深度估算模型，无需 GPU，无需服务器，无需构建工具或上传文件。只需将 `web/` 文件夹拖放到任意静态服务器（或使用单行命令启动本地静态服务器）即可运行。

---

## 示例

| 输入图像 | 生成的凹凸图 |
|---|---|
| ![Input](docs/example/frieren_input.jpg) | ![Bump map](docs/example/frieren_bump.png) |

使用默认参数处理的数字肖像效果，此处显示为 8 位灰度图（实际输出为 16 位）。可以看出，平滑的面部区域保持在中灰色（不产生虚假的厚涂起伏），头发处的笔触顺应走向凸起，而深色的眼眶部分则呈现为凹陷。

---

## 快速开始（纯前端，免安装）

整个应用使用纯 ES 模块，编写在 `web/` 目录中。因为浏览器出于安全考虑无法通过 `file://` 协议直接加载 ES 模块，您只需启动一个本地静态服务器。

```powershell
# 推荐使用 Node.js 18+ (无任何第三方依赖，使用 scripts/dev_server.mjs)
npm run dev
# 随后在浏览器中打开 http://127.0.0.1:8000/
```

```bash
# macOS / Linux
npm run dev
# 或者使用任意其他静态服务器，例如: npx serve web
```

`npm install` 不需要安装任何包（本项目无运行时依赖）。`scripts/dev_server.mjs` 是一个仅约 70 行的静态服务器脚本，仅依赖 Node.js 原生 `http` 模块。您可以通过 `PORT=8080 npm run dev` 自定义端口。

上传图片后，凹凸图的计算完全在您本地的浏览器中进行，并提供 16 位灰度 PNG 的下载链接。**您的图片绝不会被上传到任何服务器。**

### 浏览器要求

- Chrome / Edge **80+**，Firefox **113+**，Safari **16.4+**（任何支持 `CompressionStream` API 和 ES 模块的浏览器）。

### 性能参考

在 Chrome 浏览器单标签页中运行 2048×2048 像素的图像，端到端耗时如下：

| 后端 | 2K 耗时 | 备注 |
|---|---|---|
| CPU (纯 JS, Worker 线程) | 约 10 秒 | 任何环境均可使用 |
| WebGL2 (片元着色器) | 约 0.4 秒 | 几乎所有现代浏览器均支持 |

因为管线是在 Web Worker 线程中运行，计算期间网页完全不会卡顿。应用加载时会自动检测并选择最快的可用后端。

您可以在 UI 中通过 "max side" 下拉菜单限制输入图像的最大边长（默认 2048）。GPU 后端处理 4K 图像没有问题；但在 CPU 后端下处理 4K 图像会非常慢（约 1 分钟），因此建议限制在 2K 或以下。

---

## 算法管线说明

1. **结构张量 (Structure tensor)**：从输入的 RGB 图像中提取像素级的笔触方向（带有高通预滤波器，避免大范围的轮廓边缘干扰方向场）。
2. **各向异性 LIC (线积分卷积)**：生成顺应局部图像结构的笔触流场。
3. **笔触密度掩膜 (Paint-density mask)**：基于方差和亮度的加权算法，检测图像中“哪里有堆积的油墨”。细密笔触区域会判定为高密度，大面积平滑区域判定为趋于零。
4. **合成 (Composer)**：结合笔触与密度：`bump = stroke × paint_density`，并将其中心化并缩放到目标振幅。
5. **亮度驱动的直流偏移 (DC offset)**：将高亮有纹理的区域抬高（模拟油画笔触的反光凸起），暗色有纹理的区域凹陷，无纹理区域保持中灰。这能产生纯零均值脊线场无法提供的笔触厚度感。
6. **锐化补偿 (Unsharp pre-compensation)**：提前补偿 E1 打印机的切片平滑处理。
7. **导出**：生成 16 位灰度 PNG（也提供 8 位兼容格式）。

在“Simulated Print”面板中，程序会在软件中对生成的凹凸图进行高斯模糊，以便您在未打印前就能预览“E1 实际打印出来的效果”。

---

## UV 打印机极性约定

Eufy Make E1 及大多数 UV 浮雕打印机将深度图视为高度图：**白色代表凸起，黑色代表凹陷**。

在 `scan_replica` 模式中，这意味着：
- 亮度高的纹理区域（高光、笔触凸起） → 对应亮色像素 → 打印出来为凸起。
- 亮度低的纹理区域（深色暗部、阴影笔触） → 对应暗色像素 → 打印出来为凹陷。
- 任何亮度的平滑区域 → 对应中灰色像素 → 打印出来为平整表面。

亮度高度偏移（在 `web/src/presets.js` 中由 `luminanceHeightBias` 控制）负责将“哪里有颜料”转换为“颜料有多高”。

---

## 工作原理（预设参数）

所有控制参数均编写在 `web/src/presets.js` 的 `PRESET` 对象中：

| 字段 | 默认值 | 作用效果 |
|---|---|---|
| `strokeLength` | 32 | LIC 笔触长度（单位像素）。值越大，笔触越连贯开阔。 |
| `strokeThickness` | 4 | 垂直于流向的 LIC 笔触粗细。 |
| `directionStrength` | 1.0 | 各向异性强度。0 代表各向同性噪声，1 代表完全顺应 LIC 方向。 |
| `orientationHighpassSigma` | 8.0 | 结构张量的高斯模糊 σ。值大于 0 时，能忽略大范围的物理轮廓。 |
| `isoWeight` | 0.0 | 在低相干度区域混入的各向同性噪声权重。0 保持平滑区域完全平整。 |
| `thicknessGamma` | 2.0 | 笔触密度掩膜的指数幂。大于 1 时可拉大纹理区与平滑区的对比度。 |
| `thicknessFloor` | 0.0 | 提升掩膜的基底。例如设为 0.4 会产生一个“画布底色”的基础高度，在此之上叠加笔触。 |
| `outputAmplitude` | 0.22 | 目标动态范围 of 99% 振幅上限。 |
| `luminanceHeightBias` | 0.5 | 直流偏移强度。0 为纯脊线，0.5 会有明显的画笔厚度，1.0 产生极强的物理厚度。 |
| `unsharpSigma` | 1.0 | 打印机抗平滑预补偿的 σ 范围（匹配打印机的 Smoothing 1 预设）。 |
| `unsharpAlpha` | 0.5 | 打印机抗平滑预补偿的强度。 |

直接修改文件并刷新页面即可生效。

---

## 调试工作流

目标：调整 `web/src/presets.js` 中的参数，使您打印机的实际输出效果符合预期。

1. **准备测试图**：选择一张兼具平滑和丰富纹理的图片（例如梵高的画作）。
2. **生成并保存**：用本应用生成凹凸深度图并保存。
3. **打印测试**：在 E1 上使用您将在生产中使用的最低平滑度（通常为 Smoothing 1）进行打印。
4. **侧光检查**：
   - **笔触边缘太软或丢失？** 调高 `unsharpAlpha` (+0.1) 或 `outputAmplitude` (+0.05)。
   - **笔触边缘有光晕/过度锐化？** 调低 `unsharpAlpha` 0.1。
   - **整体画面太扁平？** 调高 `luminanceHeightBias` (+0.2) 以拓宽 persistent-height 范围。
   - **画面凸起太像浮雕（像人脸轮廓，而不是油画表面）？** 调低 `outputAmplitude` 或 `luminanceHeightBias`。
   - **背景太死板，想要有些底油墨厚度？** 将 `thicknessFloor` 设为 `0.3` 至 `0.5` 之间。
   - **在高分辨率（如 4K）图上笔触显得太短太碎？** 将 `strokeLength` 调至 40-60，`strokeThickness` 调至 5-6。
5. **重新导出并打印**，直到达到满意效果。

您可以使用 UI 的 “Simulated Print” 面板来在软件中模拟打印机的平滑处理；调整 σ 直至模拟效果与您打印机印出来的实物一致，然后在此基础上调整预设参数。

### E1 平滑度参考

| E1 平滑度滑块值 | 对应的等效 σ (px) —— *约等于* |
|-----------------|------------------------------|
| 1               | ≈ 1.0                        |
| 5               | ≈ 2.2                        |
| 10              | ≈ 3.5                        |

上述数值仅供参考。建议通过打印已知的光栅图形来校准您设备的实际 Gaussian PSF 表现。

---

## 项目目录结构

```
depth_map/
├── web/                        # ★ 核心网页应用 —— 部署该目录即可
│   ├── index.html
│   ├── package.json            # 声明 ES 模块类型，以便测试脚本在 Node 中运行
│   ├── test_node.mjs           # 冒烟测试脚本: `node web/test_node.mjs`
│   └── src/
│       ├── main.js             # 界面交互逻辑
│       ├── worker.js           # Web Worker 入口，在后台运行管线
│       ├── runner.js           # 运行后端分发器与自动选择
│       ├── i18n.js             # 中英文多语言字符串与助手函数
│       ├── backends/
│       │   ├── cpu.js          # 纯 JS 实现的 CPU 后端（始终可用）
│       │   └── webgl.js        # WebGL2 片元着色器实现的高加速后端
│       ├── gl/                 # WebGL2 着色器与助手
│       ├── orientation.js      # CPU：结构张量
│       ├── strokes.js          # CPU：各向异性 LIC
│       ├── compose.js          # CPU：笔触合成
│       ├── postprocess.js      # CPU：锐化补偿与量化
│       ├── presets.js          # 预设参数文件
│       ├── filters.js          # 高斯/Sobel/双线性插值等滤波器
│       ├── rng.js              # 伪随机数生成器
│       └── png.js              # 轻量级 16-bit 灰度 PNG 编码器
├── scripts/
│   ├── dev_server.mjs          # 原生 Node 静态服务器
│   └── test_dev_server.mjs     # 静态服务器 of 测试
├── .github/workflows/          # 自动部署 GitHub Pages 流程
├── docs/example/               # 示例素材
├── package.json                # npm 命令配置
├── README.md                   # 英文说明文档
└── README_zh.md                # 中文说明文档
```

---

## 计算后端

管线有两套独立的等效实现，通过统一的分发器进行调度：

| 后端 | 运行环境 | 浏览器支持 |
|---|---|---|
| **cpu** | Web Worker 线程中的纯 JS | 任何支持 ES 模块与 CompressionStream 的浏览器 |
| **webgl** | WebGL2 片元着色器 | Chrome 56+ / Firefox 51+ / Safari 15+（需支持 `EXT_color_buffer_float` 扩展） |

调度逻辑：
- `auto` (默认)：加载时自动探测 WebGL2 可用性，如果不支持则优雅降级为 CPU 后端。
- 界面上的下拉菜单允许手动强制指定后端以进行基准测试，不支持的选项会被禁用。

无论使用哪种后端，最后输出的 `Float32Array` 均会使用相同的 CPU 量化与 PNG 编码逻辑，从而保证两者输出文件的完全一致。

---

## 开发与测试

```powershell
# 运行管线冒烟测试（CPU 后端）与服务器冒烟测试
npm test

# 也可以单独运行：
npm run test:pipeline      # 执行 node web/test_node.mjs
npm run test:server        # 执行 node scripts/test_dev_server.mjs
```

`web/test_node.mjs` 测试了 CPU 后端的 9 项不变性（数据类型、平坦输入、极性、确定性、PNG 编码、后端探测、强制指定等）。它还会在本地写入一个 256×256 像素的 16-bit PNG 文件 `web/test_node_out.png` 以供视觉校验。

WebGL 后端必须在浏览器中运行并测试。

---

## 故意不包含的设计范围

- **画布编织与纸张纹理** —— 根据用户要求移除。
- **从单目深度模型（如 Marigold）生成 3D 浮雕** —— 不包含。`scan_replica` 仅基于 RGB 油墨笔触。
- **复杂的高级调参滑块** —— 界面仅保留位深、最大尺寸与平滑度 σ 等参数，其他参数请在 `web/src/presets.js` 中调校。

---

## 项目依赖

- 运行时：**无任何第三方依赖。**
- 开发环境：**无任何第三方依赖。** 本项目 `package.json` 没有声明任何运行或开发期依赖（没有 npm 包），测试与服务器全部使用 Node.js 原生模块。
