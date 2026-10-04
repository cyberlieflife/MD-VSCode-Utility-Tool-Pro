import * as vscode from 'vscode';
import * as path from 'path';
import { debounceByInput, mapLimit } from './common';
import { getFilePathFromModOrHOI4, listFilesFromModOrHOI4, readFileFromModOrHOI4 } from './fileloader';
import { localize } from './i18n';
import { sendEvent } from './telemetry';
import { Logger } from "./logger";
import { extractFocusIds } from "../previewdef/focustree/schema";
import { parseHoi4File } from "../hoiformat/hoiparser";
import { sharedFocusIndex } from "./featureflags";
import { loadCacheManifest, loadCacheData, saveCacheManifest, saveCacheData, getFileMtimes, computeStaleFiles, IndexTimer } from './indexCache';
import { getParentModUris, onDidChangeParentMods } from './parentmods';
import { whenModDependenciesSettled } from './moddependencies';

interface FocusIndex {
    [file: string]: string[]; // Filename -> array of focus keys
}

const globalFocusIndex: FocusIndex = {};
let workspaceFocusIndex: FocusIndex = {};
// 每个父模组一份，按设置/依赖里的顺序；查找时工作区覆盖它、它覆盖本体。
let parentFocusIndexes: FocusIndex[] = [];

// Reverse maps for O(1) lookup: focusKey -> filename
const globalFocusKeyToFile = new Map<string, string>();
const workspaceFocusKeyToFile = new Map<string, string>();
const parentFocusKeysToFile: Map<string, string>[] = [];

export function registerSharedFocusIndex(): vscode.Disposable {
    const disposables: vscode.Disposable[] = [];

    if (sharedFocusIndex) {
        const task = ensureFocusIndex();
        vscode.window.setStatusBarMessage('$(loading~spin) ' + localize('sharedFocusIndex.building', 'Building Shared Focus index...'), task);
        void task.then(() => {
            vscode.window.showInformationMessage(localize('sharedFocusIndex.builddone', 'Building Shared Focus index done.'));
            sendEvent('sharedFocusIndex', { size: focusIndexSize[0].toString() });
        });

        disposables.push(vscode.workspace.onDidChangeWorkspaceFolders(onChangeWorkspaceFolders));
        disposables.push(vscode.workspace.onDidChangeTextDocument(onChangeTextDocument));
        disposables.push(vscode.workspace.onDidCloseTextDocument(onCloseTextDocument));
        disposables.push(vscode.workspace.onDidCreateFiles(onCreateFiles));
        disposables.push(vscode.workspace.onDidDeleteFiles(onDeleteFiles));
        disposables.push(vscode.workspace.onDidRenameFiles(onRenameFiles));
        // 父模组名单变化：只重建这半个索引，让父模组里的共享焦点立刻可解析。
        disposables.push(onDidChangeParentMods(e => {
            if (!e.folders) {
                return;
            }
            const estimatedSize: [number] = [0];
            void buildParentFocusIndex(estimatedSize).then(
                () => undefined,
                (e2) => Logger.error(`[SharedFocus] rebuilding the parent half failed: ${String(e2)}`),
            );
        }));
    }

    return vscode.Disposable.from(...disposables);
}

// Shared size counter for the telemetry above the lazy build in registerSharedFocusIndex.
const focusIndexSize: [number] = [0];
let focusIndexBuildPromise: Promise<void> | undefined;

// Builds (once, lazily) the global + workspace focus indexes. The focus-tree loader awaits this
// before resolving shared_focus dependencies, so a preview restored right after VS Code startup
// (deserialize, while the index is still building) still resolves joint/shared focuses.
export function ensureFocusIndex(): Promise<void> {
    if (focusIndexBuildPromise === undefined) {
        const estimatedSize: [number] = [0];
        focusIndexBuildPromise = Promise.all([
            buildGlobalFocusIndex(estimatedSize),
            buildParentFocusIndex(estimatedSize),
            buildWorkspaceFocusIndex(estimatedSize),
        ]).then(() => {
            focusIndexSize[0] = estimatedSize[0];
        });
    }
    return focusIndexBuildPromise;
}

const FOCUS_CACHE_VERSION = 1;

