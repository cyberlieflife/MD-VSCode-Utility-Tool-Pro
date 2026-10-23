import * as vscode from 'vscode';
import { parseHoi4FileToleratingUnclosedTail } from '../../hoiformat/hoiparser';
import { getSpriteTypes, SpriteType, CorneredTileSpriteType } from '../../hoiformat/spritetype';
import { readFileFromModOrHOI4, hoiFileExpiryToken, expiryToken } from '../fileloader';
import { PromiseCache } from '../cache';
import { decodeImageToPng } from './imagedecoder';
import { assertDecodablePng, readPngHeaderDimensions } from './converter';
import { Sprite, Image, CorneredTileSprite } from './sprite';
import { localize } from '../i18n';
import { error } from '../debug';
import { UserError } from '../common';
import { getGfxContainerFile } from '../gfxindex';
import { gfxIndex } from '../featureflags';
export { Sprite, Image };
export { readPngHeaderDimensions };

// Decoded PNG buffers are the heaviest thing in memory; bound the image cache by total bytes
// (least-recently-accessed eviction) so large texture packs can't grow it without limit. The
// smaller caches use an entry-count cap. (Entry sizes vary ~1000x for images, so a count cap
// alone would not bound their RAM.)
const imageCacheMaxBytes = 128 * 1024 * 1024;
const imageCache = new PromiseCache<Image | undefined>({
    expireWhenChange: hoiFileExpiryToken,
    factory: getImage,
    life: 10 * 60 * 1000,
    maxBytes: imageCacheMaxBytes,
    weigher: image => image ? image.pngBuffer.length : 0
});

const spriteCache = new PromiseCache({
    expireWhenChange: spriteCacheExpiryToken,
    factory: getSpriteByKey,
    life: 10 * 60 * 1000,
    maxSize: 128
});

const gfxMapCache = new PromiseCache({
    expireWhenChange: hoiFileExpiryToken,
    factory: loadGfxMap,
    life: 10 * 60 * 1000,
    maxSize: 64
});

// Diagnostic counters for profiling focus-tree icon resolution (plan Stap 1). They separate
// "searching" cost (index misses + fallback-scan iterations) from "conversion" cost (DDS/TGA->PNG
// decodes, offloaded to a worker with a sync fallback). Reset before a render and dumped after,
// behind the debug() flag.
export const iconResolveStats = {
    indexMiss: 0,
    scanIterations: 0,
    gfxMapParses: 0,
    imageDecodes: 0,
    imageDecodeMs: 0,
};

// Negative-scan memo for the index-off fallback path: remembers that a given icon name was not
// found in a given gfxFilePath set, so the same unresolved icon doesn't re-scan (and re-miss) the
// whole list for every focus that references it. Only negatives are stored; positive sprites go
// through spriteCache (which has proper file-change expiry). Cleared per render via
// resetIconResolveStats so a newly added gfx file is picked up on the next preview.
const negativeScanMemo = new Set<string>();

export function resetIconResolveStats(): void {
    iconResolveStats.indexMiss = 0;
    iconResolveStats.scanIterations = 0;
    iconResolveStats.gfxMapParses = 0;
    iconResolveStats.imageDecodes = 0;
    iconResolveStats.imageDecodeMs = 0;
    negativeScanMemo.clear();
}

// 清空 gfx/sprite/图片解析缓存。挂桩的测试在收尾调用它：这些缓存在 200ms 内无条件命中（不看过期
// token），一套桩解析出的结果会被另一套桩的测试直接复用。
export function clearGfxCaches(): void {
    gfxMapCache.clear();
    spriteCache.clear();
    imageCache.clear();
    negativeScanMemo.clear();
}

export function getImageByPath(relativePath: string): Promise<Image | undefined> {
    return imageCache.get(relativePath);
}

export async function getSpriteByGfxName(name: string, gfxFilePath: string | string[]): Promise<Sprite | undefined> {
    const pathFromIndex = await getGfxContainerFile(name);
    if (pathFromIndex) {
        return await spriteCache.get(pathFromIndex + '?' + name);
    }

    iconResolveStats.indexMiss++;

    // When the gfx index is enabled it is authoritative: a miss means the sprite is defined in no
    // indexed gfx file. The `gfxFilePath` fallback list is itself derived from index hits, so
    // scanning it cannot find the sprite either. Return undefined immediately instead of re-parsing
    // every gfx file for each unresolved focus icon. (plan Stap 2)
    if (gfxIndex) {
        return undefined;
    }

    if (Array.isArray(gfxFilePath)) {
        const memoKey = name + ' ' + gfxFilePath.join(' ');
        if (negativeScanMemo.has(memoKey)) {
            return undefined;
        }
        for (const path of gfxFilePath) {
            iconResolveStats.scanIterations++;
            const result = await spriteCache.get(path + '?' + name);
            if (result !== undefined) {
                return result;
            }
        }
        // Remember the miss so the same icon doesn't re-scan the whole list for every focus.
        negativeScanMemo.add(memoKey);
        return undefined;
    } else {
        return await spriteCache.get(gfxFilePath + '?' + name);
    }
}

