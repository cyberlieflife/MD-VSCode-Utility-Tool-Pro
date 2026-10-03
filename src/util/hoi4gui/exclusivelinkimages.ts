import { getSpriteByGfxName } from '../image/imagecache';
import { defaultExclusiveLinkSprites, ExclusiveLinkImages, ExclusiveLinkSpriteSpec } from './exclusivelink';

// 两个互斥线精灵都定义在 nationalfocusview.gfx 里，无论哪棵树用到：MIO 特质树复用的是焦点界面的贴图。
export const nationalFocusViewGfxFile = 'interface/nationalfocusview.gfx';

/**
 * 解析互斥连线用到的四张贴图。任一无法解析时返回 undefined（未配置安装路径，或某个模组
 * 重声明了精灵却没带贴图），调用方退回纯色线。
 *
 * 默认精灵与帧号来自 nationalfocusview.gui 的 national_focus_exclusive_item 与
 * industrial_organization_detail.gui 的 industrial_organisation_mutually_exclusive_item；
 * 焦点树的 gui 布局可以声明别的。
 */
export async function loadExclusiveLinkImages(
    spec: ExclusiveLinkSpriteSpec = defaultExclusiveLinkSprites,
    gfxFiles: string | string[] = nationalFocusViewGfxFile,
): Promise<ExclusiveLinkImages | undefined> {
    const lineSprite = await getSpriteByGfxName(spec.lineGfx, gfxFiles);
    const leftSprite = await getSpriteByGfxName(spec.leftGfx, gfxFiles);
    const midSprite = spec.midGfx === spec.leftGfx ? leftSprite : await getSpriteByGfxName(spec.midGfx, gfxFiles);
    const rightSprite = spec.rightGfx === spec.leftGfx ? leftSprite : await getSpriteByGfxName(spec.rightGfx, gfxFiles);
    if (lineSprite === undefined || leftSprite === undefined || midSprite === undefined || rightSprite === undefined) {
        return undefined;
    }

    // frames 把条带横向切帧。取帧而不是整张精灵，也避开九宫格路径：它是 corneredTileSpriteType
    // 但没有 borderSize，切片只会把贴图切坏。
    const line = lineSprite.frames[spec.lineFrame];
    const left = leftSprite.frames[spec.leftFrame];
    const mid = midSprite.frames[spec.midFrame];
    const right = rightSprite.frames[spec.rightFrame];
    if (line === undefined || left === undefined || mid === undefined || right === undefined) {
        return undefined;
    }

    return { line, left, mid, right };
}
