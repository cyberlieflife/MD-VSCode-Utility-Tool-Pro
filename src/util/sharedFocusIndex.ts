import * as vscode from 'vscode';
import { extractFocusIds } from '../previewdef/focustree/schema';
import { parseHoi4File } from '../hoiformat/hoiparser';
import { sharedFocusIndex } from './featureflags';
import { IndexFile, listIndexFiles } from './indexListing';
import { localize } from './i18n';
import { sendEvent } from './telemetry';
import { createIndexBuilder, IndexProgress } from './indexBuild';
import { FileSourceOptions, ListFilesOptions } from './fileloader';
import {
    buildIndexHalf,
    captureIndexBuildContext,
    IndexBuildContext,
    readIndexFileContent,
    reportIndexParseFailure,
} from './indexHalf';
import { createIndexWatchers, toWorkspaceRelativePath } from './indexWatchers';

interface FocusIndex {
    [file: string]: string[]; // Filename -> array of focus keys
}

const globalFocusIndex: FocusIndex = {};
// 每个父模组一份，按设置/依赖里的顺序；查找时工作区覆盖它、它覆盖本体。
let parentFocusIndexes: FocusIndex[] = [];
let workspaceFocusIndex: FocusIndex = {};

// Reverse maps for O(1) lookup: focusKey -> filename
const globalFocusKeyToFile = new Map<string, string>();
const workspaceFocusKeyToFile = new Map<string, string>();
const parentFocusKeysToFile: Map<string, string>[] = [];

// Both halves report into this so the telemetry event carries the whole build's size. Reset per
// build, since a build that failed and is retried would otherwise keep counting from where it left off.
let estimatedSize: [number] = [0];

const builder = createIndexBuilder<void>({
    name: 'sharedFocusIndex',
    message: localize('sharedFocusIndex.building', 'Building Shared Focus index...'),
    build: async (progress) => {
        estimatedSize = [0];
        const context = await captureIndexBuildContext();
        await Promise.all([
            buildGlobalFocusIndex(estimatedSize, progress, context),
            buildParentFocusIndex(estimatedSize, progress, context),
            buildWorkspaceFocusIndex(estimatedSize, progress, context),
        ]);
    },
    onSuccess: () => {
        sendEvent('sharedFocusIndex', { size: estimatedSize[0].toString() });
    },
});

const buildGate = builder.gate;

// Builds (once, lazily) the global + workspace focus indexes. The focus-tree loader awaits this
// before resolving shared_focus dependencies, so a preview restored right after VS Code startup
// (deserialize, while the index is still building) still resolves joint/shared focuses.
export function ensureFocusIndex(): Promise<void> {
    return builder.ensureBuilt();
}

// 2: the cache is a line per file rather than one document per half, so a cache written before it
// is a different shape entirely.
const FOCUS_CACHE_VERSION = 2;

/** One file's focus ids, as one line of the cache. */
interface FocusCacheRecord {
    file: string;
    ids: string[];
}

const focusRoot = 'common/national_focus';

// 半区隔离：global 与 workspace 两半用 workspace: false / parent: false 明确只列自己那一份，父模组
// 各自成半区，这样删掉工作区里的覆盖文件时，父模组那份仍在索引里（否则两边一起消失）。
async function buildGlobalFocusIndex(estimatedSize: [number], progress: IndexProgress, context: IndexBuildContext): Promise<void> {
    await buildFocusIndexHalf(
        'focusIndex.global',
        { mod: false, hoi4: true, parent: false, recursively: true },
        globalFocusIndex,
        globalFocusKeyToFile,
        estimatedSize,
        progress,
        context,
    );
}

async function buildWorkspaceFocusIndex(estimatedSize: [number], progress: IndexProgress, context?: IndexBuildContext): Promise<void> {
    const buildContext = context ?? (await captureIndexBuildContext());
    await buildFocusIndexHalf(
        'focusIndex.workspace',
        { mod: true, hoi4: false, parent: false, recursively: true },
        workspaceFocusIndex,
        workspaceFocusKeyToFile,
        estimatedSize,
        progress,
        buildContext,
    );
}

