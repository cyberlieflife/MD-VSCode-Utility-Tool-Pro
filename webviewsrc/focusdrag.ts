// Pure drag-move helpers for the focus-tree preview. Import-free on purpose so unit tests can
// exercise them without a DOM.

export interface FocusGridPosition {
    x: number;
    y: number;
}

export interface DragMove {
    id: string;
    x: number;
    y: number;
}

// Converts a client-space pointer displacement (already zoomed) into whole grid steps. The scale
// is the content-element zoom factor: content pixels = client delta / scale, then grid steps =
// content pixels / grid cell size.
export function computeGridDelta(
    clientDeltaX: number,
    clientDeltaY: number,
    scale: number,
    xGridSize: number,
    yGridSize: number,
): { dx: number; dy: number } {
    if (scale <= 0 || xGridSize <= 0 || yGridSize <= 0) {
        return { dx: 0, dy: 0 };
    }
    return {
        dx: Math.round(clientDeltaX / scale / xGridSize),
        dy: Math.round(clientDeltaY / scale / yGridSize),
    };
}

// Builds the move list for the selected focuses given a whole-grid delta. Positions are the
// pre-drag file coordinates; focuses that would not actually change are omitted so the extension
// host never receives empty edits.
export function buildFocusDragMoves(
    selectedIds: Iterable<string>,
    positions: Record<string, FocusGridPosition>,
    delta: { dx: number; dy: number },
): DragMove[] {
    const moves: DragMove[] = [];
    for (const id of selectedIds) {
        const pos = positions[id];
        if (!pos) {
            continue;
        }
        const x = pos.x + delta.dx;
        const y = pos.y + delta.dy;
        if (x !== pos.x || y !== pos.y) {
            moves.push({ id, x, y });
        }
    }
    return moves;
}