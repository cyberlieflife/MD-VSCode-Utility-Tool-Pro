import './setup';
import * as assert from 'assert';
import { computeGridDelta, buildFocusDragMoves } from '../../../webviewsrc/focusdrag';

describe('webview/focusdrag', () => {
    describe('computeGridDelta', () => {
        it('converts client displacement to whole grid steps at scale 1', () => {
            assert.deepStrictEqual(computeGridDelta(96, 130, 1, 96, 130), { dx: 1, dy: 1 });
            assert.deepStrictEqual(computeGridDelta(-200, -260, 1, 96, 130), { dx: -2, dy: -2 });
        });

        it('divides by the zoom scale first', () => {
            // 96px on screen at 50% zoom is 192 content px = 2 grid steps; 130px is 260 = 2.
            assert.deepStrictEqual(computeGridDelta(96, 130, 0.5, 96, 130), { dx: 2, dy: 2 });
        });

        it('rounds sub-cell displacement to zero', () => {
            assert.deepStrictEqual(computeGridDelta(40, 60, 1, 96, 130), { dx: 0, dy: 0 });
        });

        it('guards against invalid scale and cell sizes', () => {
            assert.deepStrictEqual(computeGridDelta(100, 100, 0, 96, 130), { dx: 0, dy: 0 });
            assert.deepStrictEqual(computeGridDelta(100, 100, 1, 0, 130), { dx: 0, dy: 0 });
        });
    });

    describe('buildFocusDragMoves', () => {
        const positions = {
            a: { x: 0, y: 0 },
            b: { x: 2, y: 1 },
            c: { x: 5, y: 5 },
        };

        it('shifts every selected focus by the delta', () => {
            const moves = buildFocusDragMoves(['a', 'b'], positions, { dx: 3, dy: -1 });
            assert.deepStrictEqual(moves, [
                { id: 'a', x: 3, y: -1 },
                { id: 'b', x: 5, y: 0 },
            ]);
        });

        it('omits focuses whose coordinates would not change', () => {
            assert.deepStrictEqual(buildFocusDragMoves(['a', 'c'], positions, { dx: 0, dy: 0 }), []);
            assert.deepStrictEqual(buildFocusDragMoves(['c'], positions, { dx: 0, dy: 0 }), []);
        });

        it('skips ids with no position data', () => {
            const moves = buildFocusDragMoves(['a', 'ghost'], positions, { dx: 1, dy: 1 });
            assert.deepStrictEqual(moves, [{ id: 'a', x: 1, y: 1 }]);
        });
    });
});
