import * as vscode from 'vscode';
import { getEvents } from '../previewdef/event/schema';
import { parseHoi4File } from '../hoiformat/hoiparser';
import { eventTreePreview } from './featureflags';
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

interface EventIndex {
    [file: string]: string[]; // Filename -> array of event ids
}

const globalEventIndex: EventIndex = {};
// 每个父模组一份，按设置/依赖里的顺序；查找时工作区覆盖它、它覆盖本体。
let parentEventIndexes: EventIndex[] = [];
let workspaceEventIndex: EventIndex = {};

// Reverse maps for O(1) lookup: event id -> filename
const globalEventIdToFile = new Map<string, string>();
const workspaceEventIdToFile = new Map<string, string>();
const parentEventIdsToFile: Map<string, string>[] = [];

// Both halves report into this so the telemetry event carries the whole build's size. Reset per
// build, since a build that failed and is retried would otherwise keep counting from where it left off.
let estimatedSize: [number] = [0];

const builder = createIndexBuilder<void>({
    name: 'eventIndex',
    message: localize('eventIndex.building', 'Building Event index...'),
    build: async (progress) => {
        estimatedSize = [0];
        const context = await captureIndexBuildContext();
        await Promise.all([
            buildGlobalEventIndex(estimatedSize, progress, context),
            buildParentEventIndex(estimatedSize, progress, context),
            buildWorkspaceEventIndex(estimatedSize, progress, context),
        ]);
    },
    onSuccess: () => {
        sendEvent('eventIndex', { size: estimatedSize[0].toString() });
    },
});

const buildGate = builder.gate;

/**
 * Builds (once, lazily) the global + workspace event indexes. The event preview awaits this before
 * resolving child event ids, so a preview restored right after VS Code startup still finds events
 * defined in another file.
 */
export function ensureEventIndex(): Promise<void> {
    return builder.ensureBuilt();
}

// 2: the cache is a line per file rather than one document per half, so a cache written before it
// is a different shape entirely.
const EVENT_CACHE_VERSION = 2;

/** One file's event ids, as one line of the cache. */
interface EventCacheRecord {
    file: string;
    ids: string[];
}

const eventRoot = 'events';

// 半区隔离：global 与 workspace 两半用 workspace: false / parent: false 明确只列自己那一份，父模组
// 各自成半区，这样删掉工作区里的覆盖文件时，父模组那份仍在索引里（否则两边一起消失）。
async function buildGlobalEventIndex(estimatedSize: [number], progress: IndexProgress, context: IndexBuildContext): Promise<void> {
    await buildEventIndexHalf(
        'eventIndex.global',
        { mod: false, hoi4: true, parent: false, recursively: true },
        globalEventIndex,
        globalEventIdToFile,
        estimatedSize,
        progress,
        context,
    );
}

async function buildWorkspaceEventIndex(estimatedSize: [number], progress: IndexProgress, context?: IndexBuildContext): Promise<void> {
    const buildContext = context ?? (await captureIndexBuildContext());
    await buildEventIndexHalf(
        'eventIndex.workspace',
        { mod: true, hoi4: false, parent: false, recursively: true },
        workspaceEventIndex,
        workspaceEventIdToFile,
        estimatedSize,
        progress,
        buildContext,
    );
}

async function buildParentEventIndex(estimatedSize: [number], progress: IndexProgress, context?: IndexBuildContext): Promise<void> {
    const buildContext = context ?? (await captureIndexBuildContext());
    const parents = buildContext.parentModUris;
    parentEventIndexes = parents.map(() => ({}));
    parentEventIdsToFile.length = parents.length;
    // 没有父模组就没有这半个索引：不列举、不写缓存。
    if (parents.length === 0) {
        return;
    }
    await Promise.all(parents.map(async (parent, index) => {
        const options = { workspace: false, hoi4: false, recursively: true, parentModUris: [parent] as vscode.Uri[] };
        parentEventIdsToFile[index] = new Map<string, string>();
        await buildEventIndexHalf(
            `eventIndex.parent.${index}`,
            options,
            parentEventIndexes[index]!,
            parentEventIdsToFile[index]!,
            estimatedSize,
            progress,
            buildContext,
        );
    }));
}

