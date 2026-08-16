// Pure change-detection helpers for the world-map preview's incremental diff (sendDifferences).
//
// The previous diff compared every item of the new and cached lists with lodash isEqual, a deep
// recursive comparison per item. The loader reuses sub-loader cached arrays when a file did not
// change, so the caller first short-circuits on array identity (list === cachedList); when a
// sub-loader did reload, items are compared by a stable 64-bit fingerprint (two decorrelated 32-bit
// fnv1a passes over the JSON serialization, see fingerprint.ts) instead of a deep walk. The 64-bit
// digest keeps the per-item collision probability negligible over ~20k-item lists.
import { fnv1a } from '../../util/hash';

// Sentinel digests distinguishing the sparse-array hole states (undefined vs null) that would
// otherwise serialize ambiguously; the caller's isEqual treated undefined/null mismatches as a
// change, and these distinct values preserve that.
const HOLE_UNDEFINED = 'u';
const HOLE_NULL = 'n';

function fnv1a64Hex(s: string): string {
    let h1 = 2166136261;
    let h2 = 2166136261 ^ 0xFFFFFFFF;
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        h1 ^= c;
        h1 = Math.imul(h1, 16777619) >>> 0;
        h2 ^= c;
        h2 = Math.imul(h2, 16777619) >>> 0;
    }
    return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

export function itemFingerprint(item: unknown): string {
    if (item === undefined) {
        return HOLE_UNDEFINED;
    }
    if (item === null) {
        return HOLE_NULL;
    }
    return fnv1a64Hex(JSON.stringify(item));
}

// Fingerprints of list[start, end). Indices outside the list (a shorter cached array) fingerprint
// as undefined holes, matching the reference isEqual(item, undefined) mismatch.
export function itemFingerprints(list: unknown[], start: number, end: number): string[] {
    const fps = new Array<string>(end - start);
    for (let i = start; i < end; i++) {
        fps[i - start] = itemFingerprint(list[i]);
    }
    return fps;
}

export interface ChangeRange {
    start: number;
    end: number;
}

// Splits the fingerprint comparison into contiguous changed ranges, mirroring the reference
// fillMessageForItem control flow exactly: a range starts at the first differing index and is
// flushed at the first equal index (or the sentinel end). Ranges longer than `messageCountLimit`
// are cut into chunks. Indices are relative to the compared slice.
export function collectChangeRanges(
    isSame: (i: number) => boolean,
    count: number,
    messageCountLimit: number,
): ChangeRange[] {
    const ranges: ChangeRange[] = [];
    let lastDifferenceStart: number | undefined = undefined;
    for (let i = 0; i <= count; i++) {
        const same = i === count || isSame(i);
        if (same) {
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

export { fnv1a };
