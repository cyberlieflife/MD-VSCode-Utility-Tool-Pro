// Pure inlay placeholder substitution for the focus-tree preview. Import-free on purpose so unit
// tests can exercise it without loading the webview entry module (focustree.ts reads window
// globals at load time).

// Replaces every {{inlay_slot_class:<id>}} placeholder with its resolved class in a single regex
// pass instead of one split/join per slot (O(slots * template length) -> O(template length)).
// Placeholders with no known slot are left verbatim, matching the per-slot split/join behavior.
export function substituteInlaySlots(template: string, slotClasses: Record<string, string>): string {
    return template.replace(/{{inlay_slot_class:([^}]+)}}/g, (match, id: string) => slotClasses[id] ?? match);
}
