import { getState, setState, arrayToMap, scrollToState, tryRun, enableZoom, initCommon, setZoomEnabled } from "./util/common";
import { SelectionState, emptySelection, selectFocusIds, idsInRect, Rect, RectItem } from "./focusselection";
import { computeGridDelta, buildFocusDragMoves, DragMove } from "./focusdrag";
import { DivDropdown } from "./util/dropdown";
import { difference, minBy } from "lodash";
import { renderGridBoxCommon, GridBoxItem, GridBoxConnection } from "../src/util/hoi4gui/gridboxcommon";
import { StyleTable, normalizeForStyle } from "../src/util/styletable";
import { FocusTree, Focus } from "../src/previewdef/focustree/schema";
import { applyCondition, ConditionItem } from "../src/hoiformat/condition";
import { NumberPosition } from "../src/util/common";
import { GridBoxType } from "../src/hoiformat/gui";
import { toNumberLike } from "../src/hoiformat/schema";
import { feLocalize } from './util/i18n';
import { Checkbox } from "./util/checkbox";
import { vscode } from "./util/vscode";
import { showContextMenu as showSharedContextMenu, closeContextMenu as closeSharedContextMenu, sharedContextMenuEl } from "./util/contextmenu";
import { substituteInlaySlots } from "./inlayslots";
import { propagateAllowBranches, AllowBranchFocus } from "./focusbranch";
import { patchFocusTreeContent } from "./focustreepatch";

initCommon();

function showBranch(visibility: boolean, optionClass: string) {
    const elements = document.getElementsByClassName(optionClass);

    const hiddenBranches = getState().hiddenBranches || {};
    if (visibility) {
        delete hiddenBranches[optionClass];
    } else {
        hiddenBranches[optionClass] = true;
    }
    setState({ hiddenBranches: hiddenBranches });

    for (let i = 0; i < elements.length; i++) {
        const element = elements[i] as HTMLDivElement;
        element.style.display = element.className.split(' ').some(b => hiddenBranches[b]) ? "none" : "block";
    }
};

// Cached .focus elements refreshed by buildContent, so search() never re-queries the DOM on every
// keystroke; the debounce below coalesces burst input into a single pass.
let focusElementsCache: HTMLDivElement[] = [];
let searchDebounceTimer: number | undefined;

function search(searchContent: string, navigate: boolean = true) {
    const focuses = focusElementsCache;
    const searchedFocus: HTMLDivElement[] = [];
    let navigated = false;
    for (let i = 0; i < focuses.length; i++) {
        const focus = focuses[i];
        if (searchContent && focus.id.toLowerCase().replace(/^focus_/, '').includes(searchContent)) {
            focus.style.outline = '1px solid #E33';
            focus.style.background = 'rgba(255, 0, 0, 0.5)';
            if (navigate && !navigated) {
                focus.scrollIntoView({ block: "center", inline: "center" });
                navigated = true;
            }
            searchedFocus.push(focus);
        } else {
            focus.style.outlineWidth = '0';
            focus.style.background = 'transparent';
        }
    }

    return searchedFocus;
}

let useConditionInFocus: boolean = (window as any).useConditionInFocus;
let focusTrees: FocusTree[] = (window as any).focusTrees;

let selectedExprs: ConditionItem[] = getState().selectedExprs ?? [];
let selectedInlayExprs: ConditionItem[] = getState().selectedInlayExprs ?? [];
let selectedFocusTreeIndex: number = Math.min(focusTrees.length - 1, getState().selectedFocusTreeIndex ?? 0);
let allowBranches: DivDropdown | undefined = undefined;
let conditions: DivDropdown | undefined = undefined;
let inlayConditions: DivDropdown | undefined = undefined;
let checkedFocuses: Record<string, Checkbox> = {};

// ID/name display toggle state. Off by default (focus ids shown); when on, focus labels swap to
// the localised names resolved by the extension host from the editor-language localisation files.
let focusNamesMode = false;
let focusNamesRequested = false;
let focusNames: Record<string, string> = {};
// Original innerHTML of each focus label while name mode is active, so ID mode can restore it
// without a full re-render. Cleared whenever buildContent rebuilds the DOM (the rebuild already
// restores the rendered content, making stale entries wrong).
const focusSpanOriginalHtml = new Map<string, string>();

// Multi-selection of focus cells. Selection is per-session (not persisted); the set is cleared on
// tree switches and DOM rebuilds keep it (it is id-based and re-applied as highlight).
let selectionState: SelectionState = emptySelection();

// Pointer state while a mouse button is down: `move` started on a focus cell (drag the
// selection), `rubber-band` started on empty canvas (box-select). `moved` flips once the pointer
// travels past the drag threshold; the mode is only decided then.
interface PointerState {
    startClientX: number;
    startClientY: number;
    moved: boolean;
    mode: 'move' | 'rubber-band' | undefined;
    moveStartId: string | undefined;
    contentDeltaX: number;
    contentDeltaY: number;
    rubberStartClientX: number;
    rubberStartClientY: number;
    overlay: HTMLDivElement | null;
}
let pointerState: PointerState | null = null;
// Pre-drag file coordinates of the moves sent to the extension host, for rollback if the write
// fails (the local re-render has already applied them by then).
let pendingMoveRollback: Map<string, { x: number; y: number }> | null = null;

const dragThresholdPx = 3;

