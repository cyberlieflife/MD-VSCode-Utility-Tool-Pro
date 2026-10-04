import * as vscode from 'vscode';
import { localisationIndex } from './featureflags';
import { IndexFile, listIndexFiles } from './indexListing';
import { localize } from './i18n';
import { sendEvent } from './telemetry';
import { createIndexBuilder, indexParseQueue, IndexProgress } from './indexBuild';
import { FileSourceOptions, ListFilesOptions } from './fileloader';
import {
    buildIndexHalf,
    captureIndexBuildContext,
    IndexBuildContext,
    readIndexFileContent,
    reportIndexParseFailure,
} from './indexHalf';
import { createIndexWatchers, toWorkspaceRelativePath } from './indexWatchers';
import { ConfigurationKey } from '../constants';
import { Logger } from './logger';
import { yieldToEventLoop } from './common';
import {
    defaultYmlSuffix,
    isoBySettingName,
    ymlSuffixByIso,
    ymlSuffixes,
} from './locales';

type LocalisationData = Record<string, Record<string, string>>;

const globalLocalisationIndex: LocalisationData = {};
const globalLocalisationFileMap: Record<string, Record<string, Set<string>>> = {};
let workspaceLocalisationIndex: LocalisationData = {};
// 每个父模组一份，按设置/依赖里的顺序；查找时工作区覆盖它、它覆盖本体。
let parentLocalisationIndexes: LocalisationData[] = [];

// Tracks which localisation keys came from which file, per language
// langKey -> filePath -> Set<localisationKey>
const workspaceLocalisationFileMap: Record<string, Record<string, Set<string>>> = {};
// 父模组半区的平行表，只在重建时按文件回退用。
const parentLocalisationFileMaps: Record<string, Record<string, Set<string>>>[] = [];

// Both halves report into this so the telemetry event carries the whole build's size. Reset per
// build, since a build that failed and is retried would otherwise keep counting from where it left off.
let estimatedSize: [number] = [0];

const builder = createIndexBuilder<void>({
    name: 'localisationIndex',
    message: localize('localisationIndex.building', 'Building Localisation index...'),
    build: async (progress) => {
        estimatedSize = [0];
        const context = await captureIndexBuildContext();
        await Promise.all([
            buildGlobalLocalisationIndex(estimatedSize, progress, context),
            buildParentLocalisationIndex(estimatedSize, progress, context),
            buildWorkspaceLocalisationIndex(estimatedSize, progress, context),
        ]);
    },
    onSuccess: () => {
        sendEvent('localisationIndex', { size: estimatedSize[0].toString() });
    },
});

const buildGate = builder.gate;

// --- Lazy build scheduling -----------------------------------------------
// The index is built once. With no focus-tree preview open it is built as a slow background task
// (delayed start, one file at a time, yielding to the event loop between files) so a large first
// build never stalls VSCode startup. Opening a focus-tree preview flips the build to the fast path:
// a slow build that is still in its start delay is cancelled and restarted immediately, and a slow
// build already parsing files finishes the remainder at full concurrency. The focus-tree ID/name
// toggle (sendFocusNames) also drives this build on demand, so switching a tree to localised names
// works even without the localisationIndex setting being enabled.
const SLOW_BUILD_START_DELAY_MS = 3000;

type BuildPriority = 'fast' | 'slow';

let buildPriority: BuildPriority = 'slow';
let activeFocusTreePreviewCount = 0;
let slowStartTimer: NodeJS.Timeout | undefined;
let slowBuildResolve: (() => void) | undefined;
let slowBuildReject: ((e: unknown) => void) | undefined;
let scheduledBuild: Promise<void> | undefined;

// Called when a focus-tree preview panel opens: it is the consumer of the prewarmed index (the
// webview ID/name toggle), so a still-building index must be fast from now on.
export function notifyFocusTreePreviewOpened(): void {
    if (activeFocusTreePreviewCount === 0) {
        buildPriority = 'fast';
        // A slow background build is scheduled but has not started yet: cancel the delay and start the
        // fast build right away so the just-opened preview is not kept waiting. A slow build that is
        // already parsing sees buildPriority === 'fast' in its per-file loop and upgrades itself.
        if (slowStartTimer !== undefined) {
            clearTimeout(slowStartTimer);
            slowStartTimer = undefined;
            const resolve = slowBuildResolve;
            const reject = slowBuildReject;
            slowBuildResolve = undefined;
            slowBuildReject = undefined;
            if (resolve) {
                void builder.ensureBuilt().then(resolve, reject);
            }
        }
    }
    activeFocusTreePreviewCount++;
}

