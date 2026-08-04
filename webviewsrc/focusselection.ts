// Pure selection helpers for the focus-tree preview. Import-free on purpose so unit tests can
// exercise them without a DOM.

export interface SelectionState {
    selected: Set<string>;
}

export interface Rect {
    left: number;
    top: number;
    right: number;
    bottom: number;
}

export interface RectItem extends Rect {
    id: string;
}

export function emptySelection(): SelectionState {
    return { selected: new Set() };
}

// Replaces the selection with the given ids (the result of a rubber-band box select).
export function selectFocusIds(_state: SelectionState, ids: string[]): SelectionState {
    return { selected: new Set(ids) };
}

// Returns the ids of items whose bounds intersect the given rect (touching boundaries count).
export function idsInRect(rect: Rect, items: RectItem[]): string[] {
    const ids: string[] = [];
    for (const item of items) {
        if (item.left <= rect.right && item.right >= rect.left && item.top <= rect.bottom && item.bottom >= rect.top) {
            ids.push(item.id);
        }
    }
    return ids;
}
