import * as vscode from 'vscode';
import { FocusTree, Focus, FocusTreeShortcut, focusTreesToDisplay, getGfxNameForSearchFilter } from './schema';
import { getSpriteByGfxName, Image, getImageByPath, iconResolveStats, resetIconResolveStats, Sprite } from '../../util/image/imagecache';
import { localize, i18nTableAsScript } from '../../util/i18n';
import { forceError, randomString, mapLimit } from '../../util/common';
import { HOIPartial, toNumberLike, toStringAsSymbolIgnoreCase } from '../../hoiformat/schema';
import { html, htmlEscape, escapeAttr, previewedFileUriScript } from '../../util/html';
import { GridBoxType, IconType, ButtonType, InstantTextBoxType } from '../../hoiformat/gui';
import { FocusTreeLoader, ProgressCallback } from './loader';
import { LoaderSession } from '../../util/loader/loader';
import { debug, error } from '../../util/debug';
import { StyleTable, normalizeForStyle } from '../../util/styletable';
import { useConditionInFocus, focusTreePrerequisiteLines, localisationIndex } from '../../util/featureflags';
import { flatMap, chain } from 'lodash';
import { getFocusTitlebarImage, getFocusOverlayImage, loadFocusTitlebarStyles, resolveTitlebarGfxName } from "./titlebar";
import { FocusItemLayout, FocusShortcutGui, FocusTreeLayout, focusTreeGridBoxFor, standardFocusTreeLayout } from "./layout";
import { registerExclusiveLinkStyles } from "../../util/hoi4gui/exclusivelink";
import { loadExclusiveLinkImages, nationalFocusViewGfxFile } from "../../util/hoi4gui/exclusivelinkimages";
import { registerFocusLinkStyles } from "../../util/hoi4gui/focuslink";
import { loadFocusLinkImages } from "../../util/hoi4gui/focuslinkimages";
import { registerWarningStyles, warningListClass } from "./warningstyles";
import { registerTraceStyles } from "./tracestyles";
import { iconButtonHtml, iconClassOf } from "../toolbaricons";
import { renderContainerWindow, RenderChildTypeMap } from "../../util/hoi4gui/containerwindow";
import { calculateBBox, ParentInfo } from "../../util/hoi4gui/common";
import { renderInstantTextBox } from "../../util/hoi4gui/instanttextbox";
import { renderSprite } from "../../util/hoi4gui/nodecommon";
import { getLocalisedTextQuick } from "../../util/localisationIndex";

const defaultFocusIcon = 'gfx/interface/goals/goal_unknown.dds';

// Caps how many focus/inlay renders run concurrently.
const renderConcurrency = 8;

export interface FocusTreeUpdatePayload {
    focusTrees: FocusTree[];
    renderedFocus: Record<string, string>;
    renderedInlayWindows: Record<string, string>;
    gridBox: HOIPartial<GridBoxType>;
    useConditionInFocus: boolean;
    xGridSize: number;
    // 棋盘与各图层偏移的来源；网页端用它铺连线贴图、定位 continuous 框与初始视图。
    layout: FocusTreeLayout;
    // 每棵树的快捷键按钮，按树索引、再按快捷键索引。放在树旁边而不是树里，解析出的树对象正是
    // 部分更新指纹取用的那一份。
    renderedShortcuts: string[][];
    // 折叠快捷键按钮的按钮内容。
    renderedShortcutToggle: string;
}

export interface FocusTreePayload extends FocusTreeUpdatePayload {
    styleTable: StyleTable;
    styleNonce: string;
    toolbarFlags: ToolbarFlags;
    gfxFiles: string[];
}

export type { ToolbarFlags };

