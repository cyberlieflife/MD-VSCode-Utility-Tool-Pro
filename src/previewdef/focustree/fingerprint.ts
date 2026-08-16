// Pure fingerprint / skip-decision helpers for the focus-tree preview's partial-update path.
// Import-free of vscode-dependent modules on purpose so unit tests can exercise them without
// pulling in the preview stack (the shared util/hash.ts has no dependencies).

// Delegates to the shared fnv1a in src/util/hash.ts (the same hash drives ContentLoader's reparse
// decision and UpdateablePreviewBase's hash-skip). Exported here for the text-hash early-out and
// pinned against the other users in tests.
import { fnv1a } from '../../util/hash';
export { fnv1a };

// Pure decision for the sendPartialUpdate text-hash early-out. Unchanged text (same hash AND same
// length, the length guarding against the 32-bit collision window) plus no dependency change plus a
// rendered baseline means the parsed FocusTree[] is byte-identical, so the object-level load and
// its fingerprint serialization can be skipped entirely. `hasBaseline` mirrors the object-level
// early-out's `lastTreeStructural !== undefined` guard: the hash is only trusted when a successful
// render seeded it.
export function shouldSkipTextEarlyOut(input: {
    textHash: number;
    lastTextHash: number | undefined;
    textLength: number;
    lastTextLength: number;
    dependencyChanged: boolean;
    hasBaseline: boolean;
}): boolean {
    return !input.dependencyChanged && input.hasBaseline &&
        input.textHash === input.lastTextHash && input.textLength === input.lastTextLength;
}

export interface FocusTreeStructureInput {
    focusTrees: unknown;
    renderedFocus: Record<string, string>;
    renderedInlayWindows: Record<string, string>;
    gridBox: unknown;
    useConditionInFocus: boolean;
    xGridSize: number;
    // Structure-only styleTable records: placeholder focus icons plus the (deterministic per
    // identity) titlebar/overlay/inlay sprite CSS and the structural styles.
    styleRecords: Record<string, string>;
}

// styleTable keys whose identity (not the resolved image bytes) decides what the expensive
// icon-resolution pass has to produce. st-inlay-gui-slot- keys are counter-suffixed geometry
// classes embedded in the persistent inlay markup; a count change mints new class names whose
// rules only reach the webview through the icon-CSS repush, so they must move this fingerprint.
const iconKeyPrefixes = ['st-focus-icon-', 'st-focus-titlebar-', 'st-focus-overlay-', 'st-inlay-gfx-', 'st-inlay-gui-slot-'];

// Serialize a record with its keys in sorted order so insertion order (which varies under the
// 8-way concurrent render) does not change the fingerprint.
// (The structural fingerprint now folds each record via hashStringRecord below; key sorting is
// preserved there.)

export function computeStructuralFingerprint(input: FocusTreeStructureInput): string {
    // Hash each block separately and join fixed-width hex digests, instead of one big
    // JSON.stringify of everything (which materialises a multi-MB string on every structural change
    // of a large mod). Each record block keeps its sorted key order, so the fingerprint stays
    // insertion-order independent (the 8-way concurrent render). The output is a short fixed-format
    // string; decideFocusTreeUpdate only compares it with ===.
    const h32 = (s: string): string => fnv1a(s).toString(16).padStart(8, '0');
    // focusTrees is the largest and most safety-critical block (the whole object graph including
    // conditions and tokens), so it gets a 64-bit digest: two independent 32-bit fnv1a passes over
    // the SAME string in one traversal (no second full-length copy, unlike a + '\u0000' variant),
    // folded into two hex halves.
    const h64 = (s: string): string => fnv1a64Hex(s);
    return [
        h64(JSON.stringify(input.focusTrees)),
        hashStringRecord(input.renderedFocus),
        hashStringRecord(input.renderedInlayWindows),
        h32(JSON.stringify(input.gridBox)),
        input.useConditionInFocus ? '1' : '0',
        input.xGridSize.toString(16).padStart(2, '0'),
        hashStringRecord(input.styleRecords),
    ].join(':');
}

