import './setup';
import * as assert from 'assert';
import { patchFocusTreeContent, sameGridboxItem } from '../../../webviewsrc/focustreepatch';
import { StyleTable } from '../../../src/util/styletable';

interface TestItem {
    id: string;
    x: number;
    y: number;
    inner: string;
}

interface TestConnection {
    from: string;
    to: string;
    type: string;
}

function makeContent(items: TestItem[], connections: TestConnection[] = []): string {
    const itemHtml = items.map(it =>
        `<div data-gridbox-item="${it.id}" data-gridbox-x="${it.x}" data-gridbox-y="${it.y}" id="focus_${it.id}" class="focus">${it.inner}</div>`).join('');
    const connHtml = connections.map(c =>
        `<div data-conn-from="${c.from}" data-conn-to="${c.to}" data-conn-type="${c.type}"></div>`).join('');
    return `<div start="0" end="100" class="gridbox">${connHtml}${itemHtml}</div>`;
}

function makeStyleTable(css = ''): StyleTable {
    const table = new StyleTable();
    // Inject a raw rule so toRawCss has content to verify.
    table.raw('.test-rule', css || 'color: red;');
    return table;
}

function itemsOf(placeholder: HTMLDivElement): Map<string, HTMLElement> {
    const map = new Map<string, HTMLElement>();
    for (const el of placeholder.querySelectorAll<HTMLElement>('[data-gridbox-item]')) {
        map.set(el.getAttribute('data-gridbox-item')!, el);
    }
    return map;
}

function itemIds(placeholder: HTMLDivElement): string[] {
    return [...placeholder.querySelectorAll<HTMLElement>('[data-gridbox-item]')].map(el => el.getAttribute('data-gridbox-item')!);
}