// 半区隔离：global 与 workspace 两半用 parent: false 明确只列自己那一份，父模组各自成半区，
// 这样删掉工作区里的覆盖文件时，父模组那份仍在索引里（否则两边一起消失）。
async function buildGlobalFocusIndex(estimatedSize: [number]): Promise<void> {
    const options = { mod: false, hoi4: true, parent: false, recursively: true };
    const focusFiles = (await listFilesFromModOrHOI4('common/national_focus', options)).map(f => 'common/national_focus/' + f);
    await buildFocusIndexWithCache('focusIndex.global', focusFiles, globalFocusIndex, globalFocusKeyToFile, options, estimatedSize);
}

async function buildWorkspaceFocusIndex(estimatedSize: [number]): Promise<void> {
    const options = { mod: true, hoi4: false, parent: false, recursively: true };
    const focusFiles = (await listFilesFromModOrHOI4('common/national_focus', options)).map(f => 'common/national_focus/' + f);
    await buildFocusIndexWithCache('focusIndex.workspace', focusFiles, workspaceFocusIndex, workspaceFocusKeyToFile, options, estimatedSize);
}

async function buildParentFocusIndex(estimatedSize: [number]): Promise<void> {
    await whenModDependenciesSettled();
    const parents = getParentModUris();
    parentFocusIndexes = parents.map(() => ({}));
    parentFocusKeysToFile.length = parents.length;
    if (parents.length === 0) {
        // 没有父模组就没有这半个索引：不列举、不写缓存。
        return;
    }
    await Promise.all(parents.map(async (parent, index) => {
        const options = { mod: false, hoi4: false, recursively: true, parentModUris: [parent] as vscode.Uri[] };
        const focusFiles = (await listFilesFromModOrHOI4('common/national_focus', options)).map(f => 'common/national_focus/' + f);
        parentFocusKeysToFile[index] = new Map<string, string>();
        await buildFocusIndexWithCache(`focusIndex.parent.${index}`, focusFiles, parentFocusIndexes[index]!, parentFocusKeysToFile[index]!, options, estimatedSize);
    }));
}

async function buildFocusIndexWithCache(
    cacheName: string,
    focusFiles: string[],
    focusIndex: FocusIndex,
    reverseMap: Map<string, string>,
    options: { mod?: boolean; hoi4?: boolean },
    estimatedSize: [number]
): Promise<void> {
    const timer = new IndexTimer(cacheName);
    const resolveUri = (relativePath: string) => getFilePathFromModOrHOI4(relativePath, options);
    const currentMtimes = await getFileMtimes(focusFiles, resolveUri);
    timer.mark('mtime');

    const manifest = await loadCacheManifest(cacheName, FOCUS_CACHE_VERSION);
    let filesToParse = focusFiles;

    if (manifest) {
        const staleness = computeStaleFiles(manifest, currentMtimes);
        const cachedData = await loadCacheData(cacheName);

        if (cachedData && staleness.stale.length + staleness.removed.length + staleness.added.length < focusFiles.length) {
            try {
                const cached: FocusIndex = JSON.parse(cachedData);
                const skipFiles = new Set([...staleness.stale, ...staleness.removed]);
                for (const file in cached) {
                    if (!skipFiles.has(file)) {
                        focusIndex[file] = cached[file];
                        for (const key of cached[file]) {
                            reverseMap.set(key, file);
                        }
                    }
                }
                filesToParse = [...staleness.stale, ...staleness.added];
            } catch {
                Logger.warn(`${cacheName}: cache data corrupted, full rebuild`);
                filesToParse = focusFiles;
            }
        }
    }
    timer.mark('cache');

    await mapLimit(filesToParse, 8, f => fillFocusItems(f, focusIndex, reverseMap, options, estimatedSize));
    timer.mark('parse');
    timer.log(focusFiles.length, filesToParse.length);

    // fire-and-forget: write data before manifest for atomicity
    void Promise.all([
        saveCacheData(cacheName, JSON.stringify(focusIndex)),
        saveCacheManifest(cacheName, focusFiles, currentMtimes, FOCUS_CACHE_VERSION),
    ]).catch(e => Logger.error(`Cache save failed for ${cacheName}: ${e}`));
}

