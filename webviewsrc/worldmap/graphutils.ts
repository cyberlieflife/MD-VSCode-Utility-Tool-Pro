import { Point, Zone } from "./definitions";

export function inBBox(point: Point, bbox: Zone): boolean {
    return point.x >= bbox.x && point.x < bbox.x + bbox.w && point.y >= bbox.y && point.y < bbox.y + bbox.h;
}

export function bboxCenter(bbox: Zone): Point {
    return {
        x: bbox.x + bbox.w / 2,
        y: bbox.y + bbox.h / 2,
    };
}

export function distanceSqr(a: Point, b: Point): number {
    return (a.x - b.x) * (a.x - b.x) + (a.y - b.y) * (a.y - b.y);
}

export function distanceHamming(a: Point, b: Point): number {
    return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

export interface RiverPixel {
    x: number;
    y: number;
    color: number;
}

export interface RiverRun {
    x: number;
    y: number;
    w: number;
    color: number;
}

// Merges river pixels into horizontal same-color runs so the renderer issues one fillRect per run
// instead of one per pixel (river pixels are drawn in long rows, so this cuts fillRect calls by
// orders of magnitude at scale >= 1). Row order is ascending and runs keep their row's left-to-right
// order, so the merged rectangles cover exactly the input pixels with no overlap.
export function mergeRiverRuns(pixels: RiverPixel[]): RiverRun[] {
    const runs: RiverRun[] = [];
    if (pixels.length === 0) {
        return runs;
    }

    const byRow = new Map<number, RiverPixel[]>();
    for (const pixel of pixels) {
        let row = byRow.get(pixel.y);
        if (row === undefined) {
            byRow.set(pixel.y, row = []);
        }
        row.push(pixel);
    }

    const rows = [...byRow.keys()].sort((a, b) => a - b);
    for (const y of rows) {
        const row = byRow.get(y)!;
        row.sort((a, b) => a.x - b.x);

        let runStart = row[0].x;
        let runColor = row[0].color;
        let prevX = row[0].x;
        for (let i = 1; i < row.length; i++) {
            const pixel = row[i];
            if (pixel.color === runColor && pixel.x === prevX + 1) {
                prevX = pixel.x;
                continue;
            }
            runs.push({ x: runStart, y, w: prevX - runStart + 1, color: runColor });
            runStart = pixel.x;
            runColor = pixel.color;
            prevX = pixel.x;
        }
        runs.push({ x: runStart, y, w: prevX - runStart + 1, color: runColor });
    }

    return runs;
}
