import * as vscode from 'vscode';
import * as path from 'path';
import { parseHoi4FileToleratingUnclosedTail } from '../hoiformat/hoiparser';
import { getSpriteTypes } from '../hoiformat/spritetype';
import { debounceByInput, forceError, mapLimit, UserError } from './common';
import { error } from './debug';
import { gfxIndex } from './featureflags';
import { getFilePathFromModOrHOI4, listFilesFromModOrHOI4, readFileFromModOrHOI4 } from './fileloader';
import { localize } from './i18n';
import { uniq } from 'lodash';
import { sendEvent } from './telemetry';
import { Logger } from './logger';
import { getParentModUris, onDidChangeParentMods } from './parentmods';
import { whenModDependenciesSettled } from './moddependencies';
import { loadCacheManifest, loadCacheData, saveCacheManifest, saveCacheData, getFileMtimes, computeStaleFiles, IndexTimer } from './indexCache';

interface GfxIndexItem {
    file: string;
}

const globalGfxIndex: Record<string, GfxIndexItem | undefined> = {};
let workspaceGfxIndex: Record<string, GfxIndexItem | undefined> = {};
// 每个父模组一份索引，按设置/依赖里的顺序排列；查找时工作区覆盖它、它覆盖本体。
let parentGfxIndexes: Record<string, GfxIndexItem | undefined>[] = [];

// Reverse map for O(1) removal: file path -> sprite names from that file
const workspaceGfxFileToKeys = new Map<string, string[]>();

// Settles when the first full (global + workspace) index build finishes. Lazy: icon resolution
// starts the build on demand here if activation has not kicked it off yet.
let gfxIndexBuildPromise: Promise<void> | undefined;

// Fired after a full (re)build of the gfx indexes settles. PreviewManager listens to it so
// previews that resolved sprites while an index was still building can re-resolve the icons
// they missed (an index miss is authoritative in index mode, so those misses are permanent
// unless re-resolved).
const gfxIndexBuiltEmitter = new vscode.EventEmitter<void>();
export const onGfxIndexBuilt = gfxIndexBuiltEmitter.event;

// Sprite-name count of the last completed build, kept for the telemetry in ensureGfxIndex.
let gfxIndexSize = 0;

// The sprite namespace has no file of its own for a cache built from it to stat, so every mutation
// of either half moves this instead. Bumped *after* the write everywhere: a bump before it would let
// a reader store the new version alongside the old data and then never refetch it.
let gfxIndexVersion = 0;

function bumpGfxIndexVersion(): void {
    gfxIndexVersion++;
}

/** Changes whenever getIndexedGfxNames or getGfxContainerFile may answer differently. */
export function getGfxIndexVersion(): number {
    return gfxIndexVersion;
}

// Builds the global + workspace indexes once and reuses that promise for every caller. A build
// failure must not poison the shared promise: it resets so a later lookup retries, and resolves
// instead of rejecting so icon resolution falls through to the scan-based fallback paths rather
// than turning every preview into an error page.
export function ensureGfxIndex(): Promise<void> {
    if (gfxIndexBuildPromise === undefined) {
        const estimatedSize: [number] = [0];
        gfxIndexBuildPromise = Promise.all([
            buildGlobalGfxIndex(estimatedSize),
            buildParentGfxIndex(estimatedSize),
            buildWorkspaceGfxIndex(estimatedSize),
        ]).then(
            () => {
                gfxIndexSize = estimatedSize[0];
                sendEvent('gfxIndex', { size: gfxIndexSize.toString() });
                gfxIndexBuiltEmitter.fire();
            },
            (e) => {
                gfxIndexBuildPromise = undefined;
                error(e);
            },
        );
    }
    return gfxIndexBuildPromise;
}