export async function buildFocusTreePayload(loader: FocusTreeLoader, progress?: ProgressCallback, options?: { resolveIcons?: boolean; dependencyChanged?: boolean }): Promise<FocusTreePayload | null> {
    const resolveIcons = options?.resolveIcons !== false;
    try {
        // Per-phase timing of parsing/loading, icon resolution, and DDS->PNG conversion, logged via debug() in dev builds.
        resetIconResolveStats();
        const tStart = Date.now();

        // 依赖变更（覆盖层 gfx 清单的设置或 .mod 列表、连线贴图文件等）必须把强制开关传进会话，
        // 否则 loader 按未变的文本哈希返回依赖变更前读到的结果。
        const session = new LoaderSession(options?.dependencyChanged ?? false);
        const loadResult = await loader.load(session);
        debug('Loader session focus tree', session.loadedLoaderNames());
        const tLoaded = Date.now();

        const focusTrees = focusTreesToDisplay(loadResult.result.focusTrees);
        if (focusTrees.length === 0) {
            return null;
        }

        const layout = loadResult.result.layout ?? standardFocusTreeLayout;
        const styleTable = new StyleTable();
        const styleNonce = randomString(32);
        const renderedFocus: Record<string, string> = {};
        const renderedInlayWindows: Record<string, string> = {};

        const titlebarStyles = await loadFocusTitlebarStyles();

        // 两遍渲染都注册：贴图未解析时类下退化为纯色线，结构遍也照画互斥连线。
        const exclusiveLinkImages = !resolveIcons ? undefined : layout.mode === 'gui'
            ? await loadExclusiveLinkImages(layout.exclusive.sprites, [nationalFocusViewGfxFile, ...loadResult.result.gfxFiles])
            : await loadExclusiveLinkImages();
        registerExclusiveLinkStyles(styleTable, exclusiveLinkImages, layout.spacing.x, {
            startX: layout.exclusive.startX,
            endX: layout.exclusive.endX,
            y: layout.exclusive.offsetY,
        }, layout.spacing.y, {
            // 压过 z-index 3 的名条与复选框，连线在名条行会横穿焦点。
            zIndex: 4,
            gapUnderMid: true,
            clampToCentre: true,
        });

        // 前置连线同样两遍注册：网页端怎么都是画同一批贴图。
        const focusLinkState = focusTreePrerequisiteLines;
        const focusLinkImages = !resolveIcons ? undefined : layout.mode === 'gui'
            ? await loadFocusLinkImages(layout.prerequisiteLink.sprites, [nationalFocusViewGfxFile, ...loadResult.result.gfxFiles], focusLinkState)
            : await loadFocusLinkImages(undefined, undefined, focusLinkState);
        registerFocusLinkStyles(styleTable, focusLinkImages, focusLinkState);

        const allFocuses = flatMap(focusTrees, tree => Object.values(tree.focuses));
        const focusMessage = localize('focustree.loading.rendering_focuses', 'Rendering focuses');
        if (progress && allFocuses.length > 0) {
            progress(focusMessage, 0, allFocuses.length);
        }
        let renderedFocusCount = 0;
        await mapLimit(allFocuses, renderConcurrency, async (focus) => {
            renderedFocus[focus.id] = (await renderFocus(focus, styleTable, loadResult.result.gfxFiles, loadResult.result.overlayGfxFiles, loader.file, titlebarStyles, layout.item, resolveIcons)).replace(/\s\s+/g, ' ');
            renderedFocusCount++;
            if (progress) {
                progress(focusMessage, renderedFocusCount, allFocuses.length);
            }
        });
        const tRendered = Date.now();

        if (progress) {
            progress(localize('focustree.loading.preparing_inlay_styles', 'Preparing inlay styles'));
        }
        await prepareInlayGfxStyles(focusTrees, styleTable);

        const allInlays = flatMap(focusTrees, tree => tree.inlayWindows);
        const inlayMessage = localize('focustree.loading.rendering_inlays', 'Rendering inlay windows');
        if (progress && allInlays.length > 0) {
            progress(inlayMessage, 0, allInlays.length);
        }
        let renderedInlayCount = 0;
        await mapLimit(allInlays, renderConcurrency, async (inlay) => {
            renderedInlayWindows[inlay.id] = (await renderInlayWindow(inlay, styleTable, loadResult.result.gfxFiles)).replace(/\s\s+/g, ' ');
            renderedInlayCount++;
            if (progress) {
                progress(inlayMessage, renderedInlayCount, allInlays.length);
            }
        });
        const tInlay = Date.now();

        debug(`[focustree] timing: load=${tLoaded - tStart}ms focusRender=${tRendered - tLoaded}ms ` +
            `inlayRender=${tInlay - tRendered}ms | focuses=${allFocuses.length} ` +
            `indexMiss=${iconResolveStats.indexMiss} scanIters=${iconResolveStats.scanIterations} ` +
            `gfxMapParses=${iconResolveStats.gfxMapParses} ` +
            `imageDecodes=${iconResolveStats.imageDecodes} decodeTime=${iconResolveStats.imageDecodeMs}ms`);

        const toolbarFlags: ToolbarFlags = {
            // A focus without text_icon still renders its frame through the default_style titlebar,
            // so the toggle must appear whenever any focus can resolve a titlebar (explicit or fallback).
            hasCustomTitlebar: focusTrees.some(ft => Object.values(ft.focuses).some(f => resolveTitlebarGfxName(f.textIcon, titlebarStyles) !== undefined)),
            hasFocusOverlay: focusTrees.some(ft => Object.values(ft.focuses).some(f => f.overlay !== undefined)),
            hasInlayWindows: focusTrees.some(ft => ft.inlayWindows.length > 0),
            hasWarnings: focusTrees.some(ft => ft.warnings.length > 0),
        };

        const shortcutGui = loadResult.result.shortcutGui;
        const renderedShortcuts: string[][] = [];
        for (const tree of focusTrees) {
            const items: string[] = [];
            for (const [index, shortcut] of (tree.shortcuts ?? []).entries()) {
                items.push((await renderShortcut(shortcut, index, tree, shortcutGui?.item, styleTable, loadResult.result.gfxFiles, resolveIcons)).replace(/\s\s+/g, ' '));
            }
            renderedShortcuts.push(items);
        }
        const renderedShortcutToggle = await renderShortcutToggle(shortcutGui, styleTable, loadResult.result.gfxFiles);

        return {
            focusTrees,
            renderedFocus,
            renderedInlayWindows,
            gridBox: focusTreeGridBoxFor(layout),
            useConditionInFocus,
            xGridSize: layout.spacing.x,
            layout,
            renderedShortcuts,
            renderedShortcutToggle,
            styleTable,
            styleNonce,
            toolbarFlags,
            gfxFiles: loadResult.result.gfxFiles,
        };
    } catch (e) {
        error(e);
        return null;
    }
}

/**
 * Parses the focus trees only, skipping the expensive per-focus/inlay HTML and style rendering that
 * buildFocusTreePayload does. The partial-update early-out uses this to fingerprint structure cheaply.
 * Because it shares the loader's content-hash cache, a same-tick buildFocusTreePayload reuses this parse
 * instead of re-parsing, so the fall-through path never double-parses. Returns null when empty or on error.
 * The layout comes back too so the early-out fingerprints the same grid a full payload would carry.
 */
export async function loadFocusTreesOnly(loader: FocusTreeLoader, dependencyChanged = false): Promise<{ focusTrees: FocusTree[]; layout: FocusTreeLayout } | null> {
    try {
        const r = await loader.load(new LoaderSession(dependencyChanged));
        const focusTrees = focusTreesToDisplay(r.result.focusTrees);
        return focusTrees.length
            ? { focusTrees, layout: r.result.layout ?? standardFocusTreeLayout }
            : null;
    } catch {
        return null;
    }
}

/**
 * Builds the final preview HTML from an already-computed payload. This reuses the
 * focuses/inlays rendered by buildFocusTreePayload instead of rendering them a second
 * time, halving the heavy image work on the initial load.
 */
export async function buildFocusTreeHtml(payload: FocusTreePayload, webview: vscode.Webview, uri: vscode.Uri): Promise<string> {
    const jsCodes: string[] = [];
    jsCodes.push('window.focusTrees = ' + JSON.stringify(payload.focusTrees));
    jsCodes.push('window.renderedFocus = ' + JSON.stringify(payload.renderedFocus));
    jsCodes.push('window.renderedInlayWindows = ' + JSON.stringify(payload.renderedInlayWindows));
    jsCodes.push('window.renderedShortcuts = ' + JSON.stringify(payload.renderedShortcuts));
    jsCodes.push('window.gridBox = ' + JSON.stringify(payload.gridBox));
    if (payload.layout.links) {
        jsCodes.push('window.focusLinkOffsets = ' + JSON.stringify(payload.layout.links));
    }
    jsCodes.push('window.focusLinkTiles = ' + JSON.stringify(payload.layout.prerequisiteLink));
    if (payload.layout.center) {
        jsCodes.push('window.focusTreeCenter = ' + JSON.stringify(payload.layout.center));
    }
    jsCodes.push('window.continuousFocusSize = ' + JSON.stringify(payload.layout.continuous));
    jsCodes.push('window.styleNonce = ' + JSON.stringify(payload.styleNonce));
    jsCodes.push('window.useConditionInFocus = ' + payload.useConditionInFocus);
    jsCodes.push('window.xGridSize = ' + payload.xGridSize);
    jsCodes.push(i18nTableAsScript());

    const baseContent = await renderFocusTreeShell(payload.focusTrees, payload.styleTable, payload.toolbarFlags, payload.styleNonce, payload.gfxFiles, payload.layout, payload.renderedShortcutToggle);

    return html(
        webview,
        baseContent,
        [
            previewedFileUriScript(uri),
            ...jsCodes.map(c => ({ content: c })),
            'common.js',
            'focustree.js',
        ],
        [
            'codicon.css',
            'common.css',
            payload.styleTable,
            { nonce: payload.styleNonce },
        ],
    );
}

