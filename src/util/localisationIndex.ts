import * as vscode from 'vscode';
import * as path from 'path';
import { debounceByInput, mapLimit } from './common';
import { localisationIndex } from './featureflags';
import { getFilePathFromModOrHOI4, listFilesFromModOrHOI4, readFileFromModOrHOI4 } from './fileloader';
import { localize } from './i18n';
import { sendEvent } from './telemetry';
import { Logger } from "./logger";
import { ConfigurationKey } from '../constants';
import { loadCacheManifest, loadCacheData, saveCacheManifest, saveCacheData, getFileMtimes, computeStaleFiles, IndexTimer } from './indexCache';
import { getParentModUris, onDidChangeParentMods } from './parentmods';
import { whenModDependenciesSettled } from './moddependencies';

type LocalisationData = Record<string, Record<string, string>>;

const globalLocalisationIndex: LocalisationData = {};
let workspaceLocalisationIndex: LocalisationData = {};
// 每个父模组一份，按设置/依赖里的顺序；查找时工作区覆盖它、它覆盖本体。
let parentLocalisationIndexes: LocalisationData[] = [];

// Tracks which localisation keys came from which file, per language
// langKey -> filePath -> Set<localisationKey>
const workspaceLocalisationFileMap: Record<string, Record<string, Set<string>>> = {};
// 父模组半区的平行表，只在重建时按文件回退用。
const parentLocalisationFileMaps: Record<string, Record<string, Set<string>>>[] = [];

// Mapping of language ISO codes to yml file language suffixes
const localeMapping: Record<string, string> = {
    'en': 'l_english',
    'pt-br': 'l_braz_por',
    'de': 'l_german',
    'fr': 'l_french',
    'es': 'l_spanish',
    'pl': 'l_polish',
    'ru': 'l_russian',
    'ja': 'l_japanese',
    'zh-cn': 'l_simp_chinese',
};

// Mapping of language profiles to language ISO codes
const localeISOMapping: Record<string, string> = {
    ['Brazilian Portuguese']: 'pt-br',
    English: 'en',
    French: 'fr',
    German: 'de',
    Japanese: 'ja',
    Polish: 'pl',
    Russian: 'ru',
    ['Simplified Chinese']: 'zh-cn',
    Spanish: 'es',
};

export function registerLocalisationIndex(): vscode.Disposable {
    const disposables: vscode.Disposable[] = [];
    if (localisationIndex) {
        // Build the index up-front. If a focus-tree preview is already open in this window (e.g.
        // restored by the workspace) build it immediately at full speed; otherwise build it lazily
        // in the background (delayed, low-priority) so a big first build never stalls VSCode startup.
        // Opening a focus-tree preview later upgrades the background build to the fast path via
        // notifyFocusTreePreviewOpened (see the FocusTreePreview constructor).
        buildPriority = hasActiveFocusTreePreview() ? 'fast' : 'slow';
        void ensureLocalisationIndex();
        disposables.push(vscode.workspace.onDidChangeWorkspaceFolders(onChangeWorkspaceFolders));
        disposables.push(vscode.workspace.onDidChangeTextDocument(onChangeTextDocument));
        disposables.push(vscode.workspace.onDidCloseTextDocument(onCloseTextDocument));
        disposables.push(vscode.workspace.onDidCreateFiles(onCreateFiles));
        disposables.push(vscode.workspace.onDidDeleteFiles(onDeleteFiles));
        disposables.push(vscode.workspace.onDidRenameFiles(onRenameFiles));
        // 父模组名单变化：只重建这半个索引（缓存键按父模组序号分开，重建不牵动工作区与本体）。
        disposables.push(onDidChangeParentMods(e => {
            if (!e.folders) {
                return;
            }
            const estimatedSize: [number] = [0];
            void buildParentLocalisationIndexes(estimatedSize, buildPriority).then(
                () => undefined,
                (e2) => Logger.error(`[Localisation] rebuilding the parent half failed: ${String(e2)}`),
            );
        }));
    }

    return vscode.Disposable.from(...disposables);
}

// Shared size counter for the telemetry of the fast build. The background slow build stays silent
// on purpose (it must not interrupt the user during VSCode startup).
const localisationIndexSize: [number] = [0];
let localisationIndexBuildPromise: Promise<void> | undefined;

