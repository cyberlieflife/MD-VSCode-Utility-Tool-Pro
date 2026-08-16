// Spatial index over province bounding boxes for O(1) point lookups (getProvinceByPosition).
//
// The world map holds ~15k provinces; hovering and region-label rendering previously scanned every
// province per query (plus a coverZones pass on each candidate). The index maps each province's
// bounding box into a fixed-size grid and answers a point query by reading the single occupied
// cell the point falls into. Candidates are a strict superset of the exact hit (the caller keeps
// the original inBBox + coverZones test), so results are identical to a full scan.
//
// Map coordinates wrap horizontally: province bounding boxes may straddle the 0/width seam and
// callers normalize query x into [0, width). buildProvinceSpatialIndex therefore folds each bbox
// into [0, width) ranges when inserting, and queryPointCandidates normalizes the query x the same
// way, so seam-crossing provinces are found from either side.
import { Province } from '../../src/previewdef/worldmap/definitions';

export interface ProvinceSpatialIndex {
    cellSize: number;
    width: number;
    cells: Map<string, number[]>;
}

// Default cell size: ~512px on the vanilla 16384px-wide map, giving a handful of occupied cells
// per query while keeping each cell's candidate list short.
export function defaultCellSize(width: number): number {
    return Math.max(256, Math.round(width / 32));
}

export function buildProvinceSpatialIndex(
    provinces: (Province | null | undefined)[],
    width: number,
    cellSize: number,
): ProvinceSpatialIndex {
    const cells = new Map<string, number[]>();
    if (width <= 0 || cellSize <= 0) {
        return { cellSize: Math.max(1, cellSize), width, cells };
    }

    const put = (cellX: number, cellY: number, id: number): void => {
        const key = cellX + ',' + cellY;
        let bucket = cells.get(key);
        if (bucket === undefined) {
            cells.set(key, bucket = []);
        }
        bucket.push(id);
    };

    for (let id = 0; id < provinces.length; id++) {
        const province = provinces[id];
        if (!province) {
            continue;
        }
        const bbox = province.boundingBox;
        // Empty bounding boxes (definitions without a map presence) can never be hit by the exact
        // coverZones test, so they are skipped exactly like the scan would effectively skip them.
        if (!bbox || bbox.w <= 0 || bbox.h <= 0) {
            continue;
        }

        const y0 = Math.floor(bbox.y / cellSize);
        const y1 = Math.floor((bbox.y + bbox.h - 1) / cellSize);

        // Fold the x range into [0, width) blocks; a box wider than the map spans several blocks,
        // and a box crossing the seam lands in both neighbouring blocks' cells.
        let x = bbox.x;
        const xEnd = bbox.x + bbox.w;
        while (x < xEnd) {
            const block = Math.floor(x / width);
            const blockX = x - block * width;
            const blockEnd = Math.min(xEnd, (block + 1) * width);
            const cx0 = Math.floor(blockX / cellSize);
            const cx1 = Math.floor((blockEnd - 1 - block * width) / cellSize);
            for (let cy = y0; cy <= y1; cy++) {
                for (let cx = cx0; cx <= cx1; cx++) {
                    put(cx, cy, id);
                }
            }
            x = blockEnd;
        }
    }

    return { cellSize, width, cells };
}

// Province ids whose bounding box may contain the point, read from the single cell the point
// falls into. The caller keeps the exact inBBox + coverZones test, mirroring the scan semantics.
export function queryPointCandidates(index: ProvinceSpatialIndex, x: number, y: number): number[] {
    if (index.width <= 0 || index.cellSize <= 0) {
        return [];
    }
    // Normalize x the same way callers do (horizontal wrap); negative coordinates fold too.
    const nx = ((x % index.width) + index.width) % index.width;
    const cx = Math.floor(nx / index.cellSize);
    const cy = Math.floor(y / index.cellSize);
    if (cy < 0) {
        return [];
    }
    return index.cells.get(cx + ',' + cy) ?? [];
}
