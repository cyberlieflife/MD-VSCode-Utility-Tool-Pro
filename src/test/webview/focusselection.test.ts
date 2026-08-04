import './setup';
import * as assert from 'assert';
import { applySelectionClick, emptySelection, SelectionState } from '../../../webviewsrc/focusselection';

describe('webview/focusselection', () => {
    const positions = {
        a: { x: 0, y: 0 },
        b: { x: 2, y: 0 },
        c: { x: 1, y: 2 },
        d: { x: 3, y: 3 },
    };

    it('plain click replaces the selection and sets the anchor', () => {
        const state = applySelectionClick(emptySelection(), 'a', { ctrl: false, shift: false }, positions);
        assert.deepStrictEqual([...state.selected], ['a']);
        assert.strictEqual(state.anchor, 'a');

        const next = applySelectionClick(state, 'b', { ctrl: false, shift: false }, positions);
        assert.deepStrictEqual([...next.selected], ['b']);
        assert.strictEqual(next.anchor, 'b');
    });

    it('ctrl click toggles a focus and keeps the anchor', () => {
        let state = applySelectionClick(emptySelection(), 'a', { ctrl: false, shift: false }, positions);
        state = applySelectionClick(state, 'b', { ctrl: true, shift: false }, positions);
        assert.deepStrictEqual([...state.selected].sort(), ['a', 'b']);
        assert.strictEqual(state.anchor, 'a');

        state = applySelectionClick(state, 'b', { ctrl: true, shift: false }, positions);
        assert.deepStrictEqual([...state.selected], ['a']);
        assert.strictEqual(state.anchor, 'a');
    });

    it('shift click selects the rectangle spanned by the anchor and the clicked focus', () => {
        let state = applySelectionClick(emptySelection(), 'a', { ctrl: false, shift: false }, positions);
        state = applySelectionClick(state, 'd', { ctrl: false, shift: true }, positions);
        // Rectangle a(0,0)-d(3,3) contains a, b? b is (2,0) inside; c (1,2) inside; d inside.
        assert.deepStrictEqual([...state.selected].sort(), ['a', 'b', 'c', 'd']);
        assert.strictEqual(state.anchor, 'a');
    });

    it('shift click without an anchor falls back to a plain click', () => {
        const state = applySelectionClick(emptySelection(), 'b', { ctrl: false, shift: true }, positions);
        assert.deepStrictEqual([...state.selected], ['b']);
        assert.strictEqual(state.anchor, 'b');
    });

    it('shift click keeps selecting with the original anchor', () => {
        let state = applySelectionClick(emptySelection(), 'a', { ctrl: false, shift: false }, positions);
        state = applySelectionClick(state, 'd', { ctrl: false, shift: true }, positions);
        state = applySelectionClick(state, 'b', { ctrl: false, shift: true }, positions);
        // Anchor stays a: rectangle a(0,0)-b(2,0) contains a and b.
        assert.deepStrictEqual([...state.selected].sort(), ['a', 'b']);
        assert.strictEqual(state.anchor, 'a');
    });

    it('works with an empty selection state', () => {
        const empty: SelectionState = emptySelection();
        assert.strictEqual(empty.selected.size, 0);
        assert.strictEqual(empty.anchor, undefined);
    });
});