/** HTML shown when the file legitimately contains no focus tree. */
export function buildNoFocusTreeHtml(webview: vscode.Webview, uri: vscode.Uri): string {
    const baseContent = localize('focustree.nofocustree', 'No focus tree.');
    return html(webview, baseContent, [ previewedFileUriScript(uri) ], []);
}

/**
 * Recoverable error/timeout panel. Shows a message plus a Reload button so the user is
 * never stuck in a dead loading spinner when a render is too slow or fails.
 */
export function buildFocusTreeErrorHtml(webview: vscode.Webview, uri: vscode.Uri, e: unknown): string {
    const reloadScript = {
        content: `(function(){
            var api = acquireVsCodeApi();
            var btn = document.getElementById('ft-reload');
            if (btn) { btn.addEventListener('click', function(){ api.postMessage({ command: 'reload' }); }); }
        })();`,
    };
    const message = htmlEscape(forceError(e).toString());
    const reloadLabel = htmlEscape(localize('focustree.reload', 'Reload'));
    const title = htmlEscape(localize('focustree.loading.slow_title', 'The focus tree is taking too long to render (large file or low memory).'));
    const baseContent = `<div style="padding:16px; font:13px var(--vscode-font-family); color:var(--vscode-foreground);">
        <p>${title}</p>
        <pre style="white-space:pre-wrap; opacity:0.8;">${message}</pre>
        <button id="ft-reload">${reloadLabel}</button>
    </div>`;
    return html(webview, baseContent, [ previewedFileUriScript(uri), reloadScript ], []);
}

/**
 * Renders the static page shell (dragger, content placeholders, warnings container,
 * toolbar). Focuses and inlays themselves are rendered separately into the payload and
 * injected by the webview, so this is a cheap synchronous step.
 */
async function renderFocusTreeShell(focusTrees: FocusTree[], styleTable: StyleTable, toolbarFlags: ToolbarFlags, styleNonce: string, gfxFiles: string[], layout: FocusTreeLayout, shortcutToggle: string): Promise<string> {
    // Same reason as registerWarningStyles below: the shell stylesheet is the only one the webview
    // can still attach classes against after a render. See tracestyles.ts.
    registerTraceStyles(styleTable);

    // Set by the webview while the continuous focus box can be dragged.
    styleTable.raw(`#continuousFocuses.continuous-editable`, `
        pointer-events: auto;
        cursor: move;
        outline: 1px dashed var(--vscode-focusBorder, #007fd4);
    `);

    // CSP-nonced <style> element the webview later fills with the resolved focus-icon background CSS.
    const progressiveIconStyles = `<style id="ft-progressive-icons" nonce="${styleNonce}"></style>`;
    const continuousFocusContent =
        `<div id="continuousFocuses" class="${styleTable.oneTimeStyle('continuousFocuses', () => `
            position: absolute;
            width: ${layout.continuous.width}px;
            height: ${layout.continuous.height}px;
            margin: 20px;
            background: rgba(128, 128, 128, 0.2);
            text-align: center;
            pointer-events: none;
        `)}">Continuous focuses</div>`;

    return (
        progressiveIconStyles +
        `<div id="dragger" class="${styleTable.oneTimeStyle('dragger', () => `
            width: 100vw;
            height: 100vh;
            position: fixed;
            left:0;
            top:0;
        `)}"></div>` +
        `<div id="focustreecontent" class="${styleTable.oneTimeStyle('focustreecontent', () => `top:80px;left:-20px;position:relative;user-select:none;-webkit-user-select:none;`)}">
            <div id="focustreeplaceholder"></div>
            <div id="inlaywindowplaceholder"></div>
            ${continuousFocusContent}
        </div>` +
        renderWarningContainer(styleTable) +
        renderShortcutOverlay(styleTable, shortcutToggle) +
        await renderToolBar(focusTrees, styleTable, toolbarFlags, gfxFiles)
    );
}

interface ToolbarFlags {
    hasCustomTitlebar: boolean;
    hasFocusOverlay: boolean;
    hasInlayWindows: boolean;
    // Warning buttons live in the baked toolbar, so a 0 -> 1+ warning transition must take the
    // full-reload path instead of the in-place structure update (see toolbarFlagsEqual).
    hasWarnings: boolean;
}

// The toolbar is part of the baked-in shell, so any change to which controls it shows (including
// the 0 -> 1+ warning transition that adds the warning buttons) has to go through a full reload.
// Exported so the reload trigger is locked by tests.
export function toolbarFlagsEqual(a: ToolbarFlags | undefined, b: ToolbarFlags | undefined): boolean {
    if (a === undefined || b === undefined) { return a === b; }
    return a.hasCustomTitlebar === b.hasCustomTitlebar &&
        a.hasFocusOverlay === b.hasFocusOverlay &&
        a.hasInlayWindows === b.hasInlayWindows &&
        a.hasWarnings === b.hasWarnings;
}

function renderWarningContainer(styleTable: StyleTable) {
    // 警告标记与警告条目的类名必须在外壳样式表里注册，网页端才能随时把类挂到新渲染的焦点上。
    // 见 warningstyles.ts 的时序说明。
    registerWarningStyles(styleTable);
    return `
    <div id="warnings-container" class="${styleTable.style('warnings-container', () => `
        height: 100vh;
        width: 100vw;
        position: fixed;
        top: 0;
        left: 0;
        padding-top: 80px;
        background: var(--vscode-editor-background);
        box-sizing: border-box;
        display: none;
    `)}">
        <div id="warnings" class="${warningListClass}"></div>
    </div>`;
}