// Called when a focus-tree preview panel closes, keeping the open-preview count accurate (it decides
// whether a fresh build starts fast or slow).
export function notifyFocusTreePreviewClosed(): void {
    if (activeFocusTreePreviewCount > 0) {
        activeFocusTreePreviewCount--;
    }
}

function hasActiveFocusTreePreview(): boolean {
    return activeFocusTreePreviewCount > 0;
}

// Read through a function so TypeScript's control-flow analysis never narrows the module-level
// `buildPriority` (it may be flipped to 'fast' from notifyFocusTreePreviewOpened at any time).
function isFastBuild(): boolean {
    return buildPriority === 'fast';
}

// Builds (once) the global + workspace localisation indexes. Schedules a fast build right away when
// a focus-tree preview is open, otherwise a delayed slow build (see notifyFocusTreePreviewOpened for
// the upgrade path). A failed build drops the memo so a later lookup retries instead of reading a
// half-built index for the rest of the session.
export function ensureLocalisationIndex(): Promise<void> {
    if (scheduledBuild === undefined) {
        const task = scheduleBuild();
        scheduledBuild = task;
        void task.catch(() => {
            if (scheduledBuild === task) {
                scheduledBuild = undefined;
            }
        });
    }
    return scheduledBuild;
}

function scheduleBuild(): Promise<void> {
    if (buildPriority === 'fast') {
        return builder.ensureBuilt();
    }
    // Slow background build: delay the start so VSCode finishes activating first, then run at low
    // priority (see parseLocalisationFiles). Opening a focus-tree preview cancels the delay and
    // fast-builds instead.
    return new Promise<void>((resolve, reject) => {
        slowBuildResolve = resolve;
        slowBuildReject = reject;
        slowStartTimer = setTimeout(() => {
            slowStartTimer = undefined;
            slowBuildResolve = undefined;
            slowBuildReject = undefined;
            void builder.ensureBuilt().then(resolve, reject);
        }, SLOW_BUILD_START_DELAY_MS);
    });
}

export function registerLocalisationIndex(): vscode.Disposable {
    if (!localisationIndex) {
        return vscode.Disposable.from();
    }

    // Build the index up-front. If a focus-tree preview is already open in this window (e.g.
    // restored by the workspace) build it immediately at full speed; otherwise build it lazily
    // in the background (delayed, low-priority) so a big first build never stalls VSCode startup.
    buildPriority = hasActiveFocusTreePreview() ? 'fast' : 'slow';
    void ensureLocalisationIndex().catch(
        (e) => Logger.error(`[Localisation] build failed: ${String(e)}`),
    );
    return watchers.register();
}

const watchers = createIndexWatchers({
    enabled: true,
    extension: '.yml',
    hasStarted: () => builder.hasStarted(),
    gate: buildGate,
    reindexFile: (file) => {
        void reindexWorkspaceLocalisationFile(file);
    },
    removeFile: (file) => {
        const relative = toWorkspaceRelativePath(file, 'localisation/');
        if (relative) {
            removeWorkspaceLocalisationFile(relative);
        }
    },
    rebuildWorkspace: {
        reset: () => {
            workspaceLocalisationIndex = {};
            for (const langKey in workspaceLocalisationFileMap) {
                delete workspaceLocalisationFileMap[langKey];
            }
        },
        // The watcher-driven rebuilds run at full priority: something is already looking at the result.
        build: buildWorkspaceLocalisationIndex,
        message: localize('localisationIndex.workspace.building', 'Building workspace Localisation index...'),
        telemetryEvent: 'localisationIndex.workspace',
        failureMessage: 'Building workspace Localisation index failed.',
    },
    rebuildParent: {
        reset: () => {
            parentLocalisationIndexes = [];
            parentLocalisationFileMaps.length = 0;
        },
        build: buildParentLocalisationIndex,
    },
});

export function getLocalisedTextQuick(localisationKey: string | undefined): string | undefined {
    const previewLocalisation = vscode.workspace.getConfiguration(ConfigurationKey).previewLocalisation;
    if (previewLocalisation){
        return getLocalisedText(localisationKey, isoBySettingName[previewLocalisation] ?? vscode.env.language);
    }
    return getLocalisedText(localisationKey, vscode.env.language);
}

