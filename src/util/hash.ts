// fnv1a 32-bit content hash, the single source of truth shared by:
// - ContentLoader (src/util/loader/loader.ts) - whether a re-parse is needed;
// - UpdateablePreviewBase (src/previewdef/updateablepreview.ts, exported as hashHtml) - hash-skip;
// - the focus-tree fingerprint module (src/previewdef/focustree/fingerprint.ts) - text-hash early-out.
// Math.imul keeps the multiply in true 32-bit arithmetic: h * 16777619 (h up to 2^32-1, product
// ~7.2e16) would exceed Number.MAX_SAFE_INTEGER (2^53) and lose low bits to float rounding.
export function fnv1a(s: string): number {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 16777619) >>> 0;
    }
    return h;
}