function escapeHtml(unsafe: string): string {
    return unsafe
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function showCustomTitlebars() {
    // On by default: focus frames render with their (possibly default_style fallback) titlebar
    // unless the user explicitly hides them. v1.1.15 flipped this default from off to on, so a
    // state persisted by older versions (which may have recorded `false` from a past toggle, or
    // nothing at all) must not shadow the new default: the first run after upgrade re-asserts
    // `true` and records the migration once, so an explicit later toggle still wins.
    const state = getState();
    if (state.customTitlebarDefaultApplied !== true) {
        setState({ showCustomTitlebars: true, customTitlebarDefaultApplied: true });
        return true;
    }
    return state.showCustomTitlebars ?? true;
}

function showFocusOverlays() {
    return getState().showFocusOverlays ?? false;
}

function showInlayWindows() {
    return !!(window as any).__showInlayWindows;
}

function getSelectedInlayWindowIds() {
    return getState().selectedInlayWindowIds ?? {} as Record<string, string | undefined>;
}

function getSelectedInlayWindowId(focusTree: FocusTree): string | undefined {
    const selected = getSelectedInlayWindowIds()[focusTree.id];
    if (focusTree.inlayWindows.some(inlay => inlay.id === selected)) {
        return selected;
    }

    return focusTree.inlayWindows[0]?.id;
}

function setSelectedInlayWindowId(focusTree: FocusTree, inlayWindowId: string | undefined) {
    const selectedInlayWindowIds = getSelectedInlayWindowIds();
    selectedInlayWindowIds[focusTree.id] = inlayWindowId;
    setState({ selectedInlayWindowIds });
}

function applyCustomTitlebarVisibility() {
    const visible = showCustomTitlebars();
    const elements = document.getElementsByClassName('focus-titlebar-layer');
    for (let i = 0; i < elements.length; i++) {
        const element = elements[i] as HTMLDivElement;
        if (element.dataset.hasCustomTitlebar === 'true') {
            element.style.display = visible ? 'block' : 'none';
        }
    }
}

function applyFocusOverlayVisibility() {
    const visible = showFocusOverlays();
    const elements = document.getElementsByClassName('focus-overlay-layer');
    for (let i = 0; i < elements.length; i++) {
        const element = elements[i] as HTMLDivElement;
        if (element.dataset.hasFocusOverlay === 'true') {
            element.style.display = visible ? 'block' : 'none';
        }
    }
}

// Focus multi-selection ------------------------------------------------
function updateFocusSelectionHighlight() {
    const navigators = document.querySelectorAll<HTMLElement>('.navigator');
    for (let i = 0; i < navigators.length; i++) {
        const nav = navigators[i];
        if (selectionState.selected.has(nav.dataset.focusId ?? '')) {
            nav.style.outline = '2px solid var(--vscode-focusBorder)';
            nav.style.outlineOffset = '-2px';
        } else {
            nav.style.outline = '';
        }
    }
}

function clearFocusSelection() {
    selectionState = emptySelection();
    updateFocusSelectionHighlight();
}

// Grid positions of the current tree's focuses (file coordinates), used to compute drag moves.
function currentFocusPositions(): Record<string, { x: number; y: number }> {
    const positions: Record<string, { x: number; y: number }> = {};
    const tree = focusTrees[selectedFocusTreeIndex];
    if (tree) {
        for (const focusId in tree.focuses) {
            positions[focusId] = { x: tree.focuses[focusId].x, y: tree.focuses[focusId].y };
        }
    }
    return positions;
}

// Focus-cell interactions (navigate on press-release, drag to move, rubber-band box-select) are
// handled by the delegated document pointerdown bound on load (see below), so cells reused across
// incremental DOM updates keep working without re-binding.

// Right-click context menu ---------------------------------------------

// Maps a viewport point (right-click position) to the focus-tree grid cell under it. Uses the
// same layout math as buildContent: the canvas is the scaled #focustreecontent element, the
// grid origin sits at (leftPadding, gridbox.position.y), each cell is one slot wide/tall.
function focusPositionToGrid(clientX: number, clientY: number): { x: number; y: number } | undefined {
    const content = document.getElementById('focustreecontent');
    if (!content) {
        return undefined;
    }
    const scale = getState().scale || 1;
    const contentRect = content.getBoundingClientRect();
    const canvasX = (clientX - contentRect.left) / scale;
    const canvasY = (clientY - contentRect.top) / scale;
    const gb = (window as any).gridBox;
    if (!gb?.slotsize) {
        return undefined;
    }
    const num = (v: any): number => (typeof v === 'number' ? v : (v?._value ?? 0));
    const slotW = (window as any).xGridSize ?? (num(gb.slotsize.width) || 96);
    const slotH = num(gb.slotsize.height) || 130;

    // Anchor the mapping on a rendered cell so it matches the renderer exactly. Rebuilding the
    // layout math here is fragile: the grid origin is shifted by min-x padding, relative-position
    // chains move cells, and the renderer's format offset (gridBox.format ?? 'up' centers cells
    // on the box) is easy to get wrong. One measured cell collapses all of that into a point.
    // ('gridbox-item' is only a styleTable key, not a real class - select by data attributes.)
    const item = document.querySelector('[data-gridbox-x][data-gridbox-y]');
    if (!item) {
        // Empty tree: nothing is rendered, so fall back to the grid origin (0, 0).
        return undefined;
    }
    const gx = parseInt(item.getAttribute('data-gridbox-x') ?? '0', 10);
    const gy = parseInt(item.getAttribute('data-gridbox-y') ?? '0', 10);
    const rect = item.getBoundingClientRect();
    const originX = (rect.left - contentRect.left) / scale - gx * slotW;
    const originY = (rect.top - contentRect.top) / scale - gy * slotH;
    return {
        x: Math.round((canvasX - originX) / slotW),
        y: Math.round((canvasY - originY) / slotH),
    };
}

function closeContextMenu() {
    closeSharedContextMenu();
}

function showContextMenu(x: number, y: number, items: { label: string; onClick: () => void }[]) {
    showSharedContextMenu('ft-context-menu', x, y, items);
}

// Delete confirmation flow (two steps on purpose): first a soft confirm, then an explicit
// "really delete" before anything is sent to the extension host.
let deleteConfirmId: string | null = null;
let deleteConfirmStep = 0;
let deleteConfirmOverlay: HTMLDivElement | null = null;

function closeDeleteConfirm() {
    deleteConfirmOverlay?.remove();
    deleteConfirmOverlay = null;
    deleteConfirmId = null;
    setUiModal(false);
}

function showDeleteConfirm() {
    // Rebuild the dialog (also used for the step 1 -> step 2 transition). Only the old overlay
    // is removed here: deleteConfirmId/deleteConfirmStep are flow state that must survive the
    // rebuild, so closing helpers must not be used (they reset the id).
    deleteConfirmOverlay?.remove();
    deleteConfirmOverlay = null;
    const overlay = document.createElement('div');
    overlay.className = 'ft-confirm';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:3000;background:rgba(0,0,0,.4);' +
        'display:flex;align-items:center;justify-content:center;';
    const box = document.createElement('div');
    box.style.cssText = 'background:var(--vscode-editor-background);color:var(--vscode-editor-foreground);' +
        'border:1px solid var(--vscode-widget-border);padding:16px;min-width:320px;';
    const msg = document.createElement('div');
    msg.style.cssText = 'margin-bottom:12px;white-space:pre-wrap;';
    msg.textContent = deleteConfirmStep === 1
        ? feLocalize('focustree.deleteconfirm1', 'Delete focus {0}?', deleteConfirmId ?? '')
        : feLocalize('focustree.deleteconfirm2', 'Really delete? This cannot be undone.');
    box.appendChild(msg);
    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;';
    const cancelBtn = makeDialogButton(feLocalize('focustree.cancel', 'Cancel'));
    const okBtn = makeDialogButton(deleteConfirmStep === 1
        ? feLocalize('focustree.continue', 'Continue')
        : feLocalize('focustree.deletefocus', 'Delete'));
    btnRow.appendChild(cancelBtn);
    btnRow.appendChild(okBtn);
    box.appendChild(btnRow);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    deleteConfirmOverlay = overlay;
    setUiModal(true);

    cancelBtn.addEventListener('click', closeDeleteConfirm);
    okBtn.addEventListener('click', () => {
        if (deleteConfirmStep === 1) {
            deleteConfirmStep = 2;
            showDeleteConfirm();
        } else {
            const id = deleteConfirmId;
            closeDeleteConfirm();
            if (id !== null) {
                vscode.postMessage({ command: 'deleteFocuses', ids: [id] });
            }
        }
    });
}

function startDeleteFocus(id: string) {
    deleteConfirmId = id;
    deleteConfirmStep = 1;
    showDeleteConfirm();
}

// Create-focus panel ----------------------------------------------
let createPanelOverlay: HTMLDivElement | null = null;

function closeCreateFocusPanel() {
    createPanelOverlay?.remove();
    createPanelOverlay = null;
    setUiModal(false);
}

// Modal dialogs (delete confirm, create panel, icon picker) must block canvas interaction behind
// them: no box-select, no drag/navigate press, no wheel zoom. The modal overlays are children of
// <body>, so document-level handlers would otherwise keep firing through them.
let uiModalOpen = false;

function setUiModal(open: boolean): void {
    uiModalOpen = open;
    setZoomEnabled(!open);
}

// Dialog buttons: common.css styles bare <button> as 20x20 toolbar icon buttons, which crushes
// text (a two-character label wraps into vertical text). Give modal buttons explicit sizing.
function makeDialogButton(text: string): HTMLButtonElement {
    const b = document.createElement('button');
    b.textContent = text;
    b.style.cssText = 'width:auto;height:auto;min-width:72px;padding:4px 12px;white-space:nowrap;' +
        'background:var(--vscode-button-background);color:var(--vscode-button-foreground);' +
        'border:1px solid var(--vscode-button-border);border-radius:2px;cursor:pointer;transform:none;';
    return b;
}

// Icon picker popup: shows every focus icon used by the workspace and the HOI4 install (names
// and, when resolvable, images) and hands the picked GFX name back to the create panel. Loading is
// two-phase: the host first sends the sorted icon-name list (focusIconNames) so the grid renders
// immediately with placeholders, then streams resolved images in batches (focusIconImages) that
// only touch their own cell -- never a full rebuild. The data lives at module scope so a reopened
// picker reuses what already arrived; a webview reload (no retainContextWhenHidden) starts a fresh
// request.
let iconPickerOverlay: HTMLDivElement | null = null;
let iconPickerCallback: ((name: string) => void) | null = null;
let iconPickerRender: (() => void) | null = null;
let iconPickerApplyImages: ((images: Record<string, string>) => void) | null = null;
let iconPickerCleanup: (() => void) | null = null;
let focusIconNames: string[] = [];
let focusIconImages: Record<string, string> = {};
// Names whose image resolution is in flight (requested but not yet delivered). Guards against
// re-requesting while the host is still decoding; an unresolvable name stays here and shows its
// placeholder instead of being retried.
let focusIconLoading = new Set<string>();
let focusIconNamesArrived = false;
let focusIconRequested = false;

function closeIconPicker() {
    iconPickerCleanup?.();
    iconPickerCleanup = null;
    iconPickerRender = null;
    iconPickerApplyImages = null;
    iconPickerOverlay?.remove();
    iconPickerOverlay = null;
    iconPickerCallback = null;
    setUiModal(false);
}

function openIconPicker(onPick: (name: string) => void) {
    closeIconPicker();
    iconPickerCallback = onPick;
    setUiModal(true);
    if (!focusIconRequested) {
        focusIconRequested = true;
        // v:2 selects the two-stage icon stream (names, then batched images) on the extension host.
        vscode.postMessage({ command: 'requestFocusIcons', v: 2 });
    }
    const overlay = document.createElement('div');
    overlay.className = 'ft-iconpicker';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:4000;background:rgba(0,0,0,.4);' +
        'display:flex;align-items:center;justify-content:center;';
    const box = document.createElement('div');
    box.style.cssText = 'background:var(--vscode-editor-background);color:var(--vscode-editor-foreground);' +
        'border:1px solid var(--vscode-widget-border);padding:16px;min-width:560px;max-width:900px;' +
        'max-height:70vh;display:flex;flex-direction:column;';
    const title = document.createElement('div');
    title.style.cssText = 'font-weight:bold;margin-bottom:8px;';
    title.textContent = feLocalize('focustree.pickicon', 'Pick icon');
    box.appendChild(title);
    // Search + per-row column count live on one line: the column selector fixes how many
    // icons fit per grid row (3/4/5/6); the icons themselves scale with the cell width.
    const toolbarRow = document.createElement('div');
    toolbarRow.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:8px;';
    const search = document.createElement('input');
    search.type = 'text';
    search.placeholder = feLocalize('focustree.search', 'Search: ');
    search.style.cssText = 'flex:1;min-width:0;';
    toolbarRow.appendChild(search);
    const columnsLabel = document.createElement('label');
    columnsLabel.textContent = feLocalize('focustree.percolumn', 'Per column: ');
    columnsLabel.style.cssText = 'white-space:nowrap;';
    toolbarRow.appendChild(columnsLabel);
    const columnsSelect = document.createElement('select');
    columnsSelect.style.cssText = 'background:var(--vscode-dropdown-background);color:var(--vscode-dropdown-foreground);' +
        'border:1px solid var(--vscode-dropdown-border);';
    // Persisted per-session column count; defaults to 6 per row.
    const defaultColumns = getState().iconPickerColumns ?? 6;
    for (const n of [6, 5, 4, 3]) {
        const option = document.createElement('option');
        option.value = String(n);
        option.textContent = feLocalize('focustree.percolumn.n', 'Per column: {0}', n);
        if (n === defaultColumns) {
            option.selected = true;
        }
        columnsSelect.appendChild(option);
    }
    toolbarRow.appendChild(columnsSelect);
    box.appendChild(toolbarRow);
    const grid = document.createElement('div');
    grid.className = 'ft-iconpicker-grid';
    grid.style.cssText = 'overflow:auto;display:grid;gap:6px;';
    box.appendChild(grid);
    const closeBtn = makeDialogButton(feLocalize('focustree.cancel', 'Cancel'));
    closeBtn.style.cssText += 'margin-top:8px;align-self:flex-end;';
    box.appendChild(closeBtn);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    iconPickerOverlay = overlay;

    // Interaction constants: search is debounced so keystrokes queue one render; the recycle pool
    // caps how many previously-decoded cells stay around for a search toggle; the request window
    // constants bound how many visible icons are pulled from the host per flush.
    const SEARCH_DEBOUNCE_MS = 200;
    const POOL_MAX_CELLS = 300;
    const FLUSH_DELAY_MS = 30;
    const SCROLL_THROTTLE_MS = 80;
    const DECODE_BATCH_MAX = 60;
    const VISIBLE_BUFFER_ROWS = 2;
    const VIEWPORT_FALLBACK_HEIGHT = 400;
    const ICON_GRID_GAP = 6;

    // Cells currently in the grid (keyed by icon name) and a recycle pool of recently removed cells
    // so a search toggle reuses the already-decoded image instead of rebuilding and re-decoding it.
    const cells = new Map<string, HTMLDivElement>();
    const pool = new Map<string, HTMLDivElement>();
    let filterTimer: number | undefined;
    let columns = defaultColumns;
    // Visible-window request bookkeeping: names waiting for the debounced flush, plus the flush and
    // scroll timers. Requests are coalesced so scrolling cannot spam one message per pixel.
    const pendingRequests = new Set<string>();
    let flushTimer: number | undefined;
    let scrollTimer: number | undefined;

    const makeCell = (name: string): HTMLDivElement => {
        const cell = document.createElement('div');
        cell.dataset.name = name;
        cell.style.cssText = 'display:flex;flex-direction:column;align-items:center;cursor:pointer;' +
            'padding:4px;border:1px solid transparent;min-width:0;';
        const host = document.createElement('div');
        host.style.cssText = 'width:100%;aspect-ratio:1;display:flex;align-items:center;justify-content:center;' +
            'color:var(--vscode-descriptionForeground);font-size:10px;';
        host.textContent = '?';
        const label = document.createElement('div');
        label.style.cssText = 'font-size:10px;max-width:100%;overflow:hidden;text-overflow:ellipsis;' +
            'white-space:nowrap;text-align:center;';
        label.textContent = name;
        label.title = name;
        cell.appendChild(host);
        cell.appendChild(label);
        cell.addEventListener('click', () => {
            const cb = iconPickerCallback;
            closeIconPicker();
            cb?.(name);
        });
        return cell;
    };

    // Injects the image into a rendered cell exactly once. A cell that already decoded its image is
    // never rebuilt or re-set, so batch updates and column changes cannot trigger re-decodes.
    const setCellImage = (cell: HTMLDivElement, name: string) => {
        if (cell.dataset.imgSet === '1') {
            return;
        }
        const uri = focusIconImages[name];
        if (!uri) {
            return;
        }
        const host = cell.firstElementChild as HTMLElement;
        const img = document.createElement('img');
        img.src = uri;
        img.style.cssText = 'width:100%;aspect-ratio:1;object-fit:contain;';
        host.textContent = '';
        host.appendChild(img);
        cell.dataset.imgSet = '1';
    };

    // Measures the height of one grid row (cell height + gap) from the first rendered cell, so the
    // visible window can be computed from scrollTop/clientHeight. Falls back to 0 when the grid is
    // not laid out (jsdom / first paint), which routes to a fixed fallback window below.
    const measureStride = (): number => {
        const first = grid.firstElementChild as HTMLElement | null;
        const h = first ? first.offsetHeight : 0;
        return h > 0 ? h + ICON_GRID_GAP : 0;
    };

    // Names currently in (or just outside) the visible viewport of the grid, in grid order. Used to
    // request images only for what the user can actually see (the pull path for very large lists).
    const visibleNames = (): string[] => {
        if (grid.children.length === 0) {
            return [];
        }
        const names: string[] = [];
        for (let i = 0; i < grid.children.length; i++) {
            const name = (grid.children[i] as HTMLElement).dataset.name;
            if (name) {
                names.push(name);
            }
        }
        const stride = measureStride();
        const viewport = grid.clientHeight || VIEWPORT_FALLBACK_HEIGHT;
        if (stride <= 0 || columns <= 0) {
            // Not measurable (jsdom / pre-layout): fall back to a fixed first block.
            return names.slice(0, Math.min(names.length, columns * (VISIBLE_BUFFER_ROWS + 2)));
        }
        const rows = Math.ceil(names.length / columns);
        const startRow = Math.max(0, Math.floor(grid.scrollTop / stride) - VISIBLE_BUFFER_ROWS);
        const endRow = Math.min(rows, Math.ceil((grid.scrollTop + viewport) / stride) + VISIBLE_BUFFER_ROWS);
        const start = startRow * columns;
        const end = Math.min(names.length, endRow * columns);
        return start >= end ? [] : names.slice(start, end);
    };

    // Single request outlet: enqueues visible names that are neither delivered nor in flight, then
    // flushes them as one message after FLUSH_DELAY_MS (coalescing bursts from scroll/filter).
    const scheduleFlush = () => {
        if (flushTimer !== undefined) {
            return;
        }
        flushTimer = window.setTimeout(() => {
            flushTimer = undefined;
            const names = [...pendingRequests].filter(n => !(n in focusIconImages) && !focusIconLoading.has(n));
            pendingRequests.clear();
            if (names.length === 0) {
                return;
            }
            const batch = names.slice(0, DECODE_BATCH_MAX);
            for (const n of batch) {
                focusIconLoading.add(n);
            }
            vscode.postMessage({ command: 'requestFocusIconImages', names: batch });
        }, FLUSH_DELAY_MS);
    };

    const requestVisibleNow = () => {
        if (!grid.isConnected) {
            return;
        }
        for (const name of visibleNames()) {
            if (!(name in focusIconImages) && !focusIconLoading.has(name)) {
                pendingRequests.add(name);
            }
        }
        scheduleFlush();
    };

    // Scroll is throttled so the window is recomputed (and missing icons requested) at most once per
    // SCROLL_THROTTLE_MS instead of on every scroll event.
    const requestVisibleSoon = () => {
        if (scrollTimer !== undefined) {
            return;
        }
        scrollTimer = window.setTimeout(() => {
            scrollTimer = undefined;
            requestVisibleNow();
        }, SCROLL_THROTTLE_MS);
    };

    // Diff the grid against the current filter: only cells that appear/disappear are touched, and a
    // newly shown cell whose image already arrived is filled immediately. Order is preserved by
    // inserting each cell before the next already-placed one (walked back to front).
    const applyFilter = () => {
        const q = search.value.trim().toLowerCase();
        const matches = q ? focusIconNames.filter(n => n.toLowerCase().includes(q)) : focusIconNames.slice();
        const wanted = new Set(matches);
        for (const [name, cell] of cells) {
            if (!wanted.has(name)) {
                cell.remove();
                cells.delete(name);
                pool.set(name, cell);
                while (pool.size > POOL_MAX_CELLS) {
                    pool.delete(pool.keys().next().value as string);
                }
            }
        }
        let nextSibling: HTMLElement | null = null;
        for (let i = matches.length - 1; i >= 0; i--) {
            const name = matches[i];
            let cell = cells.get(name);
            if (!cell) {
                cell = pool.get(name);
                if (cell) {
                    pool.delete(name);
                } else {
                    cell = makeCell(name);
                }
                cells.set(name, cell);
                setCellImage(cell, name);
                grid.insertBefore(cell, nextSibling);
            }
            nextSibling = cell;
        }
    };

    let emptyHint: HTMLElement | null = null;
    const ensureEmptyHint = (text: string) => {
        if (emptyHint === null) {
            emptyHint = document.createElement('div');
            emptyHint.style.cssText = 'color:var(--vscode-descriptionForeground);padding:12px;text-align:center;';
            grid.appendChild(emptyHint);
        }
        emptyHint.textContent = text;
    };
    const removeEmptyHint = () => {
        emptyHint?.remove();
        emptyHint = null;
    };

    const render = () => {
        applyFilter();
        if (cells.size === 0) {
            ensureEmptyHint(focusIconNamesArrived
                ? feLocalize('focustree.noiconmatch', 'No matching icons.')
                : feLocalize('focustree.iconloading', 'Loading icons…'));
        } else {
            removeEmptyHint();
        }
        requestVisibleNow();
    };

    // Applies the selected per-row column count. Cells are width:100% with a square image, so the
    // CSS grid re-flows them on a column change without rebuilding (or re-decoding) anything.
    const applyColumns = () => {
        columns = parseInt(columnsSelect.value, 10) || 6;
        setState({ iconPickerColumns: columns });
        grid.style.gridTemplateColumns = `repeat(${columns}, 1fr)`;
        // A narrower/wider grid shows a different window, so request the new visible names.
        requestVisibleNow();
    };

    // Debounced search: keystrokes queue a single render 200ms after the last one, and the render
    // only diffs the grid instead of rebuilding it.
    const onSearchInput = () => {
        if (filterTimer !== undefined) {
            clearTimeout(filterTimer);
        }
        filterTimer = window.setTimeout(() => {
            filterTimer = undefined;
            grid.scrollTop = 0;
            render();
        }, SEARCH_DEBOUNCE_MS);
    };

    const cleanup = () => {
        if (filterTimer !== undefined) {
            clearTimeout(filterTimer);
            filterTimer = undefined;
        }
        if (flushTimer !== undefined) {
            clearTimeout(flushTimer);
            flushTimer = undefined;
        }
        if (scrollTimer !== undefined) {
            clearTimeout(scrollTimer);
            scrollTimer = undefined;
        }
        pendingRequests.clear();
    };

    search.addEventListener('input', onSearchInput);
    columnsSelect.addEventListener('change', applyColumns);
    closeBtn.addEventListener('click', closeIconPicker);
    grid.addEventListener('scroll', requestVisibleSoon, { passive: true });
    iconPickerRender = render;
    iconPickerApplyImages = (images) => {
        for (const name in images) {
            const cell = cells.get(name);
            if (cell) {
                setCellImage(cell, name);
            }
        }
        // A batch landing frees the in-flight set; pull the next visible window (a no-op when the
        // host already pushed everything).
        requestVisibleNow();
    };
    iconPickerCleanup = cleanup;
    applyColumns();
    render();
}

function openCreateFocusPanel(gridX: number, gridY: number) {
    closeCreateFocusPanel();
    const overlay = document.createElement('div');
    overlay.className = 'ft-create';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:3000;background:rgba(0,0,0,.4);' +
        'display:flex;align-items:center;justify-content:center;';
    const box = document.createElement('div');
    box.style.cssText = 'background:var(--vscode-editor-background);color:var(--vscode-editor-foreground);' +
        'border:1px solid var(--vscode-widget-border);padding:16px;min-width:380px;';
    const title = document.createElement('div');
    title.style.cssText = 'font-weight:bold;margin-bottom:12px;';
    title.textContent = feLocalize('focustree.createfocus', 'Create focus');
    box.appendChild(title);

    const makeField = (label: string): HTMLInputElement => {
        const row = document.createElement('div');
        row.style.cssText = 'margin-bottom:8px;';
        const lab = document.createElement('label');
        lab.style.cssText = 'display:block;margin-bottom:2px;';
        lab.textContent = label;
        const input = document.createElement('input');
        input.type = 'text';
        input.style.cssText = 'width:100%;box-sizing:border-box;';
        row.appendChild(lab);
        row.appendChild(input);
        box.appendChild(row);
        return input;
    };

    const commentHint = ' (' + feLocalize('focustree.namecomment', 'comment only') + ')';
    const idInput = makeField('ID');
    const nameInput = makeField(feLocalize('focustree.name', 'Name') + commentHint);
    const descInput = makeField(feLocalize('focustree.desc', 'Description') + commentHint);

    const iconRow = document.createElement('div');
    iconRow.style.cssText = 'margin-bottom:8px;';
    const iconLab = document.createElement('label');
    iconLab.style.cssText = 'display:block;margin-bottom:2px;';
    iconLab.textContent = feLocalize('focustree.icon', 'Icon (GFX name)');
    const iconWrap = document.createElement('div');
    iconWrap.style.cssText = 'display:flex;gap:4px;';
    const iconInput = document.createElement('input');
    iconInput.type = 'text';
    iconInput.style.cssText = 'flex:1;';
    const pickBtn = makeDialogButton(feLocalize('focustree.pickicon', 'Pick…'));
    pickBtn.style.minWidth = 'auto';
    pickBtn.addEventListener('click', () => openIconPicker((name) => { iconInput.value = name; }));
    iconWrap.appendChild(iconInput);
    iconWrap.appendChild(pickBtn);
    iconRow.appendChild(iconLab);
    iconRow.appendChild(iconWrap);
    box.appendChild(iconRow);

    // Duration as the focus cost (weeks): the hint shows the resulting days (cost * 7).
    const costRow = document.createElement('div');
    costRow.style.cssText = 'margin-bottom:8px;';
    const costLab = document.createElement('label');
    costLab.style.cssText = 'display:block;margin-bottom:2px;';
    costLab.textContent = feLocalize('focustree.cost', 'Duration (cost)');
    const costHint = document.createElement('div');
    costHint.style.cssText = 'color:var(--vscode-descriptionForeground);font-size:11px;margin-top:2px;';
    const costInput = document.createElement('input');
    costInput.type = 'number';
    costInput.min = '1';
    costInput.step = '1';
    costInput.style.cssText = 'width:100%;box-sizing:border-box;';
    const updateCostHint = () => {
        const cost = parseInt(costInput.value, 10);
        costHint.textContent = Number.isFinite(cost) && cost > 0
            ? feLocalize('focustree.costdays', '≈ {0} days (cost × 7)', String(cost * 7))
            : feLocalize('focustree.costdays.empty', 'final days = cost × 7');
    };
    costInput.addEventListener('input', updateCostHint);
    updateCostHint();
    costRow.appendChild(costLab);
    costRow.appendChild(costInput);
    costRow.appendChild(costHint);
    box.appendChild(costRow);

    // Temporary memory: pre-fill the panel with only the last created focus's id and duration
    // (cost) -- session-only, kept across panel open/close via webview state -- because these are
    // the fields that repeat along a branch. Name/description/icon are per-focus content and stay blank.
    const lastCreated = getState().lastCreatedFocus as Record<string, unknown> | undefined;
    if (lastCreated) {
        if (typeof lastCreated.id === 'string') idInput.value = lastCreated.id;
        if (typeof lastCreated.cost === 'number' && Number.isFinite(lastCreated.cost)) {
            costInput.value = String(lastCreated.cost);
            updateCostHint();
        }
    }

    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;margin-top:12px;';
    const cancelBtn = makeDialogButton(feLocalize('focustree.cancel', 'Cancel'));
    const okBtn = makeDialogButton(feLocalize('focustree.confirm', 'Confirm'));
    btnRow.appendChild(cancelBtn);
    btnRow.appendChild(okBtn);
    box.appendChild(btnRow);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    createPanelOverlay = overlay;
    setUiModal(true);
    idInput.focus();

    cancelBtn.addEventListener('click', closeCreateFocusPanel);
    okBtn.addEventListener('click', () => {
        const id = idInput.value.trim();
        if (!id) {
            return;
        }
        const name = nameInput.value.trim();
        const desc = descInput.value.trim();
        const icon = iconInput.value.trim();
        const cost = parseInt(costInput.value, 10);
        // Session memory: remember only this focus's id and duration (cost) so the next open of
        // the create panel pre-fills them; name/desc/icon are per-focus content and not remembered.
        setState({
            lastCreatedFocus: {
                id,
                cost: Number.isFinite(cost) && cost > 0 ? cost : undefined,
            },
        });
        closeCreateFocusPanel();
        vscode.postMessage({
            command: 'createFocus',
            focus: {
                id,
                name: name || undefined,
                desc: desc || undefined,
                icon: icon || undefined,
                cost: Number.isFinite(cost) && cost > 0 ? cost : undefined,
                x: gridX,
                y: gridY,
            },
        });
    });
}

// Sends the navigate message for the focus cell with the given id (its source-line tokens).
function navigateToFocus(id: string) {
    const navigators = document.querySelectorAll<HTMLElement>('.navigator');
    for (let i = 0; i < navigators.length; i++) {
        if (navigators[i].dataset.focusId === id) {
            const startStr = navigators[i].getAttribute('start');
            const endStr = navigators[i].getAttribute('end');
            // getAttribute returns null for a missing attribute; the extension host checks
            // `msg.file === undefined`, so null must become undefined (JSON then omits the field).
            const file = navigators[i].getAttribute('file') ?? undefined;
            const start = !startStr || startStr === 'undefined' ? undefined : parseInt(startStr);
            const end = !endStr ? undefined : parseInt(endStr);
            vscode.postMessage({ command: 'navigate', start, end, file });
            return;
        }
    }
}

// Binds the transient window listeners that track the pointer until release.
function startPointer(e: MouseEvent, mode: 'move' | 'rubber-band', moveStartId: string | undefined) {
    // Block the browser's default press-and-drag behaviors (text selection, native drag), which
    // otherwise fight the box-select or make the selection look like it is "moving".
    e.preventDefault();
    pointerState = {
        startClientX: e.clientX,
        startClientY: e.clientY,
        moved: false,
        mode,
        moveStartId,
        contentDeltaX: 0,
        contentDeltaY: 0,
        rubberStartClientX: e.clientX,
        rubberStartClientY: e.clientY,
        overlay: null,
    };
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerEnd);
}

