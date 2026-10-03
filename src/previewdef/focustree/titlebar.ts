import { convertNodeToJson, SchemaDef } from "../../hoiformat/schema";
import { getSpriteByGfxName, Image } from "../../util/image/imagecache";
import { parseHoi4FileCached, getDescriptorFocusOverlayGfx } from "../../util/fileloader";
import { resolveConfiguredGfxFiles } from "../../util/configuredgfxfiles";
import { getConfiguration } from "../../util/vsccommon";
import { nationalFocusViewGfxFile } from "../../util/hoi4gui/exclusivelinkimages";

// 焦点标题栏样式表、标题栏贴图与覆盖层贴图的解析。
export const focusTitlebarStylesFile = 'common/national_focus/00_titlebar_styles.txt';
// 游戏自己的焦点覆盖层定义文件。模组的覆盖层文件由 focusOverlayGfxFiles 设置或 .mod 的
// focus_overlay_gfx 列表命名，不在代码里。
export const vanillaFocusOverlayGfxFile = 'interface/goals.gfx';
const focusOverlaySetting = 'mdHoi4Utilities.focusOverlayGfxFiles';

// 与互斥连线精灵声明在同一文件，MIO 预览也读它，两个预览共用一个来源。
export { nationalFocusViewGfxFile };

// Style name used when a focus has no text_icon: the focus frame falls back to this titlebar
// instead of rendering without one.
export const defaultTitlebarStyle = 'default_style';

// Maps a focus's text_icon (or the default fallback when it has none) to its GFX sprite name.
export function resolveTitlebarGfxName(textIcon: string | undefined, titlebarStyles: Record<string, string>): string | undefined {
    return titlebarStyles[textIcon ?? defaultTitlebarStyle];
}

interface TitlebarStyleDef {
    name: string;
    available: string;
}

interface TitlebarStyleFile {
    style: TitlebarStyleDef[];
}

const titlebarStyleSchema: SchemaDef<TitlebarStyleDef> = {
    name: "string",
    available: "string",
};

const titlebarStyleFileSchema: SchemaDef<TitlebarStyleFile> = {
    style: {
        _innerType: titlebarStyleSchema,
        _type: 'array',
    },
};

export async function loadFocusTitlebarStyles(): Promise<Record<string, string>> {
    try {
        const node = await parseHoi4FileCached(focusTitlebarStylesFile);
        const file = convertNodeToJson<TitlebarStyleFile>(node, titlebarStyleFileSchema);
        const result: Record<string, string> = {};

        for (const style of file.style) {
            if (style?.name && style.available) {
                result[style.name] = style.available;
            }
        }

        return result;
    } catch {
        return {};
    }
}

export async function getFocusTitlebarImage(textIcon: string | undefined, titlebarStyles: Record<string, string>): Promise<Image | undefined> {
    const gfxName = resolveTitlebarGfxName(textIcon, titlebarStyles);
    if (!gfxName) {
        return undefined;
    }

    const sprite = await getSpriteByGfxName(gfxName, nationalFocusViewGfxFile);
    return sprite?.image;
}

/**
 * 焦点覆盖层查图的 .gfx 文件，按顺序：游戏的 interface/goals.gfx，然后是设置里的，最后是
 * 工作区模组 descriptor 里 focus_overlay_gfx 命名的（parent mods 的 descriptor 尚未支持）。
 */
export async function getFocusOverlayGfxFiles(): Promise<string[]> {
    return resolveConfiguredGfxFiles(vanillaFocusOverlayGfxFile, [
        ...(getConfiguration().focusOverlayGfxFiles ?? []).map(entry => ({ entry, source: focusOverlaySetting })),
        ...(await getDescriptorFocusOverlayGfx()).map(entry => ({ entry, source: 'focus_overlay_gfx in the .mod file' })),
    ]);
}

export async function getFocusOverlayImage(overlay: string | undefined, overlayGfxFiles: string[]): Promise<Image | undefined> {
    if (!overlay) {
        return undefined;
    }

    const sprite = await getSpriteByGfxName(overlay, overlayGfxFiles);
    return sprite?.image;
}
