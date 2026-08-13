import './setup';
import * as assert from 'assert';
import { findNearestPoints } from '../../../webviewsrc/worldmap/renderer';
import { Province, Point } from '../../../src/previewdef/worldmap/definitions';
import { distanceSqr } from '../../../webviewsrc/worldmap/graphutils';

// A tiny seeded PRNG so the property tests are deterministic across CI runs.
function makeRandom(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
        s = (s * 1664525 + 1013904223) >>> 0;
        return s / 0x100000000;
    };
}

// Minimal province shape: only the fields findNearestPoints touches.
// `paths` is a list of polylines (Point[][]); all of them belong to a single adjacency edge,
// matching real province.edges[].path which is Point[][].
function makeProvince(id: number, paths: Point[][], bbox = { x: 0, y: 0, w: 1000, h: 1000 }): Province {
    return {
        id,
        boundingBox: bbox,
        edges: [{ path: paths }],
    } as unknown as Province;
}

// Reference brute-force implementation matching the original algorithm (O(Na * Nb)).
function bruteForceNearestPair(a: Province, b: Province): [Point, Point] {
    let best: [Point, Point] | undefined = undefined;
    let bestD = Infinity;
    for (const ape of a.edges) {
        for (const ap of ape.path) {
            for (const app of ap) {
                for (const bpe of b.edges) {
                    for (const bp of bpe.path) {
                        for (const bpp of bp) {
                            const d = distanceSqr(app, bpp);
                            if (d < bestD) {
                                bestD = d;
                                best = [app, bpp];
                            }
                        }
                    }
                }
            }
        }
    }
    return best ?? [{ x: 0, y: 0 }, { x: 0, y: 0 }];
}

function bruteForceNearestTo(start: Point, b: Province): [Point, Point] {
    let best: [Point, Point] | undefined = undefined;
    let bestD = Infinity;
    for (const bpe of b.edges) {
        for (const bp of bpe.path) {
            for (const bpp of bp) {
                const d = distanceSqr(start, bpp);
                if (d < bestD) {
                    bestD = d;
                    best = [start, bpp];
                }
            }
        }
    }
    return best ?? [{ x: 0, y: 0 }, { x: 0, y: 0 }];
}