function onPointerMove(e: MouseEvent) {
    const pointer = pointerState;
    if (!pointer) {
        return;
    }
    const clientDeltaX = e.clientX - pointer.startClientX;
    const clientDeltaY = e.clientY - pointer.startClientY;
    if (!pointer.moved && Math.abs(clientDeltaX) < dragThresholdPx && Math.abs(clientDeltaY) < dragThresholdPx) {
        return;
    }
    if (!pointer.moved) {
        pointer.moved = true;
        if (pointer.mode === 'move' && pointer.moveStartId !== undefined && !selectionState.selected.has(pointer.moveStartId)) {
            // Dragging an unselected focus body moves only it. No highlight here: the box would
            // only flash during the drag and is cleared on release (and after a valid move).
            selectionState = { selected: new Set([pointer.moveStartId]) };
        }
    }
    const scale = getState().scale || 1;
    pointer.contentDeltaX = clientDeltaX / scale;
    pointer.contentDeltaY = clientDeltaY / scale;
    if (pointer.mode === 'move') {
        applyDragTransforms(pointer.contentDeltaX, pointer.contentDeltaY);
    } else if (pointer.mode === 'rubber-band') {
        updateRubberBand(e);
    }
}

function updateRubberBand(e: MouseEvent) {
    const pointer = pointerState;
    if (!pointer) {
        return;
    }
    if (!pointer.overlay) {
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;border:1px solid var(--vscode-focusBorder);' +
            'background:rgba(127,127,127,0.2);z-index:1000;pointer-events:none;';
        document.body.appendChild(overlay);
        pointer.overlay = overlay;
    }
    const left = Math.min(pointer.rubberStartClientX, e.clientX);
    const top = Math.min(pointer.rubberStartClientY, e.clientY);
    pointer.overlay.style.left = left + 'px';
    pointer.overlay.style.top = top + 'px';
    pointer.overlay.style.width = Math.abs(e.clientX - pointer.rubberStartClientX) + 'px';
    pointer.overlay.style.height = Math.abs(e.clientY - pointer.rubberStartClientY) + 'px';
}