// --- Lazy build scheduling -----------------------------------------------
// The index is built once. With no focus-tree preview open it is built as a slow background task
// (delayed start, one file at a time, yielding to the event loop between files) so a large first
// build never stalls VSCode startup. Opening a focus-tree preview flips the build to the fast path:
// a slow build that is still in its start delay is cancelled and restarted immediately, and a slow
// build already parsing files finishes the remainder at full concurrency. The focus-tree ID/name
// toggle (sendFocusNames) also drives this build on demand, so switching a tree to localised names
// works even without the localisationIndex setting being enabled.
const SLOW_BUILD_START_DELAY_MS = 3000;
const LOCALISATION_PARSE_CONCURRENCY_FAST = 8;

type BuildPriority = 'fast' | 'slow';

let buildPriority: BuildPriority = 'slow';
let activeFocusTreePreviewCount = 0;
let slowStartTimer: NodeJS.Timeout | undefined;
let slowBuildResolve: (() => void) | undefined;
let slowBuildReject: ((e: unknown) => void) | undefined;

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
                void buildLocalisationIndexes('fast').then(resolve, reject);
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
// the upgrade path).
export function ensureLocalisationIndex(): Promise<void> {
    if (localisationIndexBuildPromise === undefined) {
        localisationIndexBuildPromise = scheduleBuild();
    }
    return localisationIndexBuildPromise;
}

function scheduleBuild(): Promise<void> {
    if (buildPriority === 'fast') {
        return buildLocalisationIndexes('fast');
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
            void buildLocalisationIndexes('slow').then(resolve, reject);
        }, SLOW_BUILD_START_DELAY_MS);
    });
}

function buildLocalisationIndexes(priority: BuildPriority): Promise<void> {
    const estimatedSize: [number] = [0];
    const task = Promise.all([
        buildGlobalLocalisationIndex(estimatedSize, priority),
        buildParentLocalisationIndexes(estimatedSize, priority),
        buildWorkspaceLocalisationIndex(estimatedSize, priority),
    ]).then(() => {
        localisationIndexSize[0] = estimatedSize[0];
    });
    if (priority === 'fast') {
        vscode.window.setStatusBarMessage('$(loading~spin) ' + localize('localisationIndex.building', 'Building Localisation index...'), task);
        void task.then(() => {
            vscode.window.showInformationMessage(localize('localisationIndex.builddone', 'Building Localisation index done.'));
            sendEvent('localisationIndex', {size: localisationIndexSize[0].toString()});
        });
    }
    return task;
}

function yieldToEventLoop(): Promise<void> {
    return new Promise(resolve => {
        if (typeof setImmediate === 'function') {
            setImmediate(resolve);
        } else {
            setTimeout(resolve, 0);
        }
    });
}

export function getLocalisedTextQuick(localisationKey: string | undefined): string | undefined {
    const previewLocalisation = vscode.workspace.getConfiguration(ConfigurationKey).previewLocalisation;
    if (previewLocalisation){
        return getLocalisedText(localisationKey, localeISOMapping[previewLocalisation]?? vscode.env.language);
    }
    return getLocalisedText(localisationKey, vscode.env.language);
}

