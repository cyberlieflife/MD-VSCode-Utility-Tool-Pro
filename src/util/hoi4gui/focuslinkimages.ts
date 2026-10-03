import { getSpriteByGfxName, Image } from '../image/imagecache';
import type { GridBoxTileShape } from './gridboxcommon';
import { defaultFocusLinkSprites, FocusLinkImages, FocusLinkSpriteSpec, FocusLinkState, focusLinkFrames, focusLinkShapes } from './focuslink';
import { nationalFocusViewGfxFile } from './exclusivelinkimages';

/**
 * 解析 `state` 颜色下每种前置连线贴图的实线与虚线帧。任一无法解析时返回 undefined，
 * 调用方保留纯色线，而不是画出半张贴图的路。
 */
export async function loadFocusLinkImages(
    spec: FocusLinkSpriteSpec = defaultFocusLinkSprites,
    gfxFiles: string | string[] = nationalFocusViewGfxFile,
    state: FocusLinkState = 'available',
): Promise<FocusLinkImages | undefined> {
    const frames = focusLinkFrames(state);
    const solid: Partial<Record<GridBoxTileShape, Image>> = {};
    const dashed: Partial<Record<GridBoxTileShape, Image>> = {};
    for (const shape of focusLinkShapes) {
        const sprite = await getSpriteByGfxName(spec.gfx[shape], gfxFiles);
        // 与互斥连线一样取帧而不是整张精灵：条带里有全部四帧。
        const solidFrame = sprite?.frames[frames.solid];
        const dashedFrame = sprite?.frames[frames.dashed];
        if (solidFrame === undefined || dashedFrame === undefined) {
            return undefined;
        }
        solid[shape] = solidFrame;
        dashed[shape] = dashedFrame;
    }

    return { solid, dashed } as FocusLinkImages;
}