describe('webview/worldmap/findNearestPoints', function () {
    describe('fast paths', function () {
        it('returns both endpoints directly when both are given', function () {
            const a = makeProvince(1, [[{ x: 0, y: 0 }]]);
            const b = makeProvince(2, [[{ x: 0, y: 0 }]]);
            const start = { x: 10, y: 20 };
            const end = { x: 30, y: 40 };
            assert.deepStrictEqual(findNearestPoints(start, end, a, b), [start, end]);
        });

        it('falls back to bounding-box center when the other province is missing', function () {
            const a = makeProvince(1, [[{ x: 0, y: 0 }]], { x: 4, y: 8, w: 10, h: 20 });
            const result = findNearestPoints(undefined, undefined, a, undefined);
            assert.deepStrictEqual(result, [{ x: 9, y: 18 }, { x: 9, y: 18 }]);
        });

        it('falls back to bounding-box center when the other province has no boundary points', function () {
            // After the start/end swap `a` is the province passed second (b); the fallback centers
            // the swapped `a`'s bounding box, i.e. { 200, 200, 100, 100 } -> (250, 250).
            const a = makeProvince(1, [], { x: 0, y: 0, w: 100, h: 100 });
            const b = makeProvince(2, [], { x: 200, y: 200, w: 100, h: 100 });
            const result = findNearestPoints(undefined, undefined, a, b);
            assert.deepStrictEqual(result, [{ x: 250, y: 250 }, { x: 250, y: 250 }]);
        });
    });

    describe('single-point nearest neighbor (one endpoint known)', function () {
        it('finds the closest boundary point on the other province', function () {
            const a = makeProvince(1, [[{ x: 0, y: 0 }]]);
            const b = makeProvince(2, [
                [
                    { x: 100, y: 100 },
                    { x: 110, y: 100 },
                    { x: 105, y: 108 },
                ],
            ]);
            const start = { x: 103, y: 99 };
            const [gotStart, gotEnd] = findNearestPoints(start, undefined, a, b);
            assert.deepStrictEqual(gotStart, start);
            // (100,100): d2=10 vs (110,100): d2=50 vs (105,108): d2=85.
            assert.deepStrictEqual(gotEnd, { x: 100, y: 100 });
        });

        it('matches brute force across random point sets', function () {
            const rand = makeRandom(0xC0FFEE);
            for (let trial = 0; trial < 50; trial++) {
                const a = makeProvince(1, [[{ x: 0, y: 0 }]]);
                const bPaths: Point[][] = [];
                const count = 10 + Math.floor(rand() * 200);
                for (let i = 0; i < count; i++) {
                    bPaths.push([{ x: Math.floor(rand() * 4096), y: Math.floor(rand() * 4096) }]);
                }
                const b = makeProvince(2, bPaths);
                const start = { x: Math.floor(rand() * 4096), y: Math.floor(rand() * 4096) };

                const got = findNearestPoints(start, undefined, a, b);
                const expected = bruteForceNearestTo(start, b);
                assert.strictEqual(distanceSqr(got[0], got[1]), distanceSqr(expected[0], expected[1]),
                    `trial ${trial}: start=(${start.x},${start.y})`);
            }
        });
    });

    describe('two-set nearest pair (no endpoints known)', function () {
        it('matches brute force across random point sets', function () {
            const rand = makeRandom(0xDEADBEEF);
            for (let trial = 0; trial < 50; trial++) {
                const aCount = 10 + Math.floor(rand() * 200);
                const bCount = 10 + Math.floor(rand() * 200);
                const aPaths: Point[][] = [];
                for (let i = 0; i < aCount; i++) {
                    aPaths.push([{ x: Math.floor(rand() * 4096), y: Math.floor(rand() * 4096) }]);
                }
                const bPaths: Point[][] = [];
                for (let i = 0; i < bCount; i++) {
                    bPaths.push([{ x: Math.floor(rand() * 4096), y: Math.floor(rand() * 4096) }]);
                }
                const a = makeProvince(1, aPaths);
                const b = makeProvince(2, bPaths);

                const got = findNearestPoints(undefined, undefined, a, b);
                const expected = bruteForceNearestPair(a, b);
                assert.strictEqual(distanceSqr(got[0], got[1]), distanceSqr(expected[0], expected[1]),
                    `trial ${trial}: got (${got[0].x},${got[0].y})<->(${got[1].x},${got[1].y}), ` +
                    `expected (${expected[0].x},${expected[0].y})<->(${expected[1].x},${expected[1].y})`);
            }
        });

        it('matches brute force for clustered (realistic) point sets', function () {
            const rand = makeRandom(0x1234ABCD);
            for (let trial = 0; trial < 50; trial++) {
                // Two spatially separated clusters, like two distant provinces.
                const aPaths: Point[][] = [];
                const ax = Math.floor(rand() * 2000);
                const ay = Math.floor(rand() * 2000);
                for (let i = 0; i < 150; i++) {
                    aPaths.push([{ x: ax + Math.floor(rand() * 200), y: ay + Math.floor(rand() * 200) }]);
                }
                const bPaths: Point[][] = [];
                const bx = Math.floor(rand() * 2000);
                const by = Math.floor(rand() * 2000);
                for (let i = 0; i < 150; i++) {
                    bPaths.push([{ x: bx + Math.floor(rand() * 200), y: by + Math.floor(rand() * 200) }]);
                }
                const a = makeProvince(1, aPaths);
                const b = makeProvince(2, bPaths);

                const got = findNearestPoints(undefined, undefined, a, b);
                const expected = bruteForceNearestPair(a, b);
                assert.strictEqual(distanceSqr(got[0], got[1]), distanceSqr(expected[0], expected[1]),
                    `trial ${trial}`);
            }
        });
    });

    describe('fractional coordinates (robustness of the ring-scan lower bound)', function () {
        it('single-point nearest neighbor stays exact for fractional points', function () {
            const rand = makeRandom(0xF00DC0DE);
            for (let trial = 0; trial < 50; trial++) {
                const a = makeProvince(1, [[{ x: 0, y: 0 }]]);
                const bPaths: Point[][] = [];
                const count = 10 + Math.floor(rand() * 100);
                for (let i = 0; i < count; i++) {
                    // Fractional coordinates, including values a hair below a cell boundary.
                    bPaths.push([{ x: rand() * 2000 + 0.5, y: rand() * 2000 + 0.5 }]);
                }
                const b = makeProvince(2, bPaths);
                const start = { x: rand() * 2000 + 0.5, y: rand() * 2000 + 0.5 };

                const got = findNearestPoints(start, undefined, a, b);
                const expected = bruteForceNearestTo(start, b);
                assert.strictEqual(distanceSqr(got[0], got[1]), distanceSqr(expected[0], expected[1]),
                    `trial ${trial}`);
            }
        });

        it('two-set nearest pair stays exact for fractional points', function () {
            const rand = makeRandom(0xFEEDFACE);
            for (let trial = 0; trial < 30; trial++) {
                const aPaths: Point[][] = [];
                for (let i = 0; i < 60; i++) {
                    aPaths.push([{ x: rand() * 2000 + 0.5, y: rand() * 2000 + 0.5 }]);
                }
                const bPaths: Point[][] = [];
                for (let i = 0; i < 60; i++) {
                    bPaths.push([{ x: rand() * 2000 + 0.5, y: rand() * 2000 + 0.5 }]);
                }
                const a = makeProvince(1, aPaths);
                const b = makeProvince(2, bPaths);

                const got = findNearestPoints(undefined, undefined, a, b);
                const expected = bruteForceNearestPair(a, b);
                assert.strictEqual(distanceSqr(got[0], got[1]), distanceSqr(expected[0], expected[1]),
                    `trial ${trial}: got ${distanceSqr(got[0], got[1])} vs ${distanceSqr(expected[0], expected[1])}`);
            }
        });
    });

    describe('end-only swap normalization (start missing, end given)', function () {
        it('searches nearest on the province passed first, and returns [end, nearest]', function () {
            // Call shape (undefined, end=P, a, b). The normalization moves P into `start` and swaps
            // provinces, so the nearest point must be searched on the province passed as `a`.
            const a = makeProvince(1, [[{ x: 100, y: 100 }, { x: 105, y: 108 }]]);
            const b = makeProvince(2, [[{ x: 500, y: 500 }]]);
            const end = { x: 103, y: 99 };
            const [gotStart, gotEnd] = findNearestPoints(undefined, end, a, b);
            assert.deepStrictEqual(gotStart, end);
            // Nearest to (103,99) among a's points: (100,100) d2=10 vs (105,108) d2=85.
            assert.deepStrictEqual(gotEnd, { x: 100, y: 100 });
        });

        it('end-only shape equals the equivalent start-only shape (shared cache entry)', function () {
            const a = makeProvince(1, [[{ x: 0, y: 0 }, { x: 10, y: 0 }]]);
            const b = makeProvince(2, [[{ x: 5, y: 8 }, { x: 12, y: 3 }]]);
            const p = { x: 3, y: 4 };
            // (undefined, p, a, b) normalizes to start=p, a=b, b=a; (p, undefined, b, a) is
            // already start-only with the same swap. Both must resolve to [p, nearest in a].
            const viaEnd = findNearestPoints(undefined, p, a, b);
            const viaStart = findNearestPoints(p, undefined, b, a);
            assert.deepStrictEqual(viaEnd, viaStart);
        });
    });

    describe('L1 result cache', function () {
        it('returns the identical result object for repeated identical calls', function () {
            const a = makeProvince(1, [[{ x: 0, y: 0 }, { x: 10, y: 0 }]]);
            const b = makeProvince(2, [[{ x: 5, y: 8 }, { x: 12, y: 3 }]]);
            const first = findNearestPoints(undefined, undefined, a, b);
            const second = findNearestPoints(undefined, undefined, a, b);
            assert.strictEqual(first, second);
        });

        it('recomputes when the province objects are replaced (WeakMap keys invalidated)', function () {
            const b = makeProvince(2, [[{ x: 900, y: 900 }]]);
            // First query with one pair of province objects: nearest of (0,0) in b is (900,900).
            const a1 = makeProvince(1, [[{ x: 0, y: 0 }]]);
            const first = findNearestPoints(undefined, undefined, a1, b);
            assert.strictEqual(distanceSqr(first[0], first[1]), 900 * 900 * 2);
            // Replaced province object with different boundary points: previously cached result
            // (keyed by the old a object) must not leak into the new pair.
            const a2 = makeProvince(1, [[{ x: 0, y: 0 }]]);
            const b2 = makeProvince(2, [[{ x: 3, y: 4 }]]);
            const second = findNearestPoints(undefined, undefined, a2, b2);
            assert.strictEqual(distanceSqr(second[0], second[1]), 3 * 3 + 4 * 4);
        });
    });
});
