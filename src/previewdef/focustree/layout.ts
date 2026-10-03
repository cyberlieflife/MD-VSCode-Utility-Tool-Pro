import { HOIPartial, NumberLike, toNumberLike, toStringAsSymbolIgnoreCase } from '../../hoiformat/schema';
import { ContainerWindowType, GridBoxType, GuiFile, PositionType } from '../../hoiformat/gui';
import { NumberPosition } from '../../util/common';
import { getWidth, normalizeNumberLike } from '../../util/hoi4gui/common';
import { defaultExclusiveLinkSprites, ExclusiveLinkSpriteSpec } from '../../util/hoi4gui/exclusivelink';
import { defaultFocusLinkSprites, FocusLinkSpriteSpec, focusLinkShapes } from '../../util/hoi4gui/focuslink';

// 从 nationalfocusview.gui 构建焦点树的布局参数：网格、每个焦点的各图层偏移、连线与互斥
// 标记的贴图规格、continuous focus 框尺寸。
export type FocusTreeLayoutMode = 'standard' | 'gui';

export const nationalFocusViewGuiFile = 'interface/nationalfocusview.gui';

/**
 * 一个焦点各图层在它的网格格子里的位置，用焦点渲染器写进 CSS 的数字表示。standard 的取值
 * 是预览一直使用的那些。
 */
export interface FocusItemLayout {
    iconOffsetX: number;
    iconOffsetY: number;
    titlebarOffsetX: number;
    titlebarTop: number;
    overlayOffsetX: number;
    overlayOffsetY: number;
    textOffsetX: number;
    textTop: number;
}

// 树从第一行起的生长方向，游戏取自网格的 `format`。
export type FocusTreeFormat = 'up' | 'down' | 'left' | 'right';

export interface FocusTreeLayout {
    mode: FocusTreeLayoutMode;
    format: FocusTreeFormat;
    grid: NumberPosition;
    spacing: NumberPosition;
    item: FocusItemLayout;
    // 两端都落在标准布局位置时为 undefined，标准页面不带额外数据。
    links?: { parent: NumberPosition; child: NumberPosition };
    // `national_focus_center`：initial_show_position 槽位中游戏居中视图的点。只在 gui 文件声明
    // 时才设置，否则预览仍从左上角打开。
    center?: NumberPosition;
    exclusive: { offsetY: number; startX: number; endX: number; sprites: ExclusiveLinkSpriteSpec };
    // 前置连线贴图的规格：尺寸、离线的偏移、各形状的精灵。
    prerequisiteLink: { size: number; offset: NumberPosition; sprites: FocusLinkSpriteSpec };
    // continuous focus 框。只有尺寸来自文件：树里的 continuous_focus_position 会在游戏里替换
    // 窗口自身的位置。
    continuous: { width: number; height: number };
}

export const standardFocusTreeLayout: FocusTreeLayout = {
    mode: 'standard',
    format: 'up',
    grid: { x: 50, y: 50 },
    spacing: { x: 96, y: 130 },
    item: {
        iconOffsetX: 0,
        iconOffsetY: -18,
        titlebarOffsetX: 0,
        titlebarTop: 70,
        overlayOffsetX: 0,
        overlayOffsetY: -3,
        textOffsetX: 0,
        textTop: 85,
    },
    // 游戏画线穿过名条中部、跨过两条名条之间的间隙。图标中心在 bg 顶下方 28px（互斥 item y 28 +
    // exclusive_offset y 24 + 32px 图标的一半 - bg y 40），即格子中心下方 70 + 28 - 65。两端从
    // 164px 名条中心外移 80px，即标准 32px 图标内缩再加 48。
    exclusive: { offsetY: 33, startX: 48, endX: -48, sprites: defaultExclusiveLinkSprites },
    prerequisiteLink: { size: 16, offset: { x: 0, y: 0 }, sprites: defaultFocusLinkSprites },
    continuous: { width: 770, height: 380 },
};

// 游戏自己的 nationalfocusview.gui 所声明的值，标准布局就是照着它画的。预览的焦点是 96x130
// 的格子而不是游戏 165x128 的窗口，模组 gui 的坐标不能照搬：每个值按它与这些参考值的距离
// 平移标准布局。
const reference = {
    symbol: { x: 5, y: -44 },
    bg: { x: 5, y: 40 },
    overlay: { x: -9, y: -28 },
    name: { x: 15, y: 58, maxWidth: 147 },
    linkBegin: { x: 80, y: 64 },
    linkEnd: { x: 80, y: 0 },
    exclusiveOffset: { x: 172, y: 24 },
    exclusiveOffsetLeftX: 12,
    exclusiveItem: { x: -5, y: 28 },
    exclusiveOffsetY: 24,
    exclusiveItemY: 28,
    link: { x: -2, y: 0 },
};

type Window = HOIPartial<ContainerWindowType>;

function num(value: NumberLike | undefined): number | undefined {
    return normalizeNumberLike(value, 0);
}

function point(position: HOIPartial<{ x: NumberLike; y: NumberLike }> | undefined): Partial<NumberPosition> {
    return { x: num(position?.x), y: num(position?.y) };
}

