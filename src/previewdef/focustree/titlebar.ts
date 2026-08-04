import { convertNodeToJson, SchemaDef } from "../../hoiformat/schema";
import { getSpriteByGfxName, Image } from "../../util/image/imagecache";
import { parseHoi4FileCached } from "../../util/fileloader";

export const focusTitlebarStylesFile = 'common/national_focus/00_titlebar_styles.txt';
export const nationalFocusViewGfxFile = 'interface/nationalfocusview.gfx';
export const goalsOverlaysGfxFile = 'interface/goals_overlays.gfx';

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

export async function getFocusOverlayImage(overlay: string | undefined): Promise<Image | undefined> {
    if (!overlay) {
        return undefined;
    }

    const sprite = await getSpriteByGfxName(overlay, goalsOverlaysGfxFile);
    return sprite?.image;
}
