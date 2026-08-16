import './setup';
import * as assert from 'assert';
import { buildProvinceSpatialIndex, defaultCellSize, queryPointCandidates } from '../../../webviewsrc/worldmap/spatialindex';
import { Province, Point, Zone } from '../../../src/previewdef/worldmap/definitions';
import { inBBox } from '../../../webviewsrc/worldmap/graphutils';

// A tiny seeded PRNG so the property tests are deterministic across CI runs.
function makeRandom(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
        s = (s * 1664525 + 1013904223) >>> 0;
        return s / 0x100000000;
    };
}

// Minimal province shape: only the fields the exact lookup test touches.
function makeProvince(id: number, bbox: Zone, coverZones?: Zone[]): Province {
    return {
        id,
        boundingBox: bbox,
        coverZones: coverZones ?? [bbox],
        edges: [],
    } as unknown as Province;
}

// Reference scan replicating the original getProvinceByPosition semantics: the caller's query
// point is tested verbatim against each province's raw bounding box (callers normalize x into
// [0, width) before calling; the reference never folds the bbox itself).
function bruteForceGetProvinceByPosition(
    provinces: (Province | null | undefined)[],
    x: number,
    y: number,
): Province | undefined {
    const point: Point = { x, y };
    for (const province of provinces) {
        if (province && inBBox(point, province.boundingBox) && province.coverZones.some(z => inBBox(point, z))) {
            return province;
        }
    }
    return undefined;
}

// Indexed lookup replicating FEWorldMapClass.getProvinceByPosition: candidates come from the
// spatial index (which wraps x internally), the exact test is byte-identical to the scan.
function indexedGetProvinceByPosition(
    provinces: (Province | null | undefined)[],
    width: number,
    cellSize: number,
    x: number,
    y: number,
): Province | undefined {
    const index = buildProvinceSpatialIndex(provinces, width, cellSize);
    const point: Point = { x, y };
    for (const id of queryPointCandidates(index, x, y)) {
        const province = provinces[id];
        if (province && inBBox(point, province.boundingBox) && province.coverZones.some(z => inBBox(point, z))) {
            return province;
        }
    }
    return undefined;
}