function applyDragTransforms(contentDeltaX: number, contentDeltaY: number) {
    const navigators = document.querySelectorAll<HTMLElement>('.navigator');
    for (let i = 0; i < navigators.length; i++) {
        if (selectionState.selected.has(navigators[i].dataset.focusId ?? '')) {
            navigators[i].style.transform = `translate(${contentDeltaX}px, ${contentDeltaY}px)`;
        }
    }
}

function clearDragTransforms() {
    const navigators = document.querySelectorAll<HTMLElement>('.navigator');
    for (let i = 0; i < navigators.length; i++) {
        navigators[i].style.transform = '';
    }
}

function onPointerEnd(e: MouseEvent) {
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerEnd);
    const pointer = pointerState;
    pointerState = null;
    if (!pointer) {
        return;
    }
    if (pointer.overlay) {
        pointer.overlay.remove();
    }

    if (!pointer.moved) {
        // A clean press-release: when it started on a focus cell (moveStartId set) navigate to
        // its source line regardless of the drag mode; on empty canvas clear the selection.
        if (pointer.moveStartId !== undefined) {
            navigateToFocus(pointer.moveStartId);
        } else {
            clearFocusSelection();
        }
        return;
    }

    if (pointer.mode === 'rubber-band') {
        // Box-select every focus whose bounds intersect the drag rectangle.
        const rect: Rect = {
            left: Math.min(pointer.rubberStartClientX, e.clientX),
            top: Math.min(pointer.rubberStartClientY, e.clientY),
            right: Math.max(pointer.rubberStartClientX, e.clientX),
            bottom: Math.max(pointer.rubberStartClientY, e.clientY),
        };
        const items: RectItem[] = [];
        const navigators = document.querySelectorAll<HTMLElement>('.navigator');
        for (let i = 0; i < navigators.length; i++) {
            const id = navigators[i].dataset.focusId;
            if (id === undefined) {
                continue;
            }
            const bounds = navigators[i].getBoundingClientRect();
            items.push({ id, left: bounds.left, top: bounds.top, right: bounds.right, bottom: bounds.bottom });
        }
        selectionState = selectFocusIds(selectionState, idsInRect(rect, items));
        updateFocusSelectionHighlight();
        return;
    }

    // Move mode: compute the moves first (they depend on the current selection), then clear the
    // selection unconditionally - a release that did not cross a grid step must not leave the
    // highlight box behind - and write the moves back.
    const tree = focusTrees[selectedFocusTreeIndex];
    if (tree) {
        const scale = getState().scale || 1;
        const xGridSize = (window as any).xGridSize ?? 96;
        const yGridSize = (window as any).gridBox?.slotsize?.height?._value ?? 130;
        const delta = computeGridDelta(pointer.contentDeltaX * scale, pointer.contentDeltaY * scale, scale, xGridSize, yGridSize);
        const prevPositions: Record<string, { x: number; y: number }> = {};
        const moves: DragMove[] = buildFocusDragMoves(selectionState.selected, currentFocusPositions(), delta);
        for (const move of moves) {
            const focus = tree.focuses[move.id];
            if (focus) {
                prevPositions[move.id] = { x: focus.x, y: focus.y };
                focus.x = move.x;
                focus.y = move.y;
            }
        }
        clearFocusSelection();
        if (moves.length === 0) {
            clearDragTransforms();
            return;
        }
        pendingMoveRollback = new Map(Object.entries(prevPositions));
        void buildContent().then(() => retriggerSearch()).catch(() => {});
        vscode.postMessage({ command: 'moveFocuses', moves });
    } else {
        clearFocusSelection();
        clearDragTransforms();
    }
}

