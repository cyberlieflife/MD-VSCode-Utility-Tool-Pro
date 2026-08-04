// Pure focus-selection state machine for the focus-tree preview. Import-free on purpose so unit
// tests can exercise it without a DOM.

export interface SelectionState {
    selected: Set<string>;
    // Anchor of the last plain click, used as the rectangle origin for shift-range selection.
    anchor: string | undefined;
}

export interface FocusGridPosition {
    x: number;
    y: number;
}

export function emptySelection(): SelectionState {
    return { selected: new Set(), anchor: undefined };
}

// Applies one click to the selection:
// - plain: replace the selection with the clicked focus (new anchor)
// - ctrl/meta: toggle the clicked focus, keep the anchor
// - shift: replace the selection with every focus inside the rectangle spanned by the anchor
//   and the clicked focus (grid coordinates); falls back to a plain click without an anchor
export function applySelectionClick(
    state: SelectionState,
    id: string,
    modifiers: { ctrl: boolean; shift: boolean },
    focusPositions: Record<string, FocusGridPosition>,
): SelectionState {
    if (modifiers.ctrl) {
        const next = new Set(state.selected);
        if (next.has(id)) {
            next.delete(id);
        } else {
            next.add(id);
        }
        return { selected: next, anchor: state.anchor };
    }

    if (modifiers.shift) {
        const anchorId = state.anchor ?? id;
        const anchorPos = focusPositions[anchorId];
        const idPos = focusPositions[id];
        if (anchorPos && idPos) {
            const minX = Math.min(anchorPos.x, idPos.x);
            const maxX = Math.max(anchorPos.x, idPos.x);
            const minY = Math.min(anchorPos.y, idPos.y);
            const maxY = Math.max(anchorPos.y, idPos.y);
            const next = new Set<string>();
            for (const [focusId, pos] of Object.entries(focusPositions)) {
                if (pos.x >= minX && pos.x <= maxX && pos.y >= minY && pos.y <= maxY) {
                    next.add(focusId);
                }
            }
            return { selected: next, anchor: state.anchor ?? id };
        }
        return { selected: new Set([id]), anchor: id };
    }

    return { selected: new Set([id]), anchor: id };
}
