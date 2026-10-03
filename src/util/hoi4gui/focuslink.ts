import { StyleTable } from '../styletable';
import type { Image } from '../image/imagecache';
import type { GridBoxTileShape } from './gridboxcommon';

/**
 * 焦点树的前置连线，按游戏画法绘制：来自 nationalfocusview.gui 中 national_focus_link
 * 声明的 GFX_focus_link_* 精灵的 16x16 贴图，每种贴图形状一张。宿主/网页端的拆分与
 * exclusivelink.ts 相同：网格在网页端铺贴图并挂 focusLinkClass 的类名，类名背后的 CSS 在
 * 宿主注册（贴图要在宿主解码）。网页端两遍渲染都会画同一批贴图，类名承载全部差异：
 * 结构遍是细线，贴图解析完成后才有纹理。
 *
 * 本模块被 webview bundle 引入，保持无宿主依赖。
 */
export const focusLinkShapes: GridBoxTileShape[] = ['up_down', 'left_right', 'up_left', 'up_right', 'down_left', 'down_right'];

export function focusLinkClass(shape: GridBoxTileShape, dashed: boolean): string {
    return 'st-focus-link-' + shape.replace('_', '-') + (dashed ? '-dashed' : '');
}

// StyleTable.style 会补上 st- 前缀；从类名去掉前缀即同一选择器的 style 名，两处不会漂移。
function focusLinkStyleName(shape: GridBoxTileShape, dashed: boolean): string {
    return focusLinkClass(shape, dashed).slice('st-'.length);
}

/** 每种贴图形状的精灵。 */
export interface FocusLinkSpriteSpec {
    gfx: Record<GridBoxTileShape, string>;
}

/** 预览按游戏的两条线色绘制：可用焦点为蓝，已完成焦点为绿。 */
export type FocusLinkState = 'available' | 'completed';

// 每条精灵条带含四帧：已完成（绿）的实线与虚线，然后是可用（蓝）的同样两条。游戏按每条线
// 自行取帧，gui 的 frame 不参与决定。
export function focusLinkFrames(state: FocusLinkState): { solid: number; dashed: number } {
    return state === 'completed' ? { solid: 0, dashed: 1 } : { solid: 2, dashed: 3 };
}

export const defaultFocusLinkSprites: FocusLinkSpriteSpec = {
    gfx: {
        up_down: 'GFX_focus_link_up_down',
        left_right: 'GFX_focus_link_left_right',
        up_left: 'GFX_focus_link_up_left',
        up_right: 'GFX_focus_link_up_right',
        down_left: 'GFX_focus_link_down_left',
        down_right: 'GFX_focus_link_down_right',
    },
};

export interface FocusLinkImages {
    solid: Record<GridBoxTileShape, Image>;
    dashed: Record<GridBoxTileShape, Image>;
}

const lineColors: Record<FocusLinkState, string> = {
    available: '#88aaff',
    completed: '#68b86f',
};

function repeatOf(shape: GridBoxTileShape): string {
    return shape === 'up_down' ? 'repeat-y' : shape === 'left_right' ? 'repeat-x' : 'no-repeat';
}

// 纯色线在贴图格里的走向：::before 画竖向的半段，::after 画横向的半段，各自从形状名的方向
// 伸到格子中心。
function verticalPart(shape: GridBoxTileShape): { top: string; bottom: string } | undefined {
    if (shape === 'left_right') {
        return undefined;
    }
    if (shape === 'up_down') {
        return { top: '0', bottom: '0' };
    }
    return shape.startsWith('up') ? { top: '0', bottom: '50%' } : { top: '50%', bottom: '0' };
}

function horizontalPart(shape: GridBoxTileShape): { left: string; right: string } | undefined {
    if (shape === 'up_down') {
        return undefined;
    }
    if (shape === 'left_right') {
        return { left: '0', right: '0' };
    }
    return shape.endsWith('left') ? { left: '0', right: '50%' } : { left: '50%', right: '0' };
}

/**
 * 注册每个 focusLinkClass 背后的 CSS。`images` 传 undefined 得到预览一直以来的 1px 细线，
 * 结构遍与安装路径不可解析时都需要它；细线取 `state` 的颜色，这样贴图替换它时不换色。
 *
 * 与互斥连线一样，两个分支刻意在贴图格里层和两个伪元素上声明同一组属性：两遍渲染落在同一
 * 页面的两个 <style> 里，只在一侧声明的属性会在另一份下面残留。
 */
export function registerFocusLinkStyles(styleTable: StyleTable, images: FocusLinkImages | undefined, state: FocusLinkState = 'available'): void {
    for (const dashed of [false, true]) {
        for (const shape of focusLinkShapes) {
            const styleName = focusLinkStyleName(shape, dashed);
            const image = images ? (dashed ? images.dashed : images.solid)[shape] : undefined;
            const border = `1px ${dashed ? 'dashed' : 'solid'} ${lineColors[state]}`;

            styleTable.style(styleName, () => image ? `
                background-image: url(${image.uri});
                background-repeat: ${repeatOf(shape)};
                background-position: center center;
                background-size: ${image.width}px ${image.height}px;
            ` : `
                background-image: none;
                background-repeat: repeat;
                background-position: 0 0;
                background-size: auto;
            `);

            const vertical = image ? undefined : verticalPart(shape);
            styleTable.style(styleName, () => vertical ? `
                content: '';
                position: absolute;
                left: 50%;
                top: ${vertical.top};
                bottom: ${vertical.bottom};
                border-left: ${border};
            ` : `
                content: none;
                position: static;
                left: auto;
                top: auto;
                bottom: auto;
                border-left: none;
            `, '::before');

            const horizontal = image ? undefined : horizontalPart(shape);
            styleTable.style(styleName, () => horizontal ? `
                content: '';
                position: absolute;
                top: 50%;
                left: ${horizontal.left};
                right: ${horizontal.right};
                border-top: ${border};
            ` : `
                content: none;
                position: static;
                top: auto;
                left: auto;
                right: auto;
                border-top: none;
            `, '::after');
        }
    }
}
