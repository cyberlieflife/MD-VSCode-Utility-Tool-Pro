import * as assert from 'assert';
import { isEqual } from 'lodash';
import { itemFingerprint, itemFingerprints, collectChangeRanges, ChangeRange } from '../previewdef/worldmap/itemfingerprint';

// A tiny seeded PRNG so the property tests are deterministic across CI runs.
function makeRandom(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
        s = (s * 1664525 + 1013904223) >>> 0;
        return s / 0x100000000;
    };
}

// Reference implementation replicating the original fillMessageForItem loop (absolute indices,
// lodash isEqual per item, same flush/split rules).
function referenceRanges(
    list: unknown[],
    cachedList: unknown[],
    listStart: number,
    listEnd: number,
    messageCountLimit: number,
): ChangeRange[] {
    const ranges: ChangeRange[] = [];
    let lastDifferenceStart: number | undefined = undefined;
    for (let i = listStart; i <= listEnd; i++) {
        if (i === listEnd || isEqual(list[i], cachedList[i])) {
            if (lastDifferenceStart !== undefined) {
                ranges.push({ start: lastDifferenceStart, end: i });
                lastDifferenceStart = undefined;
            }
        } else {
            if (lastDifferenceStart === undefined) {
                lastDifferenceStart = i;
            } else if (i - lastDifferenceStart >= messageCountLimit) {
                ranges.push({ start: lastDifferenceStart, end: i });
                lastDifferenceStart = i;
            }
        }
    }
    return ranges;
}

function fingerprintRanges(list: unknown[], cachedList: unknown[], listStart: number, listEnd: number, messageCountLimit: number): ChangeRange[] {
    const newFps = itemFingerprints(list, listStart, listEnd);
    const oldFps = itemFingerprints(cachedList, listStart, listEnd);
    const ranges = collectChangeRanges(i => newFps[i] === oldFps[i], listEnd - listStart, messageCountLimit);
    return ranges.map(r => ({ start: listStart + r.start, end: listStart + r.end }));
}

describe('worldmap item fingerprint diff', function () {
    describe('itemFingerprint', function () {
        it('is deterministic for equal items', function () {
            const item = { id: 3, name: 'x', provinces: [1, 2, 3], nested: { a: [true, null] } };
            assert.strictEqual(itemFingerprint(item), itemFingerprint(item));
        });

        it('distinguishes undefined and null holes', function () {
            assert.notStrictEqual(itemFingerprint(undefined), itemFingerprint(null));
            assert.strictEqual(itemFingerprint(undefined), itemFingerprint(undefined));
            assert.strictEqual(itemFingerprint(null), itemFingerprint(null));
        });

        it('distinguishes structurally different items', function () {
            assert.notStrictEqual(itemFingerprint({ a: 1 }), itemFingerprint({ a: 2 }));
        });

        it('fingerprints out-of-range slots as undefined holes', function () {
            const fps = itemFingerprints([{ a: 1 }], 0, 3);
            assert.strictEqual(fps.length, 3);
            assert.notStrictEqual(fps[0], fps[1]);
            assert.strictEqual(fps[1], fps[2]);
        });
    });

    describe('collectChangeRanges', function () {
        it('returns no ranges when everything matches', function () {
            assert.deepStrictEqual(collectChangeRanges(() => true, 5, 300), []);
        });

        it('returns one range covering everything when nothing matches', function () {
            assert.deepStrictEqual(collectChangeRanges(() => false, 4, 300), [{ start: 0, end: 4 }]);
        });

        it('splits a long changed run at the message count limit', function () {
            const ranges = collectChangeRanges(() => false, 10, 3);
            assert.deepStrictEqual(ranges, [
                { start: 0, end: 3 },
                { start: 3, end: 6 },
                { start: 6, end: 9 },
                { start: 9, end: 10 },
            ]);
        });

        it('matches the reference scan for sparse single-item changes', function () {
            const isSame = (i: number) => i !== 2 && i !== 7;
            assert.deepStrictEqual(collectChangeRanges(isSame, 10, 300), [
                { start: 2, end: 3 },
                { start: 7, end: 8 },
            ]);
        });
    });

    describe('equivalence with the reference isEqual diff', function () {
        it('matches across randomized item lists, including holes and shorter cached lists', function () {
            const rand = makeRandom(0xD1FF11);
            for (let trial = 0; trial < 60; trial++) {
                const count = 5 + Math.floor(rand() * 60);
                const cachedList: unknown[] = [];
                const list: unknown[] = [];
                for (let i = 0; i < count; i++) {
                    const mutate = rand() > 0.75;
                    const holeKind = rand();
                    if (holeKind < 0.08) {
                        cachedList.push(undefined);
                        list.push(undefined);
                    } else if (holeKind < 0.16) {
                        cachedList.push(null);
                        list.push(rand() > 0.5 ? null : undefined);
                    } else {
                        const base = {
                            id: i,
                            color: Math.floor(rand() * 0xFFFFFF),
                            edges: Array.from({ length: Math.floor(rand() * 4) }, (_, e) => ({
                                to: e,
                                path: Array.from({ length: Math.floor(rand() * 5) }, (_, p) => ({ x: p, y: p })),
                            })),
                        };
                        cachedList.push(base);
                        list.push(mutate ? { ...base, color: base.color + 1 } : base);
                    }
                }
                // Simulate a shorter cached list (provinces added).
                const cachedShort = cachedList.slice(0, Math.max(1, Math.floor(cachedList.length * 0.7)));
                const start = 0;
                const end = list.length;

                const expected = referenceRanges(list, cachedShort, start, end, 17);
                const got = fingerprintRanges(list, cachedShort, start, end, 17);
                assert.deepStrictEqual(got, expected, `trial ${trial}`);
            }
        });

        it('handles a non-zero list start (bad-id prefix)', function () {
            const cachedList = [undefined, undefined, { id: 1 }, { id: 2 }, { id: 3 }];
            const list = [undefined, undefined, { id: 1 }, { id: 2, extra: true }, { id: 3 }];
            const expected = referenceRanges(list, cachedList, 2, 5, 300);
            const got = fingerprintRanges(list, cachedList, 2, 5, 300);
            assert.deepStrictEqual(got, expected);
            assert.deepStrictEqual(got, [{ start: 3, end: 4 }]);
        });
    });
});
