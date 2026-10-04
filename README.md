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
| Idea / 理念 | Preview as cards with categories, swap chains and filters / 预览，以卡片呈现，含分类、交换链与筛选 |
| Character / 角色 | Preview with portraits, roles and the modifiers each trait grants / 预览，含肖像、职务与每个特质的修正 |
| Decision / 决议 | Preview as a graph of categories, decisions and missions / 预览，以类别、决议与任务图呈现 |
| Balance of power / 权力平衡 | The game's own balance of power window with its ranges and decisions / 游戏原版权力平衡窗口，含区间与决议 |

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

The Settings editor lists them under the extension in five sections, one page each. / 设置编辑器按五个分组列出这些设置，每组一页。

**Game and mod / 游戏与模组**

| Setting / 设置项 | Type / 类型 | Description / 说明 |
| --- | --- | --- |
| `mdHoi4Utilities.installPath` | `string` | Heart of Iron IV install path. Without this, most features are broken. / 钢铁雄心 IV 安装路径。未设置时大部分功能不可用。 |
| `mdHoi4Utilities.loadDlcContents` | `boolean` | Whether to load DLC images when previewing files (all DLCs are around 600MB; enabling this uses more memory). / 预览时是否加载 DLC 图片（全部 DLC 约 600MB，开启会占用更多内存）。 |
| `mdHoi4Utilities.modFile` | `string` | Path to the working `.mod` file, used to read `replace_path`. If not specified, uses the first `.mod` file in the first folder of the workspace. / 工作 `.mod` 文件路径，用于读取 `replace_path`。未设置时使用工作区第一个文件夹里的第一个 `.mod`。 |
| `mdHoi4Utilities.parentModPaths` | `string[]` | Absolute folders of the mods this workspace extends, searched after the workspace folders and before the game install. / 本工作区所扩展模组的绝对路径，在工作区文件夹之后、游戏安装目录之前查找。 |
| `mdHoi4Utilities.userDataPath` | `string` | The Hearts of Iron IV user data folder (the one with `dlc_load.json`), where the `.mod` file's `dependencies` are looked up. Found automatically when empty. / 钢铁雄心 IV 用户数据目录（含 `dlc_load.json`），用于解析 `.mod` 的 `dependencies`。留空时自动查找。 |

**Previews / 预览**

| Setting / 设置项 | Type / 类型 | Description / 说明 |
| --- | --- | --- |
| `mdHoi4Utilities.previewLocalisation` | `enum` | Language of the content shown in the previews. / 预览中显示的语言。 |
| `mdHoi4Utilities.previewWheel` | `enum` | What a plain mouse wheel does in a preview: `scroll` (the default), `zoom`, or `auto` (zoom for a mouse, scroll for a trackpad). / 预览里裸滚轮的行为：`scroll`（默认）、`zoom`，或 `auto`（鼠标滚轮缩放，触控板滚动）。 |
| `mdHoi4Utilities.eventTreePreview` | `boolean` | Enable the event tree preview. / 启用事件树预览。 |
| `mdHoi4Utilities.ideaPreview` | `boolean` | Enable the idea preview. / 启用理念预览。 |
| `mdHoi4Utilities.characterPreview` | `boolean` | Enable the character preview. / 启用角色预览。 |
| `mdHoi4Utilities.decisionPreview` | `boolean` | Enable the decision preview. / 启用决议预览。 |
| `mdHoi4Utilities.bopPreview` | `boolean` | Enable the balance of power preview. / 启用权力平衡预览。 |
| `mdHoi4Utilities.useConditionInFocus` | `boolean` | Show conditions in the focus tree preview. / 在国策树预览中显示条件。 |
| `mdHoi4Utilities.focusTreeLayout` | `enum` | Where the focus tree preview takes its layout from: `standard`, or the mod's `interface/nationalfocusview.gui`. / 焦点树预览的布局来源：`standard` 内置布局，或模组的 `interface/nationalfocusview.gui`。 |
| `mdHoi4Utilities.focusTreePrerequisiteLines` | `enum` | Which of the game's prerequisite line colours the focus tree preview draws: `available` (blue) or `completed` (green). / 焦点树预览按游戏的哪种前置连线颜色绘制：`available` 蓝色或 `completed` 绿色。 |
| `mdHoi4Utilities.focusOverlayGfxFiles` | `string[]` | `.gfx` files or folders that define the mod's focus overlay sprites, searched after the game's `interface/goals.gfx`. / 定义模组焦点覆盖层精灵的 `.gfx` 文件或文件夹，在游戏的 `interface/goals.gfx` 之后查找。 |
| `mdHoi4Utilities.decisionGfxFiles` | `string[]` | `.gfx` files or folders that define the mod's decision sprites. / 定义模组决议精灵的 `.gfx` 文件或文件夹。 |
| `mdHoi4Utilities.ideaPlaceholderIcon` | `string` | Image drawn for an idea whose `picture` does not resolve. / 理念 `picture` 无法解析时绘制的图像。 |
| `mdHoi4Utilities.characterTraitStructuralKeys` | `string[]` | Trait keys that describe the trait rather than grant a modifier. / 描述特质本身而非提供修正的特质键。 |
| `mdHoi4Utilities.modifierFormatFiles` | `string[]` | Files that say how a modifier reads, written like `common/modifier_definitions`. / 指定修正显示格式的文件，写法同 `common/modifier_definitions`。 |
| `mdHoi4Utilities.technologyGfxRoots` | `string[]` | Folders scanned for `.gfx` files used by the technology tree preview. / 科技树预览扫描 `.gfx` 文件的文件夹。 |
| `mdHoi4Utilities.technologyCountryIcons` | `boolean` | Offer a country dropdown in the technology tree preview and draw each technology with that country's icon. / 科技树预览提供国家下拉，并按所选国家绘制科技图标。 |
| `mdHoi4Utilities.inlayWindowGfxRoots` | `string[]` | Folders scanned first for the `.gfx` files focus inlay windows use, before the whole `interface/` folder. Empty by default. / 优先扫描的国策内嵌窗口 `.gfx` 文件夹，之后仍会扫描整个 `interface/`。默认为空。 |
| `mdHoi4Utilities.modifierInlayHint` | `boolean` | Show the localised name of modifiers inline in `.txt` script files. / 在 `.txt` 脚本文件中内联显示修正的本地化名称。 |

