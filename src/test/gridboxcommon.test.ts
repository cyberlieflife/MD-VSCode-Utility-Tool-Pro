import * as assert from 'assert';
import { GridBoxItem, gridBoxContentOffset, renderLineConnections } from '../util/hoi4gui/gridboxcommon';
import { StyleTable } from '../util/styletable';

// 焦点树风格的前置连线贴图参数：类名前缀 t-，便于从输出里挑出贴图格。
const tiles = {
    size: 16,
    className: (shape: string, dashed: boolean) => `t-${shape}${dashed ? '-d' : ''}`,
};
const slot = { width: 96, height: 130 };
const size = { width: 96, height: 1000 };

// 每个贴图格的类名与内联几何，按输出顺序。
function tileBoxes(html: string): string[] {
    return [...html.matchAll(/class="([^"]*)"\s*style="([^"]*)"/g)].flatMap(m => {
        const tile = m[1]!.split(/\s+/).find(c => c.startsWith('t-'));
        return tile ? [`${tile} ${m[2]}`] : [];
    });
}

function item(id: string, gridX: number, gridY: number, connections: GridBoxItem['connections'] = []): GridBoxItem {
    return { id, gridX, gridY, connections };
}

describe('util/hoi4gui/gridboxcommon', () => {
    describe('renderLineConnections', () => {
        it('moves a parent connection end by the connection offsets', () => {
            const items: Record<string, GridBoxItem> = {
                child: item('child', 0, 1, [{ target: 'parent', targetType: 'parent', style: '1px solid black' }]),
                parent: item('parent', 0, 0),
            };
            const st = new StyleTable();
            renderLineConnections(items, 'up', { width: 50, height: 50 }, { width: 50, height: 200 }, st, 1);
            assert.ok(st.toRawCss().includes('top: 25px'));

            const moved = new StyleTable();
            renderLineConnections(items, 'up', { width: 50, height: 50 }, { width: 50, height: 200 }, moved, 1, { parent: { x: 0, y: 10 }, child: { x: 0, y: -5 } });
            const css = moved.toRawCss();
            assert.ok(css.includes('top: 35px'));
            assert.ok(css.includes('height: 35px'));
        });

        describe('with connection tiles', () => {
            it('draws a straight parent link as one vertical run', () => {
                const items: Record<string, GridBoxItem> = {
                    child: item('child', 0, 1, [{ target: 'parent', targetType: 'parent', style: '1px solid black' }]),
                    parent: item('parent', 0, 0),
                };
                const html = renderLineConnections(items, 'up', slot, size, new StyleTable(), 0.5, undefined, tiles);
                assert.deepStrictEqual(tileBoxes(html), ['t-up_down left: 40px; top: 65px; width: 16px; height: 130px;']);
            });

            it('draws an elbow as runs meeting corner tiles, on the path the border line takes', () => {
                const items: Record<string, GridBoxItem> = {
                    child: item('child', 2, 1, [{ target: 'parent', targetType: 'parent', style: '1px dashed black', dashed: true }]),
                    parent: item('parent', 0, 0),
                };
                const html = renderLineConnections(items, 'up', slot, size, new StyleTable(), 0.5, undefined, tiles);
                assert.deepStrictEqual(tileBoxes(html), [
                    't-up_down-d left: 40px; top: 65px; width: 16px; height: 57px;',
                    't-left_right-d left: 56px; top: 122px; width: 176px; height: 16px;',
                    't-up_down-d left: 232px; top: 138px; width: 16px; height: 57px;',
                    't-up_right-d left: 40px; top: 122px; width: 16px; height: 16px;',
                    't-down_left-d left: 232px; top: 122px; width: 16px; height: 16px;',
                ]);
                assert.strictEqual((html.match(/data-conn-from="child" data-conn-to="parent" data-conn-type="parent"/g) ?? []).length, 5);
            });

            it('moves every tile by the tile offset', () => {
                const items: Record<string, GridBoxItem> = {
                    child: item('child', 0, 1, [{ target: 'parent', targetType: 'parent' }]),
                    parent: item('parent', 0, 0),
                };
                const html = renderLineConnections(items, 'up', slot, size, new StyleTable(), 0.5, undefined, { ...tiles, offset: { x: 3, y: -2 } });
                assert.deepStrictEqual(tileBoxes(html), ['t-up_down left: 43px; top: 63px; width: 16px; height: 130px;']);
            });

            it('leaves related connections on the border line', () => {
                const items: Record<string, GridBoxItem> = {
                    a: item('a', 0, 0, [{ target: 'b', targetType: 'related', style: '1px solid red' }]),
                    b: item('b', 2, 0),
                };
                const st = new StyleTable();
                const html = renderLineConnections(items, 'up', slot, size, st, 0.5, undefined, tiles);
                assert.deepStrictEqual(tileBoxes(html), []);
                assert.ok(st.toRawCss().includes('border-top: 1px solid red'));
            });
        });

        it('returns empty for no items', () => {
            const st = new StyleTable();
            const html = renderLineConnections({}, 'up', { width: 50, height: 50 }, { width: 200, height: 200 }, st, 1);
            assert.strictEqual(html, '');
        });
    });

    describe('gridBoxContentOffset', () => {
        // 焦点树的网格：一个 96x130 的槽位宽、不占高。
        const slotSize = { width: 96, height: 130 };
        const gridSize = { width: 96, height: 0 };
        const items = [
            { gridX: 0, gridY: 0 },
            { gridX: 1, gridY: 2 },
            { gridX: -1, gridY: 1 },
        ];

        it('reaches past the grid corner by the extent each format lays out towards', () => {
            assert.deepStrictEqual(gridBoxContentOffset(items, 'up', slotSize, gridSize), { x: -96, y: 0 });
            assert.deepStrictEqual(gridBoxContentOffset(items, 'down', slotSize, gridSize), { x: -96, y: -390 });
            assert.deepStrictEqual(gridBoxContentOffset(items, 'left', slotSize, gridSize), { x: 0, y: -195 });
            assert.deepStrictEqual(gridBoxContentOffset(items, 'right', slotSize, gridSize), { x: -192, y: -195 });
        });

        it('is zero when every item is inside the grid', () => {
            assert.deepStrictEqual(gridBoxContentOffset([{ gridX: 2, gridY: 3 }], 'up', slotSize, gridSize), { x: 0, y: 0 });
            assert.deepStrictEqual(gridBoxContentOffset([], 'down', slotSize, gridSize), { x: 0, y: 0 });
        });
    });
});