// Shared lookup: editor-language first, then l_english fallback. `getLocalisedText` gates this on
// the localisationIndex feature flag (its index is not built without it); the unchecked variant
// is for callers that have built the index on demand (e.g. the focus-tree name toggle).
function lookupLocalisedText(localisationKey: string, language: string): string | undefined {
    const langKey = localeMapping[language.toLowerCase()] || 'l_english'; // use mapping to get language suffix
    const defaultLangKey = 'l_english';

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

const LOC_CACHE_VERSION = 1;
const langSuffixes = Object.values(localeMapping);
const langSuffixPattern = langSuffixes.join('|');
const localisationFileFilter = new RegExp(`.*_(${langSuffixPattern})\\.yml$`, 'i');

interface LocCacheData {
    index: LocalisationData;
    fileMap: Record<string, Record<string, string[]>>; // langKey -> filePath -> keys[]
}

async function buildGlobalLocalisationIndex(estimatedSize: [number], priority: BuildPriority): Promise<void> {
    const options = {mod: false, hoi4: true, recursively: true};
    const localisationFiles = (await listFilesFromModOrHOI4('localisation', options)).filter(f => localisationFileFilter.test(f)).map(f => 'localisation/' + f);
    await buildLocalisationIndexWithCache('localisationIndex.global', localisationFiles, globalLocalisationIndex, null, options, estimatedSize, priority);
}

async function buildWorkspaceLocalisationIndex(estimatedSize: [number], priority: BuildPriority): Promise<void> {
    const options = {mod: true, hoi4: false, recursively: true};
    const localisationFiles = (await listFilesFromModOrHOI4('localisation', options)).filter(f => localisationFileFilter.test(f)).map(f => 'localisation/' + f);
    await buildLocalisationIndexWithCache('localisationIndex.workspace', localisationFiles, workspaceLocalisationIndex, workspaceLocalisationFileMap, options, estimatedSize, priority);
}

// 父模组各占一份索引，理由与 GFX 索引相同：工作区覆盖父模组、父模组覆盖本体，各自一份才能让缓存键
// 互不干扰。名单变化时只重建这半个索引。
async function buildParentLocalisationIndexes(estimatedSize: [number], priority: BuildPriority): Promise<void> {
    await whenModDependenciesSettled();
    const parents = getParentModUris();
    parentLocalisationIndexes = parents.map(() => ({}));
    parentLocalisationFileMaps.length = parents.length;
    if (parents.length === 0) {
        // 没有父模组就没有这半个索引：不列举、不写缓存。
        return;
    }
    await Promise.all(parents.map(async (parent, index) => {
        const options = { mod: false, hoi4: false, recursively: true, parentModUris: [parent] as vscode.Uri[] };
        const localisationFiles = (await listFilesFromModOrHOI4('localisation', options)).filter(f => localisationFileFilter.test(f)).map(f => 'localisation/' + f);
        parentLocalisationFileMaps[index] = {};
        await buildLocalisationIndexWithCache(`localisationIndex.parent.${index}`, localisationFiles, parentLocalisationIndexes[index]!, parentLocalisationFileMaps[index]!, options, estimatedSize, priority);
    }));
}

// Runs the file-parse phase. Fast: all files in parallel (8-way, like the original eager build).
// Slow: one file at a time, yielding to the event loop between files so the build never blocks the
// UI thread; if a focus-tree preview opens mid-build (buildPriority flips to 'fast') the remainder
// is finished at full concurrency.
async function parseLocalisationFiles(
    files: string[],
    targetIndex: LocalisationData,
    fileMap: Record<string, Record<string, Set<string>>> | null,
    options: { mod?: boolean; hoi4?: boolean },
    estimatedSize: [number],
    priority: BuildPriority,
): Promise<void> {
    if (priority === 'fast' || isFastBuild()) {
        await mapLimit(files, LOCALISATION_PARSE_CONCURRENCY_FAST, f => fillLocalisationItems(f, targetIndex, fileMap, options, estimatedSize));
        return;
    }
    for (let i = 0; i < files.length; i++) {
        if (isFastBuild()) {
            await mapLimit(files.slice(i), LOCALISATION_PARSE_CONCURRENCY_FAST, f => fillLocalisationItems(f, targetIndex, fileMap, options, estimatedSize));
            return;
        }
        await yieldToEventLoop();
        await fillLocalisationItems(files[i], targetIndex, fileMap, options, estimatedSize);
    }
}

async function buildLocalisationIndexWithCache(
    cacheName: string,
    locFiles: string[],
    targetIndex: LocalisationData,
    fileMap: Record<string, Record<string, Set<string>>> | null,
    options: { mod?: boolean; hoi4?: boolean },
    estimatedSize: [number],
    priority: BuildPriority
): Promise<void> {
    const timer = new IndexTimer(cacheName);
    const resolveUri = (relativePath: string) => getFilePathFromModOrHOI4(relativePath, options);
    const currentMtimes = await getFileMtimes(locFiles, resolveUri);
    timer.mark('mtime');

    const manifest = await loadCacheManifest(cacheName, LOC_CACHE_VERSION);
    let filesToParse = locFiles;

    if (manifest) {
        const staleness = computeStaleFiles(manifest, currentMtimes);
        const cachedData = await loadCacheData(cacheName);

        if (cachedData && staleness.stale.length + staleness.removed.length + staleness.added.length < locFiles.length) {
            try {
                const cached: LocCacheData = JSON.parse(cachedData);
                const skipFiles = new Set([...staleness.stale, ...staleness.removed]);

                for (const langKey in cached.index) {
                    if (!targetIndex[langKey]) {
                        targetIndex[langKey] = {};
                    }
                    const fileKeysForLang = cached.fileMap?.[langKey] ?? {};
                    for (const filePath in fileKeysForLang) {
                        if (!skipFiles.has(filePath)) {
                            const keys = fileKeysForLang[filePath];
                            for (const key of keys) {
                                if (cached.index[langKey][key] !== undefined) {
                                    targetIndex[langKey][key] = cached.index[langKey][key];
                                }
                            }
                            if (fileMap) {
                                if (!fileMap[langKey]) {
                                    fileMap[langKey] = {};
                                }
                                fileMap[langKey][filePath] = new Set(keys);
                            }
                        }
                    }
                }

                filesToParse = [...staleness.stale, ...staleness.added];
            } catch {
                Logger.warn(`${cacheName}: cache data corrupted, full rebuild`);
                filesToParse = locFiles;
            }
        }
    }

    // Self-heal against a corrupted cache pair (a data file written empty next to a full
    // manifest, e.g. by an interrupted write): the cache hit above then yields an empty index
    // with nothing left to parse, and every later build would stay empty forever. Detect that
    // state and force a full reparse instead.
    const cachedIndexKeyCount = Object.values(targetIndex).reduce((sum, lang) => sum + Object.keys(lang).length, 0);
    if (manifest && filesToParse.length === 0 && cachedIndexKeyCount === 0 && locFiles.length > 0) {
        Logger.warn(`${cacheName}: cache data is empty while the manifest lists ${locFiles.length} files; rebuilding from scratch`);
        filesToParse = locFiles;
    }
    timer.mark('cache');

    await parseLocalisationFiles(filesToParse, targetIndex, fileMap, options, estimatedSize, priority);
    timer.mark('parse');
    timer.log(locFiles.length, filesToParse.length);

    // Serialize Sets to arrays for JSON cache
    const serializedFileMap: Record<string, Record<string, string[]>> = {};
    if (fileMap) {
        for (const langKey in fileMap) {
            serializedFileMap[langKey] = {};
            for (const filePath in fileMap[langKey]) {
                serializedFileMap[langKey][filePath] = [...fileMap[langKey][filePath]];
            }
        }
    }
    // Never persist an empty index next to a full manifest: that pair makes every later build
    // trust the empty cache and skip parsing entirely (see the self-heal above).
    const indexKeyCount = Object.values(targetIndex).reduce((sum, lang) => sum + Object.keys(lang).length, 0);
    if (locFiles.length > 0 && indexKeyCount === 0) {
        Logger.warn(`${cacheName}: parsed ${locFiles.length} files but produced no entries; cache not saved`);
        return;
    }
    const cacheData: LocCacheData = { index: targetIndex, fileMap: serializedFileMap };
    // fire-and-forget: write data before manifest for atomicity
    void Promise.all([
        saveCacheData(cacheName, JSON.stringify(cacheData)),
        saveCacheManifest(cacheName, locFiles, currentMtimes, LOC_CACHE_VERSION),
    ]).catch(e => Logger.error(`Cache save failed for ${cacheName}: ${e}`));
}

async function fillLocalisationItems(localisationFile: string, localisationIndex: LocalisationData, fileMap: Record<string, Record<string, Set<string>>> | null, options: {
    mod?: boolean,
    hoi4?: boolean
}, estimatedSize?: [number]): Promise<void> {
    const [fileBuffer] = await readFileFromModOrHOI4(localisationFile, options);
    const content = fileBuffer.toString();
    try {
        const localisations = parseLocalisation(content);
        for (const langKey in localisations) {
            if (!localisationIndex[langKey]) {
                localisationIndex[langKey] = {};
            }

            Object.assign(localisationIndex[langKey], localisations[langKey]);

            if (fileMap) {
                if (!fileMap[langKey]) {
                    fileMap[langKey] = {};
                }
                fileMap[langKey][localisationFile] = new Set(Object.keys(localisations[langKey]));
            }

            if (estimatedSize) {
                estimatedSize[0] += Object.keys(localisations[langKey]).reduce((sum, key) => sum + key.length + localisations[langKey][key].length, 0);
            }
        }
    } catch (e) {
        console.log(localisationFile);
        console.log(content);
        console.error(e);

        const baseMessage = options.hoi4
            ? localize('localisationIndex.vanilla','[Vanilla]')
            : localize('localisationIndex.mod','[mod]');

        const failureMessage = localize('localisationIndex.parseFailure','parsing failed! Please check if the file has issues!');

        if ((e as { name?: string } | null)?.name === 'YAMLException') {
            Logger.error(`${baseMessage} ${localisationFile} ${failureMessage}\n${(e as Error).message}`);
        } else {
            Logger.error(`${baseMessage} ${localisationFile} ${failureMessage}`);
        }
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
            result[currentLang][entryMatch[1].trim()] = entryMatch[2];
        }
    }

    return result;
}