async function renderToolBar(focusTrees: FocusTree[], styleTable: StyleTable, flags: ToolbarFlags, gfxFiles: string[]): Promise<string> {
    const focuses = focusTrees.length <= 1 ? '' : `
        <label for="focuses" class="${styleTable.style('focusesLabel', () => `margin-right:5px`)}">${localize('focustree.focustree', 'Focus tree: ')}</label>
        <div class="select-container ${styleTable.style('marginRight10', () => `margin-right:10px`)}">
            <select id="focuses" class="select multiple-select" tabindex="0" role="combobox">
                ${focusTrees.map((focus, i) => `<option value="${i}">${focus.id}</option>`).join('')}
            </select>
        </div>`;

    const searchbox = `
        <label for="searchbox" class="${styleTable.style('searchboxLabel', () => `margin-right:5px`)}">${localize('focustree.search', 'Search: ')}</label>
        <input
            class="${styleTable.style('searchbox', () => `margin-right:10px`)}"
            id="searchbox"
            type="text"
        />`;

    // ID/name display toggle: un-checked = show focus ids (default), checked = show localised
    // names resolved from the editor-language localisation files on demand.
    const nameToggle = `
        <div class="${styleTable.style('focusNamesContainer', () => `margin-right:10px; display:flex; align-items:center;`)}">
            <label for="show-focus-names" class="${styleTable.style('focusNamesIdLabel', () => `margin-right:5px;`)}">ID</label>
            <input
                id="show-focus-names"
                type="checkbox"
            />
            <label for="show-focus-names" class="${styleTable.style('focusNamesNameLabel', () => `margin-left:5px;`)}">${localize('focustree.names', 'Names')}</label>
        </div>`;

    const customTitlebars = !flags.hasCustomTitlebar ? '' : `
        <div class="${styleTable.style('customTitlebarsContainer', () => `margin-right:10px; display:flex; align-items:center;`)}">
            <label for="show-custom-titlebars">${localize('focustree.customtitlebars', 'Custom titlebars')}</label>
            <input
                id="show-custom-titlebars"
                type="checkbox"
            />
        </div>`;

    const focusOverlays = !flags.hasFocusOverlay ? '' : `
        <div class="${styleTable.style('focusOverlaysContainer', () => `margin-right:10px; display:flex; align-items:center;`)}">
            <label for="show-focus-overlays">${localize('focustree.focusoverlays', 'Focus overlays')}</label>
            <input
                id="show-focus-overlays"
                type="checkbox"
            />
        </div>`;

    const inlayWindowsToggle = !flags.hasInlayWindows ? '' : `
        <div id="show-inlay-windows-container" class="${styleTable.style('inlayWindowsContainer', () => `margin-right:10px; display:flex; align-items:center;`)}">
            <label for="show-inlay-windows">${localize('focustree.inlaywindows', 'Inlay windows')}</label>
            <input
                id="show-inlay-windows"
                type="checkbox"
            />
        </div>`;

    const inlayWindows = !flags.hasInlayWindows ? '' : `
        <div id="inlay-window-container">
            <label for="inlay-windows" class="${styleTable.style('inlayWindowsLabel', () => `margin-right:5px`)}">${localize('focustree.inlaywindow', 'Inlay window: ')}</label>
            <div class="select-container ${styleTable.style('marginRight10', () => `margin-right:10px`)}">
                <select id="inlay-windows" class="select multiple-select" tabindex="0" role="combobox"></select>
            </div>
        </div>`;

    const allowbranch = `
        <div id="allowbranch-container">
            <label for="allowbranch" class="${styleTable.style('allowbranchLabel', () => `margin-right:5px`)}">${localize('focustree.allowbranch', 'Allow branch: ')}</label>
            <div class="select-container ${styleTable.style('marginRight10', () => `margin-right:10px`)}">
                <div id="allowbranch" class="select multiple-select" tabindex="0" role="combobox">
                    <span class="value"></span>
                </div>
            </div>
        </div>`;

    // 收起的下拉和它最长的选项一样宽，而一个条件可以是整块触发器，所以盒子限宽、标签留在同一行。
    const conditionContainerClass = styleTable.style('conditionContainer', () => `white-space:nowrap`);
    const conditionSelectClass = styleTable.style('conditionSelect', () => `max-width:400px; overflow:hidden;`);
    const conditions = `
        <div id="condition-container" class="${conditionContainerClass}">
            <label for="conditions" class="${styleTable.style('conditionsLabel', () => `margin-right:5px`)}">${localize('focustree.focusconditions', 'Focus conditions: ')}</label>
            <div class="select-container ${styleTable.style('marginRight10', () => `margin-right:10px`)}">
                <div id="conditions" class="select multiple-select ${conditionSelectClass}" tabindex="0" role="combobox">
                    <span class="value"></span>
                </div>
            </div>
        </div>`;

    const inlayConditions = `
        <div id="inlay-condition-container" class="${conditionContainerClass}">
            <label for="inlay-conditions" class="${styleTable.style('inlayConditionsLabel', () => `margin-right:5px`)}">${localize('focustree.inlayconditions', 'Inlay conditions: ')}</label>
            <div class="select-container ${styleTable.style('marginRight10', () => `margin-right:10px`)}">
                <div id="inlay-conditions" class="select multiple-select ${conditionSelectClass}" tabindex="0" role="combobox">
                    <span class="value"></span>
                </div>
            </div>
        </div>`;
    
    // The warning buttons stay in place, disabled while no tree has a warning.
    const hasNoWarnings = !flags.hasWarnings;
    const warningsButton = iconButtonHtml('showWarnings', localize, { domId: 'show-warnings', on: false, disabled: hasNoWarnings })
        + iconButtonHtml('warningMarkers', localize, { domId: 'toggle-warning-markers', on: true, disabled: hasNoWarnings })
        + iconButtonHtml('copyWarnings', localize, { domId: 'copy-warnings', disabled: hasNoWarnings });

    const hasAllowBranch = focusTrees.some(ft => ft.allowBranchOptions.length > 0);
    const resetCheckboxesButton = !hasAllowBranch ? '' : iconButtonHtml('resetCheckboxes', localize, { domId: 'reset-focus-checkboxes' });

    // The continuous focus box is dragged in the webview, so the toggle lives here and the position
    // is written back through a message; the button is hidden again by the webview on a tree the
    // file does not define itself.
    const editContinuousButton = iconButtonHtml('editContinuous', localize, { domId: 'edit-continuous-focus' });

    // Shown by the webview only while a prerequisite trace is active, so there is always a visible
    // way out of the dimmed view. Hidden through an inline display rather than the `hidden`
    // attribute: the class below sets a display of its own, which would win over `[hidden]`.
    const traceStatus = `
        <div id="trace-status-container" style="display:none" class="${styleTable.style('traceStatusContainer', () => `margin-left:10px; align-items:center;`)}">
            <span id="trace-status" class="${styleTable.style('traceStatus', () => `margin-right:5px; opacity:0.8;`)}"></span>
            ${iconButtonHtml('clearTrace', localize, { domId: 'clear-trace' })}
        </div>`;

    // Search filters: one dropdown entry per distinct search_filters value across all focus trees,
    // each carrying the GFX_<filter> sprite as its icon. Selecting entries dims all focuses that do
    // not carry any of the selected filters.
    const searchFilterNames = chain(focusTrees).flatMap(ft => ft.searchFilters).uniq().value();
    const searchFilterSprites: Record<string, Sprite | undefined> = {};
    await Promise.all(searchFilterNames.map(async searchFilter => {
        searchFilterSprites[searchFilter] = await getSpriteByGfxName(getGfxNameForSearchFilter(searchFilter), gfxFiles);
    }));

    const searchFilters = searchFilterNames.length === 0 ? '' : `
        <div id="search-filters-container">
            <label for="search-filters" class="${styleTable.style('searchFiltersLabel', () => `margin-right:5px`)}">${localize('focustree.searchfilters', 'Filters: ')}</label>
            <div class="select-container ${styleTable.style('marginRight10', () => `margin-right:10px`)}">
                <div id="search-filters" class="select multiple-select" tabindex="0" role="combobox">
                    <span class="value"></span>
                    ${
                        searchFilterNames.map(filter =>
                            `<div class="option" value="${htmlEscape(filter)}">
                                <span class="${styleTable.oneTimeStyle('searchFilterIcon', () =>
                                    `background-image: url(${searchFilterSprites[filter]?.image.uri});`
                                )}
                                ${styleTable.style('searchFilterIcon', () =>
                                    `display: inline-block; width: 16px; height: 16px; background-size: 16px 16px;`
                                )}"></span>
                                ${htmlEscape(getLocalisedTextQuick(filter) ?? '')}
                            </div>`)
                        .join('')
                    }
                </div>
            </div>
        </div>
    `;

    return `<div class="toolbar-outer ${styleTable.style('toolbar-padding', () => `padding-top:5px; padding-bottom:5px; box-sizing: border-box; height: 80px;`)}">
        <div class="toolbar ${styleTable.style('toolbar', () => `flex-direction: column;top:0;transform:none;`)}">
            <div id="toolbar-row-1" class="toolbar-row">
                ${focuses}
                ${useConditionInFocus ? conditions + inlayConditions : allowbranch}
                ${inlayWindows}
                ${warningsButton}
                ${editContinuousButton}
                ${resetCheckboxesButton}
                ${traceStatus}
            </div>
            <div class="toolbar-row">
                ${nameToggle}
                ${customTitlebars}
                ${focusOverlays}
                ${inlayWindowsToggle}
                ${searchbox}
                ${searchFilters}
            </div>
        </div>
    </div>`;
}