// Shared lookup: editor-language first, then l_english fallback. `getLocalisedText` gates this on
// the localisationIndex feature flag (its index is not built without it); the unchecked variant
// is for callers that have built the index on demand (e.g. the focus-tree name toggle).
function lookupLocalisedText(localisationKey: string, language: string): string | undefined {
    const langKey = ymlSuffixByIso[language.toLowerCase()] || defaultYmlSuffix;
    const defaultLangKey = defaultYmlSuffix;

    return globalLocalisationIndex[langKey]?.[localisationKey] ||
        workspaceLocalisationIndex[langKey]?.[localisationKey] ||
        parentLocalisationIndexes.map(index => index[langKey]?.[localisationKey]).find(value => value) ||
        globalLocalisationIndex[defaultLangKey]?.[localisationKey] ||
        workspaceLocalisationIndex[defaultLangKey]?.[localisationKey] ||
        parentLocalisationIndexes.map(index => index[defaultLangKey]?.[localisationKey]).find(value => value);
}

export function getLocalisedText(localisationKey: string | undefined, language: string): string | undefined {
    if (!localisationKey) {
        return localisationKey;
    }

    if (!localisationIndex) {
        return localisationKey ?? '';
    }

    return lookupLocalisedText(localisationKey, language) ?? localisationKey;
}

// Flag-independent variant of getLocalisedText for on-demand callers (see ensureLocalisationIndex).
export function getLocalisedTextUnchecked(localisationKey: string | undefined, language: string): string | undefined {
    if (!localisationKey) {
        return localisationKey;
    }

    return lookupLocalisedText(localisationKey, language) ?? localisationKey;
}

// 2: the cache is a line per file/language rather than one document per half, so a cache written
// before it is a different shape entirely.
const LOC_CACHE_VERSION = 2;
const langSuffixPattern = ymlSuffixes.join('|');
const localisationFileFilter = new RegExp(`.*_(${langSuffixPattern})\\.yml$`, 'i');

/**
 * One language of one .yml file, as one line of the cache. The file's keys are the entries' keys,
 * so the cache no longer carries a second copy of every key alongside the index.
 */
type LocCacheRecord = [
    langKey: string,
    filePath: string,
    entries: Record<string, string>,
];

const localisationRoot = 'localisation';
const isLocalisationFile = (relativePath: string) => localisationFileFilter.test(relativePath);

async function buildGlobalLocalisationIndex(estimatedSize: [number], progress: IndexProgress, context: IndexBuildContext): Promise<void> {
    await buildLocalisationIndexHalf(
        'localisationIndex.global',
        { mod: false, hoi4: true, recursively: true },
        globalLocalisationIndex,
        globalLocalisationFileMap,
        estimatedSize,
        progress,
        context,
    );
}

async function buildWorkspaceLocalisationIndex(estimatedSize: [number], progress: IndexProgress, context?: IndexBuildContext): Promise<void> {
    const buildContext = context ?? (await captureIndexBuildContext());
    await buildLocalisationIndexHalf(
        'localisationIndex.workspace',
        { mod: true, parent: false, hoi4: false, recursively: true },
        workspaceLocalisationIndex,
        workspaceLocalisationFileMap,
        estimatedSize,
        progress,
        buildContext,
    );
}

// 父模组各占一份索引，理由与 GFX 索引相同：工作区覆盖父模组、父模组覆盖本体，各自一份才能让缓存键
// 互不干扰。名单变化时只重建这半个索引。
async function buildParentLocalisationIndex(estimatedSize: [number], progress: IndexProgress, context?: IndexBuildContext): Promise<void> {
    const buildContext = context ?? (await captureIndexBuildContext());
    const parents = buildContext.parentModUris;
    parentLocalisationIndexes = parents.map(() => ({}));
    parentLocalisationFileMaps.length = parents.length;
    // 没有父模组就没有这半个索引：不列举、不写缓存。
    if (parents.length === 0) {
        return;
    }
    await Promise.all(parents.map(async (parent, index) => {
        const fileMap: Record<string, Record<string, Set<string>>> = {};
        parentLocalisationFileMaps[index] = fileMap;
        const options = { workspace: false, hoi4: false, recursively: true, parentModUris: [parent] as vscode.Uri[] };
        await buildLocalisationIndexHalf(
            `localisationIndex.parent.${index}`,
            options,
            parentLocalisationIndexes[index]!,
            fileMap,
            estimatedSize,
            progress,
            buildContext,
        );
    }));
}

