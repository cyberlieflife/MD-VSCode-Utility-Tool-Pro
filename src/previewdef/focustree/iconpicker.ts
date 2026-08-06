import { extractFocusIcons } from './schema';
import { listFilesFromModOrHOI4, parseHoi4FileCached } from '../../util/fileloader';
import { getSpriteByGfxName, Sprite, Image } from '../../util/image/imagecache';

// Maximum single-frame pixels for the picker's atlas-crop path. A multi-frame focus sprite's whole
// texture is wasteful to decode and transfer for a small square cell, so the first frame is cropped
// instead. Larger textures fall back to the whole image rather than paying a big synchronous PNG
// crop on the hot path.
const MAX_PICKER_ATLAS_PIXELS = 512 * 512;

// Default number of picker icons emitted per streaming batch (and the concurrency bound for the
// name -> image resolution). The underlying imageCache dedupes concurrent decodes of one texture.
const DEFAULT_BATCH_SIZE = 16;
const DEFAULT_LIMIT = 8;

export interface IconImage {
    name: string;
    imageUri: string | undefined;
}

// Collects every focus icon GFX name used by the workspace and the vanilla national-focus files
// (deduplicated and sorted). No image resolution or decode happens here, so this is cheap even on a
// cold start: the file listing and per-file parses are served from fileListCache/parseCache.
export async function collectFocusIconNames(): Promise<string[]> {
    const names = new Set<string>();
    const files = await listFilesFromModOrHOI4('common/national_focus', { mod: true, hoi4: true, recursively: true });
    for (const f of files) {
        const rel = 'common/national_focus/' + f;
        try {
            const node = await parseHoi4FileCached(rel);
            for (const name of extractFocusIcons(node)) {
                names.add(name);
            }
        } catch { /* unreadable focus file: skip */ }
    }
    return [...names].sort((a, b) => a.localeCompare(b));
}

// Picker thumbnail for a focus icon: a single-frame sprite returns its whole image; a multi-frame
// atlas returns just the first frame (cropped once per sprite instance and memoized on Sprite.frames,
// the same frame the focus-tree preview and inlay windows show). Huge textures fall back to the
// whole image so an unexpectedly large atlas cannot stall the picker with a synchronous crop.
export function pickPickerImage(sprite: Sprite | undefined): Image | undefined {
    if (!sprite?.image) {
        return undefined;
    }
    if (sprite.noOfFrames > 1 && sprite.image.width * sprite.image.height <= MAX_PICKER_ATLAS_PIXELS) {
        return sprite.frames[0];
    }
    return sprite.image;
}

export async function getFocusIconPickerImage(name: string): Promise<Image | undefined> {
    const sprite = await getSpriteByGfxName(name, ['interface/goals.gfx']);
    return pickPickerImage(sprite);
}

export interface ResolveFocusIconsOptions {
    // How many resolved icons each onBatch callback (and the last partial batch) carries.
    batchSize?: number;
    // Concurrency bound for the name -> uri resolution. Defaults to 8 (same as the focus-tree
    // renderer); the decode throughput is capped by the single image worker either way.
    limit?: number;
    // Per-name resolver. Defaults to getFocusIconPickerImage -> Image.uri; tests inject a stub, and
    // the preview instance passes a memoizing resolver that dedupes in-flight requests.
    resolver?: (name: string) => Promise<string | undefined>;
    // Called with each completed batch. `done` is true on the final batch (including the empty
    // list when `names` is empty). Emitting streams results out before the full list is resolved.
    onBatch?: (images: IconImage[], done: boolean) => void | Promise<void>;
}

/**
 * Resolves each name to its picker-image data URI and returns the full list. Names are
 * deduplicated (a name resolved twice in one call decodes once). Results are also streamed through
 * `onBatch` in index-contiguous batches of `batchSize` as soon as each batch completes, so a caller
 * can push early batches to a webview while the rest still decode. Batches are only emitted in
 * order, so the last batch always carries `done: true` exactly once.
 */
export async function resolveFocusIconImages(
    names: string[],
    options: ResolveFocusIconsOptions = {},
): Promise<IconImage[]> {
    const batchSize = Math.max(1, options.batchSize ?? DEFAULT_BATCH_SIZE);
    const limit = Math.max(1, options.limit ?? DEFAULT_LIMIT);
    const resolver = options.resolver ?? (async (name) => (await getFocusIconPickerImage(name))?.uri);
    const onBatch = options.onBatch;

    const unique = [...new Set(names)];
    const total = unique.length;
    const results = new Array<IconImage>(total);
    if (total === 0) {
        await onBatch?.([], true);
        return results;
    }

    // Concurrency worker with streaming batch emission. Each completed slot bumps its batch's
    // fill count; whenever the next un-emitted batch is complete, it is emitted. Because batches
    // are index-contiguous and only emitted in order, the slices handed to onBatch always hold
    // fully-resolved entries regardless of the order workers finish in.
    const batchFill = new Map<number, number>();
    let emitted = 0;
    const emitCompleteBatches = async (): Promise<void> => {
        while (emitted < total) {
            const batchEnd = Math.min(emitted + batchSize, total);
            if ((batchFill.get(emitted) ?? 0) < batchEnd - emitted) {
                break;
            }
            const done = batchEnd === total;
            const batch = results.slice(emitted, batchEnd);
            // Advance before awaiting so a concurrent worker that observes the same completed batch
            // during the await gap can never emit it a second time (single-threaded JS makes the
            // check + advance atomic).
            emitted = batchEnd;
            await onBatch?.(batch, done);
        }
    };

    let nextIndex = 0;
    const worker = async (): Promise<void> => {
        while (true) {
            const index = nextIndex++;
            if (index >= total) {
                return;
            }
            let imageUri: string | undefined;
            try {
                imageUri = await resolver(unique[index]);
            } catch { /* icon not resolvable: name-only entry */ }
            results[index] = { name: unique[index], imageUri };
            const batchStart = index - (index % batchSize);
            batchFill.set(batchStart, (batchFill.get(batchStart) ?? 0) + 1);
            await emitCompleteBatches();
        }
    };

    const workers: Promise<void>[] = [];
    const effectiveLimit = Math.max(1, Math.min(limit, total));
    for (let i = 0; i < effectiveLimit; i++) {
        workers.push(worker());
    }
    await Promise.all(workers);
    return results;
}
