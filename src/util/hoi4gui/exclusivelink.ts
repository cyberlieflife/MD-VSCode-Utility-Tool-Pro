import { StyleTable } from '../styletable';
import type { Image } from '../image/imagecache';
import type { Format } from '../../hoiformat/gui';
import { GridBoxConnection, GridBoxItem } from './gridboxcommon';

// 互斥连线的类名与贴图规格：webview 侧只挂类名，CSS 由宿主注册（贴图要在宿主解码）。
// 本模块被 webview bundle 引入，保持无宿主依赖。
export const exclusiveLinkClass = 'st-focus-exclusive-link';
export const exclusiveLinkVerticalClass = 'st-focus-exclusive-link-vertical';
// StyleTable.style 会补上 st- 前缀；从类名去掉前缀即同一选择器的 style 名，两处不会漂移。
const exclusiveLinkStyleName = exclusiveLinkClass.slice('st-'.length);
const exclusiveLinkVerticalStyleName = exclusiveLinkVerticalClass.slice('st-'.length);

/** 互斥连线用到的精灵与 0 基帧号。 */
export interface ExclusiveLinkSpriteSpec {
    lineGfx: string;
    lineFrame: number;
    leftGfx: string;
    leftFrame: number;
    midGfx: string;
    midFrame: number;
    rightGfx: string;
    rightFrame: number;
}

// gui 里的 frame = 1 是第一帧；精灵的 frames 数组是 0 基。
export const defaultExclusiveLinkSprites: ExclusiveLinkSpriteSpec = {
    lineGfx: 'GFX_focus_exclusive_line1',
    lineFrame: 0,
    leftGfx: 'GFX_focus_link_exclusive',
    leftFrame: 1,
    midGfx: 'GFX_focus_link_exclusive',
    midFrame: 0,
    rightGfx: 'GFX_focus_link_exclusive',
    rightFrame: 2,
};

/** gui 布局相对标准布局对连线的平移（像素），全部默认 0。 */
export interface ExclusiveLinkOffset {
    startX?: number;
    endX?: number;
    y?: number;
}

/**
 * 焦点树在标准布局之外的额外画法：`gapUnderMid` 让线在中间图标边缘断开（图标半透明处
 * 会透出下面的线）；`zIndex` 把线抬到节点之上（线穿过焦点名条时需要）；`clampToCentre`
 * 在两端收得比半条线还短时把图标夹在居中位置。
 */
export interface ExclusiveLinkOptions {
    gapUnderMid?: boolean;
    zIndex?: number;
    clampToCentre?: boolean;
}

export interface ExclusiveLinkImages {
    line: Image;
    left: Image;
    mid: Image;
    right: Image;
}

// 连接元素的跨度是节点中心到节点中心，而游戏按盒边到盒边摆互斥标记：内缩半个槽位减半个
// 图标即落到盒边，线再内缩半个图标复现 gui（link1 在 x=16，图标 32 宽画在 x=0）。
export function exclusiveLinkInsets(slotWidth: number, iconWidth: number): { iconInset: number; lineInset: number } {
    const iconInset = slotWidth / 2 - iconWidth / 2;
    return { iconInset, lineInset: iconInset + iconWidth / 2 };
}

/**
 * 注册 exclusiveLinkClass 背后的 CSS；`images` 传 undefined 得到旧的纯红细线（结构渲染遍与
 * 安装路径不可解析时用）。两个分支刻意声明同一组属性：焦点树分两遍渲染、各有一张
 * StyleTable，两份规则会同时存在于页面里按属性逐条级联，只在一侧声明的属性不会被覆盖
 * 而是混入——那正是红框曾透在贴图下面的原因。
 *
 * `offset` 把连线的左右端与高度移离标准布局位置；`options` 见 ExclusiveLinkOptions。
 * 竖直变体用于 LEFT/RIGHT 生长的树：同一批横向贴图旋转四分之一圈画在 1px 宽的连接元素上。
 */
