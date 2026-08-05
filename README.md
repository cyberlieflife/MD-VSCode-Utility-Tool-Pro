<p align="center">
  <img src="icon.png" alt="HOI 4 Utilities Pro" width="128" height="128" />
</p>

<h1 align="center">HOI 4 Utilities Pro</h1>
<p align="center"><b>钢铁雄心4模组工具扩展版</b></p>

<p align="center">
  [中文](README_CN.md) | English
</p>

<p align="center">
  All-in-one preview tools for HOI4 mod developers — Focus Tree · Technology Tree · Event Tree · World Map · MIO · GUI · GFX · DDS/TGA
</p>

---

## Features

| Preview | Description |
| --- | --- |
| World map | Preview with provinces, strategic regions and supply areas |
| Focus tree | Preview with conditions, shared focuses, joint focus trees and custom titlebars |
| Technology tree | Preview |
| Event tree | Preview |
| MIO | Military Industrial Organization preview |
| GUI | Preview |
| GFX | Preview `.gfx` sprite definitions (all HOI4 sprites are defined here) |
| Images | Preview `.dds` / `.tga` files |

> The focus tree preview also supports right-click management: **delete focus** (double confirmation) and **create focus**.

## Getting Started

1. Install and enable this extension in VSCode.
2. Set the Heart of Iron IV install path (either way):
   - (Recommended) Open the command palette with `Ctrl+Shift+P` and use the command `Select HOI4 install path` to browse the folder that installed Heart of Iron IV;
   - Or set `mdHoi4Utilities.installPath` in the settings page (`Ctrl+,`).
3. Open your mod development folder.
4. (Optional) Open the command palette with `Ctrl+Shift+P` and use the command `Select mod file` to set the working mod descriptor (the `.mod` file).
5. Use these entries:
   - Command palette (`Ctrl+Shift+P`) commands: `Preview World Map` / `Preview HOI4 file`;
   - The `Preview HOI4 file` button on the top-right toolbar of the text editor;
   - Open a `.dds` or `.tga` file directly.

## Extension Settings

| Setting | Type | Description |
| --- | --- | --- |
| `mdHoi4Utilities.installPath` | `string` | Heart of Iron IV install path. Without this, most features are broken. |
| `mdHoi4Utilities.loadDlcContents` | `boolean` | Whether to load DLC images when previewing files (all DLCs are around 600MB; enabling this uses more memory). |
| `mdHoi4Utilities.modFile` | `string` | Path to the working `.mod` file, used to read `replace_path`. If not specified, uses the first `.mod` file in the first folder of the workspace. |
| `mdHoi4Utilities.enableSupplyArea` | `boolean` | Check this to enable supply areas when developing mods for HOI4 1.10 or below. |
| `mdHoi4Utilities.previewLocalisation` | `enum` | Language of the content shown in the event tree preview. |

## Known Issues

- The focus tree GUI cannot be configured like the technology tree.
- Edge lines on the world map do not always fit the edges of the colors.
- The event tree preview will duplicate an event when it is reachable from different options.

## Credits

This project evolved from the following projects, and we thank all previous contributors:

- **Original extension repository**: [herbix/hoi4modutilities](https://github.com/herbix/hoi4modutilities)
  — the earliest HOI4 mod tooling.
- **Base extension repository**: [MillenniumDawn/MD-VSCode-Utility-Tool](https://github.com/MillenniumDawn/MD-VSCode-Utility-Tool)
  — **this repositoryis forked from it**.
- Special thanks to **AngriestBird** for helping this project.

## Contribute

If you have any suggestions or issues, feel free to open an issue or a PR on the [Github repository](https://github.com/cyberlieflife/MD-VSCode-Utility-Tool-Pro).