// Persists the current preview UI state (conditions, toggles, name mode, ...) to the extension
// host, which stores it per previewed file so closing and reopening the panel restores it.
function saveUiState() {
    vscode.postMessage({
        command: 'saveUiState',
        state: {
            ...getState(),
            showFocusNames: focusNamesMode,
        },
    });
}

// Applies persisted UI state answered to requestUiState: restores the module-level selections,
// the toggle controls, the name mode, the tree selector, hidden branches and the search box,
// then re-renders so the restored conditions take effect.
async function applyRestoredUiState(state: Record<string, any>) {
    selectedExprs = state.selectedExprs ?? [];
    selectedInlayExprs = state.selectedInlayExprs ?? [];
    if (focusTrees.length > 0) {
        selectedFocusTreeIndex = Math.min(focusTrees.length - 1, state.selectedFocusTreeIndex ?? 0);
        if (selectedFocusTreeIndex < 0) { selectedFocusTreeIndex = 0; }
    }
    setState({
        selectedExprs,
        selectedInlayExprs,
        selectedFocusTreeIndex,
        hiddenBranches: state.hiddenBranches ?? {},
        checkedFocuses: state.checkedFocuses ?? {},
        searchboxValue: state.searchboxValue ?? '',
        showCustomTitlebars: state.showCustomTitlebars,
        showFocusOverlays: state.showFocusOverlays,
        showInlayWindows: state.showInlayWindows,
        selectedInlayWindowIds: state.selectedInlayWindowIds ?? {},
    });

    const titlebars = document.getElementById('show-custom-titlebars') as HTMLInputElement | null;
    if (titlebars) { titlebars.checked = showCustomTitlebars(); }
    const overlays = document.getElementById('show-focus-overlays') as HTMLInputElement | null;
    if (overlays) { overlays.checked = showFocusOverlays(); }
    const inlayWin = document.getElementById('show-inlay-windows') as HTMLInputElement | null;
    if (inlayWin) {
        const show = state.showInlayWindows === true;
        inlayWin.checked = show;
        (window as any).__showInlayWindows = show;
    }
    const nameToggle = document.getElementById('show-focus-names') as HTMLInputElement | null;
    if (nameToggle) { nameToggle.checked = state.showFocusNames === true; }
    if (state.showFocusNames === true) {
        focusNamesMode = true;
        if (!focusNamesRequested) {
            focusNamesRequested = true;
            const ids: string[] = [];
            for (const tree of focusTrees) {
                for (const focusId in tree.focuses) { ids.push(focusId); }
            }
            vscode.postMessage({ command: 'requestFocusNames', ids });
        }
    }
    const focusesElement = document.getElementById('focuses') as HTMLSelectElement | null;
    if (focusesElement) { focusesElement.value = selectedFocusTreeIndex.toString(); }
    if (!useConditionInFocus) {
        const hiddenBranches = state.hiddenBranches || {};
        for (const key in hiddenBranches) { showBranch(false, key); }
        if (allowBranches) {
            allowBranches.selectedValues$.next(allowBranches.selectedValues$.value.filter(v => !hiddenBranches[v]));
        }
    }
    const searchbox = document.getElementById('searchbox') as HTMLInputElement | null;
    if (searchbox && state.searchboxValue) { searchbox.value = state.searchboxValue; }

    updateSelectedFocusTree(false);
    await buildContent();
    retriggerSearch();
    updateFocusNameDisplay();
}

// Applies the ID/name toggle to the on-screen focus labels. Name mode swaps each label to its
// localised name (caching the original HTML so ID mode can restore it); ID mode restores.
function updateFocusNameDisplay() {
    // Only the label span inside each focus cell (the navigator also carries data-focus-id).
    const spans = document.querySelectorAll<HTMLElement>('.navigator [data-focus-id]');
    for (let i = 0; i < spans.length; i++) {
        const span = spans[i];
        const id = span.dataset.focusId;
        if (id === undefined) {
            continue;
        }
        if (focusNamesMode) {
            const name = focusNames[id];
            if (name !== undefined) {
                if (!focusSpanOriginalHtml.has(id)) {
                    focusSpanOriginalHtml.set(id, span.innerHTML);
                }
                // Keep the inner hit-area span so the label still counts as the focus body.
                span.innerHTML = '<span style="pointer-events: auto;">' + escapeHtml(name) + '</span>';
            }
        } else {
            const original = focusSpanOriginalHtml.get(id);
            if (original !== undefined) {
                span.innerHTML = original;
                focusSpanOriginalHtml.delete(id);
            }
        }
    }
}

async function buildContent() {
    const focusCheckState = getState().checkedFocuses ?? {};
    const checkedFocusesExprs = Object.keys(focusCheckState)
        .filter(fid => focusCheckState[fid])
        .map(fid => ({ scopeName: '', nodeContent: 'has_completed_focus = ' + fid }));

    const focustreeplaceholder = document.getElementById('focustreeplaceholder') as HTMLDivElement;
    
    const styleTable = new StyleTable();
    const renderedFocus: Record<string, string> = (window as any).renderedFocus;
    const focusTree = focusTrees[selectedFocusTreeIndex];
    const focuses = Object.values(focusTree.focuses);

    const allowBranchOptionsValue: Record<string, boolean> = {};
    const exprs = [{ scopeName: '', nodeContent: 'has_focus_tree = ' + focusTree.id }, ...checkedFocusesExprs, ...selectedExprs, ...selectedInlayExprs];
    focusTree.allowBranchOptions.forEach(option => {
        const focus = focusTree.focuses[option];
        allowBranchOptionsValue[option] = !focus || focus.allowBranch === undefined || applyCondition(focus.allowBranch, exprs);
    });

    // For synthetic trees (shared focuses), always allow branches to show them in preview
    if (focusTree.isSharedFocues) {
        focusTree.allowBranchOptions.forEach(option => {
            allowBranchOptionsValue[option] = true;
        });
    }

    const gridbox: GridBoxType = (window as any).gridBox;

    const focusPosition: Record<string, NumberPosition> = {};
    calculateFocusAllowed(focusTree, allowBranchOptionsValue);
    const focusGrixBoxItems = focuses.map(focus => focusToGridItem(focus, focusTree, allowBranchOptionsValue, focusPosition, exprs)).filter((v): v is GridBoxItem => !!v);
    
    const minX = minBy(Object.values(focusPosition), 'x')?.x ?? 0;
    const leftPadding = gridbox.position.x._value - Math.min(minX * (window as any).xGridSize, 0);

    const focusTreeContent = await renderGridBoxCommon({ ...gridbox, position: {...gridbox.position, x: toNumberLike(leftPadding)} }, {
        size: { width: 0, height: 0 },
        orientation: 'upper_left'
    }, {
        styleTable,
        items: arrayToMap(focusGrixBoxItems, 'id'),
        onRenderItem: item => Promise.resolve(
            renderedFocus[item.id]
                .replace('{{position}}', item.gridX + ', ' + item.gridY)
                .replace('{{iconClass}}', getFocusIcon(focusTree.focuses[item.id], exprs, styleTable))
            ),
        cornerPosition: 0.5,
    });

    patchFocusTreeContent(focustreeplaceholder, focusTreeContent, styleTable, (window as any).styleNonce);
    const inlayWindowPlaceholder = document.getElementById('inlaywindowplaceholder') as HTMLDivElement;
    inlayWindowPlaceholder.innerHTML = renderInlayWindows(focusTree, exprs);

    setupCheckedFocuses(focuses, focusTree);
    applyCustomTitlebarVisibility();
    applyFocusOverlayVisibility();
    // The rebuild replaced every focus label, so cached originals are stale. Re-apply the name
    // mode (no-op in ID mode) and the selection highlight after the fresh render.
    focusSpanOriginalHtml.clear();
    updateFocusNameDisplay();
    updateFocusSelectionHighlight();
    // Refresh the search element cache against the rebuilt DOM.
    focusElementsCache = Array.from(document.getElementsByClassName('focus')) as HTMLDivElement[];
    applySearchFilters();
}

function calculateFocusAllowed(focusTree: FocusTree, allowBranchOptionsValue: Record<string, boolean>) {
    // Dependency-driven queue propagation (O(V + E)) replaces the while-changed full rescan
    // (worst case O(V^2)); the pure helper reproduces the scan's fixed point exactly.
    const propagated = propagateAllowBranches(
        focusTree.focuses as unknown as Record<string, AllowBranchFocus>,
        allowBranchOptionsValue,
    );
    for (const key in propagated) {
        allowBranchOptionsValue[key] = propagated[key];
    }
}