function getInlayGfxStyleKey(gfxName: string, gfxFile: string | undefined) {
    return 'inlay-gfx-' + normalizeForStyle((gfxFile ?? 'missing') + '-' + gfxName);
}

async function prepareInlayGfxStyles(focusTrees: FocusTree[], styleTable: StyleTable): Promise<void> {
    const processed = new Set<string>();
    for (const focusTree of focusTrees) {
        for (const inlay of focusTree.inlayWindows) {
            for (const slot of inlay.scriptedImages) {
                for (const option of slot.gfxOptions) {
                    const key = getInlayGfxStyleKey(option.gfxName, option.gfxFile);
                    if (processed.has(key)) {
                        continue;
                    }
                    processed.add(key);

                    if (!option.gfxFile) {
                        styleTable.style(key, () => `
                            width: 96px;
                            height: 96px;
                            background: rgba(127, 127, 127, 0.35);
                            border: 1px dashed var(--vscode-panel-border);
                        `);
                        continue;
                    }

                    const sprite = await getSpriteByGfxName(option.gfxName, option.gfxFile);
                    const frame = sprite?.frames[0];
                    if (!frame) {
                        styleTable.style(key, () => `
                            width: 96px;
                            height: 96px;
                            background: rgba(127, 127, 127, 0.35);
                            border: 1px dashed var(--vscode-panel-border);
                        `);
                        continue;
                    }

                    styleTable.style(key, () => `
                        width: ${Math.min(frame.width, 144)}px;
                        height: ${Math.min(frame.height, 144)}px;
                        background-image: url(${frame.uri});
                        background-repeat: no-repeat;
                        background-position: center;
                        background-size: contain;
                    `);
                }
            }
        }
    }
}

async function renderInlayWindow(inlay: FocusTree["inlayWindows"][number], styleTable: StyleTable, gfxFiles: string[]): Promise<string> {
    if (!inlay.guiWindow) {
        return '';
    }

    const parentInfo: ParentInfo = {
        size: {
            width: 1920,
            height: 1080,
        },
        orientation: 'upper_left',
    };

    // 树里的 inlay_window 位置就是窗口左上角该去的地方。根窗口自己的朝向（比如 lower_left）会
    // 把窗口锚到父容器上方的角上，整整低出一个屏高。
    const content = await renderContainerWindow(
        {
            ...inlay.guiWindow,
            position: { x: toNumberLike(0), y: toNumberLike(0) },
            orientation: toStringAsSymbolIgnoreCase('upper_left'),
        },
        parentInfo,
        {
            styleTable,
            enableNavigator: true,
            classNames: 'focus-inlay-window navigator',
            getSprite: (sprite) => getSpriteByGfxName(sprite, gfxFiles),
            onRenderChild: async (type, child, parent) => renderInlayOverrideChild(type, child, parent, inlay, styleTable, gfxFiles),
        }
    );

    return `<div class="${styleTable.style('focus-inlay-window-root', () => `
        position: absolute;
        left: ${inlay.position.x}px;
        top: ${inlay.position.y}px;
        z-index: 5;
    `)}" start="${inlay.token?.start}" end="${inlay.token?.end}" file="${inlay.file}">${content}</div>`;
}

