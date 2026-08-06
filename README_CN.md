<p align="center">
 <img src="icon.png" alt="钢铁雄心4模组工具扩展版" width="128" height="128" />
</p>

<h1 align="center">钢铁雄心4模组工具扩展版</h1>
<p align="center"><b>HOI 4 Utilities Pro</b></p>

<p align="center">
  [English](README.md) | 中文
</p>

<p align="center">
 HOI4 模组开发者的一站式预览工具 —— 国策树 · 科技树 · 事件树 · 世界地图 · MIO · GUI · GFX · DDS/TGA
</p>

---

> [!IMPORTANT]
> 本项目与 **HOI4 Mod Utilities** 和 **HOI4 Utilities 2026** 的主要区别是：在预览功能上新增了**图形化编辑支持**。

## 特性 (Features)

| 预览类型 | 说明 |
| --- | --- |
| 世界地图 | `World map` 预览，含省份、战略区域、补给区域 |
| 国策树 | `Focus tree` 预览，支持条件、共享国策、联合树、自定义标题栏 |
| 科技树 | `Technology tree` 预览 |
| 事件树 | `Event tree` 预览 |
| MIO | 军事工业组织预览 |
| GUI | 界面预览 |
| GFX | `.gfx` 精灵定义预览（HOI4 的精灵都定义在这里） |
| 图片 | `.dds` / `.tga` 图片预览 |

## 快速开始 (Getting Started)

1. 在 VSCode 中安装并启用本扩展。
2. 设置钢铁雄心 IV 安装路径（二选一）：
 - （推荐）命令面板 `Ctrl+Shift+P` → 使用命令 `Select HOI4 install path` 浏览游戏安装目录；
 - 或在设置页（`Ctrl+,`）中填写 `mdHoi4Utilities.installPath`。
3. 打开你的模组开发目录。
4. （可选）命令面板 → `Select mod file` 选择工作模组描述文件（`.mod`）。
5. 使用入口：
 - 命令面板（`Ctrl+Shift+P`）命令：`Preview World Map` / `Preview HOI4 file`；
 - 文本编辑器右上角工具栏的 `Preview HOI4 file` 按钮；
 - 直接打开 `.dds` / `.tga` 文件。

## 扩展设置 (Extension Settings)

| 设置项 | 类型 | 说明 |
| --- | --- | --- |
| `mdHoi4Utilities.installPath` | `string` | 钢铁雄心 IV 安装路径。未设置时大部分功能不可用。 |
| `mdHoi4Utilities.loadDlcContents` | `boolean` | 预览时是否加载 DLC 图片（全部 DLC 约 600MB，开启会占用更多内存）。 |
| `mdHoi4Utilities.modFile` | `string` | 工作 `.mod` 文件路径，用于读取 `replace_path`。未设置时使用工作区第一个文件夹里的第一个 `.mod`。 |
| `mdHoi4Utilities.enableSupplyArea` | `boolean` | 为 HOI4 1.10 及以下版本做模组时勾选，启用补给区域。 |
| `mdHoi4Utilities.previewLocalisation` | `enum` | 事件树预览中显示的语言。 |

## 已知问题 (Known Issues)

- 国策树的 GUI 不能像科技树那样配置。
- 世界地图的边缘线不一定与颜色边界完全贴合。
- 事件树预览中，同一事件来自不同选项时会重复显示。

## 致谢 (Credits)

本项目由以下项目一路演进而来，感谢所有前人的贡献：

- **原始扩展仓库**：[herbix/hoi4modutilities](https://github.com/herbix/hoi4modutilities)
 —— 最早的 HOI4 模组工具。
- **原扩展仓库**：[MillenniumDawn/MD-VSCode-Utility-Tool](https://github.com/MillenniumDawn/MD-VSCode-Utility-Tool)
 —— **本仓库由它 fork 而来**。
- 特别感谢 **AngriestBird** 对项目的帮助。

## 贡献 (Contribute)

有任何建议或问题，欢迎到 [Github 仓库](https://github.com/cyberlieflife/MD-VSCode-Utility-Tool-Pro) 提 issue 或 PR。