async function buildEventIndexHalf(
    cacheName: string,
    options: ListFilesOptions,
    targetIndex: EventIndex,
    reverseMap: Map<string, string>,
    estimatedSize: [number],
    progress: IndexProgress,
    context: IndexBuildContext,
): Promise<void> {
    await buildIndexHalf<EventCacheRecord>(
        {
            cacheName,
            version: EVENT_CACHE_VERSION,
            cacheScope: context.cacheScope,
            dependencyGeneration: context.dependencyGeneration,
            listFiles: (token) =>
                listIndexFiles({
                    roots: [eventRoot],
                    options: { ...options, token },
                    // A mod with no events/ folder at all is ordinary, not a build failure.
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
                await fillEventItems(
                    file,
                    targetIndex,
                    reverseMap,
                    options,
                    estimatedSize,
                );
            },
            serialize: () => {
                const records: EventCacheRecord[] = [];
                for (const file in targetIndex) {
                    records.push({ file, ids: targetIndex[file]! });
                }
                return records;
            },
        },
        progress,
    );
}

async function fillEventItems(
    eventFile: IndexFile,
    eventIndex: EventIndex,
    reverseMap: Map<string, string>,
    options: FileSourceOptions,
    estimatedSize?: [number],
): Promise<void> {
    const ids = await readEventIds(eventFile, options, estimatedSize);
    if (ids === undefined) {
        return;
    }

    applyEventIds(eventFile.path, ids, eventIndex, reverseMap);
}

/**
 * Reading and parsing half of the index fill. Returns the file's event ids, an empty list when the
 * file holds no event definitions at all, or undefined when parsing failed -- so the caller decides
 * whether a failure means "write nothing" (the build) or "keep what is already indexed" (a re-index).
 */
async function readEventIds(
    eventFile: IndexFile,
    options: FileSourceOptions,
    estimatedSize?: [number],
): Promise<string[] | undefined> {
    const filePath = eventFile.path;
    const fileBuffer = await readIndexFileContent('Event index', eventFile, options);
    if (fileBuffer === undefined) {
        return undefined;
    }
    const fileContent = fileBuffer.toString();

    // Skip files that don't contain any event type definitions
    if (!fileContent.includes('country_event')
        && !fileContent.includes('news_event')
        && !fileContent.includes('state_event')
        && !fileContent.includes('unit_leader_event')
        && !fileContent.includes('operative_leader_event')) {
        return [];
    }

    try {
        const events = getEvents(parseHoi4File(fileContent, localize('infile', 'In file {0}:\n', filePath), { keepTokens: false }), filePath);
        const ids = Object.values(events.eventItemsByNamespace).flat().map(e => e.id);

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
function applyEventIds(
    eventFile: string,
    ids: string[],
    eventIndex: EventIndex,
    reverseMap: Map<string, string>,
): void {
    const previous = eventIndex[eventFile];
    if (previous) {
        for (const key of previous) {
            if (reverseMap.get(key) === eventFile) {
                reverseMap.delete(key);
            }
        }
    }

    if (ids.length === 0) {
        delete eventIndex[eventFile];
        return;
    }

    eventIndex[eventFile] = ids;
    for (const key of ids) {
        reverseMap.set(key, eventFile);
    }
}

export function findFileByEventId(id: string): string | undefined {
    // 与文件查找同序：工作区覆盖父模组、父模组覆盖本体。
    return (
        workspaceEventIdToFile.get(id) ??
        parentEventIdsToFile.map(map => map.get(id)).find(value => value !== undefined) ??
        globalEventIdToFile.get(id)
    );
}

function removeWorkspaceEventFile(relative: string): void {
    applyEventIds(relative, [], workspaceEventIndex, workspaceEventIdToFile);
}

/**
 * Re-indexes an edited event file: parse first, swap the entry in afterwards, so a preview
 * refreshing in the window between the edit and the re-parse still resolves the file's events.
 * A file that fails to parse midway through an edit keeps the ids it was last indexed with.
 */
async function reindexWorkspaceEventFile(file: vscode.Uri): Promise<void> {
    const relative = toWorkspaceRelativePath(file, `${eventRoot}/`);
    if (!relative) {
        return;
    }

    const ids = await readEventIds(
        { path: relative },
        { workspace: true, parent: false, hoi4: false },
    );
    if (ids === undefined) {
        return;
    }

    applyEventIds(relative, ids, workspaceEventIndex, workspaceEventIdToFile);
}

const watchers = createIndexWatchers({
    enabled: eventTreePreview,
    extension: '.txt',
    hasStarted: () => builder.hasStarted(),
    gate: buildGate,
    reindexFile: (file) => {
        void reindexWorkspaceEventFile(file);
    },
    removeFile: (file) => {
        const relative = toWorkspaceRelativePath(file, `${eventRoot}/`);
        if (relative) {
            removeWorkspaceEventFile(relative);
        }
    },
    rebuildWorkspace: {
        reset: () => {
            workspaceEventIndex = {};
            workspaceEventIdToFile.clear();
        },
        build: buildWorkspaceEventIndex,
        message: localize('eventIndex.workspace.building', 'Building workspace Event index...'),
        telemetryEvent: 'eventIndex.workspace',
        failureMessage: 'Building workspace Event index failed.',
    },
    rebuildParent: {
        reset: () => {
            parentEventIndexes = [];
            parentEventIdsToFile.length = 0;
        },
        build: buildParentEventIndex,
    },
});

export function registerEventIndex(): vscode.Disposable {
    return watchers.register();
}

// Test-only: clears memoized build state so isolated tests can exercise the lazy-build path.
export function __resetEventIndexForTests(): void {
    builder.reset();
    for (const file of Object.keys(globalEventIndex)) {
        delete globalEventIndex[file];
    }
    parentEventIndexes = [];
    workspaceEventIndex = {};
    globalEventIdToFile.clear();
    parentEventIdsToFile.length = 0;
    workspaceEventIdToFile.clear();
}

// Test-only: exposes the incremental event handlers so tests can drive the build/event race directly.
export const __testHandlers = watchers.handlers;