async function renderInlayOverrideChild<T extends keyof RenderChildTypeMap>(
    type: T,
    child: RenderChildTypeMap[T],
    parentInfo: ParentInfo,
    inlay: FocusTree["inlayWindows"][number],
    styleTable: StyleTable,
    gfxFiles: string[],
): Promise<string | undefined> {
    if ((type !== 'icon' && type !== 'button') || !child.name) {
        return undefined;
    }

    const slot = inlay.scriptedImages.find(scriptedImage => scriptedImage.id === child.name);
    if (!slot) {
        return undefined;
    }

    const spriteOption = slot.gfxOptions.find(option => option.gfxFile) ?? slot.gfxOptions[0];
    if (!spriteOption) {
        return undefined;
    }

    const sprite = spriteOption.gfxFile ? await getSpriteByGfxName(spriteOption.gfxName, spriteOption.gfxFile) : await getSpriteByGfxName(spriteOption.gfxName, gfxFiles);
    if (!sprite) {
        return undefined;
    }

    const iconLikeChild = child as any as IconType & ButtonType;
    let [x, y] = calculateBBox(iconLikeChild, parentInfo);
    if (iconLikeChild.centerposition) {
        x -= sprite.width / 2;
        y -= sprite.height / 2;
    }

    const scale = iconLikeChild.scale ?? 1;
    // 图片只来自占位符：网页端按选中的条件把它换成对应 option 的类。这里若把第一张图作为背景
    // 一起烧进来，它的规则在样式表里更靠后，会盖过被选中的那张；精灵只负责撑出尺寸。
    const gfxClassPlaceholder = `{{inlay_slot_class:${slot.id}}}`;
    const spriteHtml = `<div class="${gfxClassPlaceholder} ${styleTable.style('positionAbsolute', () => `position: absolute;`)} ${styleTable.oneTimeStyle('inlay-gui-slot-image', () => `
        left: 0px;
        top: 0px;
        width: ${sprite.width * scale}px;
        height: ${sprite.height * scale}px;
    `)}"></div>`;
    const textHtml = type === 'button' ? await renderInstantTextBox({
        ...iconLikeChild,
        position: { x: toNumberLike(0), y: toNumberLike(0) },
        bordersize: { x: toNumberLike(0), y: toNumberLike(0) },
        maxheight: toNumberLike(sprite.height * scale),
        maxwidth: toNumberLike(sprite.width * scale),
        font: iconLikeChild.buttonfont,
        text: iconLikeChild.buttontext ?? iconLikeChild.text,
        format: toStringAsSymbolIgnoreCase('center'),
        vertical_alignment: 'center',
        orientation: toStringAsSymbolIgnoreCase('upper_left')
    }, parentInfo, { styleTable }) : '';

    return `<div
        start="${child._token?.start}"
        end="${child._token?.end}"
        class="navigator ${styleTable.style('positionAbsolute', () => `position: absolute;`)} ${styleTable.oneTimeStyle('inlay-gui-slot', () => `
            left: ${x}px;
            top: ${y}px;
            width: ${sprite.width * scale}px;
            height: ${sprite.height * scale}px;
        `)}">
            ${spriteHtml}
            ${textHtml}
        </div>`;
}

// 快捷键按钮组，落在游戏自己的左下角。始终渲染，所以树新增或去掉 shortcut 块不需要重载外壳；
// 网页端按树填充列表，在没有快捷键的树上把整个浮层隐藏。用固定定位而不是放进画布，缩放不会
// 把它带走。
function renderShortcutOverlay(styleTable: StyleTable, toggle: string): string {
    styleTable.raw('#shortcut-overlay', `
        position: fixed;
        left: 12px;
        bottom: 12px;
        z-index: 3;
        flex-direction: column-reverse;
        align-items: flex-start;
        user-select: none;
    `);
    styleTable.raw('#shortcut-list', `
        display: flex;
        flex-direction: column-reverse;
        max-height: calc(100vh - 110px);
        overflow-y: auto;
    `);
    styleTable.raw('#shortcut-overlay.collapsed #shortcut-list', `display: none;`);
    styleTable.raw('#shortcut-toggle', `
        position: relative;
        padding: 0;
        margin-top: 2px;
        border: none;
        background: none;
        cursor: pointer;
    `);
    styleTable.raw('#shortcut-overlay.collapsed #shortcut-toggle > *', `transform: scaleX(-1);`);
    const title = escapeAttr(localize('focustree.shortcuts.toggle', 'Show or hide the shortcuts'));
    return `
    <div id="shortcut-overlay" style="display:none">
        <div id="shortcut-list"></div>
        <button id="shortcut-toggle" title="${title}" aria-label="${title}" aria-expanded="true">${toggle}</button>
    </div>`;
}

// 工作区里没有任何 nationalfocusview.gui 声明 focus_tree_shortcut_item 时，按原版窗口的尺寸画。
const fallbackShortcutItem = {
    size: { width: 190, height: 72 },
    icon: { x: 37, y: 37, scale: 0.6 },
    name: { x: 63, y: 6, width: 112, height: 60, fontSize: 14 },
};