export function registerExclusiveLinkStyles(
    styleTable: StyleTable,
    images: ExclusiveLinkImages | undefined,
    slotWidth: number,
    offset: ExclusiveLinkOffset = {},
    slotHeight: number = slotWidth,
    options: ExclusiveLinkOptions = {},
): void {
    const { startX = 0, endX = 0, y: offsetY = 0 } = offset;
    const px = (value: number) => value === 0 ? '0' : value + 'px';
    // 最多内缩半条线减去 half，使两端在中间相遇而不是交叉。
    const inset = (value: number, half: number) => options.clampToCentre ? `min(${value}px, calc(50% - ${half}px))` : `${value}px`;

    // 两个图层都比 1px 的连接元素高，是有意为之；zIndex 与 overflow 合并注册（同一选择器，
    // StyleTable 按选择器去重，分两次调用会丢掉后一次）。
    styleTable.style(exclusiveLinkStyleName, () => `
        ${options.zIndex !== undefined ? `z-index: ${options.zIndex};` : ''}
        overflow: visible;
    `);
    styleTable.style(exclusiveLinkVerticalStyleName, () => `
        container-type: size;
        overflow: visible;
    `);

    if (images === undefined) {
        // 与贴图分支声明同一组属性（见函数说明），只把取值退化为纯色线；缺了任一侧，
        // 另一侧的值会在两遍 CSS 的级联里透出来。
        styleTable.style(exclusiveLinkVerticalStyleName, () => `
            content: '';
            position: absolute;
            left: 0;
            top: 0;
            width: 0;
            height: 100%;
            border-left: 1px solid red;
            transform-origin: 0 0;
            transform: none;
            background-image: none;
            background-repeat: no-repeat;
            background-position: 0 0;
            background-size: auto;
        `, '::before');
        styleTable.style(exclusiveLinkVerticalStyleName, () => `
            content: none;
            position: absolute;
            left: 0;
            top: 0;
            width: 0;
            height: 0;
            transform-origin: 0 0;
            transform: none;
            background-image: none;
            background-repeat: no-repeat;
            background-position: 0 0;
            background-size: auto;
        `, '::after');
        styleTable.style(exclusiveLinkStyleName, () => `
            content: '';
            position: absolute;
            left: ${px(startX)};
            right: ${px(-endX)};
            top: ${px(offsetY)};
            height: 0;
            border-top: 1px solid red;
            background-image: none;
            background-repeat: no-repeat;
            background-position: 0 0;
            background-size: auto;
            mask-image: none;
        `, '::before');
        styleTable.style(exclusiveLinkStyleName, () => `
            content: none;
            position: absolute;
            left: 0;
            right: 0;
            top: 0;
            height: 0;
            background-image: none;
            background-repeat: no-repeat;
            background-position: 0 0;
            background-size: auto;
        `, '::after');
        return;
    }

    const { line, left, mid, right } = images;
    const { iconInset, lineInset } = exclusiveLinkInsets(slotWidth, left.width);
    const midHalf = mid.width / 2;
    const lineMask = options.gapUnderMid
        ? `linear-gradient(to right, #000 calc(50% - ${midHalf}px), transparent calc(50% - ${midHalf}px), transparent calc(50% + ${midHalf}px), #000 calc(50% + ${midHalf}px))`
        : 'none';

    styleTable.style(exclusiveLinkStyleName, () => `
        content: '';
        position: absolute;
        left: ${inset(lineInset + startX, 0)};
        right: ${inset(lineInset - endX, 0)};
        top: ${offsetY - line.height / 2}px;
        height: ${line.height}px;
        border-top: none;
        background-image: url(${line.uri});
        background-repeat: repeat-x;
        background-position: left center;
        background-size: ${line.width}px ${line.height}px;
        mask-image: ${lineMask};
    `, '::before');

    // 三个图标作为三层背景画在同一元素上：左箭头、中间图标、右箭头，与游戏 gui 的声明顺序一致。
    styleTable.style(exclusiveLinkStyleName, () => `
        content: '';
        position: absolute;
        left: ${inset(iconInset + startX, left.width / 2)};
        right: ${inset(iconInset - endX, right.width / 2)};
        top: ${offsetY - left.height / 2}px;
        height: ${left.height}px;
        background-image: url(${left.uri}), url(${mid.uri}), url(${right.uri});
        background-repeat: no-repeat, no-repeat, no-repeat;
        background-position: left center, center center, right center;
        background-size: ${left.width}px ${left.height}px, ${mid.width}px ${mid.height}px, ${right.width}px ${right.height}px;
    `, '::after');

    // 竖直变体：横向条带以左上角为原点顺时针转 90 度沿列向下，再右移半个厚度居中到线上。
    const vertical = exclusiveLinkInsets(slotHeight, left.width);
    styleTable.style(exclusiveLinkVerticalStyleName, () => `
        content: '';
        position: absolute;
        left: 0;
        top: ${vertical.lineInset}px;
        width: calc(100cqh - ${vertical.lineInset * 2}px);
        height: ${line.height}px;
        border-left: none;
        transform-origin: 0 0;
        transform: translateX(${line.height / 2}px) rotate(90deg);
        background-image: url(${line.uri});
        background-repeat: repeat-x;
        background-position: left center;
        background-size: ${line.width}px ${line.height}px;
    `, '::before');
    styleTable.style(exclusiveLinkVerticalStyleName, () => `
        content: '';
        position: absolute;
        left: 0;
        top: ${vertical.iconInset}px;
        width: calc(100cqh - ${vertical.iconInset * 2}px);
        height: ${left.height}px;
        transform-origin: 0 0;
        transform: translateX(${left.height / 2}px) rotate(90deg);
        background-image: url(${left.uri}), url(${mid.uri}), url(${right.uri});
        background-repeat: no-repeat, no-repeat, no-repeat;
        background-position: left center, center center, right center;
        background-size: ${left.width}px ${left.height}px, ${mid.width}px ${mid.height}px, ${right.width}px ${right.height}px;
    `, '::after');
}