async function buildLocalisationIndexHalf(
    cacheName: string,
    options: ListFilesOptions,
    targetIndex: LocalisationData,
    fileMap: Record<string, Record<string, Set<string>>> | null,
    estimatedSize: [number],
    progress: IndexProgress,
    context: IndexBuildContext,
): Promise<void> {
    await buildIndexHalf<LocCacheRecord>(
        {
            cacheName,
            version: LOC_CACHE_VERSION,
            cacheScope: context.cacheScope,
            dependencyGeneration: context.dependencyGeneration,
            // A partial rebuild cannot preserve duplicate-key precedence: when two files define the
            // same key, the one parsed last wins, and hydrating the untouched file's cached value
            // first would let it win instead. Any change therefore re-parses the whole half.
            fullRebuildOnAnyChange: true,
            listFiles: (token) =>
                listIndexFiles({
                    roots: [localisationRoot],
                    filter: isLocalisationFile,
                    options: { ...options, token },
                    // A mod with no localisation/ folder at all is ordinary, not a build failure.
                    tolerateRootErrors: true,
                }),
            hydrate: ([langKey, filePath, entries], skipFiles) => {
                if (skipFiles.has(filePath)) {
                    return;
                }
                Object.assign(
                    targetIndex[langKey] ?? (targetIndex[langKey] = {}),
                    entries,
                );
                if (fileMap) {
                    const fileMapForLang = fileMap[langKey] ?? (fileMap[langKey] = {});
                    fileMapForLang[filePath] = new Set(Object.keys(entries));
                }
            },
            parseFile: async (file) => {
                await fillLocalisationItems(
                    file,
                    targetIndex,
                    fileMap,
                    options,
                    estimatedSize,
                );
            },
            // Each value is copied from the index rather than from the file, so a key two files define
            // is cached with the text that won, as it always was.
            serialize: () => {
                const records: LocCacheRecord[] = [];
                for (const langKey in fileMap ?? {}) {
                    const languageIndex = targetIndex[langKey] ?? {};
                    const filesForLang = fileMap?.[langKey] ?? {};
                    for (const filePath in filesForLang) {
                        const entries: Record<string, string> = {};
                        for (const key of filesForLang[filePath] ?? []) {
                            const value = languageIndex[key];
                            if (value !== undefined) {
                                entries[key] = value;
                            }
                        }
                        records.push([langKey, filePath, entries]);
                    }
                }
                return records;
            },
            parseFiles: parseLocalisationFiles,
        },
        progress,
    );
}

/**
 * Runs the parse phase. Fast: the shared queue at its own width. Slow: one file at a time, yielding
 * to the event loop between files so the build never blocks the UI thread; if a focus-tree preview
 * opens mid-build (buildPriority flips to 'fast') the remainder is finished at full concurrency.
 */
async function parseLocalisationFiles(
    files: IndexFile[],
    parseOne: (file: IndexFile) => Promise<void>,
    progress: IndexProgress,
): Promise<void> {
    if (isFastBuild()) {
        await indexParseQueue.map(files, parseOne, { token: progress.token });
        return;
    }

    for (let i = 0; i < files.length; i++) {
        if (isFastBuild()) {
            await indexParseQueue.map(files.slice(i), parseOne, { token: progress.token });
            return;
        }
        await yieldToEventLoop();
        await indexParseQueue.map([files[i]!], parseOne, { token: progress.token });
    }
}

/** Returns whether the file was read and parsed, so a re-index knows not to discard what it has. */
async function fillLocalisationItems(
    localisationFile: IndexFile,
    localisationIndex: LocalisationData,
    fileMap: Record<string, Record<string, Set<string>>> | null,
    options: FileSourceOptions,
    estimatedSize?: [number],
): Promise<boolean> {
    const filePath = localisationFile.path;
    const fileBuffer = await readIndexFileContent('Localisation index', localisationFile, options);
    if (fileBuffer === undefined) {
        return false;
    }
    const content = fileBuffer.toString();

    try {
        const localisations = parseLocalisation(content);
        for (const langKey in localisations) {
            if (!localisationIndex[langKey]) {
                localisationIndex[langKey] = {};
            }

            const languageLocalisations = localisations[langKey] ?? {};
            Object.assign(localisationIndex[langKey], languageLocalisations);

            if (fileMap) {
                if (!fileMap[langKey]) {
                    fileMap[langKey] = {};
                }
                fileMap[langKey][filePath] = new Set(Object.keys(languageLocalisations));
            }

            if (estimatedSize) {
                estimatedSize[0] += Object.keys(languageLocalisations).reduce(
                    (sum, key) => sum + key.length + (languageLocalisations[key] ?? '').length,
                    0,
                );
            }
        }
        return true;
    } catch (e) {
        // This logged only the message, where the focus index logged the stack. Both go through the
        // same reporter now, which prefers the stack.
        reportIndexParseFailure(filePath, options, e);
        return false;
    }
}