function updateSelectedFocusTree(clearCondition: boolean) {
    const focusTree = focusTrees[selectedFocusTreeIndex];
    const continuousFocuses = document.getElementById('continuousFocuses') as HTMLDivElement;

    if (focusTree.continuousFocusPositionX !== undefined && focusTree.continuousFocusPositionY !== undefined) {
        continuousFocuses.style.left = (focusTree.continuousFocusPositionX - 59) + 'px';
        continuousFocuses.style.top = (focusTree.continuousFocusPositionY + 7) + 'px';
        continuousFocuses.style.display = 'block';
    } else {
        continuousFocuses.style.display = 'none';
    }

    if (useConditionInFocus) {
        const conditionExprs = dedupeConditionExprs(focusTree.conditionExprs).filter(e => e.scopeName !== '' ||
            (!e.nodeContent.startsWith('has_focus_tree = ') && !e.nodeContent.startsWith('has_completed_focus = ')));
        const inlayConditionExprs = dedupeConditionExprs(focusTree.inlayConditionExprs).filter(e => e.scopeName !== '' ||
            (!e.nodeContent.startsWith('has_focus_tree = ') && !e.nodeContent.startsWith('has_completed_focus = ')));

        const conditionContainerElement = document.getElementById('condition-container') as HTMLDivElement | null;
        if (conditionContainerElement) {
            conditionContainerElement.style.display = conditionExprs.length > 0 ? 'block' : 'none';
        }

        if (conditions) {
            // Options are built via DOM + textContent so foreign condition strings from mod files
            // can never inject markup into the dropdown.
            conditions.select.innerHTML = '<span class="value"></span>';
            for (const option of conditionExprs) {
                const div = document.createElement('div');
                div.className = 'option';
                div.setAttribute('value', `${option.scopeName}!|${option.nodeContent}`);
                div.textContent = (option.scopeName ? `[${option.scopeName}]` : '') + option.nodeContent;
                conditions.select.appendChild(div);
            }
            conditions.selectedValues$.next(clearCondition ? [] : selectedExprs.map(e => `${e.scopeName}!|${e.nodeContent}`));
        }

        const inlayConditionContainerElement = document.getElementById('inlay-condition-container') as HTMLDivElement | null;
        if (inlayConditionContainerElement) {
            inlayConditionContainerElement.style.display = showInlayWindows() && inlayConditionExprs.length > 0 ? 'block' : 'none';
        }

        if (inlayConditions) {
            inlayConditions.select.innerHTML = '<span class="value"></span>';
            for (const option of inlayConditionExprs) {
                const div = document.createElement('div');
                div.className = 'option';
                div.setAttribute('value', `${option.scopeName}!|${option.nodeContent}`);
                div.textContent = (option.scopeName ? `[${option.scopeName}]` : '') + option.nodeContent;
                inlayConditions.select.appendChild(div);
            }
            inlayConditions.selectedValues$.next(clearCondition ? [] : selectedInlayExprs.map(e => `${e.scopeName}!|${e.nodeContent}`));
        }

    } else {
        const allowBranchesContainerElement = document.getElementById('allowbranch-container') as HTMLDivElement | null;
        if (allowBranchesContainerElement) {
            allowBranchesContainerElement.style.display = focusTree.allowBranchOptions.length > 0 ? 'block' : 'none';
        }

        if (allowBranches) {
            allowBranches.select.innerHTML = `<span class="value"></span>
                ${focusTree.allowBranchOptions.map(option => `<div class="option" value="inbranch_${option}">${option}</div>`).join('')}`;
            allowBranches.selectAll();
        }
    }

    const inlayWindowsElement = document.getElementById('inlay-windows') as HTMLSelectElement | null;
    const inlayWindowsContainerElement = document.getElementById('inlay-window-container') as HTMLDivElement | null;
    if (inlayWindowsContainerElement) {
        inlayWindowsContainerElement.style.display = focusTree.inlayWindows.length > 0 ? 'block' : 'none';
    }
    if (inlayWindowsElement) {
        inlayWindowsElement.innerHTML = focusTree.inlayWindows.map(inlay => `<option value="${inlay.id}">${inlay.id}</option>`).join('');
        const selectedInlayWindowId = getSelectedInlayWindowId(focusTree);
        if (selectedInlayWindowId) {
            inlayWindowsElement.value = selectedInlayWindowId;
            setSelectedInlayWindowId(focusTree, selectedInlayWindowId);
        }
    }

    const warnings = document.getElementById('warnings') as HTMLTextAreaElement | null;
    if (warnings) {
        warnings.value = focusTree.warnings.length === 0 ? feLocalize('worldmap.warnings.nowarnings', 'No warnings.') :
            focusTree.warnings.map(w => `[${w.source}] ${w.text}`).join('\n');
    }
}

function getFocusPosition(
    focus: Focus | undefined,
    positionByFocusId: Record<string, NumberPosition>,
    focusTree: FocusTree,
    focusStack: Focus[] = [],
    exprs: ConditionItem[],
): NumberPosition {
    if (focus === undefined) {
        return { x: 0, y: 0 };
    }

    const cached = positionByFocusId[focus.id];
    if (cached) {
        return cached;
    }

    if (focusStack.includes(focus)) {
        return { x: 0, y: 0 };
    }

    let position: NumberPosition = { x: focus.x, y: focus.y };
    if (focus.relativePositionId !== undefined) {
        focusStack.push(focus);
        const relativeFocusPosition = getFocusPosition(focusTree.focuses[focus.relativePositionId], positionByFocusId, focusTree, focusStack, exprs);
        focusStack.pop();
        position.x += relativeFocusPosition.x;
        position.y += relativeFocusPosition.y;
    }

    for (const offset of focus.offset) {
        if (offset.trigger !== undefined && applyCondition(offset.trigger, exprs)) {
            position.x += offset.x;
            position.y += offset.y;
        }
    }

    positionByFocusId[focus.id] = position;
    return position;
}

function getFocusIcon(focus: Focus, exprs: ConditionItem[], styleTable: StyleTable): string {
    for (const icon of focus.icon) {
        if (applyCondition(icon.condition, exprs)) {
            const iconName = icon.icon;
            return styleTable.name('focus-icon-' + normalizeForStyle(iconName ?? '-empty'));
        }
    }

    return styleTable.name('focus-icon-' + normalizeForStyle('-empty'));
}

function focusToGridItem(
    focus: Focus,
    focustree: FocusTree,
    allowBranchOptionsValue: Record<string, boolean>,
    positionByFocusId: Record<string, NumberPosition>,
    exprs: ConditionItem[],
): GridBoxItem | undefined {
    if (useConditionInFocus) {
        if (allowBranchOptionsValue[focus.id] === false) {
            return undefined;
        }
    }

    const classNames = focus.inAllowBranch.map(v => 'inbranch_' + v).join(' ');
    const connections: GridBoxConnection[] = [];
    
    for (const prerequisites of focus.prerequisite) {
        let style: string;
        if (prerequisites.length > 1) {
            style = "1px dashed #88aaff";
        } else {
            style = "1px solid #88aaff";
        }

        prerequisites.forEach(p => {
            const fp = focustree.focuses[p];
            const classNames2 = fp?.inAllowBranch.map(v => 'inbranch_' + v).join(' ') ?? '';
            connections.push({
                target: p,
                targetType: 'parent',
                style: style,
                classNames: classNames + ' ' + classNames2,
            });
        });
    }

    focus.exclusive.forEach(e => {
        const fe = focustree.focuses[e];
        const classNames2 = fe?.inAllowBranch.map(v => 'inbranch_' + v).join(' ') ?? '';
        connections.push({
            target: e,
            targetType: 'related',
            style: "1px solid red",
            classNames: classNames + ' ' + classNames2,
        });
    });

    const position = getFocusPosition(focus, positionByFocusId, focustree, [], exprs);

    return {
        id: focus.id,
        htmlId: 'focus_' + focus.id,
        classNames: classNames + ' focus',
        gridX: position.x,
        gridY: position.y,
        connections,
    };
}

// Handles a focus-completion checkbox toggle: enforces exclusive mutual exclusion, persists the
// state, rebuilds (incrementally) and restores the scroll position. Invoked from the delegated
// document change handler, so reused cells across incremental updates never need re-binding.
async function onFocusCheckboxChange(checkbox: HTMLInputElement, focusId: string, focus: Focus): Promise<void> {
    const focusCheckState = getState().checkedFocuses ?? {};
    if (checkbox.checked) {
        for (const exclusiveFocus of focus.exclusive) {
            const exclusiveCheckbox = checkedFocuses[exclusiveFocus];
            if (exclusiveCheckbox) {
                exclusiveCheckbox.input.checked = false;
                focusCheckState[exclusiveFocus] = false;
            }
        }
    }
    focusCheckState[focusId] = checkbox.checked;
    setState({ checkedFocuses: focusCheckState });
    saveUiState();

    const rect = checkbox.getBoundingClientRect();
    const oldLeft = rect.left, oldTop = rect.top;
    await buildContent();

    const newCheckbox = document.getElementById(`checkbox-${normalizeForStyle(focusId)}`) as HTMLInputElement;
    if (newCheckbox) {
        const rect = newCheckbox.getBoundingClientRect();
        const newLeft = rect.left, newTop = rect.top;
        window.scrollBy(newLeft - oldLeft, newTop - oldTop);
    }

    retriggerSearch();
}

// Syncs the completion-checkbox rows with the current tree. Wraps only newly-present checkboxes
// (Checkbox inserts a visual container per wrap, so re-wrapping a reused cell would duplicate it)
// and disposes rows that are no longer present. Change events are handled by the delegated
// document handler via onFocusCheckboxChange.
function setupCheckedFocuses(focuses: Focus[], focusTree: FocusTree) {
    const focusCheckState = getState().checkedFocuses ?? {};
    const existing = new Set(Object.keys(checkedFocuses));
    const wanted = new Set<string>();
    for (const focus of focuses) {
        const checkbox = document.getElementById(`checkbox-${normalizeForStyle(focus.id)}`) as HTMLInputElement;
        if (!checkbox) {
            continue;
        }
        if (focusTree.conditionExprs.some(e => e.scopeName === '' && e.nodeContent === 'has_completed_focus = ' + focus.id)) {
            wanted.add(focus.id);
            checkbox.checked = !!focusCheckState[focus.id];
            // Re-wrap when the row is new OR its previous input left the DOM (an incremental patch
            // replaced that cell); a stale wrapper would leave the fresh checkbox unwrapped.
            if (!checkedFocuses[focus.id] || !document.contains(checkedFocuses[focus.id].input)) {
                checkedFocuses[focus.id]?.dispose();
                checkedFocuses[focus.id] = new Checkbox(checkbox);
            }
        } else {
            checkbox.parentElement?.remove();
        }
    }
    for (const focusId of existing) {
        if (!wanted.has(focusId)) {
            checkedFocuses[focusId].dispose();
            delete checkedFocuses[focusId];
        }
    }
}