// 64-bit fold over the sorted (key, value-hash) pairs of a string record, without materialising
// the whole record as one JSON string (renderedFocus/renderedInlayWindows carry thousands of HTML
// fragments and the styleTable records all per-focus rules). Each value is reduced to a fixed-width
// 32-bit hash first, so the fold input stays tiny; the key, a ':' separator and the fixed-width
// digest keep the pair serialization unambiguous. Key order is sorted, matching the previous
// sortedRecordEntries behavior.
function hashStringRecord(record: Record<string, string>): string {
    const keys = Object.keys(record).sort();
    let h1 = 2166136261;
    let h2 = 2166136261 ^ 0xFFFFFFFF;
    const fold = (s: string): void => {
        for (let i = 0; i < s.length; i++) {
            const c = s.charCodeAt(i);
            h1 ^= c;
            h1 = Math.imul(h1, 16777619) >>> 0;
            h2 ^= c;
            h2 = Math.imul(h2, 16777619) >>> 0;
        }
    };
    for (const key of keys) {
        fold(key);
        fold(':');
        fold(fnv1a(record[key]).toString(16).padStart(8, '0'));
        fold(';');
    }
    return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

// 64-bit fnv1a digest as a 16-hex-char string: two 32-bit passes over the same input in a single
// traversal. The second pass starts from a different offset basis so the halves decorrelate; each
// half stays a true 32-bit integer (Math.imul), avoiding the Number precision loss of combining
// them arithmetically (a 2^64 product exceeds Number.MAX_SAFE_INTEGER).
function fnv1a64Hex(s: string): string {
    let h1 = 2166136261;
    let h2 = 2166136261 ^ 0xFFFFFFFF; // decorrelated second offset basis
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        h1 ^= c;
        h1 = Math.imul(h1, 16777619) >>> 0;
        h2 ^= c;
        h2 = Math.imul(h2, 16777619) >>> 0;
    }
    return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

export function computeIconSourceFingerprint(styleRecords: Record<string, string>): string {
    const keys = Object.keys(styleRecords).filter(k => iconKeyPrefixes.some(p => k.startsWith(p)));
    keys.sort();
    return JSON.stringify(keys);
}

// Object-level fingerprint input: the parsed focus trees plus the static grid metadata and the
// config that changes the RENDER without changing the FocusTree objects (useConditionInFocus).
// Used by the partial-update early-out to detect a structural change BEFORE any HTML/style rendering,
// so it is the focusTrees-only subset of computeStructuralFingerprint's hash (no rendered/styleTable
// records). The localisation knobs are intentionally NOT folded in: the focus-tree render never
// embeds localised text (names are resolved on demand by the webview ID/name toggle), so a
// localisation-index / preview-language flip cannot change the rendered structure and must not move
// the hash.
export interface FocusTreeObjectStructureInput {
    focusTrees: unknown;
    gridBox: unknown;
    useConditionInFocus: boolean;
    xGridSize: number;
}

export function computeTreeStructuralFingerprint(input: FocusTreeObjectStructureInput): string {
    // guiWindow is a large HOIPartial subtree resolved from the .gui dependency file. It changes only on
    // a .gui dependency change, which reaches the preview as dependencyChanged (handled by the early-out's
    // !dependencyChanged gate), and any change to WHICH inlay a tree references shows up in the other inlay
    // fields (windowName/guiFile/scriptedImages), so excluding guiWindow shrinks the hash without hiding a
    // structural change. The replacer drops any property named guiWindow at any depth (no other field uses
    // that name) instead of mutating the real focusTrees objects. Focus/inlay tokens are KEPT on purpose: a
    // text shift legitimately moves navigation offsets, matching the rendered start=/end= behavior.
    return JSON.stringify([
        input.focusTrees,
        input.gridBox,
        input.useConditionInFocus,
        input.xGridSize,
    ], (key, value) => key === 'guiWindow' ? undefined : value);
}

interface FingerprintFocus {
    icon?: { icon?: string }[];
    textIcon?: string;
    overlay?: string;
}

interface FingerprintTree {
    focuses?: Record<string, FingerprintFocus>;
    inlayWindows?: { scriptedImages?: { gfxOptions?: { gfxName?: string }[] }[] }[];
}

// Object-level analog of computeIconSourceFingerprint: the set of icon identities the render has to
// resolve, taken straight from the parsed trees. Keys are category-prefixed so an icon and an overlay of
// the same name stay distinct, mirroring the st-focus-icon-/st-focus-overlay-/... styleTable prefixes.
export function computeTreeIconFingerprint(focusTrees: FingerprintTree[]): string {
    const keys = new Set<string>();
    for (const tree of focusTrees) {
        for (const focus of Object.values(tree.focuses ?? {})) {
            for (const icon of focus.icon ?? []) {
                if (icon.icon !== undefined) { keys.add('icon:' + icon.icon); }
            }
            if (focus.textIcon !== undefined) { keys.add('titlebar:' + focus.textIcon); }
            if (focus.overlay !== undefined) { keys.add('overlay:' + focus.overlay); }
        }
        for (const inlay of tree.inlayWindows ?? []) {
            for (const slot of inlay.scriptedImages ?? []) {
                for (const option of slot.gfxOptions ?? []) {
                    if (option.gfxName !== undefined) { keys.add('inlay-gfx:' + option.gfxName); }
                }
            }
        }
    }
    return JSON.stringify([...keys].sort());
}

export interface FocusTreeFingerprints {
    structural: string;
    iconSource: string;
}

export interface FocusTreeUpdateDecision {
    postUpdate: boolean;
    pushIcons: boolean;
}

/**
 * Decides what the webview needs given the previous and current fingerprints. `postUpdate` rebuilds
 * the focus DOM; `pushIcons` re-resolves and re-pushes the real icon CSS. Both false means nothing
 * the webview renders changed, so the update can be skipped entirely (the common while-typing case).
 */
export function decideFocusTreeUpdate(prev: FocusTreeFingerprints | undefined, next: FocusTreeFingerprints): FocusTreeUpdateDecision {
    if (prev === undefined) {
        return { postUpdate: true, pushIcons: true };
    }
    return {
        postUpdate: next.structural !== prev.structural,
        pushIcons: next.iconSource !== prev.iconSource,
    };
}