function onChangeWorkspaceFolders(_: vscode.WorkspaceFoldersChangeEvent) {
    workspaceLocalisationIndex = {};
    for (const langKey in workspaceLocalisationFileMap) {
        delete workspaceLocalisationFileMap[langKey];
    }
    const estimatedSize: [number] = [0];
    const task = buildWorkspaceLocalisationIndex(estimatedSize, 'fast');
    vscode.window.setStatusBarMessage('$(loading~spin) ' + localize('localisationIndex.workspace.building', 'Building workspace Localisation index...'), task);
    void task.then(() => {
        vscode.window.showInformationMessage(localize('localisationIndex.workspace.builddone', 'Building workspace Localisation index done.'));
        sendEvent('localisationIndex.workspace', {size: estimatedSize[0].toString()});
    });
}

function onChangeTextDocument(e: vscode.TextDocumentChangeEvent) {
    const file = e.document.uri;
    if (file.path.endsWith('.yml')) {
        onChangeTextDocumentImpl(file);
    }
}

const onChangeTextDocumentImpl = debounceByInput(
    (file: vscode.Uri) => {
        removeWorkspaceLocalisationIndex(file);
        addWorkspaceLocalisationIndex(file);
    },
    file => file.toString(),
    1000,
    {trailing: true}
);