function dedupeConditionExprs(exprs: ConditionItem[]): ConditionItem[] {
    const result: ConditionItem[] = [];
    for (const expr of exprs) {
        if (!result.some(existing => existing.scopeName === expr.scopeName && existing.nodeContent === expr.nodeContent)) {
            result.push(expr);
        }
    }

    return result;
}

function renderInlayWindows(focusTree: FocusTree, exprs: ConditionItem[]): string {
    if (!showInlayWindows()) {
        return '';
    }

    const selectedInlayWindowId = getSelectedInlayWindowId(focusTree);
    if (!selectedInlayWindowId) {
        return '';
    }

    const selectedInlayWindow = focusTree.inlayWindows.find(inlay => inlay.id === selectedInlayWindowId);
    if (!selectedInlayWindow || !applyCondition(selectedInlayWindow.visible, exprs)) {
        return '';
    }

    const renderedInlayWindows: Record<string, string> = (window as any).renderedInlayWindows ?? {};
    const template = renderedInlayWindows[selectedInlayWindow.id] ?? '';
    const slotClasses: Record<string, string> = {};
    for (const slot of selectedInlayWindow.scriptedImages) {
        const activeOption = getActiveInlayOption(slot.gfxOptions, exprs);
        slotClasses[slot.id] = activeOption ? getInlayGfxClassName(activeOption.gfxName, activeOption.gfxFile) : '';
    }
    // One regex pass over the template instead of a split/join per slot (O(slots * length) -> O(length)).
    return substituteInlaySlots(template, slotClasses);
}

function getActiveInlayOption<T extends { condition: any }>(options: T[], exprs: ConditionItem[]): T | undefined {
    for (const option of options) {
        if (applyCondition(option.condition, exprs)) {
            return option;
        }
    }

    return undefined;
}

function getInlayGfxClassName(gfxName: string | undefined, gfxFile: string | undefined): string {
    return 'st-inlay-gfx-' + normalizeForStyle((gfxFile ?? 'missing') + '-' + (gfxName ?? 'missing'));
}

let retriggerSearch: () => void = () => {};

let selectedSearchFilters: string[] = getState().selectedSearchFilters ?? [];

// Dims every focus that does not carry any of the selected search filters; the filters come from
// the focus files' search_filters list (one dropdown entry per distinct value across all trees).
function applySearchFilters(): void {
    const focusTree = focusTrees[selectedFocusTreeIndex];
    if (!focusTree) {
        return;
    }

    for (const focus of Object.values(focusTree.focuses)) {
        const focusElement = document.getElementById('focus_' + focus.id);
        if (!focusElement) {
            continue;
        }

        const matchesFilter = selectedSearchFilters.some(filter => focus.searchFilters.includes(filter));
        focusElement.style.opacity = matchesFilter || selectedSearchFilters.length === 0 ? '1' : '0.2';
    }
}

window.addEventListener('message', async (event) => {
    const msg = event.data;

    // Fills the nonced <style> with the real focus-icon background CSS once the deferred conversion finishes.
    if (msg.type === 'iconStyles') {
        const styleEl = document.getElementById('ft-progressive-icons');
        if (styleEl) {
            styleEl.textContent = msg.css;
        }
        return;
    }

    // Localised names for the ID/name toggle arrived from the extension host.
    if (msg.type === 'focusNames') {
        focusNames = msg.names ?? {};
        focusNamesRequested = true;
        updateFocusNameDisplay();
        return;
    }

    // Drag-move write-back result. Success needs no action (the document change triggers a fresh
    // render); failure restores the pre-drag coordinates locally.
    if (msg.type === 'focusesMoved') {
        if (msg.ok !== true && pendingMoveRollback) {
            const tree = focusTrees[selectedFocusTreeIndex];
            if (tree) {
                for (const [id, pos] of pendingMoveRollback) {
                    const focus = tree.focuses[id];
                    if (focus) {
                        focus.x = pos.x;
                        focus.y = pos.y;
                    }
                }
            }
            pendingMoveRollback = null;
            clearFocusSelection();
            await buildContent();
            retriggerSearch();
        } else {
            pendingMoveRollback = null;
        }
        return;
    }

    // Create-focus picker data from the extension host.
    // Legacy single-shot payload (a host without the two-stage protocol): migrate it into the
    // per-phase state in one step so the grid is immediately ready with images.
    if (msg.type === 'focusIcons') {
        const icons: { name: string; imageUri?: string }[] = msg.icons ?? [];
        focusIconNames = icons.map(i => i.name).sort((a, b) => a.localeCompare(b));
        const images: Record<string, string> = {};
        for (const icon of icons) {
            if (icon.imageUri) {
                images[icon.name] = icon.imageUri;
            }
        }
        focusIconImages = images;
        focusIconNamesArrived = true;
        if (iconPickerRender) {
            iconPickerRender();
        }
        return;
    }
    // Two-stage phase 1: the sorted name list arrives first (cheap), so the grid renders
    // immediately with placeholders and becomes searchable.
    if (msg.type === 'focusIconNames') {
        const names: string[] = msg.names ?? [];
        focusIconNames = names.slice().sort((a, b) => a.localeCompare(b));
        focusIconNamesArrived = true;
        if (iconPickerRender) {
            iconPickerRender();
        }
        return;
    }
    // Two-stage phase 2: a batch of resolved images; only the matching cells are updated.
    if (msg.type === 'focusIconImages') {
        const images: Record<string, string> = {};
        for (const icon of msg.images ?? []) {
            focusIconLoading.delete(icon?.name);
            if (icon?.imageUri) {
                images[icon.name] = icon.imageUri;
                focusIconImages[icon.name] = icon.imageUri;
            }
        }
        if (iconPickerApplyImages) {
            iconPickerApplyImages(images);
        }
        return;
    }

    // Persisted preview UI state (conditions, toggles, name mode, ...) from the extension host.
    if (msg.type === 'uiState') {
        await applyRestoredUiState(msg.state ?? {});
        return;
    }

    if (msg.type !== 'update') return;

    focusTrees = msg.focusTrees;
    (window as any).focusTrees = msg.focusTrees;
    (window as any).renderedFocus = msg.renderedFocus;
    (window as any).renderedInlayWindows = msg.renderedInlayWindows;
    (window as any).gridBox = msg.gridBox;
    useConditionInFocus = msg.useConditionInFocus;
    (window as any).useConditionInFocus = msg.useConditionInFocus;
    (window as any).xGridSize = msg.xGridSize;

    if (selectedFocusTreeIndex >= focusTrees.length) {
        selectedFocusTreeIndex = Math.max(0, focusTrees.length - 1);
        setState({ selectedFocusTreeIndex });
    }

    updateSelectedFocusTree(false);
    await buildContent();
    retriggerSearch();
});