export function registerGfxIndex(): vscode.Disposable {
    const disposables: vscode.Disposable[] = [];
    if (gfxIndex) {
        const task = ensureGfxIndex();
        vscode.window.setStatusBarMessage('$(loading~spin) ' + localize('gfxindex.building', 'Building GFX index...'), task);
        void task.then(() => {
            vscode.window.showInformationMessage(localize('gfxindex.builddone', 'Building GFX index done.'));
        });
        disposables.push(vscode.workspace.onDidChangeWorkspaceFolders(onChangeWorkspaceFolders));
        disposables.push(vscode.workspace.onDidChangeTextDocument(onChangeTextDocument));
        disposables.push(vscode.workspace.onDidCloseTextDocument(onCloseTextDocument));
        disposables.push(vscode.workspace.onDidCreateFiles(onCreateFiles));
        disposables.push(vscode.workspace.onDidDeleteFiles(onDeleteFiles));
        disposables.push(vscode.workspace.onDidRenameFiles(onRenameFiles));
        // 父模组名单变化（设置、`.mod` 依赖或工作区文件夹）：重建这半个索引，让新父模组的精灵
        // 立刻可查；已开的预览靠 built 通知重新解析之前 miss 掉的图标。
        disposables.push(onDidChangeParentMods(e => {
            if (!e.folders) {
                return;
            }
            const estimatedSize: [number] = [0];
            void buildParentGfxIndex(estimatedSize).then(() => {
                gfxIndexBuiltEmitter.fire();
            }, (e2) => error(e2));
        }));
    }

    return vscode.Disposable.from(...disposables);
}

export async function getGfxContainerFile(gfxName: string | undefined): Promise<string | undefined> {
    if (!gfxIndex || !gfxName) {
        return undefined;
    }

    // The index builds in the background after activation. A preview restored right after VS Code
    // startup (deserialize) runs its icon pass while the build is still in flight; without this
    // wait a miss during the build window is treated as authoritative ("defined in no indexed gfx
    // file", see getSpriteByGfxName) and the sprite is lost for the panel's lifetime. Awaiting the
    // settled promise costs one microtask.
    await ensureGfxIndex();
    // The game's order: the working mod, then the mods it extends, then vanilla.
    return (
        workspaceGfxIndex[gfxName] ??
        parentGfxIndexes.map(index => index[gfxName]).find(item => item !== undefined) ??
        globalGfxIndex[gfxName]
    )?.file;
}

export async function getGfxContainerFiles(gfxNames: (string | undefined)[]): Promise<string[]> {
    return uniq((await Promise.all(gfxNames.map(getGfxContainerFile))).filter((v): v is string => v !== undefined));
}

/**
 * Every sprite name the index holds, from both halves. For a caller that has to look at the names
 * themselves rather than resolve one it already knows -- listing which countries ship art for a
 * technology means reading the whole namespace once, not probing every tag against every id.
 * Empty when the index is off, like `getGfxContainerFile`.
 */
export async function getIndexedGfxNames(): Promise<string[]> {
    if (!gfxIndex) {
        return [];
    }

    await ensureGfxIndex();
    return uniq([
        ...Object.keys(workspaceGfxIndex),
        ...parentGfxIndexes.flatMap(index => Object.keys(index)),
        ...Object.keys(globalGfxIndex),
    ]);
}

const GFX_CACHE_VERSION = 2;

interface GfxCacheData {
    index: Record<string, GfxIndexItem | undefined>;
    fileToKeys: Record<string, string[]>;
}

async function buildGlobalGfxIndex(estimatedSize: [number]): Promise<void> {
    const options = { mod: false, recursively: true };
    const gfxFiles = (await listFilesFromModOrHOI4('interface', options)).filter(f => f.toLocaleLowerCase().endsWith('.gfx')).map(f => 'interface/' + f);
    await buildGfxIndexWithCache('gfxIndex.global', gfxFiles, globalGfxIndex, null, options, estimatedSize);
}

// 父模组各占一份索引：查找顺序是工作区覆盖父模组、父模组覆盖本体，而每个父模组一份索引才能让
// 各自的缓存键（列举 + mtime）互不干扰；名单在设置或 `.mod` 依赖变化时重建。
async function buildParentGfxIndex(estimatedSize: [number]): Promise<void> {
    // 依赖解析可能还在进行；此时列举只会看到显式设置的那些父模组，缓存命名空间也不会再出现。
    await whenModDependenciesSettled();
    const parents = getParentModUris();
    parentGfxIndexes = parents.map(() => ({}));
    if (parents.length === 0) {
        // 没有父模组就没有这半个索引：不列举、不写缓存。
        return;
    }
    await Promise.all(parents.map(async (parent, index) => {
        const options = { mod: false, hoi4: false, recursively: true, parentModUris: [parent] as vscode.Uri[] };
        const gfxFiles = (await listFilesFromModOrHOI4('interface', options))
            .filter(f => f.toLocaleLowerCase().endsWith('.gfx'))
            .map(f => 'interface/' + f);
        await buildGfxIndexWithCache(`gfxIndex.parent.${index}`, gfxFiles, parentGfxIndexes[index]!, null, options, estimatedSize);
    }));
}