**World map / 世界地图**

| Setting / 设置项 | Type / 类型 | Description / 说明 |
| --- | --- | --- |
| `mdHoi4Utilities.enableSupplyArea` | `boolean` | Check this to enable supply areas when developing mods for HOI4 1.10 or below. / 为 HOI4 1.10 及以下版本做模组时勾选，启用补给区域。 |
| `mdHoi4Utilities.worldMapRetainContextWhenHidden` | `boolean` | Keep the world map preview's webview loaded while the tab is hidden (faster to switch back, uses more memory). / 标签页隐藏时保留世界地图预览的网页内容（切回更快，占用更多内存）。 |

**Indexes and performance / 索引与性能**

| Setting / 设置项 | Type / 类型 | Description / 说明 |
| --- | --- | --- |
| `mdHoi4Utilities.sharedFocusIndex` | `boolean` | Index shared focuses so other trees can pull them in. / 建立共享国策索引，供其它国策树引用。 |
| `mdHoi4Utilities.ideaSwapIndex` | `boolean` | Scan `common` and `events` for `swap_ideas` so the idea preview shows chains (reads many files on the first build). / 扫描 `common` 与 `events` 中的 `swap_ideas`，让理念预览显示交换链（首次构建会读取大量文件）。 |
| `mdHoi4Utilities.gfxIndex` | `boolean` | Index every sprite definition. Faster icon lookups, more memory. / 建立精灵定义索引。图标查找更快，占用更多内存。 |
| `mdHoi4Utilities.localisationIndex` | `boolean` | Index localisation so previews show translated text. Uses more memory. / 建立本地化索引，让预览显示译文。占用更多内存。 |
| `mdHoi4Utilities.imageDecodeWorkers` | `number` | Threads used to decode `.dds` / `.tga` images (1–16, default 4). / 解码 `.dds` / `.tga` 图片使用的线程数（1–16，默认 4）。 |

**Auditor / 检查器**

| Setting / 设置项 | Type / 类型 | Description / 说明 |
| --- | --- | --- |
| `mdHoi4Utilities.auditor.reportFolder` | `string` | Folder the focus-tree audit report is written to (`focus-tree-audit.md`). Empty opens the report in an untitled editor. / 国策树审计报告的写入文件夹（`focus-tree-audit.md`）。留空时在未命名编辑器中打开报告。 |
| `mdHoi4Utilities.auditor.includeVanilla` | `boolean` | Also check the focus trees in the HOI4 install path, not only the working mod's. / 除工作模组外，也检查 HOI4 安装目录中的国策树。 |

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