window.addEventListener('load', tryRun(async function() {
    // Focus-cell and blank-canvas pointer handling, delegated on document (registered once). A
    // clean press-release on a focus cell navigates to the source line, dragging a focus cell
    // moves the selection, and dragging on empty canvas rubber-band box-selects every intersected
    // focus. Delegation keeps interactions working across incremental DOM updates, where cells are
    // reused instead of rebuilt and re-bound.
    document.addEventListener('pointerdown', (e) => {
        if (e.button !== 0 || uiModalOpen) {
            return;
        }
        const target = e.target as HTMLElement;
        // Toolbar controls (buttons, selects, dropdowns, inputs), dropdown popups and the warnings
        // textarea keep their own behavior.
        if (target.closest('.toolbar, .toolbar-outer') ||
            target.closest('.select-dropdown') ||
            target.closest('input, select, textarea, button, label')) {
            return;
        }
        const nav = target.closest('.navigator') as HTMLElement | null;
        if (nav) {
            const id = nav.dataset.focusId;
            if (id === undefined) {
                return;
            }
            // Clicks on the completion checkbox (or other inputs) never start a drag.
            if (target.closest('input, .focus-checkbox')) {
                return;
            }
            // The icon/titlebar/overlay layers and the label are the focus body and are
            // pointer-events: auto, so pressing them resolves to a child element (drag = move,
            // press-release = navigate). Pressing the cell's visual gaps resolves to the
            // navigator itself (everything else passes through), which box-selects instead.
            const mode = target === nav ? 'rubber-band' : 'move';
            // Capture guarantees the matching pointerup reaches us even if the pointer leaves the
            // cell or the webview frame before release (the mouseup that used to be lost).
            try {
                nav.setPointerCapture(e.pointerId);
            } catch { /* not supported (jsdom, older engines): mouse events still work */ }
            startPointer(e, mode, id);
            return;
        }
        // Blank canvas anywhere (outside focus cells and controls) starts a rubber-band box select.
        try {
            document.body.setPointerCapture(e.pointerId);
        } catch { /* not supported (jsdom, older engines): mouse events still work */ }
        startPointer(e, 'rubber-band', undefined);
    });

    // Focus-completion checkboxes: one delegated change handler instead of per-cell bindings, so
    // reused cells across incremental DOM updates keep working without re-binding.
    document.addEventListener('change', (e) => {
        const input = e.target as HTMLInputElement;
        if (input.type !== 'checkbox') {
            return;
        }
        const nav = input.closest('.navigator') as HTMLElement | null;
        const focusId = nav?.dataset.focusId;
        if (focusId === undefined) {
            return;
        }
        const focus = focusTrees[selectedFocusTreeIndex]?.focuses[focusId];
        if (!focus) {
            return;
        }
        void onFocusCheckboxChange(input, focusId, focus);
    });

    // Right-click on a focus cell offers delete; on empty canvas it offers create.
    document.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        if (uiModalOpen) {
            return;
        }
        const target = e.target as HTMLElement;
        const nav = target.closest('.navigator') as HTMLElement | null;
        if (nav) {
            const id = nav.dataset.focusId;
            if (id !== undefined) {
                showContextMenu(e.clientX, e.clientY, [
                    { label: feLocalize('focustree.deletefocus', 'Delete focus') + '「' + id + '」', onClick: () => startDeleteFocus(id) },
                ]);
                return;
            }
        }
        showContextMenu(e.clientX, e.clientY, [
            {
                label: feLocalize('focustree.createfocus', 'Create focus'),
                onClick: () => {
                    const grid = focusPositionToGrid(e.clientX, e.clientY);
                    openCreateFocusPanel(grid?.x ?? 0, grid?.y ?? 0);
                },
            },
        ]);
    });
    document.addEventListener('pointerdown', (e) => {
        if (sharedContextMenuEl() && !sharedContextMenuEl()!.contains(e.target as Node)) {
            closeContextMenu();
        }
    });

    // Focus name display: ID (default) or localised name
    const showFocusNamesElement = document.getElementById('show-focus-names') as HTMLInputElement | null;
    if (showFocusNamesElement) {
        showFocusNamesElement.checked = focusNamesMode;
        showFocusNamesElement.addEventListener('change', () => {
            focusNamesMode = showFocusNamesElement.checked;
            if (focusNamesMode && !focusNamesRequested) {
                focusNamesRequested = true;
                const ids: string[] = [];
                for (const tree of focusTrees) {
                    for (const focusId in tree.focuses) {
                        ids.push(focusId);
                    }
                }
                vscode.postMessage({ command: 'requestFocusNames', ids });
            }
            updateFocusNameDisplay();
            saveUiState();
        });
    }
    // Custom titlebars
    const showCustomTitlebarsElement = document.getElementById('show-custom-titlebars') as HTMLInputElement | null;
    if (showCustomTitlebarsElement) {
        showCustomTitlebarsElement.checked = showCustomTitlebars();
        showCustomTitlebarsElement.addEventListener('change', () => {
            setState({ showCustomTitlebars: showCustomTitlebarsElement.checked });
            applyCustomTitlebarVisibility();
            saveUiState();
        });
    }
    const showFocusOverlaysElement = document.getElementById('show-focus-overlays') as HTMLInputElement | null;
    if (showFocusOverlaysElement) {
        showFocusOverlaysElement.checked = showFocusOverlays();
        showFocusOverlaysElement.addEventListener('change', () => {
            setState({ showFocusOverlays: showFocusOverlaysElement.checked });
            applyFocusOverlayVisibility();
            saveUiState();
        });
    }
    const showInlayWindowsElement = document.getElementById('show-inlay-windows') as HTMLInputElement | null;
    if (showInlayWindowsElement) {
        (window as any).__showInlayWindows = false;
        showInlayWindowsElement.checked = false;
        showInlayWindowsElement.addEventListener('change', async () => {
            (window as any).__showInlayWindows = showInlayWindowsElement.checked;
            setState({ showInlayWindows: showInlayWindowsElement.checked });
            updateSelectedFocusTree(false);
            await buildContent();
            retriggerSearch();
            saveUiState();
        });
    }

    // Focuses
    const focusesElement = document.getElementById('focuses') as HTMLSelectElement | null;
    if (focusesElement) {
        focusesElement.value = selectedFocusTreeIndex.toString();
        focusesElement.addEventListener('change', async () => {
            selectedFocusTreeIndex = parseInt(focusesElement.value);
            setState({ selectedFocusTreeIndex });
            clearFocusSelection();
            updateSelectedFocusTree(true);
            await buildContent();
            retriggerSearch();
            saveUiState();
        });
    }

    const inlayWindowsElement = document.getElementById('inlay-windows') as HTMLSelectElement | null;
    if (inlayWindowsElement) {
        inlayWindowsElement.addEventListener('change', async () => {
            const focusTree = focusTrees[selectedFocusTreeIndex];
            setSelectedInlayWindowId(focusTree, inlayWindowsElement.value);
            await buildContent();
            retriggerSearch();
        });
    }

    // Allow branch
    if (!useConditionInFocus) {
        const hiddenBranches = getState().hiddenBranches || {};
        for (const key in hiddenBranches) {
            showBranch(false, key);
        }

        const allowBranchesElement = document.getElementById('allowbranch') as HTMLDivElement | null;
        if (allowBranchesElement) {
            allowBranches = new DivDropdown(allowBranchesElement, true);
            allowBranches.selectAll();

            const allValues = allowBranches.selectedValues$.value;
            allowBranches.selectedValues$.next(allValues.filter(v => !hiddenBranches[v]));

            let oldSelection = allowBranches.selectedValues$.value;
            allowBranches.selectedValues$.subscribe(selection => {
                const showBranches = difference(selection, oldSelection);
                showBranches.forEach(s => showBranch(true, s));
                const hideBranches = difference(oldSelection, selection);
                hideBranches.forEach(s => showBranch(false, s));
                oldSelection = selection;

                const hiddenBranches = difference(allValues, selection);
                setState({ hiddenBranches });
                saveUiState();
            });
        }
    }

    // Searchbox
    const searchbox = document.getElementById('searchbox') as HTMLInputElement;
    let currentNavigatedIndex = 0;
    let oldSearchboxValue: string = getState().searchboxValue || '';
    let searchedFocus: HTMLDivElement[] = search(oldSearchboxValue, false);

    searchbox.value = oldSearchboxValue;

    // Debounced search: burst input (keyup/keypress/paste/cut) coalesces into one pass 200ms after
    // the last keystroke. Enter always flushes first so navigation acts on the current value.
    const flushSearch = () => {
        if (searchDebounceTimer === undefined) {
            return;
        }
        clearTimeout(searchDebounceTimer);
        searchDebounceTimer = undefined;
        currentNavigatedIndex = 0;
        searchedFocus = search(oldSearchboxValue);
        setState({ searchboxValue: oldSearchboxValue });
        saveUiState();
    };
    const searchboxChangeFunc = function(this: HTMLInputElement) {
        const searchboxValue = this.value.toLowerCase();
        if (oldSearchboxValue === searchboxValue) {
            return;
        }
        // Advance the tracked value immediately so repeated keys coalesce onto the latest text.
        oldSearchboxValue = searchboxValue;
        if (searchDebounceTimer !== undefined) {
            clearTimeout(searchDebounceTimer);
        }
        searchDebounceTimer = window.setTimeout(flushSearch, 200);
    };

    searchbox.addEventListener('change', searchboxChangeFunc);
    searchbox.addEventListener('keypress', function(e) {
        if (e.key === 'Enter') {
            flushSearch();
            const visibleSearchedFocus = searchedFocus.filter(f => f.style.display !== 'none');
            if (visibleSearchedFocus.length > 0) {
                currentNavigatedIndex = (currentNavigatedIndex + (e.shiftKey ? visibleSearchedFocus.length - 1 : 1)) % visibleSearchedFocus.length;
                visibleSearchedFocus[currentNavigatedIndex].scrollIntoView({ block: "center", inline: "center" });
            }
        } else {
            searchboxChangeFunc.apply(this);
        }
    });
    searchbox.addEventListener('keyup', searchboxChangeFunc);
    searchbox.addEventListener('paste', searchboxChangeFunc);
    searchbox.addEventListener('cut', searchboxChangeFunc);

    retriggerSearch = () => { searchedFocus = search(oldSearchboxValue, false); };

    // Conditions
    if (useConditionInFocus) {
        const conditionsElement = document.getElementById('conditions') as HTMLDivElement | null;
        if (conditionsElement) {
            conditions = new DivDropdown(conditionsElement, true);
            
            conditions.selectedValues$.next(selectedExprs.map(e => `${e.scopeName}!|${e.nodeContent}`));
            conditions.selectedValues$.subscribe(async (selection) => {
                selectedExprs = selection.map<ConditionItem>(selection => {
                    const index = selection.indexOf('!|');
                    if (index === -1) {
                        return {
                            scopeName: '',
                            nodeContent: selection,
                        };
                    } else {
                        return {
                            scopeName: selection.substring(0, index),
                            nodeContent: selection.substring(index + 2),
                        };
                    }
                });

                setState({ selectedExprs });
                saveUiState();
                
                await buildContent();
                retriggerSearch();
            });
        }

        const inlayConditionsElement = document.getElementById('inlay-conditions') as HTMLDivElement | null;
        if (inlayConditionsElement) {
            inlayConditions = new DivDropdown(inlayConditionsElement, true);

            inlayConditions.selectedValues$.next(selectedInlayExprs.map(e => `${e.scopeName}!|${e.nodeContent}`));
            inlayConditions.selectedValues$.subscribe(async (selection) => {
                selectedInlayExprs = selection.map<ConditionItem>(selection => {
                    const index = selection.indexOf('!|');
                    if (index === -1) {
                        return {
                            scopeName: '',
                            nodeContent: selection,
                        };
                    } else {
                        return {
                            scopeName: selection.substring(0, index),
                            nodeContent: selection.substring(index + 2),
                        };
                    }
                });

                setState({ selectedInlayExprs });
                saveUiState();

                await buildContent();
                retriggerSearch();
            });
        }
    }

    // Zoom
    const contentElement = document.getElementById('focustreecontent') as HTMLDivElement;
    enableZoom(contentElement, 0, 80);

    // Search filters: dims focuses that don't carry any selected filter.
    const searchFiltersElement = document.getElementById('search-filters') as HTMLDivElement | null;
    if (searchFiltersElement) {
        const searchFiltersDropdown = new DivDropdown(searchFiltersElement, true);
        searchFiltersDropdown.selectedValues$.next(selectedSearchFilters);
        searchFiltersDropdown.selectedValues$.subscribe((selection) => {
            selectedSearchFilters = [...selection];
            setState({ selectedSearchFilters });

            applySearchFilters();
        });
    }

    // Toggle warnings
    const showWarnings = document.getElementById('show-warnings') as HTMLButtonElement;
    if (showWarnings) {
        const warnings = document.getElementById('warnings-container') as HTMLDivElement;
        showWarnings.addEventListener('click', () => {
            const visible = warnings.style.display === 'block';
            document.body.style.overflow = visible ? '' : 'hidden';
            warnings.style.display = visible ? 'none' : 'block';
        });
    }

    // Reset focus-completion checkboxes
    const resetFocusCheckboxes = document.getElementById('reset-focus-checkboxes') as HTMLButtonElement | null;
    if (resetFocusCheckboxes) {
        resetFocusCheckboxes.addEventListener('click', async () => {
            setState({ checkedFocuses: {} });
            saveUiState();
            await buildContent();
            retriggerSearch();
        });
    }

    // Escape clears the focus selection.
    window.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && selectionState.selected.size > 0) {
            clearFocusSelection();
        }
    });

    updateSelectedFocusTree(false);
    await buildContent();
    scrollToState();

    // Tells the extension the structure is on screen so it can post the deferred focus-icon CSS.
    vscode.postMessage({ command: 'ready' });
    // Ask for the persisted UI state; the answer re-applies conditions, toggles and name mode.
    vscode.postMessage({ command: 'requestUiState' });
}));