/**
 * 把互斥连线的纯色线换成游戏贴图，仅当两节点同一行时。其余组合走
 * renderGridBoxConnection 的 L 形折线（在竖长盒的两条边上画边框），横向贴图不适用——焦点树
 * 的 schema 已对这类配对给出警告。在这里而不是建 items 时决定，才能知道目标的所在行。
 * 在 webview 侧、items 即将进入 renderGridBoxCommon 前调用；`format` 是网格的。
 */
export function applyExclusiveLinkStyle(items: GridBoxItem[], format: Format['_name'] = 'up'): void {
    const linkClass = format === 'left' || format === 'right' ? exclusiveLinkVerticalClass : exclusiveLinkClass;
    const rowById: Record<string, number> = {};
    for (const item of items) {
        rowById[item.id] = item.gridY;
    }

    const drawn: Record<string, true> = {};
    for (const item of items) {
        const kept: GridBoxConnection[] = [];
        for (const conn of item.connections) {
            if (conn.targetType !== 'related' || rowById[conn.target] !== item.gridY) {
                kept.push(conn);
                continue;
            }

            // 一对节点的两侧互相推一条连接，连线会叠画两次。对 1px 边框不可见，但会把半透明
            // 贴图双重合成；两条连接带同一组分支类名，丢掉任一条都安全。
            const key = item.id < conn.target
                ? item.id + ' ' + conn.target
                : conn.target + ' ' + item.id;
            if (drawn[key]) {
                continue;
            }
            drawn[key] = true;

            conn.style = 'none';
            conn.classNames = (conn.classNames ?? '') + ' ' + linkClass;
            kept.push(conn);
        }
        item.connections = kept;
    }
}
