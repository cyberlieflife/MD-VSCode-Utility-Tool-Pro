// fnv1a 32-bit content hash, the single source of truth shared by:
// - ContentLoader (src/util/loader/loader.ts) - whether a re-parse is needed;
// - UpdateablePreviewBase (src/previewdef/updateablepreview.ts, exported as hashHtml) - hash-skip;
// - the focus-tree fingerprint module (src/previewdef/focustree/fingerprint.ts) - text-hash early-out.
// Math.imul keeps the multiply in true 32-bit arithmetic: h * 16777619 (h up to 2^32-1, product
// ~7.2e16) would exceed Number.MAX_SAFE_INTEGER (2^53) and lose low bits to float rounding.
export function fnv1a(s: string): number {
    return fnv1a32(s);
}

const FNV_PRIME = 16777619;

/** 32-bit FNV-1a with a caller-supplied offset basis, for combining two passes into one digest. */
export function fnv1a32(s: string, offsetBasis: number = 2166136261): number {
    let h = offsetBasis;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, FNV_PRIME) >>> 0;
    }
    return h;
}

/**
 * 16 hex characters from two 32-bit passes over the same string; the second starts from a
 * decorrelated offset basis so the halves do not move together. Used for cache namespaces, where a
 * collision costs no more than two mods sharing one cache.
 */
export function fnv1a64Hex(s: string): string {
    return hex8(fnv1a32(s)) + hex8(fnv1a32(s, 2166136261 ^ 0xFFFFFFFF));
}

function hex8(value: number): string {
    return value.toString(16).padStart(8, '0');
}