const langHeaderRegex = /^\s*(l_[a-z_]+):\s*(?:#.*)?$/i;
// key: optional version number, then the greedy quoted value (preserves embedded quotes, ignores a trailing `# comment`).
const localisationEntryRegex = /^\s*([^\s:#][^:]*):\s*\d*\s*"(.*)"/;

// Parses a HOI4 localisation .yml line by line rather than round-tripping through a YAML parser.
// Each line is independent, so a single malformed entry (e.g. a value with no closing quote) is
// skipped on its own instead of corrupting every entry after it in the same file.
export function parseLocalisation(fileContent: string): LocalisationData {
    const result: LocalisationData = {};
    let currentLang: string | undefined;

    for (const rawLine of fileContent.split(/\r?\n/)) {
        const line = rawLine.replace(/^﻿/, '');
        const trimmed = line.trim();
        if (trimmed === '' || trimmed.startsWith('#')) {
            continue;
        }

        const headerMatch = langHeaderRegex.exec(line);
        if (headerMatch) {
            currentLang = headerMatch[1];
            if (!result[currentLang]) {
                result[currentLang] = {};
            }
            continue;
        }

        if (!currentLang) {
            continue;
        }

        const entryMatch = localisationEntryRegex.exec(line);
        if (entryMatch) {
            const key = entryMatch[1];
            const value = entryMatch[2];
            if (key !== undefined && value !== undefined) {
                const currentLanguage = result[currentLang] ?? (result[currentLang] = {});
                currentLanguage[key.trim()] = value;
            }
        }
    }

    return result;
}

function removeWorkspaceLocalisationFile(relative: string): void {
    for (const langKey of Object.keys(workspaceLocalisationFileMap)) {
        const fileKeys = workspaceLocalisationFileMap[langKey]?.[relative];
        if (fileKeys && workspaceLocalisationIndex[langKey]) {
            for (const key of fileKeys) {
                delete workspaceLocalisationIndex[langKey][key];
            }
            delete workspaceLocalisationFileMap[langKey][relative];
        }
    }
}

/**
 * Re-indexes an edited .yml file: parse first, swap the entry in afterwards. Clearing the entry up
 * front -- what an edit used to do -- left every key the file defines unresolvable for as long as
 * the re-parse took, and a preview refreshing in that window showed raw keys.
 */
async function reindexWorkspaceLocalisationFile(file: vscode.Uri): Promise<void> {
    const relative = toWorkspaceRelativePath(file, 'localisation/');
    if (!relative) {
        return;
    }

    // No URI: a re-index reaches one file, so resolving it the usual way costs nothing. Workspace
    // only: a re-index that fires after the file was deleted must not read the parent's copy into
    // this half, which is the one half the parent's files are never in.
    const parsedIndex: LocalisationData = {};
    const parsedFileMap: Record<string, Record<string, Set<string>>> = {};
    await fillLocalisationItems(
        { path: relative },
        parsedIndex,
        parsedFileMap,
        { workspace: true, parent: false, hoi4: false },
    );

    removeWorkspaceLocalisationFile(relative);
    for (const langKey in parsedIndex) {
        const languageIndex = workspaceLocalisationIndex[langKey] ?? (workspaceLocalisationIndex[langKey] = {});
        Object.assign(languageIndex, parsedIndex[langKey]);
        const fileMapForLang = workspaceLocalisationFileMap[langKey] ?? (workspaceLocalisationFileMap[langKey] = {});
        fileMapForLang[relative] = new Set(Object.keys(parsedIndex[langKey]));
    }
}

// Test-only: clears memoized build state so isolated tests can exercise the lazy-build path.
export function __resetLocalisationIndexForTests(): void {
    builder.reset();
    scheduledBuild = undefined;
    if (slowStartTimer !== undefined) {
        clearTimeout(slowStartTimer);
        slowStartTimer = undefined;
    }
    slowBuildResolve = undefined;
    slowBuildReject = undefined;
    for (const key of Object.keys(globalLocalisationIndex)) {
        delete globalLocalisationIndex[key];
    }
    for (const key of Object.keys(globalLocalisationFileMap)) {
        delete globalLocalisationFileMap[key];
    }
    workspaceLocalisationIndex = {};
    for (const langKey in workspaceLocalisationFileMap) {
        delete workspaceLocalisationFileMap[langKey];
    }
    parentLocalisationIndexes = [];
    parentLocalisationFileMaps.length = 0;
}

// Test-only: exposes the incremental event handlers so tests can drive the build/event race directly.
export const __testHandlers = watchers.handlers;