async function buildWorkspaceGfxIndex(estimatedSize: [number]): Promise<void> {
    const options = { hoi4: false, recursively: true };
    const gfxFiles = (await listFilesFromModOrHOI4('interface', options)).filter(f => f.toLocaleLowerCase().endsWith('.gfx')).map(f => 'interface/' + f);
    await buildGfxIndexWithCache('gfxIndex.workspace', gfxFiles, workspaceGfxIndex, workspaceGfxFileToKeys, options, estimatedSize);
}

async function buildGfxIndexWithCache(
    cacheName: string,
    gfxFiles: string[],
    targetIndex: Record<string, GfxIndexItem | undefined>,
    fileToKeysMap: Map<string, string[]> | null,
    options: { mod?: boolean; hoi4?: boolean },
    estimatedSize: [number]
): Promise<void> {
    const timer = new IndexTimer(cacheName);
    const resolveUri = (relativePath: string) => getFilePathFromModOrHOI4(relativePath, options);
    const currentMtimes = await getFileMtimes(gfxFiles, resolveUri);
    timer.mark('mtime');

    const manifest = await loadCacheManifest(cacheName, GFX_CACHE_VERSION);
    let filesToParse = gfxFiles;

    if (manifest) {
        const staleness = computeStaleFiles(manifest, currentMtimes);
        const cachedData = await loadCacheData(cacheName);

        if (cachedData && staleness.stale.length + staleness.removed.length + staleness.added.length < gfxFiles.length) {
            try {
                const cached: GfxCacheData = JSON.parse(cachedData);
                const skipFiles = new Set([...staleness.stale, ...staleness.removed]);
                for (const spriteName in cached.index) {
                    const item = cached.index[spriteName];
                    if (item && !skipFiles.has(item.file)) {
                        targetIndex[spriteName] = item;
                    }
                }
                if (fileToKeysMap && cached.fileToKeys) {
                    for (const file in cached.fileToKeys) {
                        if (!skipFiles.has(file)) {
                            fileToKeysMap.set(file, cached.fileToKeys[file]);
                        }
                    }
                }
                filesToParse = [...staleness.stale, ...staleness.added];
            } catch {
                Logger.warn(`${cacheName}: cache data corrupted, full rebuild`);
                filesToParse = gfxFiles;
            }
        }
    }
    timer.mark('cache');

    await mapLimit(filesToParse, 8, f => fillGfxItems(f, targetIndex, fileToKeysMap, options, estimatedSize));
    timer.mark('parse');
    timer.log(gfxFiles.length, filesToParse.length);
    // Both the cache-restore writes above and the parses just finished are in targetIndex now.
    bumpGfxIndexVersion();

    const serializedFileToKeys: Record<string, string[]> = {};
    if (fileToKeysMap) {
        fileToKeysMap.forEach((keys, file) => { serializedFileToKeys[file] = keys; });
    }
    const cacheData: GfxCacheData = {
        index: targetIndex,
        fileToKeys: serializedFileToKeys,
    };
    // fire-and-forget: write data before manifest for atomicity
    void Promise.all([
        saveCacheData(cacheName, JSON.stringify(cacheData)),
        saveCacheManifest(cacheName, gfxFiles, currentMtimes, GFX_CACHE_VERSION),
    ]).catch(e => Logger.error(`Cache save failed for ${cacheName}: ${e}`));
}

async function fillGfxItems(gfxFile: string, gfxIndex: Record<string, GfxIndexItem | undefined>, fileToKeysMap: Map<string, string[]> | null, options: { mod?: boolean, hoi4?: boolean }, estimatedSize?: [number]): Promise<void> {
    try {
        if (estimatedSize) {
            estimatedSize[0] += gfxFile.length;
        }
        const [fileBuffer, uri] = await readFileFromModOrHOI4(gfxFile, options);
        const spriteTypes = getSpriteTypes(parseHoi4FileToleratingUnclosedTail(fileBuffer.toString(), localize('infile', 'In file {0}:\n', uri.toString()), { keepTokens: false }));
        const spriteNames: string[] = [];
        for (const spriteType of spriteTypes) {
            gfxIndex[spriteType.name] = { file: gfxFile };
            if (fileToKeysMap) {
                spriteNames.push(spriteType.name);
            }
            if (estimatedSize) {
                estimatedSize[0] += spriteType.name.length + 8;
            }
        }
        if (fileToKeysMap && spriteNames.length > 0) {
            fileToKeysMap.set(gfxFile, spriteNames);
        }
    } catch(e) {
        error(new UserError(forceError(e).toString()));
    }
}