describe('webview/focustree/patchFocusTreeContent', function () {
    it('first render assigns the full content plus the style element', function () {
        const placeholder = document.createElement('div');
        patchFocusTreeContent(placeholder, makeContent([{ id: 'a', x: 0, y: 0, inner: 'A' }]), makeStyleTable(), 'n1');
        assert.strictEqual(placeholder.querySelectorAll('[data-gridbox-item]').length, 1);
        const styleEl = placeholder.querySelector('style');
        assert.ok(styleEl, 'style element must exist');
        assert.strictEqual(styleEl!.getAttribute('nonce'), 'n1');
        assert.ok(styleEl!.textContent.includes('.test-rule'));
    });

    it('keeps identical cells as the same DOM nodes on a re-patch', function () {
        const placeholder = document.createElement('div');
        const content = makeContent([
            { id: 'a', x: 0, y: 0, inner: 'A' },
            { id: 'b', x: 1, y: 0, inner: 'B' },
        ]);
        patchFocusTreeContent(placeholder, content, makeStyleTable(), 'n1');
        const before = itemsOf(placeholder);
        patchFocusTreeContent(placeholder, content, makeStyleTable(), 'n1');
        const after = itemsOf(placeholder);
        assert.strictEqual(after.get('a'), before.get('a'), 'unchanged cell a must keep its node');
        assert.strictEqual(after.get('b'), before.get('b'), 'unchanged cell b must keep its node');
    });

    it('replaces only the changed cell and keeps the others', function () {
        const placeholder = document.createElement('div');
        patchFocusTreeContent(placeholder, makeContent([
            { id: 'a', x: 0, y: 0, inner: 'A' },
            { id: 'b', x: 1, y: 0, inner: 'B' },
        ]), makeStyleTable(), 'n1');
        const before = itemsOf(placeholder);
        // b moves: only b's node is replaced.
        patchFocusTreeContent(placeholder, makeContent([
            { id: 'a', x: 0, y: 0, inner: 'A' },
            { id: 'b', x: 2, y: 0, inner: 'B' },
        ]), makeStyleTable(), 'n1');
        const after = itemsOf(placeholder);
        assert.strictEqual(after.get('a'), before.get('a'), 'unchanged cell a must keep its node');
        assert.notStrictEqual(after.get('b'), before.get('b'), 'moved cell b must be replaced');
        assert.strictEqual(after.get('b')!.getAttribute('data-gridbox-x'), '2');
    });

    it('inserts new cells in order and removes dropped ones', function () {
        const placeholder = document.createElement('div');
        patchFocusTreeContent(placeholder, makeContent([
            { id: 'a', x: 0, y: 0, inner: 'A' },
            { id: 'b', x: 1, y: 0, inner: 'B' },
        ]), makeStyleTable(), 'n1');
        const beforeA = itemsOf(placeholder).get('a');
        // Add 'c' between a and b, drop 'b'.
        patchFocusTreeContent(placeholder, makeContent([
            { id: 'a', x: 0, y: 0, inner: 'A' },
            { id: 'c', x: 1, y: 0, inner: 'C' },
        ]), makeStyleTable(), 'n1');
        assert.deepStrictEqual(itemIds(placeholder), ['a', 'c']);
        const after = itemsOf(placeholder);
        assert.strictEqual(after.get('a'), beforeA, 'kept cell a keeps its node');
        assert.ok(after.get('c'), 'new cell c is present');
        assert.strictEqual(placeholder.querySelectorAll('[data-gridbox-item]').length, 2);
    });

    it('rebuilds connections and keeps the container identity', function () {
        const placeholder = document.createElement('div');
        patchFocusTreeContent(placeholder, makeContent(
            [
                { id: 'a', x: 0, y: 0, inner: 'A' },
                { id: 'b', x: 1, y: 0, inner: 'B' },
            ],
            [{ from: 'a', to: 'b', type: 'parent' }],
        ), makeStyleTable(), 'n1');
        const rootBefore = placeholder.querySelector('[data-gridbox-item]')!.parentElement;
        patchFocusTreeContent(placeholder, makeContent(
            [
                { id: 'a', x: 0, y: 0, inner: 'A' },
                { id: 'b', x: 1, y: 0, inner: 'B' },
            ],
            [{ from: 'a', to: 'b', type: 'related' }],
        ), makeStyleTable(), 'n1');
        const connections = placeholder.querySelectorAll('[data-conn-from]');
        assert.strictEqual(connections.length, 1);
        assert.strictEqual(connections[0].getAttribute('data-conn-type'), 'related');
        assert.strictEqual(placeholder.querySelector('[data-gridbox-item]')!.parentElement, rootBefore, 'container is reused');
    });

    it('updates the style element text in place', function () {
        const placeholder = document.createElement('div');
        patchFocusTreeContent(placeholder, makeContent([{ id: 'a', x: 0, y: 0, inner: 'A' }]), makeStyleTable('color: red;'), 'n1');
        const styleEl = placeholder.querySelector('style')!;
        assert.ok(styleEl.textContent.includes('color: red;'));
        patchFocusTreeContent(placeholder, makeContent([{ id: 'a', x: 0, y: 0, inner: 'A' }]), makeStyleTable('color: blue;'), 'n1');
        assert.strictEqual(styleEl, placeholder.querySelector('style'), 'style element is reused');
        assert.ok(styleEl.textContent.includes('color: blue;'));
        assert.ok(!styleEl.textContent.includes('color: red;'));
    });

    it('clears the content area when the grid becomes empty', function () {
        const placeholder = document.createElement('div');
        patchFocusTreeContent(placeholder, makeContent([{ id: 'a', x: 0, y: 0, inner: 'A' }]), makeStyleTable(), 'n1');
        // Simulate an empty render: a root with no items/connections.
        patchFocusTreeContent(placeholder, '<div class="gridbox"></div>', makeStyleTable(), 'n1');
        assert.strictEqual(placeholder.querySelectorAll('[data-gridbox-item]').length, 0);
    });

    describe('sameGridboxItem', function () {
        it('returns true for identical cells', function () {
            const a = document.createElement('div');
            a.setAttribute('data-gridbox-x', '1');
            a.setAttribute('data-gridbox-y', '2');
            a.innerHTML = '<span>x</span>';
            const b = document.createElement('div');
            b.setAttribute('data-gridbox-x', '1');
            b.setAttribute('data-gridbox-y', '2');
            b.innerHTML = '<span>x</span>';
            assert.strictEqual(sameGridboxItem(a, b), true);
        });

        it('returns false when position or content differs', function () {
            const a = document.createElement('div');
            a.setAttribute('data-gridbox-x', '1');
            a.setAttribute('data-gridbox-y', '2');
            a.innerHTML = '<span>x</span>';
            const moved = document.createElement('div');
            moved.setAttribute('data-gridbox-x', '3');
            moved.setAttribute('data-gridbox-y', '2');
            moved.innerHTML = '<span>x</span>';
            assert.strictEqual(sameGridboxItem(a, moved), false);
            const changed = document.createElement('div');
            changed.setAttribute('data-gridbox-x', '1');
            changed.setAttribute('data-gridbox-y', '2');
            changed.innerHTML = '<span>y</span>';
            assert.strictEqual(sameGridboxItem(a, changed), false);
        });
    });
});