function findWindow(windows: Window[], name: string): Window | undefined {
    for (const window of windows) {
        if (window.name === name) {
            return window;
        }
    }
    for (const window of windows) {
        const found = findWindow([...window.containerwindowtype, ...window.windowtype], name);
        if (found) {
            return found;
        }
    }
    return undefined;
}

function childWindow(window: Window | undefined, name: string): Window | undefined {
    return window ? [...window.containerwindowtype, ...window.windowtype].find(w => w.name === name) : undefined;
}

// 百分比尺寸在这里没有可依的基准，同样保留标准值。
function length(value: NumberLike | undefined): number | undefined {
    const result = num(value);
    return result !== undefined && result > 0 ? result : undefined;
}

function byName<T extends { name?: string }>(elements: T[] | undefined, name: string): T | undefined {
    return elements?.find(e => e.name === name);
}

// gui 只声明了一张精灵（竖直走向）。当它遵循游戏的 `..._up_down` 命名时其余形状是它的兄弟
// 名称；否则只替换竖直走向那张。gui 的 `frame` 只是图标的起始帧：每条线的帧由游戏按状态取。
function focusLinkSprites(icon: { spritetype?: string; quadtexturesprite?: string } | undefined): FocusLinkSpriteSpec {
    const defaults = defaultFocusLinkSprites;
    const name = icon?.spritetype ?? icon?.quadtexturesprite;
    if (name === undefined) {
        return defaults;
    }
    const suffix = '_up_down';
    const prefix = name.endsWith(suffix) ? name.slice(0, -suffix.length) : undefined;
    const gfx = { ...defaults.gfx, up_down: name };
    if (prefix !== undefined) {
        for (const shape of focusLinkShapes) {
            gfx[shape] = `${prefix}_${shape}`;
        }
    }
    return { gfx };
}

function shift(standard: number, value: number | undefined, referenceValue: number): number {
    return value === undefined ? standard : standard + value - referenceValue;
}

// gui 的帧从 1 起算，没有帧的图标显示第一帧；图标缺失则保留默认。
function frameOf(icon: { frame?: number } | undefined, fallback: number): number {
    return icon === undefined ? fallback : Math.max(0, (icon.frame ?? 1) - 1);
}

/**
 * 从加载好的 nationalfocusview.gui 构建焦点树布局。文件未声明的每个值保留标准值，
 * 因此空列表给出标准布局的 gui 模式。
 */