async function buildParentFocusIndex(estimatedSize: [number], progress: IndexProgress, context?: IndexBuildContext): Promise<void> {
    const buildContext = context ?? (await captureIndexBuildContext());
    const parents = buildContext.parentModUris;
    parentFocusIndexes = parents.map(() => ({}));
    parentFocusKeysToFile.length = parents.length;
    // 没有父模组就没有这半个索引：不列举、不写缓存。
    if (parents.length === 0) {
        return;
    }
    await Promise.all(parents.map(async (parent, index) => {
        const options = { workspace: false, hoi4: false, recursively: true, parentModUris: [parent] as vscode.Uri[] };
        parentFocusKeysToFile[index] = new Map<string, string>();
        await buildFocusIndexHalf(
            `focusIndex.parent.${index}`,
            options,
            parentFocusIndexes[index]!,
            parentFocusKeysToFile[index]!,
            estimatedSize,
            progress,
            buildContext,
        );
    }));
}

async function buildFocusIndexHalf(
    cacheName: string,
    options: ListFilesOptions,
    targetIndex: FocusIndex,
    reverseMap: Map<string, string>,
    estimatedSize: [number],
    progress: IndexProgress,
    context: IndexBuildContext,
): Promise<void> {
    await buildIndexHalf<FocusCacheRecord>(
        {
            cacheName,
            version: FOCUS_CACHE_VERSION,
            cacheScope: context.cacheScope,
            dependencyGeneration: context.dependencyGeneration,
            listFiles: (token) =>
                listIndexFiles({
                    roots: [focusRoot],
                    options: { ...options, token },
                    // A mod with no national_focus/ folder at all is ordinary, not a build failure.
                    tolerateRootErrors: true,
                }),
            hydrate: (record, skipFiles) => {
                if (skipFiles.has(record.file) || record.ids.length === 0) {
                    return;
                }
                targetIndex[record.file] = record.ids;
                for (const key of record.ids) {
                    reverseMap.set(key, record.file);
                }
            },
            parseFile: async (file) => {
                await fillFocusItems(
                    file,
                    targetIndex,
                    reverseMap,
                    options,
                    estimatedSize,
                );
            },
            serialize: () => {
                const records: FocusCacheRecord[] = [];
                for (const file in targetIndex) {
                    records.push({ file, ids: targetIndex[file]! });
                }
                return records;
            },
        },
        progress,
    );
}

async function fillFocusItems(
    focusFile: IndexFile,
    focusIndex: FocusIndex,
    reverseMap: Map<string, string>,
    options: FileSourceOptions,
    estimatedSize?: [number],
): Promise<void> {
    const ids = await readFocusIds(focusFile, options, estimatedSize);
    if (ids === undefined) {
        return;
    }

    applyFocusIds(focusFile.path, ids, focusIndex, reverseMap);
}

/**
 * Reading and parsing half of the index fill. Returns the file's focus ids, an empty list when the
 * file holds no focus definitions at all, or undefined when parsing failed -- so the caller decides
 * whether a failure means "write nothing" (the build) or "keep what is already indexed" (a re-index).
 */
async function readFocusIds(
    focusFile: IndexFile,
    options: FileSourceOptions,
    estimatedSize?: [number],
): Promise<string[] | undefined> {
    const filePath = focusFile.path;
    const fileBuffer = await readIndexFileContent('Shared focus index', focusFile, options);
    if (fileBuffer === undefined) {
        return undefined;
    }
    const fileContent = fileBuffer.toString();

    // Skip files that don't contain any focus type definitions
    if (!fileContent.includes('focus_tree')
        && !fileContent.includes('shared_focus')
        && !fileContent.includes('joint_focus')) {
        return [];
    }

    try {
        const ids = extractFocusIds(parseHoi4File(fileContent, localize('infile', 'In file {0}:\n', filePath), { keepTokens: false }));

        if (estimatedSize) {
            estimatedSize[0] += fileBuffer.length;
        }

        return ids;
    } catch (e) {
        reportIndexParseFailure(filePath, options, e);
        return undefined;
    }
}