function onChangeWorkspaceFolders(_: vscode.WorkspaceFoldersChangeEvent) {
    workspaceGfxIndex = {};
    workspaceGfxFileToKeys.clear();
    // The cleared index answers differently right now, before the rebuild finishes.
    bumpGfxIndexVersion();
    const estimatedSize: [number] = [0];
    const task = buildWorkspaceGfxIndex(estimatedSize);
    vscode.window.setStatusBarMessage('$(loading~spin) ' + localize('gfxindex.workspace.building', 'Building workspace GFX index...'), task);
    void task.then(() => {
        vscode.window.showInformationMessage(localize('gfxindex.workspace.builddone', 'Building workspace GFX index done.'));
        sendEvent('gfxIndex.workspace', { size: estimatedSize[0].toString() });
        // The rebuild window has the same authoritative-miss hazard as the startup build, so
        // let open previews re-resolve the sprites they resolved against the empty index.
        gfxIndexBuiltEmitter.fire();
    }, (e) => {
        // A failed rebuild also leaves the workspace index empty: still notify so open previews
        // re-resolve (the global index may cover them), and never leave the rejection unhandled.
        error(e);
        gfxIndexBuiltEmitter.fire();
    });
}

function onChangeTextDocument(e: vscode.TextDocumentChangeEvent) {
    const file = e.document.uri;
    if (file.path.endsWith('.gfx')) {
        onChangeTextDocumentImpl(file);
    }
}

const onChangeTextDocumentImpl = debounceByInput(
    (file: vscode.Uri) => {
        removeWorkspaceGfxIndex(file);
        addWorkspaceGfxIndex(file);
    },
    file => file.toString(),
    1000,
    { trailing: true }
);

function onCloseTextDocument(document: vscode.TextDocument) {
    const file = document.uri;
    if (file.path.endsWith('.gfx') && document.isDirty) {
        removeWorkspaceGfxIndex(file);
        addWorkspaceGfxIndex(file);
    }
}

function onCreateFiles(e: vscode.FileCreateEvent) {
    for (const file of e.files) {
        if (file.path.endsWith('.gfx')) {
            addWorkspaceGfxIndex(file);
        }
    }
}

function onDeleteFiles(e: vscode.FileDeleteEvent) {
    for (const file of e.files) {
        if (file.path.endsWith('.gfx')) {
            removeWorkspaceGfxIndex(file);
        }
    }
}

function onRenameFiles(e: vscode.FileRenameEvent) {
    onDeleteFiles({ files: e.files.map(f => f.oldUri) });
    onCreateFiles({ files: e.files.map(f => f.newUri) });
}

function removeWorkspaceGfxIndex(file: vscode.Uri) {
    const wsFolder = vscode.workspace.getWorkspaceFolder(file);
    if (wsFolder) {
        const relative = path.relative(wsFolder.uri.path, file.path).replace(/\\+/g, '/');
        if (relative && relative.startsWith('interface/')) {
            const keys = workspaceGfxFileToKeys.get(relative);
            if (keys) {
                for (const key of keys) {
                    delete workspaceGfxIndex[key];
                }
                workspaceGfxFileToKeys.delete(relative);
                bumpGfxIndexVersion();
            }
        }
    }
}

function addWorkspaceGfxIndex(file: vscode.Uri) {
    const wsFolder = vscode.workspace.getWorkspaceFolder(file);
    if (wsFolder) {
        const relative = path.relative(wsFolder.uri.path, file.path).replace(/\\+/g, '/');
        if (relative && relative.startsWith('interface/')) {
            void fillGfxItems(relative, workspaceGfxIndex, workspaceGfxFileToKeys, { hoi4: false })
                .then(() => bumpGfxIndexVersion());
        }
    }
}