async function spriteCacheExpiryToken(key: string, spritePromise: Promise<Sprite | undefined>): Promise<string> {
    const [gfxFilePath] = key.split('?');
    const gfxToken = await hoiFileExpiryToken(gfxFilePath);
    const sprite = await spritePromise;
    if (sprite) {
        return `${gfxToken}:${expiryToken(sprite.image.path)}`;
    }
    return gfxToken;
}

function getSpriteByKey(key: string): Promise<Sprite | undefined> {
    const [gfxFilePath, name] = key.split('?');
    return getSpriteByGfxNameImpl(name, gfxFilePath);
}

async function getSpriteByGfxNameImpl(name: string, gfxFilePath: string): Promise<Sprite | undefined> {
    const gfxMap = await gfxMapCache.get(gfxFilePath);
    // Exact name first: one .gfx file may define two sprites differing only in case, and the exact
    // spelling is the one the game would pick. The lowercase map is the fallback for a picture or
    // icon written in a different case than its sprite (e.g. `mex` for `GFX_idea_MEX`).
    const sprite = gfxMap.byName[name] ?? gfxMap.byLowerName.get(name.toLowerCase());

    if (sprite === undefined) {
        return undefined;
    }

    const image = await imageCache.get(sprite.texturefile);
    if (image === undefined) {
        return undefined;
    }

    if ('bordersize' in sprite) {
        return new CorneredTileSprite(name, image, sprite.noofframes, sprite.size, sprite.bordersize);
    }

    return new Sprite(name, image, sprite.noofframes);
}

async function getImage(relativePath: string): Promise<Image | undefined> {
    let readFileResult: [Buffer, vscode.Uri] | undefined = undefined;
    try {
        readFileResult = await readFileFromModOrHOI4(relativePath);
    } catch(e) {
        if (!(e instanceof UserError)) {
            error("Failed to get image " + relativePath);
        }
        error(e);

        if (relativePath.length <= 4 || relativePath.endsWith('.dds')) {
            return undefined;
        }

        // in case .png or .tga not exist but .dds exist
        relativePath = relativePath.substr(0, relativePath.length - 4) + '.dds';
    }

    try {
        const [buffer, realPath] = readFileResult ?? await readFileFromModOrHOI4(relativePath);
        let pngBuffer: Buffer;
        let width: number;
        let height: number;

        relativePath = relativePath.toLowerCase();
        const decodeStart = Date.now();
        if (relativePath.endsWith('.dds')) {
            ({ pngBuffer, width, height } = await decodeImageToPng(buffer, 'dds'));

        } else if (relativePath.endsWith('.tga')) {
            ({ pngBuffer, width, height } = await decodeImageToPng(buffer, 'tga'));

        } else if (relativePath.endsWith('.png')) {
            // PNG passthrough: only chunk headers are read, never a full inflate, and an image the
            // decoder cannot handle is refused before pngjs allocates for it.
            pngBuffer = buffer;
            ({ width, height } = assertDecodablePng(buffer));

        } else {
            throw new UserError('Unsupported image type: ' + relativePath);
        }
        iconResolveStats.imageDecodes++;
        iconResolveStats.imageDecodeMs += Date.now() - decodeStart;

        return new Image(pngBuffer, width, height, realPath);

    } catch (e) {
        if (!(e instanceof UserError)) {
            error("Failed to get image " + relativePath);
        }
        error(e);
        return undefined;
    }
}

interface GfxMap {
    // Sprites keyed by their name as written in the .gfx file.
    byName: Record<string, SpriteType | CorneredTileSpriteType>;
    // The same sprites keyed by lowercase name, so a picture or icon that differs only in case
    // still resolves. Last definition wins, matching byName.
    byLowerName: Map<string, SpriteType | CorneredTileSpriteType>;
}

async function loadGfxMap(path: string): Promise<GfxMap> {
    const byName: Record<string, SpriteType | CorneredTileSpriteType> = {};
    const byLowerName = new Map<string, SpriteType | CorneredTileSpriteType>();
    try {
        iconResolveStats.gfxMapParses++;
        const [buffer, realPath] = await readFileFromModOrHOI4(path);
        const gfx = buffer.toString('utf-8');
        const node = parseHoi4FileToleratingUnclosedTail(gfx, localize('infile', 'In file {0}:\n', realPath));
        const spriteTypes = getSpriteTypes(node);

        for (const st of spriteTypes) {
            byName[st.name] = st;
            byLowerName.set(st.name.toLowerCase(), st);
        }

    } catch (e) {
        error(e);
    }

    return { byName, byLowerName };
}