/**
 * Writing half of the index fill: swaps a file's entry for a fresh set of ids in one step, dropping
 * only the keys that entry still owns. An empty list removes the file from the index entirely.
 */
function applyFocusIds(
    focusFile: string,
    ids: string[],
    focusIndex: FocusIndex,
    reverseMap: Map<string, string>,
): void {
    const previous = focusIndex[focusFile];
    if (previous) {
        for (const key of previous) {
            if (reverseMap.get(key) === focusFile) {
                reverseMap.delete(key);
            }
        }
    }

    if (ids.length === 0) {
        delete focusIndex[focusFile];
        return;
    }

    focusIndex[focusFile] = ids;
    for (const key of ids) {
        reverseMap.set(key, focusFile);
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

function removeWorkspaceFocusFile(relative: string): void {
    applyFocusIds(relative, [], workspaceFocusIndex, workspaceFocusKeyToFile);
}

/**
 * Re-indexes an edited focus file: parse first, swap the entry in afterwards. Clearing the entry up
 * front (what an edit used to do) left the index without any of the file's focuses for as long as the
 * re-parse took, and a focus tree preview refreshing in that window -- which the same edit triggers,
 * on the same one second debounce -- resolved none of the file's shared focuses and silently dropped
 * the whole branch from the tree. A file that fails to parse midway through an edit keeps the ids it
 * was last indexed with, instead of losing them until the next edit that happens to parse.
 */
async function reindexWorkspaceFocusFile(file: vscode.Uri): Promise<void> {
    const relative = toWorkspaceRelativePath(file, `${focusRoot}/`);
    if (!relative) {
        return;
    }

    // readFocusIds reports both an unreadable file and a parse failure as undefined, logging either
    // itself, so there is nothing to catch here: the previously indexed ids stay in place.
    // No URI: a re-index reaches one file, so resolving it the usual way costs nothing worth avoiding.
    // Workspace only: a re-index that fires after the file was deleted must not read the parent's
    // copy into this half.
    const ids = await readFocusIds(
        { path: relative },
        { workspace: true, parent: false, hoi4: false },
    );
    if (ids === undefined) {
        return;
    }

    applyFocusIds(relative, ids, workspaceFocusIndex, workspaceFocusKeyToFile);
}

const watchers = createIndexWatchers({
    enabled: sharedFocusIndex,
    extension: '.txt',
    hasStarted: () => builder.hasStarted(),
    gate: buildGate,
    reindexFile: (file) => {
        void reindexWorkspaceFocusFile(file);
    },
    removeFile: (file) => {
        const relative = toWorkspaceRelativePath(file, `${focusRoot}/`);
        if (relative) {
            removeWorkspaceFocusFile(relative);
        }
    },
    rebuildWorkspace: {
        reset: () => {
            workspaceFocusIndex = {};
            workspaceFocusKeyToFile.clear();
        },
        build: buildWorkspaceFocusIndex,
        message: localize('sharedFocusIndex.workspace.building', 'Building workspace Focus index...'),
        telemetryEvent: 'sharedFocusIndex.workspace',
        failureMessage: 'Building workspace Focus index failed.',
    },
    rebuildParent: {
        reset: () => {
            parentFocusIndexes = [];
            parentFocusKeysToFile.length = 0;
        },
        build: buildParentFocusIndex,
    },
});

export function registerSharedFocusIndex(): vscode.Disposable {
    return watchers.register();
}

// Test-only: clears memoized build state so isolated tests can exercise the lazy-build path.
export function __resetSharedFocusIndexForTests(): void {
    builder.reset();
    for (const file of Object.keys(globalFocusIndex)) {
        delete globalFocusIndex[file];
    }
    parentFocusIndexes = [];
    workspaceFocusIndex = {};
    globalFocusKeyToFile.clear();
    parentFocusKeysToFile.length = 0;
    workspaceFocusKeyToFile.clear();
}

// Test-only: exposes the incremental event handlers so tests can drive the build/event race directly.
export const __testHandlers = watchers.handlers;