describe('webview/worldmap/province spatial index', function () {
    describe('defaultCellSize', function () {
        it('scales with the map width and floors at 256', function () {
            assert.strictEqual(defaultCellSize(16384), 512);
            assert.strictEqual(defaultCellSize(4096), 256);
            assert.strictEqual(defaultCellSize(1024), 256);
            assert.strictEqual(defaultCellSize(0), 256);
        });
    });

    describe('exactness against a full scan', function () {
        it('hits the province under the point and misses empty space', function () {
            const provinces = [
                makeProvince(1, { x: 10, y: 20, w: 100, h: 80 }),
                makeProvince(2, { x: 200, y: 50, w: 40, h: 40 }),
                undefined,
                makeProvince(4, { x: 0, y: 0, w: 0, h: 0 }),
            ];
            assert.strictEqual(indexedGetProvinceByPosition(provinces, 1024, 64, 50, 50)?.id, 1);
            assert.strictEqual(indexedGetProvinceByPosition(provinces, 1024, 64, 210, 60)?.id, 2);
            assert.strictEqual(indexedGetProvinceByPosition(provinces, 1024, 64, 150, 10), undefined);
            // Empty-bbox province (id 4) is never hit, matching the scan (coverZones is empty).
            assert.strictEqual(indexedGetProvinceByPosition(provinces, 1024, 64, 0, 0), undefined);
        });

        it('respects the coverZones sub-test when the bbox is larger than the zones', function () {
            const provinces = [
                makeProvince(7, { x: 0, y: 0, w: 100, h: 100 }, [
                    { x: 10, y: 10, w: 5, h: 5 },
                    { x: 80, y: 80, w: 5, h: 5 },
                ]),
            ];
            assert.strictEqual(indexedGetProvinceByPosition(provinces, 1024, 64, 12, 12)?.id, 7);
            assert.strictEqual(indexedGetProvinceByPosition(provinces, 1024, 64, 50, 50), undefined);
        });

        it('finds provinces straddling the horizontal seam from both sides', function () {
            // bbox [1020, 1040) on a 1024-wide map: the raw bbox spans past the seam.
            const provinces = [
                makeProvince(3, { x: 1020, y: 0, w: 20, h: 10 }),
            ];
            // A point inside the raw bbox resolves.
            assert.strictEqual(indexedGetProvinceByPosition(provinces, 1024, 64, 1022, 5)?.id, 3);
            // The index folds the bbox into the seam-side cell, so x=10 IS a candidate (the id
            // stored is the province's array slot, like provinces[slot] lookups)...
            const index = buildProvinceSpatialIndex(provinces, 1024, 64);
            assert.deepStrictEqual([...queryPointCandidates(index, 10, 5)], [0]);
            // ...but the exact test uses the raw bbox exactly like the reference scan (which never
            // folds it), so x=10 must not resolve - scan parity is preserved.
            assert.strictEqual(indexedGetProvinceByPosition(provinces, 1024, 64, 10, 5), undefined);
            // An unwrapped point that still lies inside the raw bbox resolves like the scan would.
            assert.strictEqual(indexedGetProvinceByPosition(provinces, 1024, 64, 1030, 5)?.id, 3);
            // A point outside the raw bbox (1050), even though it wraps near the seam cell, must
            // not resolve - scan parity is preserved.
            assert.strictEqual(indexedGetProvinceByPosition(provinces, 1024, 64, 1050, 5), undefined);
        });

        it('handles boxes wider than the whole map', function () {
            const provinces = [
                makeProvince(9, { x: 100, y: 0, w: 2000, h: 8 }),
            ];
            assert.strictEqual(indexedGetProvinceByPosition(provinces, 1024, 64, 500, 4)?.id, 9);
            assert.strictEqual(indexedGetProvinceByPosition(provinces, 1024, 64, 100, 4)?.id, 9);
        });

        it('matches the full scan across random province sets and query points', function () {
            const rand = makeRandom(0xBEEF0123);
            const width = 1024;
            for (let trial = 0; trial < 60; trial++) {
                const provinces: (Province | null | undefined)[] = [];
                const count = 5 + Math.floor(rand() * 120);
                for (let i = 0; i < count; i++) {
                    const x = Math.floor(rand() * width);
                    const w = 1 + Math.floor(rand() * 400);
                    provinces.push(makeProvince(i + 1, {
                        x,
                        y: Math.floor(rand() * 256),
                        w,
                        h: 1 + Math.floor(rand() * 200),
                    }));
                }
                // Sprinkle empty slots and empty-bbox provinces like the real sparse arrays.
                if (count > 10) {
                    provinces[3] = undefined;
                    provinces[7] = makeProvince(7, { x: 0, y: 0, w: 0, h: 0 });
                }
                for (let q = 0; q < 30; q++) {
                    const x = Math.floor(rand() * width * 1.5); // includes out-of-range x
                    const y = Math.floor(rand() * 300) - 20; // includes negative y
                    const expected = bruteForceGetProvinceByPosition(provinces, x, y);
                    const got = indexedGetProvinceByPosition(provinces, width, 64, x, y);
                    assert.strictEqual(got?.id ?? undefined, expected?.id ?? undefined,
                        `trial ${trial} q ${q}: point (${x},${y})`);
                }
            }
        });

        it('matches the full scan for seam-heavy randomized layouts', function () {
            const rand = makeRandom(0x5EA00123);
            const width = 1024;
            for (let trial = 0; trial < 40; trial++) {
                const provinces: (Province | null | undefined)[] = [];
                const count = 10 + Math.floor(rand() * 60);
                for (let i = 0; i < count; i++) {
                    // Bias x toward the seam so many boxes straddle 0/width.
                    const x = Math.floor(rand() * 200) + (rand() > 0.5 ? width - 200 : 0);
                    provinces.push(makeProvince(i + 1, {
                        x,
                        y: Math.floor(rand() * 256),
                        w: 1 + Math.floor(rand() * 300),
                        h: 1 + Math.floor(rand() * 100),
                    }));
                }
                for (let q = 0; q < 25; q++) {
                    const x = Math.floor(rand() * width);
                    const y = Math.floor(rand() * 256);
                    const expected = bruteForceGetProvinceByPosition(provinces, x, y);
                    const got = indexedGetProvinceByPosition(provinces, width, 64, x, y);
                    assert.strictEqual(got?.id ?? undefined, expected?.id ?? undefined,
                        `trial ${trial} q ${q}: point (${x},${y})`);
                }
            }
        });
    });
});
