import * as assert from 'assert';
import { GridBoxConnection, GridBoxItem } from '../util/hoi4gui/gridboxcommon';
import { applyExclusiveLinkStyle, exclusiveLinkClass, exclusiveLinkVerticalClass } from '../util/hoi4gui/exclusivelink';

function item(id: string, gridX: number, gridY: number, connections: GridBoxConnection[] = []): GridBoxItem {
    return { id, gridX, gridY, connections };
}

// 焦点树给每条连接挂分支可见性类名；MIO 树不挂。
function exclusiveTo(target: string, classNames?: string): GridBoxConnection {
    return { target, targetType: 'related', style: '1px solid red', classNames };
}

describe('applyExclusiveLinkStyle', () => {
    it('gives a same row pair the textured link instead of the plain line', () => {
        const a = item('a', 0, 3, [exclusiveTo('b', 'inbranch_x')]);
        applyExclusiveLinkStyle([a, item('b', 2, 3)]);

        const conn = a.connections[0]!;
        assert.strictEqual(conn.style, 'none');
        assert.ok(conn.classNames?.includes(exclusiveLinkClass));
        // 分支可见性类名必须保留，否则连线不再随分支隐藏。
        assert.ok(conn.classNames?.includes('inbranch_x'));
    });

    it('leaves a pair on different rows on the plain line', () => {
        const a = item('a', 0, 3, [exclusiveTo('b', 'inbranch_x')]);
        applyExclusiveLinkStyle([a, item('b', 2, 4)]);

        const conn = a.connections[0]!;
        assert.strictEqual(conn.style, '1px solid red');
        assert.ok(!conn.classNames?.includes(exclusiveLinkClass));
    });

    it('leaves a link to a node that is not rendered alone', () => {
        const a = item('a', 0, 3, [exclusiveTo('hidden', 'inbranch_x')]);
        applyExclusiveLinkStyle([a]);

        assert.strictEqual(a.connections[0]!.style, '1px solid red');
    });

    it('draws a mutual pair once instead of twice on top of itself', () => {
        const a = item('a', 0, 3, [exclusiveTo('b', 'inbranch_x')]);
        const b = item('b', 2, 3, [exclusiveTo('a', 'inbranch_x')]);
        applyExclusiveLinkStyle([a, b]);

        assert.strictEqual(a.connections.length + b.connections.length, 1);
        const conn = (a.connections[0] ?? b.connections[0])!;
        assert.ok(conn.classNames?.includes(exclusiveLinkClass));
    });

    it('does not touch prerequisite connections', () => {
        const a = item('a', 0, 3, [{ target: 'b', targetType: 'parent', style: '1px solid #88aaff' }]);
        applyExclusiveLinkStyle([a, item('b', 2, 3)]);

        const conn = a.connections[0]!;
        assert.strictEqual(conn.style, '1px solid #88aaff');
        assert.strictEqual(conn.classNames, undefined);
    });

    // MIO 树建的连接没有任何类名，类名仍要单独落下，而不是拼到 undefined 上。
    it('tags a connection that carries no classes of its own', () => {
        const a = item('a', 0, 3, [exclusiveTo('b')]);
        applyExclusiveLinkStyle([a, item('b', 1, 3)]);

        const conn = a.connections[0]!;
        assert.strictEqual(conn.style, 'none');
        assert.strictEqual(conn.classNames?.trim(), exclusiveLinkClass);
    });

    // LEFT/RIGHT 网格把一行转成一列，配对的连线走竖直形态。
    it('gives a sideways tree the vertical link', () => {
        for (const format of ['left', 'right'] as const) {
            const a = item('a', 0, 3, [exclusiveTo('b', 'inbranch_x')]);
            applyExclusiveLinkStyle([a, item('b', 2, 3)], format);

            const conn = a.connections[0]!;
            assert.strictEqual(conn.style, 'none');
            assert.ok(conn.classNames?.includes(exclusiveLinkVerticalClass));
            assert.ok(!conn.classNames?.split(' ').includes(exclusiveLinkClass));
        }

        const down = item('a', 0, 3, [exclusiveTo('b')]);
        applyExclusiveLinkStyle([down, item('b', 2, 3)], 'down');
        assert.strictEqual(down.connections[0]!.classNames?.trim(), exclusiveLinkClass);
    });
});
