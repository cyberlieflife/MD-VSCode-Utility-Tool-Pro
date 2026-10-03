import { StyleTable } from '../../util/styletable';

/**
 * 焦点树内容构建器（把 CSS 写进外壳样式表）与焦点树网页端（把类名挂到渲染出的焦点上）共享的
 * 类名。
 *
 * 规则刻意放在外壳样式表而不是网页端每次渲染构建的 StyleTable 里：`StyleTable.toStyleElement`
 * 在调用时对记录做快照，任何在 `#focustreeplaceholder` 被填充之后注册的内容都到不了页面。
 * 留在外壳里——只发出一次、在任何渲染之前——这种时序陷阱就不可能发生。
 *
 * `registerWarningStyles` 通过 `StyleTable.name` 推导名字，测试断言发出的规则与下面的常量一致，
 * 两侧不会漂移。
 */
export const warningBoxClass = 'st-focus-warning-box';
export const warningBadgeClass = 'st-focus-warning-badge';
export const warningFlashClass = 'st-focus-warning-flash';
export const warningEntryClass = 'st-focus-warning-entry';
export const warningListClass = 'st-focus-warning-list';

export function registerWarningStyles(styleTable: StyleTable): void {
    // 标记框作为焦点网格项的子元素绘制、覆盖整个格子。z-index 压过焦点自己的各图层
    // （标题栏 0、图标 1、覆盖层 2、复选框与标签 3），pointer-events:none 让点击继续落到下面的
    // .navigator 上，穿过标记的跳转定义仍然有效。MIO 预览给重叠特质的是同样的处理。
    styleTable.style('focus-warning-box', () => `
        position: absolute;
        left: 0;
        top: 0;
        width: 100%;
        height: 100%;
        box-sizing: border-box;
        border: 2px solid #e33;
        background: rgba(255, 0, 0, 0.18);
        pointer-events: none;
        z-index: 6;
    `);

    styleTable.style('focus-warning-badge', () => `
        position: absolute;
        top: 1px;
        right: 3px;
        font-size: 10px;
        font-weight: bold;
        color: #fff;
        text-shadow: 0 0 3px #000;
        pointer-events: none;
        white-space: nowrap;
    `);

    // 从警告面板跳到的焦点上做的短促脉冲，让眼睛抓住画布滚到了哪里。刻意用 box-shadow 而不是
    // outline 或背景：搜索会在每次渲染后给每个未匹配的焦点写上内联的 `outlineWidth: 0` 与
    // `background: transparent`，内联样式会赢过这条规则。
    styleTable.style('focus-warning-flash', () => `
        box-shadow: 0 0 0 3px #ffb454, 0 0 12px 4px rgba(255, 180, 84, 0.6);
    `);

    styleTable.style('focus-warning-list', () => `
        height: 100%;
        width: 100%;
        overflow: auto;
        font-family: 'Consolas', monospace;
        background: var(--vscode-editor-background);
        padding: 10px;
        box-sizing: border-box;
    `);

    styleTable.style('focus-warning-entry', () => `
        display: block;
        width: 100%;
        text-align: left;
        cursor: pointer;
        padding: 3px 6px;
        border-left: 3px solid #e33;
        margin-bottom: 3px;
        white-space: pre-wrap;
        color: var(--vscode-editor-foreground);
        background: transparent;
    `);

    styleTable.style('focus-warning-entry', () => `
        background: var(--vscode-list-hoverBackground);
    `, ':hover');

    styleTable.style('focus-warning-entry', () => `
        outline: 1px solid var(--vscode-focusBorder);
    `, ':focus');
}
