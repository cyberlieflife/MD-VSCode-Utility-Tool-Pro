import * as assert from 'assert';
import { loadEntrypoint } from './setup';
import { GridBoxConnectionTiles, GridBoxItem, renderLineConnections } from '../../../src/util/hoi4gui/gridboxcommon';
import { focusLinkClass } from '../../../src/util/hoi4gui/focuslink';
import { StyleTable } from '../../../src/util/styletable';
import { traceDimClass, traceLineClass } from '../../../src/previewdef/focustree/tracestyles';

// focustree.ts 在模块级读取 window.focusTrees 并把处理器挂到 window 的 load/message 上；这里只
// 测导出的连线过滤函数，所以让 setup 的 loadEntrypoint 把监听先扣住。模块缓存先清掉：依赖
// "重新加载模块才收到 ready" 的交互测试需要自己的一份实例。
(global as any).window.focusTrees = [];
delete require.cache[require.resolve('../../../webviewsrc/focustree')];
delete require.cache[require.resolve('../../../webviewsrc/util/vscode')];
delete require.cache[require.resolve('../../../webviewsrc/util/common')];

const focustree = loadEntrypoint(
    () => require('../../../webviewsrc/focustree') as typeof import('../../../webviewsrc/focustree'),
).module;

const { applyPrerequisiteTrace } = focustree;

function item(id: string, gridX: number, gridY: number, connections: GridBoxItem['connections']): GridBoxItem {
    return { id, gridX, gridY, connections };
}

/**
 * 用真实的连线渲染器产出标记，而不是手写标记：data-conn-* 属性的形态一变，测试就会失败。
 *
 * 布局：`child` 在 `parentA`/`parentB` 下一行并把两者都列为前置，于是每条前置连线都是两段折线；
 * `child` 与同行的 `sibling` 互斥；它下面的 `grandchild` 以 `child` 为前置。
 */
function renderTree(tiles?: GridBoxConnectionTiles): HTMLElement {
    const items: Record<string, GridBoxItem> = {
        parentA: item('parentA', 0, 0, []),
        parentB: item('parentB', 4, 0, []),
        sibling: item('sibling', 3, 1, []),
        child: item('child', 1, 1, [
            { target: 'parentA', targetType: 'parent', style: '1px solid #88aaff' },
            { target: 'parentB', targetType: 'parent', style: '1px solid #88aaff' },
            { target: 'sibling', targetType: 'related', style: '1px solid red' },
        ]),
        grandchild: item('grandchild', 1, 2, [
            { target: 'child', targetType: 'parent', style: '1px solid #88aaff' },
        ]),
    };

    const root = document.createElement('div');
    root.innerHTML = renderLineConnections(
        items,
        'up',
        { width: 96, height: 130 },
        { width: 0, height: 0 },
        new StyleTable(),
        0.5,
        undefined,
        tiles,
    );
    document.body.appendChild(root);
    return root;
}

function classesOf(root: HTMLElement, from: string, to: string): string[][] {
    const found = root.querySelectorAll(`[data-conn-from="${from}"][data-conn-to="${to}"]`);
    const result: string[][] = [];
    for (let i = 0; i < found.length; i++) {
        const element = found[i] as HTMLElement;
        result.push([traceLineClass, traceDimClass].filter(c => element.classList.contains(c)));
    }
    return result;
}

describe('webview/focustree applyPrerequisiteTrace', () => {
    afterEach(() => {
        document.body.innerHTML = '';
    });

    it('lights every div of an elbow edge the traced focus owns', () => {
        const root = renderTree();
        applyPrerequisiteTrace(root, 'child');

        for (const parent of ['parentA', 'parentB']) {
            const edge = classesOf(root, 'child', parent);
            // 斜向前置连线画成两段；两段都要点亮，否则那条线看起来是断的。
            assert.strictEqual(edge.length, 2, `expected an elbow towards ${parent}`);
            for (const classes of edge) {
                assert.deepStrictEqual(classes, [traceLineClass]);
            }
        }
    });

    it('dims the traced focus mutually exclusive link', () => {
        const root = renderTree();
        applyPrerequisiteTrace(root, 'child');

        const edge = classesOf(root, 'child', 'sibling');
        assert.ok(edge.length > 0);
        for (const classes of edge) {
            assert.deepStrictEqual(classes, [traceDimClass]);
        }
    });

    it('dims edges that only point at the traced focus', () => {
        const root = renderTree();
        applyPrerequisiteTrace(root, 'child');

        // grandchild -> child 是 grandchild 的前置而不是 child 的，所以它和其它线一起变暗。
        // 追踪刻意只保留某个焦点自己的前置，而不是它的整个邻域。
        const edge = classesOf(root, 'grandchild', 'child');
        assert.ok(edge.length > 0);
        for (const classes of edge) {
            assert.deepStrictEqual(classes, [traceDimClass]);
        }
    });

    it('leaves nothing behind when the trace is cleared', () => {
        const root = renderTree();
        applyPrerequisiteTrace(root, 'child');
        applyPrerequisiteTrace(root, undefined);

        assert.strictEqual(root.querySelectorAll('.' + traceLineClass).length, 0);
        assert.strictEqual(root.querySelectorAll('.' + traceDimClass).length, 0);
    });

    it('switches cleanly from one traced focus to another', () => {
        const root = renderTree();
        applyPrerequisiteTrace(root, 'child');
        applyPrerequisiteTrace(root, 'grandchild');

        for (const classes of classesOf(root, 'grandchild', 'child')) {
            assert.deepStrictEqual(classes, [traceLineClass]);
        }
        for (const classes of classesOf(root, 'child', 'parentA')) {
            assert.deepStrictEqual(classes, [traceDimClass]);
        }
    });

    it('lights every tile of a prerequisite line drawn from the link sprites', () => {
        const root = renderTree({ size: 16, className: focusLinkClass });
        applyPrerequisiteTrace(root, 'child');

        // 一条折线是三段线加两个拐角，每一块都要点亮。
        const edge = classesOf(root, 'child', 'parentA');
        assert.strictEqual(edge.length, 5);
        for (const classes of edge) {
            assert.deepStrictEqual(classes, [traceLineClass]);
        }
        for (const classes of classesOf(root, 'grandchild', 'child')) {
            assert.deepStrictEqual(classes, [traceDimClass]);
        }
    });

    // 壳层样式表是渲染后唯一还能挂类的样式表，选择器必须与导出的类名一致（否则类挂上去没样式）。
    it('emits both trace class names into the shell stylesheet', async () => {
        const { registerTraceStyles } = await import('../../../src/previewdef/focustree/tracestyles');
        const styleTable = new StyleTable();
        registerTraceStyles(styleTable);
        const css = styleTable.toRawCss();
        assert.ok(css.includes('.' + traceLineClass), traceLineClass);
        assert.ok(css.includes('.' + traceDimClass), traceDimClass);
    });
});
