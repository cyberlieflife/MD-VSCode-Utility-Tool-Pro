<p align="center">
  <img src="icon.png" alt="HOI 4 Utilities Pro / 钢铁雄心4模组工具扩展版" width="128" height="128" />
</p>

<h1 align="center">HOI 4 Utilities Pro</h1>
<p align="center"><b>钢铁雄心4模组工具扩展版</b></p>

<p align="center">
  All-in-one preview tools for HOI4 mod developers — Focus Tree · Technology Tree · Event Tree · World Map · MIO · GUI · GFX · DDS/TGA
  HOI4 模组开发者的一站式预览工具 —— 国策树 · 科技树 · 事件树 · 世界地图 · MIO · GUI · GFX · DDS/TGA
</p>

---

> [!IMPORTANT]
> The main difference between this project and **HOI4 Mod Utilities** / **HOI4 Utilities 2026** is the **graphical editing support** added to the preview features.
> 本项目与 **HOI4 Mod Utilities** 和 **HOI4 Utilities 2026** 的主要区别是：在预览功能上新增了**图形化编辑支持**。

## Features / 特性

| Preview / 预览类型 | Description / 说明 |
| --- | --- |
| World map / 世界地图 | Preview with provinces, strategic regions and supply areas / 预览，含省份、战略区域、补给区域 |
| Focus tree / 国策树 | Preview with conditions, shared focuses, joint focus trees and custom titlebars / 预览，支持条件、共享国策、联合树、自定义标题栏 |
| Technology tree / 科技树 | Preview / 预览 |
| Event tree / 事件树 | Preview / 预览 |
| MIO / MIO | Military Industrial Organization preview / 军事工业组织预览 |
| GUI / GUI | Preview / 界面预览 |
| GFX / GFX | Preview `.gfx` sprite definitions (all HOI4 sprites are defined here) / `.gfx` 精灵定义预览（HOI4 的精灵都定义在这里） |
| Images / 图片 | Preview `.dds` / `.tga` files / `.dds` / `.tga` 图片预览 |

## Getting Started / 快速开始

1. Install and enable this extension in VSCode. / 在 VSCode 中安装并启用本扩展。
2. Set the Heart of Iron IV install path (either way): / 设置钢铁雄心 IV 安装路径（二选一）：
   - (Recommended) Open the command palette with `Ctrl+Shift+P` and use the command `Select HOI4 install path` to browse the folder that installed Heart of Iron IV; / （推荐）命令面板 `Ctrl+Shift+P` → 使用命令 `Select HOI4 install path` 浏览游戏安装目录；
   - Or set `mdHoi4Utilities.installPath` in the settings page (`Ctrl+,`). / 或在设置页（`Ctrl+,`）中填写 `mdHoi4Utilities.installPath`。
3. Open your mod development folder. / 打开你的模组开发目录。
4. (Optional) Open the command palette with `Ctrl+Shift+P` and use the command `Select mod file` to set the working mod descriptor (the `.mod` file). / （可选）命令面板 → `Select mod file` 选择工作模组描述文件（`.mod`）。
5. Use these entries: / 使用入口：
   - Command palette (`Ctrl+Shift+P`) commands: `Preview World Map` / `Preview HOI4 file`; / 命令面板（`Ctrl+Shift+P`）命令：`Preview World Map` / `Preview HOI4 file`；
   - The `Preview HOI4 file` button on the top-right toolbar of the text editor; / 文本编辑器右上角工具栏的 `Preview HOI4 file` 按钮；
   - Open a `.dds` or `.tga` file directly. / 直接打开 `.dds` / `.tga` 文件。

## Extension Settings / 扩展设置

| Setting / 设置项 | Type / 类型 | Description / 说明 |
| --- | --- | --- |
| `mdHoi4Utilities.installPath` | `string` | Heart of Iron IV install path. Without this, most features are broken. / 钢铁雄心 IV 安装路径。未设置时大部分功能不可用。 |
| `mdHoi4Utilities.loadDlcContents` | `boolean` | Whether to load DLC images when previewing files (all DLCs are around 600MB; enabling this uses more memory). / 预览时是否加载 DLC 图片（全部 DLC 约 600MB，开启会占用更多内存）。 |
| `mdHoi4Utilities.modFile` | `string` | Path to the working `.mod` file, used to read `replace_path`. If not specified, uses the first `.mod` file in the first folder of the workspace. / 工作 `.mod` 文件路径，用于读取 `replace_path`。未设置时使用工作区第一个文件夹里的第一个 `.mod`。 |
| `mdHoi4Utilities.enableSupplyArea` | `boolean` | Check this to enable supply areas when developing mods for HOI4 1.10 or below. / 为 HOI4 1.10 及以下版本做模组时勾选，启用补给区域。 |
| `mdHoi4Utilities.previewLocalisation` | `enum` | Language of the content shown in the event tree preview. / 事件树预览中显示的语言。 |

## Known Issues / 已知问题

- The focus tree GUI cannot be configured like the technology tree. / 国策树的 GUI 不能像科技树那样配置。
- Edge lines on the world map do not always fit the edges of the colors. / 世界地图的边缘线不一定与颜色边界完全贴合。
- The event tree preview will duplicate an event when it is reachable from different options. / 事件树预览中，同一事件来自不同选项时会重复显示。

## Credits / 致谢

This project evolved from the following projects, and we thank all previous contributors:
本项目由以下项目一路演进而来，感谢所有前人的贡献：

- **Original extension repository / 原始扩展仓库**: [herbix/hoi4modutilities](https://github.com/herbix/hoi4modutilities)
  — the earliest HOI4 mod tooling. / 最早的 HOI4 模组工具。
- **Base extension repository / 原扩展仓库**: [MillenniumDawn/MD-VSCode-Utility-Tool](https://github.com/MillenniumDawn/MD-VSCode-Utility-Tool)
  — **this repositoryis forked from it**. / **本仓库由它 fork 而来**。
- Special thanks to **AngriestBird** for helping this project. / 特别感谢 **AngriestBird** 对项目的帮助。

## Contribute / 贡献

If you have any suggestions or issues, feel free to open an issue or a PR on the [Github repository](https://github.com/cyberlieflife/MD-VSCode-Utility-Tool-Pro).
有任何建议或问题，欢迎到 [Github 仓库](https://github.com/cyberlieflife/MD-VSCode-Utility-Tool-Pro) 提 issue 或 PR。