// 一个快捷键按游戏的画法：nationalfocusview.gui 里的 item 窗口，`name` 文本框放本地化后的
// 快捷键名，`focus_button` 放目标焦点的图标。
async function renderShortcut(
    shortcut: FocusTreeShortcut,
    index: number,
    tree: FocusTree,
    item: FocusShortcutGui['item'],
    styleTable: StyleTable,
    gfxFiles: string[],
    resolveIcons: boolean,
): Promise<string> {
    const label = await localiseShortcutName(shortcut.name);
    const iconName = tree.focuses[shortcut.target]?.icon.find(i => i.icon)?.icon;
    const image = !resolveIcons ? undefined : iconName ? await getFocusIcon(iconName, gfxFiles) : await getImageByPath(defaultFocusIcon);

    // 图片挂在一个以图标命名的类上，和焦点图标一样：结构遍往这个类名下写占位，图标遍把真图盖上，
    // 尺寸也放在那里。居中用 transform，位置就不受那个尺寸影响。
    const icon = (x: number, y: number, scale: number, centered: boolean) => {
        const pictureClass = styleTable.style(`shortcut-icon-${normalizeForStyle(iconName ?? '-empty')}-${Math.round(scale * 100)}`, () => image ? `
            width: ${image.width * scale}px;
            height: ${image.height * scale}px;
            background-image: url(${image.uri});
            background-size: ${image.width * scale}px ${image.height * scale}px;
        ` : `
            width: ${94 * scale}px;
            height: ${86 * scale}px;
            background: rgba(127, 127, 127, 0.35);
        `);
        return `<div class="${pictureClass} ${styleTable.oneTimeStyle('shortcut-icon', () => `
            position: absolute;
            left: ${x}px;
            top: ${y}px;
            ${centered ? 'transform: translate(-50%, -50%);' : ''}
            pointer-events: none;
        `)}"></div>`;
    };
    // 自己画盒子而不是用共享的文本框渲染器：那个按行高居中单行，而快捷键名会折成两行。
    const text = (x: number, y: number, width: number, height: number, fontSize: number) =>
        `<div class="${styleTable.oneTimeStyle('shortcut-name', () => `
            position: absolute;
            left: ${x}px;
            top: ${y}px;
            width: ${width}px;
            height: ${height}px;
            font-size: ${fontSize}px;
        `)} ${styleTable.style('shortcut-name-common', () => `
            display: flex;
            align-items: center;
            justify-content: center;
            text-align: center;
            overflow: hidden;
            color: white;
            text-shadow: 0 0 3px black, 0px 0px 5px black;
            pointer-events: none;
        `)}">${htmlEscape(label)}</div>`;

    let width: number;
    let height: number;
    let content: string;
    if (item) {
        const parentInfo: ParentInfo = { size: { width: 1920, height: 1080 }, orientation: 'upper_left' };
        [, , width, height] = calculateBBox(item, parentInfo);
        content = await renderContainerWindow(item, parentInfo, {
            styleTable,
            ignorePosition: true,
            // 两遍都要出图，和 inlay 窗口一样：图标遍只推 CSS，结构遍漏掉的标记就永远不会出现。
            getSprite: (sprite) => getSpriteByGfxName(sprite, gfxFiles),
            onRenderChild: async (type, child, childParent) => {
                if (type === 'button' && child.name === 'focus_button') {
                    const button = child as unknown as HOIPartial<ButtonType>;
                    const [x, y] = calculateBBox({ ...button, size: undefined }, childParent);
                    return icon(x, y, button.scale ?? 1, !!button.centerposition);
                }
                if (type === 'instanttextbox' && child.name === 'name') {
                    const textbox = child as unknown as HOIPartial<InstantTextBoxType>;
                    const [x, y, w, h] = calculateBBox({ ...textbox, size: { width: textbox.maxwidth, height: textbox.maxheight } }, childParent);
                    const fontMatch = /\d+/.exec((textbox.font ?? '').replace('hoi4', ''));
                    return text(x, y, w, h, Math.ceil(parseInt(fontMatch?.[0] ?? '16') * 0.7));
                }
                return undefined;
            },
        });
    } else {
        const fallback = fallbackShortcutItem;
        ({ width, height } = fallback.size);
        content = `<div class="${styleTable.style('shortcut-item-plain', () => `
                position: absolute;
                inset: 0;
                box-sizing: border-box;
                border: 1px solid var(--vscode-panel-border);
                border-radius: 4px;
                background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
            `)}"></div>` +
            icon(fallback.icon.x, fallback.icon.y, fallback.icon.scale, true) +
            text(fallback.name.x, fallback.name.y, fallback.name.width, fallback.name.height, fallback.name.fontSize);
    }

    return `<div data-shortcut-index="${index}" title="${escapeAttr(shortcut.target)}" class="${styleTable.oneTimeStyle('shortcut-item', () => `
        position: relative;
        flex: none;
        width: ${width}px;
        height: ${height}px;
        cursor: pointer;
    `)}">${content}</div>`;
}

// 折叠快捷键的按钮：nationalfocusview.gui 的 toggle_shortcuts，没有就画一个 chevron。它的箭头
// 朝左，折叠时由网页端镜像过来。
async function renderShortcutToggle(gui: FocusShortcutGui | undefined, styleTable: StyleTable, gfxFiles: string[]): Promise<string> {
    const spriteName = gui?.toggle?.quadtexturesprite ?? gui?.toggle?.spritetype;
    const sprite = spriteName ? await getSpriteByGfxName(spriteName, gfxFiles) : undefined;
    if (!sprite) {
        return `<i class="${iconClassOf('shortcutToggle')}"></i>`;
    }
    return `<div class="${styleTable.oneTimeStyle('shortcut-toggle-sprite', () => `
        position: relative;
        width: ${sprite.width}px;
        height: ${sprite.height}px;
    `)}">${renderSprite({ x: 0, y: 0 }, sprite, sprite, 0, 1, { styleTable })}</div>`;
}

// 游戏画在快捷键按钮上的名字；没有本地化索引或没有对应条目时用原始键。
async function localiseShortcutName(name: string): Promise<string> {
    if (!localisationIndex) {
        return name;
    }
    return (await getLocalisedTextQuick(name)) || name;
}

// Per-focus rendered-HTML cache. The structure pass (resolveIcons=false) and the icon pass
// (resolveIcons=true) render the same focus object twice per load, and the markup is identical
// either way: icons/titlebars/overlays are styleTable rules referenced by {{iconClass}}, only the
// styleTable contents differ between passes. Keyed by the focus object, so a re-parse (new
// objects, also on dependency changes) invalidates automatically; a WeakMap never leaks.
const renderedFocusHtmlCache = new WeakMap<Focus, string>();

async function renderFocus(
    focus: Focus,
    styleTable: StyleTable,
    gfxFiles: string[],
    overlayGfxFiles: string[],
    file: string,
    titlebarStyles: Record<string, string>,
    itemLayout: FocusItemLayout,
    resolveIcons: boolean = true,
): Promise<string> {
    // Skips the expensive per-texture DDS->PNG conversions in the structure-only pass and registers a
    // neutral placeholder. 元素尺寸取图片尺寸：图标层是焦点的拖动命中区，必须与图片同宽高。
    for (const focusIcon of focus.icon) {
        const iconName = focusIcon.icon;
        const iconObject = resolveIcons && iconName ? await getFocusIcon(iconName, gfxFiles) : null;
        styleTable.style('focus-icon-' + normalizeForStyle(iconName ?? '-empty'), () =>
            iconObject
                ? `background-image: url(${iconObject.uri}); width: ${iconObject.width}px; height: ${iconObject.height}px; background-size: ${iconObject.width}px ${iconObject.height}px; background-color: transparent;`
                : resolveIcons
                    ? `background: grey; width: 64px; height: 64px; background-size: 0px;`
                    : `background-color: rgba(127, 127, 127, 0.25); width: 64px; height: 64px; background-size: 0px;`
        );
    }
    
    styleTable.style('focus-icon-' + normalizeForStyle('-empty'), () => 'background: grey; width: 64px; height: 64px;');

    const titlebarObject = await getFocusTitlebarImage(focus.textIcon, titlebarStyles);
    const titlebarClass = styleTable.style('focus-titlebar-' + normalizeForStyle(focus.textIcon ?? '-empty'), () =>
        titlebarObject ? `
            background-image: url(${titlebarObject.uri});
            width: ${titlebarObject.width}px;
            height: ${titlebarObject.height}px;
            background-size: ${titlebarObject.width}px ${titlebarObject.height}px;
        ` : `
            display: none;
        `
    );
    const overlayObject = await getFocusOverlayImage(focus.overlay, overlayGfxFiles);
    const overlayClass = styleTable.style('focus-overlay-' + normalizeForStyle(focus.overlay ?? '-empty'), () =>
        overlayObject ? `
            background-image: url(${overlayObject.uri});
            width: ${overlayObject.width}px;
            height: ${overlayObject.height}px;
            background-size: ${overlayObject.width}px ${overlayObject.height}px;
            display: block;
        ` : `
            display: none;
        `
    );

    // Layout classes are registered on every pass (the styleTable is fresh per render), then the
    // markup assembly reuses the cached string when this focus object was already rendered.
    const focusCommonClass = styleTable.style('focus-common', () => `
        position: relative;
        width: 100%;
        height: 100%;
        text-align: center;
        cursor: pointer;
    `);
    const layerStyles = focusLayerStyles(itemLayout);
    const focusIconLayerClass = styleTable.style('focus-icon-layer', () => layerStyles.iconLayer);
    const focusTitlebarLayerClass = styleTable.style('focus-titlebar-layer', () => layerStyles.titlebarLayer);
    const focusOverlayLayerClass = styleTable.style('focus-overlay-layer', () => layerStyles.overlayLayer);
    const focusCheckboxClass = styleTable.style('focus-checkbox', () => `position: absolute; top: 1px; z-index: 3;`);
    const focusSpanClass = styleTable.style('focus-span', () => layerStyles.span);

    const cachedHtml = renderedFocusHtmlCache.get(focus);
    if (cachedHtml !== undefined) {
        return cachedHtml;
    }
    const html = assembleFocusHtml(focus, file, {
        titlebarClass,
        overlayClass,
        hasCustomTitlebar: titlebarObject !== undefined,
        hasFocusOverlay: overlayObject !== undefined,
        focusCommonClass,
        focusIconLayerClass,
        focusTitlebarLayerClass,
        focusOverlayLayerClass,
        focusCheckboxClass,
        focusSpanClass,
    });
    renderedFocusHtmlCache.set(focus, html);
    return html;
}