async function fillFocusItems(focusFile: string, focusIndex: FocusIndex, reverseMap: Map<string, string>, options: { mod?: boolean; hoi4?: boolean }, estimatedSize?: [number]): Promise<void> {
    const [fileBuffer] = await readFileFromModOrHOI4(focusFile, options);
    const fileContent = fileBuffer.toString();

    // Skip files that don't contain any focus type definitions
    if (!fileContent.includes('focus_tree')
        && !fileContent.includes('shared_focus')
        && !fileContent.includes('joint_focus')) {
        return;
    }

    try {
        const ids = extractFocusIds(parseHoi4File(fileContent, localize('infile', 'In file {0}:\n', focusFile), { keepTokens: false }));
        focusIndex[focusFile] = ids;

        for (const key of ids) {
            reverseMap.set(key, focusFile);
        }

        if (estimatedSize) {
            estimatedSize[0] += fileBuffer.length;
        }
    } catch (e) {
        const baseMessage = options.hoi4
            ? localize('sharedFocusIndex.vanilla', '[Vanilla]')
            : localize('sharedFocusIndex.mod', '[Mod]');

        const failureMessage = localize('sharedFocusIndex.parseFailure', 'Parsing failed! Please check if the file has issues!');
        if (e instanceof Error) {
            Logger.error(`${baseMessage} ${focusFile} ${failureMessage}\n${e.stack}`);
        }
    }
}

export function findFileByFocusKey(key: string): string | undefined {
    // 与文件查找同序：工作区覆盖父模组、父模组覆盖本体。
    return (
        workspaceFocusKeyToFile.get(key) ??
        parentFocusKeysToFile.map(map => map.get(key)).find(value => value !== undefined) ??
        globalFocusKeyToFile.get(key)
    );
}

function onChangeWorkspaceFolders(_: vscode.WorkspaceFoldersChangeEvent) {
    workspaceFocusIndex = {};
    workspaceFocusKeyToFile.clear();

    const estimatedSize: [number] = [0];
    const task = buildWorkspaceFocusIndex(estimatedSize);
    vscode.window.setStatusBarMessage('$(loading~spin) ' + localize('sharedFocusIndex.workspace.building', 'Building workspace Focus index...'), task);
    void task.then(() => {
        vscode.window.showInformationMessage(localize('sharedFocusIndex.workspace.builddone', 'Building workspace Focus index done.'));
        sendEvent('sharedFocusIndex.workspace', { size: estimatedSize[0].toString() });
    });
}

function onChangeTextDocument(e: vscode.TextDocumentChangeEvent) {
    const file = e.document.uri;
    if (file.path.endsWith('.txt')) {
        onChangeTextDocumentImpl(file);
    }
}

const onChangeTextDocumentImpl = debounceByInput(
    (file: vscode.Uri) => {
        removeWorkspaceFocusIndex(file);
        addWorkspaceFocusIndex(file);
    },
    file => file.toString(),
    1000,
    { trailing: true }
);

function onCloseTextDocument(document: vscode.TextDocument) {
    const file = document.uri;
    if (file.path.endsWith('.txt') && document.isDirty) {
        removeWorkspaceFocusIndex(file);
        addWorkspaceFocusIndex(file);
    }
}

function onCreateFiles(e: vscode.FileCreateEvent) {
    for (const file of e.files) {
        if (file.path.endsWith('.txt')) {
            addWorkspaceFocusIndex(file);
        }
    }
}

function onDeleteFiles(e: vscode.FileDeleteEvent) {
    for (const file of e.files) {
        if (file.path.endsWith('.txt')) {
            removeWorkspaceFocusIndex(file);
        }
    }
}

function onRenameFiles(e: vscode.FileRenameEvent) {
    onDeleteFiles({ files: e.files.map(f => f.oldUri) });
    onCreateFiles({ files: e.files.map(f => f.newUri) });
}

function removeWorkspaceFocusIndex(file: vscode.Uri) {
    const wsFolder = vscode.workspace.getWorkspaceFolder(file);
    if (wsFolder) {
        const relative = path.relative(wsFolder.uri.path, file.path).replace(/\\+/g, '/');
        if (relative && relative.startsWith('common/national_focus/')) {
            const keys = workspaceFocusIndex[relative];
            if (keys) {
                for (const key of keys) {
                    if (workspaceFocusKeyToFile.get(key) === relative) {
                        workspaceFocusKeyToFile.delete(key);
                    }
                }
            }
            delete workspaceFocusIndex[relative];
        }
    }
}

function addWorkspaceFocusIndex(file: vscode.Uri) {
    const wsFolder = vscode.workspace.getWorkspaceFolder(file);
    if (wsFolder) {
        const relative = path.relative(wsFolder.uri.path, file.path).replace(/\\+/g, '/');
        if (relative && relative.startsWith('common/national_focus/')) {
            void fillFocusItems(relative, workspaceFocusIndex, workspaceFocusKeyToFile, { hoi4: false });
        }
    }
}
