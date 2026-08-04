import './setup';
import * as assert from 'assert';
import { emptySelection, selectFocusIds, idsInRect, Rect, RectItem } from '../../../webviewsrc/focusselection';

describe('webview/focusselection', () => {
    it('starts empty', () => {
        const state = emptySelection();
        assert.strictEqual(state.selected.size, 0);
    });

    it('selectFocusIds replaces the selection', () => {
        const state = selectFocusIds(emptySelection(), ['a', 'b']);
        assert.deepStrictEqual([...state.selected].sort(), ['a', 'b']);

        const next = selectFocusIds(state, ['c']);
        assert.deepStrictEqual([...next.selected], ['c']);
    });

    describe('idsInRect', () => {
        const items: RectItem[] = [
            { id: 'a', left: 0, top: 0, right: 100, bottom: 100 },
            { id: 'b', left: 200, top: 0, right: 300, bottom: 100 },
            { id: 'c', left: 50, top: 50, right: 150, bottom: 150 },
        ];

        it('returns ids whose bounds intersect the rect', () => {
            const rect: Rect = { left: 40, top: 40, right: 220, bottom: 120 };
            assert.deepStrictEqual(idsInRect(rect, items).sort(), ['a', 'b', 'c']);
        });

        it('returns an empty list for a rect that touches nothing', () => {
            const rect: Rect = { left: 400, top: 400, right: 500, bottom: 500 };
            assert.deepStrictEqual(idsInRect(rect, items), []);
        });

        it('treats a touching boundary as intersecting', () => {
            // a's right edge and b's left edge both touch the rect boundary.
            const rect: Rect = { left: 100, top: 0, right: 200, bottom: 100 };
            assert.deepStrictEqual(idsInRect(rect, [items[0], items[1]]), ['a', 'b']);
        });
    });
});