// `base` 按 `offset` 像素平移，标准布局的写法保持不变。
function withOffset(base: string, offset: number): string {
    return offset === 0 ? base : `calc(${base} ${offset < 0 ? '-' : '+'} ${Math.abs(offset)}px)`;
}

/**
 * 焦点各图层的 CSS，由布局的 item 偏移参数化。两条契约由测试锁定：图标层必须保持可命中（它是
 * 焦点的拖动命中区——网页端的 move/框选判定按命中的元素区分，绝不能是 pointer-events: none），
 * 且各层位置随布局设置移动。
 */
export function focusLayerStyles(itemLayout: FocusItemLayout): { iconLayer: string; titlebarLayer: string; overlayLayer: string; span: string } {
    return {
        iconLayer: `
            position: absolute;
            left: ${withOffset('50%', itemLayout.iconOffsetX)};
            top: ${withOffset('50%', itemLayout.iconOffsetY)};
            transform: translate(-50%, -50%);
            background-position-x: center;
            background-position-y: center;
            background-repeat: no-repeat;
            z-index: 1;
        `,
        titlebarLayer: `
            position: absolute;
            left: ${withOffset('50%', itemLayout.titlebarOffsetX)};
            top: ${itemLayout.titlebarTop}px;
            transform: translateX(-50%);
            background-repeat: no-repeat;
            z-index: 0;
        `,
        overlayLayer: `
            position: absolute;
            left: 50%;
            top: 50%;
            transform: translate(${withOffset('-50%', itemLayout.overlayOffsetX)}, ${withOffset('-50%', itemLayout.overlayOffsetY)});
            background-repeat: no-repeat;
            z-index: 2;
        `,
        span: `
            position: relative;
            z-index: 3;
            margin: 10px -400px;
            margin-top: ${itemLayout.textTop}px;${itemLayout.textOffsetX === 0 ? '' : `
            left: ${itemLayout.textOffsetX}px;`}
            text-align: center;
            display: inline-block;
            pointer-events: none;
        `,
    };
}

export interface FocusHtmlClasses {
    titlebarClass: string;
    overlayClass: string;
    hasCustomTitlebar: boolean;
    hasFocusOverlay: boolean;
    focusCommonClass: string;
    focusIconLayerClass: string;
    focusTitlebarLayerClass: string;
    focusOverlayLayerClass: string;
    focusCheckboxClass: string;
    focusSpanClass: string;
}

// Pure markup assembly for one focus cell. Deterministic per (focus, classes), so renderFocus can
// cache it across passes over the same focus object. Exported for unit tests of the cache contract.
export function assembleFocusHtml(focus: Focus, file: string, classes: FocusHtmlClasses): string {
    // The label is always the raw focus id. Localised names are not embedded here: they are resolved
    // on demand by the webview's ID/name toggle (requestFocusNames -> focusNames) against the
    // prewarmed localisation index, so the lazy index build only ever serves that toggle.
    const textContent = focus.id;

    return `<div
    class="
        navigator
        ${classes.focusCommonClass}
    "
    data-focus-id="${focus.id}"
    start="${focus.token?.start}"
    end="${focus.token?.end}"
    ${file === focus.file ? '' : `file="${focus.file}"`}
    title="${focus.id}\n({{position}})\n${escapeAttr(localize('focustree.tracehint', "Shift+click: show only this focus's prerequisite lines"))}">
        <div
        class="{{iconClass}} ${classes.focusIconLayerClass}"></div>
        <div
        class="focus-titlebar-layer ${classes.titlebarClass} ${classes.focusTitlebarLayerClass}"
        data-has-custom-titlebar="${classes.hasCustomTitlebar ? 'true' : 'false'}"></div>
        <div
        class="focus-overlay-layer ${classes.overlayClass} ${classes.focusOverlayLayerClass}"
        data-has-focus-overlay="${classes.hasFocusOverlay ? 'true' : 'false'}"></div>
        <div class="focus-checkbox ${classes.focusCheckboxClass}">
            <input id="checkbox-${normalizeForStyle(focus.id)}" type="checkbox"/>
        </div>
        <!-- The outer span only provides the layout (the negative margins extend it far past the
             cell); it must not swallow clicks in the visual gaps. The inner span is the actual
             label hit area, so clicking the text counts as the focus body (move/navigate) while
             clicking anywhere else in the cell passes through to the navigator (box-select). -->
        <span
        class="${classes.focusSpanClass}"
        data-focus-id="${focus.id}">
        <span style="pointer-events: auto;">${textContent}</span>
        </span>
    </div>`;
}

export async function getFocusIcon(name: string, gfxFiles: string[]): Promise<Image | undefined> {
    const sprite = await getSpriteByGfxName(name, gfxFiles);
    if (sprite !== undefined) {
        return sprite.image;
    }

    return await getImageByPath(defaultFocusIcon);
}