export function buildFocusTreeLayout(guiFiles: HOIPartial<GuiFile>[]): FocusTreeLayout {
    const guiTypes = guiFiles.flatMap(f => f.guitypes);
    const windows = guiTypes.flatMap(t => [...t.containerwindowtype, ...t.windowtype]);
    const positions: Record<string, Partial<NumberPosition>> = {};
    const collectPositions = (list: HOIPartial<PositionType>[]) => {
        for (const position of list) {
            if (position.name && !(position.name in positions)) {
                positions[position.name] = point(position.position);
            }
        }
    };
    guiTypes.forEach(t => collectPositions(t.positiontype));

    const standard = standardFocusTreeLayout;

    // 焦点网格是 `tree > grid_window` 里的 `grid`；游戏文件在别处还有一个同名 gridbox，所以按
    // 路径逐层找而不是按名字查。
    const view = findWindow(windows, 'nationalfocusview');
    const gridWindow = childWindow(childWindow(view, 'tree'), 'grid_window');
    const gridBox = byName(gridWindow?.gridboxtype, 'grid');
    const gridPosition = point(gridBox?.position);
    const format = gridBox?.format?._name;

    const spacing = positions['focus_spacing'] ?? {};
    const continuousSize = childWindow(gridWindow, 'continuous_focus_window')?.size;

    const item = findWindow(windows, 'national_focus_item');
    const symbol = point(byName(item?.buttontype, 'symbol')?.position);
    const bg = point(byName(item?.buttontype, 'bg')?.position);
    const overlay = point(byName(item?.icontype, 'overlay')?.position);
    const nameBox = byName(item?.instanttextboxtype, 'name');
    const name = point(nameBox?.position);
    const nameMaxWidth = num(nameBox?.maxwidth) ?? reference.name.maxWidth;
    const nameCenter = name.x === undefined && nameBox?.maxwidth === undefined ? undefined : (name.x ?? reference.name.x) + nameMaxWidth / 2;

    const linkBegin = positions['link_begin'] ?? {};
    const linkEnd = positions['link_end'] ?? {};
    const parent = {
        x: shift(0, linkBegin.x, reference.linkBegin.x),
        y: shift(0, linkBegin.y, reference.linkBegin.y),
    };
    const child = {
        x: shift(0, linkEnd.x, reference.linkEnd.x),
        y: shift(0, linkEnd.y, reference.linkEnd.y),
    };
    const links = parent.x === 0 && parent.y === 0 && child.x === 0 && child.y === 0 ? undefined : { parent, child };

    const declaredCenter = positions['national_focus_center'];
    const center = declaredCenter ? { x: declaredCenter.x ?? 0, y: declaredCenter.y ?? 0 } : undefined;

    const exclusiveItem = findWindow(windows, 'national_focus_exclusive_item');
    const exclusiveOffset = positions['exclusive_offset'] ?? {};
    const exclusiveItemPosition = point(exclusiveItem?.position);
    const exclusiveOffsetY = shift(standard.exclusive.offsetY, exclusiveOffset.y, reference.exclusiveOffset.y) +
        shift(0, exclusiveItemPosition.y, reference.exclusiveItem.y);
    // 游戏没有公开这条规则，数值是照它自己的数读出来的：对 165px 宽、中心在 x=80 的焦点，连线
    // 从左焦点加 `exclusive_offset.x` 起、到右焦点加 `exclusive_offset_left.x` 止，两者都随
    // 互斥 item 自身的 x 平移。`exclusive_positioning` 不参与。
    const exclusiveItemShiftX = shift(0, exclusiveItemPosition.x, reference.exclusiveItem.x);
    const exclusiveStartX = shift(standard.exclusive.startX, exclusiveOffset.x, reference.exclusiveOffset.x) + exclusiveItemShiftX;
    const exclusiveEndX = shift(standard.exclusive.endX, positions['exclusive_offset_left']?.x, reference.exclusiveOffsetLeftX) + exclusiveItemShiftX;
    const exclusiveIcon = (iconName: string) => byName(exclusiveItem?.icontype, iconName);
    const line = exclusiveIcon('link1');
    const left = exclusiveIcon('left');
    const mid = exclusiveIcon('mid');
    const right = exclusiveIcon('right');
    const defaults = defaultExclusiveLinkSprites;

    const linkWindow = findWindow(windows, 'national_focus_link');
    const linkPosition = point(linkWindow?.position);
    const linkSize = num(getWidth(linkWindow?.size));

    return {
        mode: 'gui',
        // `center` 会把每个焦点叠在同一格；游戏自己的文件写的是 `UP`。
        format: format === 'down' || format === 'left' || format === 'right' ? format : 'up',
        grid: { x: gridPosition.x ?? standard.grid.x, y: gridPosition.y ?? standard.grid.y },
        spacing: { x: spacing.x ?? standard.spacing.x, y: spacing.y ?? standard.spacing.y },
        item: {
            iconOffsetX: shift(standard.item.iconOffsetX, symbol.x, reference.symbol.x),
            iconOffsetY: shift(standard.item.iconOffsetY, symbol.y, reference.symbol.y),
            titlebarOffsetX: shift(standard.item.titlebarOffsetX, bg.x, reference.bg.x),
            titlebarTop: shift(standard.item.titlebarTop, bg.y, reference.bg.y),
            overlayOffsetX: shift(standard.item.overlayOffsetX, overlay.x, reference.overlay.x),
            overlayOffsetY: shift(standard.item.overlayOffsetY, overlay.y, reference.overlay.y),
            textOffsetX: shift(standard.item.textOffsetX, nameCenter, reference.name.x + reference.name.maxWidth / 2),
            textTop: shift(standard.item.textTop, name.y, reference.name.y),
        },
        ...(links ? { links } : {}),
        ...(center ? { center } : {}),
        exclusive: {
            offsetY: exclusiveOffsetY,
            startX: exclusiveStartX,
            endX: exclusiveEndX,
            sprites: {
                lineGfx: line?.spritetype ?? line?.quadtexturesprite ?? defaults.lineGfx,
                lineFrame: frameOf(line, defaults.lineFrame),
                leftGfx: left?.spritetype ?? left?.quadtexturesprite ?? defaults.leftGfx,
                leftFrame: frameOf(left, defaults.leftFrame),
                midGfx: mid?.spritetype ?? mid?.quadtexturesprite ?? defaults.midGfx,
                midFrame: frameOf(mid, defaults.midFrame),
                rightGfx: right?.spritetype ?? right?.quadtexturesprite ?? defaults.rightGfx,
                rightFrame: frameOf(right, defaults.rightFrame),
            },
        },
        prerequisiteLink: {
            size: linkSize !== undefined && linkSize > 0 ? linkSize : standard.prerequisiteLink.size,
            offset: {
                x: shift(0, linkPosition.x, reference.link.x),
                y: shift(0, linkPosition.y, reference.link.y),
            },
            sprites: focusLinkSprites(byName(linkWindow?.icontype, 'link')),
        },
        continuous: {
            width: length(continuousSize?.width) ?? standard.continuous.width,
            height: length(continuousSize?.height) ?? standard.continuous.height,
        },
    };
}

export function focusTreeGridBoxFor(layout: FocusTreeLayout): HOIPartial<GridBoxType> {
    return {
        position: { x: toNumberLike(layout.grid.x), y: toNumberLike(layout.grid.y) },
        format: toStringAsSymbolIgnoreCase(layout.format),
        size: { width: toNumberLike(layout.spacing.x), height: undefined },
        slotsize: { width: toNumberLike(layout.spacing.x), height: toNumberLike(layout.spacing.y) },
    } as HOIPartial<GridBoxType>;
}
