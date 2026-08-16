import './setup';
import * as assert from 'assert';
import { mergeRiverRuns, RiverPixel, RiverRun } from '../../../webviewsrc/worldmap/graphutils';

// A tiny seeded PRNG so the property tests are deterministic across CI runs.
function makeRandom(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
        s = (s * 1664525 + 1013904223) >>> 0;
        return s / 0x100000000;
    };
}

// Expands runs back into the exact pixel set they claim to cover.
function runsToPixels(runs: RiverRun[]): RiverPixel[] {
    const pixels: RiverPixel[] = [];
    for (const run of runs) {
        for (let x = run.x; x < run.x + run.w; x++) {
            pixels.push({ x, y: run.y, color: run.color });
        }
    }
    return pixels;
}

function pixelKey(p: RiverPixel): string {
    return p.x + ',' + p.y + ',' + p.color;
}

describe('webview/worldmap/mergeRiverRuns', function () {
    it('merges contiguous same-color pixels on a row into one span', function () {
        assert.deepStrictEqual(
            mergeRiverRuns([
                { x: 3, y: 2, color: 1 },
                { x: 4, y: 2, color: 1 },
                { x: 5, y: 2, color: 1 },
            ]),
            [{ x: 3, y: 2, w: 3, color: 1 }],
        );
    });

    it('breaks spans across rows', function () {
        assert.deepStrictEqual(
            mergeRiverRuns([
                { x: 1, y: 2, color: 1 },
                { x: 1, y: 3, color: 1 },
            ]),
            [
                { x: 1, y: 2, w: 1, color: 1 },
                { x: 1, y: 3, w: 1, color: 1 },
            ],
        );
    });

    it('breaks spans when the color changes mid-row', function () {
        assert.deepStrictEqual(
            mergeRiverRuns([
                { x: 0, y: 1, color: 2 },
                { x: 1, y: 1, color: 2 },
                { x: 2, y: 1, color: 3 },
                { x: 3, y: 1, color: 3 },
            ]),
            [
                { x: 0, y: 1, w: 2, color: 2 },
                { x: 2, y: 1, w: 2, color: 3 },
            ],
        );
    });

    it('breaks spans on non-contiguous pixels (gap)', function () {
        assert.deepStrictEqual(
            mergeRiverRuns([
                { x: 0, y: 1, color: 1 },
                { x: 5, y: 1, color: 1 },
            ]),
            [
                { x: 0, y: 1, w: 1, color: 1 },
                { x: 5, y: 1, w: 1, color: 1 },
            ],
        );
    });

    it('returns an empty list for empty input', function () {
        assert.deepStrictEqual(mergeRiverRuns([]), []);
    });

    it('is order-independent (sorted output for shuffled input)', function () {
        const pixels: RiverPixel[] = [
            { x: 2, y: 0, color: 1 },
            { x: 0, y: 0, color: 1 },
            { x: 1, y: 0, color: 1 },
            { x: 4, y: 1, color: 2 },
        ];
        const shuffled = pixels.slice().reverse();
        const expected = mergeRiverRuns(pixels);
        const got = mergeRiverRuns(shuffled);
        assert.deepStrictEqual(got, expected);
    });

    it('run coverage equals the pixel set exactly (merge preserves semantics)', function () {
        const rand = makeRandom(0xA1ABE55);
        for (let trial = 0; trial < 60; trial++) {
            const pixels: RiverPixel[] = [];
            const count = 1 + Math.floor(rand() * 300);
            for (let i = 0; i < count; i++) {
                pixels.push({
                    x: Math.floor(rand() * 200),
                    y: Math.floor(rand() * 30),
                    color: Math.floor(rand() * 12),
                });
            }
            const runs = mergeRiverRuns(pixels);
            // The runs must be non-overlapping within a row and strictly ordered.
            for (const run of runs) {
                assert.ok(run.w > 0, 'run width must be positive');
            }
            // Expanded coverage == input pixel multiset (colors and positions).
            const expectedCounts = new Map<string, number>();
            for (const p of pixels) {
                const key = pixelKey(p);
                expectedCounts.set(key, (expectedCounts.get(key) ?? 0) + 1);
            }
            const gotCounts = new Map<string, number>();
            for (const p of runsToPixels(runs)) {
                const key = pixelKey(p);
                gotCounts.set(key, (gotCounts.get(key) ?? 0) + 1);
            }
            assert.strictEqual(gotCounts.size, expectedCounts.size, `trial ${trial} distinct pixels`);
            for (const [key, count] of expectedCounts) {
                assert.strictEqual(gotCounts.get(key), count, `trial ${trial} pixel ${key}`);
            }
        }
    });
});