function onCloseTextDocument(document: vscode.TextDocument) {
    const file = document.uri;
    if (file.path.endsWith('.yml') && document.isDirty) {
        removeWorkspaceLocalisationIndex(file);
        addWorkspaceLocalisationIndex(file);
    }
}

function onCreateFiles(e: vscode.FileCreateEvent) {
    for (const file of e.files) {
        if (file.path.endsWith('.yml')) {
            addWorkspaceLocalisationIndex(file);
        }
    }
}

function onDeleteFiles(e: vscode.FileDeleteEvent) {
    for (const file of e.files) {
        if (file.path.endsWith('.yml')) {
            removeWorkspaceLocalisationIndex(file);
        }
    }
}

function onRenameFiles(e: vscode.FileRenameEvent) {
    onDeleteFiles({files: e.files.map(f => f.oldUri)});
    onCreateFiles({files: e.files.map(f => f.newUri)});
}

function removeWorkspaceLocalisationIndex(file: vscode.Uri) {
    const wsFolder = vscode.workspace.getWorkspaceFolder(file);
    if (wsFolder) {
        const relative = path.relative(wsFolder.uri.path, file.path).replace(/\\+/g, '/');
        if (relative && relative.startsWith('localisation/')) {
            const langKey = getLangKeyFromPath(relative);
            const fileKeys = workspaceLocalisationFileMap[langKey]?.[relative];
            if (fileKeys && workspaceLocalisationIndex[langKey]) {
                for (const key of fileKeys) {
                    delete workspaceLocalisationIndex[langKey][key];
                }
                delete workspaceLocalisationFileMap[langKey][relative];
            }
        }
    }
}

function addWorkspaceLocalisationIndex(file: vscode.Uri) {
    const wsFolder = vscode.workspace.getWorkspaceFolder(file);
    if (wsFolder) {
        const relative = path.relative(wsFolder.uri.path, file.path).replace(/\\+/g, '/');
        if (relative && relative.startsWith('localisation/')) {
            void fillLocalisationItems(relative, workspaceLocalisationIndex, workspaceLocalisationFileMap, {hoi4: false});
        }
    }
}

function getLangKeyFromPath(filePath: string): string {
    const match = filePath.match(localisationFileFilter);
    return match ? match[1] : 'l_english';
}