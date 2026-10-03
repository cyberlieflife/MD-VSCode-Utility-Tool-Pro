import * as vscode from 'vscode';
import { buildFocusTreeHtml, buildNoFocusTreeHtml, buildFocusTreeErrorHtml, buildFocusTreePayload, loadFocusTreesOnly, FocusTreePayload, FocusTreeUpdatePayload, ToolbarFlags } from './contentbuilder';
import { FocusTreeLayout, focusTreeGridBoxFor } from './layout';
import { matchPathEnd } from '../../util/nodecommon';
import { PreviewBase } from '../previewbase';
import { PreviewProviderDef } from '../previewmanager';
import { contextContainer } from '../../context';
import { FocusTreeLoader } from './loader';
import { FocusTree, Focus } from './schema';
import { buildFocusMoveEdits, buildDeleteFocusEdits, findFocusTreeInsertPosition, buildFocusInsertBlock } from './move';
import { collectFocusIconNames, getFocusIconPickerImage, resolveFocusIconImages } from './iconpicker';
import { Logger } from '../../util/logger';
import { getRelativePathInWorkspace, getDocumentByUri } from '../../util/vsccommon';
import { localize } from '../../util/i18n';
import { loadingShellHtml } from '../../util/html';
import { withTimeout, TimeoutError } from '../../util/common';
import { error } from '../../util/debug';
import { useConditionInFocus } from '../../util/featureflags';
import { ensureLocalisationIndex, getLocalisedTextUnchecked, notifyFocusTreePreviewOpened, notifyFocusTreePreviewClosed } from '../../util/localisationIndex';
import { computeStructuralFingerprint, computeIconSourceFingerprint, computeTreeStructuralFingerprint, computeTreeIconFingerprint, decideFocusTreeUpdate, fnv1a, shouldSkipTextEarlyOut, FocusTreeFingerprints } from './fingerprint';

// A render taking longer than this is treated as stuck. The underlying load keeps running
// in the background, but the user gets a recoverable panel instead of an endless spinner.
const focusTreeRenderTimeout = 60 * 1000;

// Above this many unique picker icons, the host stops auto-pushing every image (which would decode
// hundreds of textures in the background) and instead lets the webview pull only the icons its
// visible window needs. Below it, streaming everything up front is cheaper and smoother.
const pickerIconPullThreshold = 500;

function canPreviewFocusTree(document: vscode.TextDocument) {
    const uri = document.uri;
    if (matchPathEnd(uri.toString().toLowerCase(), ['common', 'national_focus', '*']) && uri.path.toLowerCase().endsWith('.txt')) {
        return 0;
    }

    return undefined;
}

function toolbarFlagsEqual(a: ToolbarFlags | undefined, b: ToolbarFlags | undefined): boolean {
    if (a === undefined || b === undefined) {return a === b;}
    return a.hasCustomTitlebar === b.hasCustomTitlebar &&
        a.hasFocusOverlay === b.hasFocusOverlay &&
        a.hasInlayWindows === b.hasInlayWindows;
}

class FocusTreePreview extends PreviewBase {
    private focusTreeLoader: FocusTreeLoader;
    private content: string | undefined;
    // Fingerprints of the last rendered structure-only payload. structuralFingerprint drives the
    // in-place `update`; iconSourceFingerprint drives the (expensive) icon re-resolution + re-push.
    private lastStructuralFingerprint: string | undefined = undefined;
    private lastIconSourceFingerprint: string | undefined = undefined;
    // Cheaper object-level fingerprints of the last rendered trees, computed from the parsed FocusTree[]
    // before any HTML/style work. They drive the pre-render early-out in sendPartialUpdate; kept in
    // lockstep with the rendered fingerprints above (seeded/reset at exactly the same points).
    private lastTreeStructural: string | undefined = undefined;
    private lastTreeIcon: string | undefined = undefined;
    // fnv1a hash + length of the last seen document text, used to short-circuit the
    // sendPartialUpdate early-out entirely: unchanged text (and no dependency change) means the
    // parsed FocusTree[] is identical, so neither the object-level load nor its fingerprint
    // serialization needs to run. Seeded/reset at the same points as the fingerprints above.
    // The length component guards against the 32-bit fnv1a collision/float-precision window (the
    // same hash also drives ContentLoader's reparse decision; here it gates render too).
    private lastTextHash: number | undefined = undefined;
    private lastTextLength = -1;
    private lastToolbarFlags: ToolbarFlags | undefined = undefined;
    private lastGoodHadFocusTrees = false;
    // Bug #36: the most recent real-icon CSS pushed to the webview, re-posted when the webview is
    // reloaded (hide->show tears it down) or the panel becomes visible again. Tagged with the
    // generation it belongs to so a cache from a superseded load is never re-pushed.
    private lastPushedIconCss: string | undefined = undefined;
    private lastPushedIconGeneration = -1;
    // An in-place `update` post patches the DOM but never refreshes the stored panel.webview.html,
    // so a hide->show reload (no retainContextWhenHidden) restores the pre-update structure. Cache
    // the last posted update and re-post it when the reloaded webview signals `ready`, tagged with
    // the generation so a full reload (which bumps the generation and re-renders fresh html that
    // already embeds the current structure) invalidates it.
    private lastUpdateMessage: (FocusTreeUpdatePayload & { type: string }) | undefined = undefined;
    private lastUpdateGeneration = -1;
    // Serializes updates so two loads can never run concurrently against the same loader.
    private updateQueue: Promise<void> = Promise.resolve();
    // Generation token: each full (re)load bumps it so a slow background icon push from an earlier
    // load is dropped instead of overwriting a newer render.
    private iconRenderGeneration = 0;
    // Resolves when the webview signals it has rendered the structure and can accept icon CSS.
    private webviewReady: Promise<void> = Promise.resolve();
    private signalWebviewReady: () => void = () => {};
    // Focus trees of the last successful render, kept for drag-move write-back (the webview only
    // knows ids; the token positions for precise edits live here).
    private lastFocusTrees: FocusTree[] = [];
    // Session memo of picker icons resolved for the create-focus icon picker (name -> data URI,
    // undefined = unresolvable) plus the bookkeeping for the debounced resolution stream. The memo
    // survives webview reloads on the same panel, so a reopened picker never re-decodes; it is
    // bounded by the picker's unique icon count and dropped when the preview is disposed.
    private resolvedIconImages = new Map<string, string | undefined>();
    private pendingIconImageRequests = new Set<string>();
    private inFlightIconImages = new Map<string, Promise<string | undefined>>();
    private iconImageFlushTimer: NodeJS.Timeout | undefined;

    constructor(uri: vscode.Uri, panel: vscode.WebviewPanel) {
        super(uri, panel);
        // A focus-tree preview is the consumer of the prewarmed localisation index (the webview ID/name
        // toggle): opening one upgrades a still-pending background index build to the fast path, and
        // closing it keeps the open-preview count accurate for the next build's fast/slow decision.
        notifyFocusTreePreviewOpened();
        this.panel.onDidDispose(() => notifyFocusTreePreviewClosed());
        // Read from the live document so a parallel update clearing `this.content` can never
        // make the loader parse an empty string (which used to flip the preview to "No focus tree").
        this.focusTreeLoader = new FocusTreeLoader(
            getRelativePathInWorkspace(this.uri),
            () => Promise.resolve(getDocumentByUri(this.uri)?.getText() ?? this.content ?? ''),
        );
        this.focusTreeLoader.onLoadDone(r => this.updateDependencies(r.dependencies));
        this.panel.webview.onDidReceiveMessage(msg => {
            if (msg?.command === 'saveUiState') {
                void savePreviewUiState(this, msg.state);
                return;
            }
            if (msg?.command === 'requestUiState') {
                void sendPreviewUiState(this);
                return;
            }
            if (msg?.command === 'requestFocusIcons') {
                // v:2 selects the two-stage icon stream (names first, then batched images); older
                // webviews (no v) get the legacy single-shot list so a panel that was open before
                // this extension updated keeps working until it is reloaded.
                if (msg?.v === 2) {
                    void this.sendFocusIconNames();
                } else {
                    void sendFocusIcons(this);
                }
                return;
            }
            if (msg?.command === 'requestFocusIconImages') {
                void this.requestIconImages(msg.names);
                return;
            }
            if (msg?.command === 'createFocus') {
                void this.createFocus(msg.focus);
                return;
            }
            if (msg?.command === 'deleteFocuses') {
                void this.deleteFocuses(msg.ids);
                return;
            }
            if (msg?.command === 'moveFocuses') {
                void this.applyFocusMoves(msg.moves);
                return;
            }
            if (msg?.command === 'requestFocusNames') {
                void this.sendFocusNames(msg.ids);
                return;
            }
            if (msg?.command === 'ready') {
                this.signalWebviewReady();
                // Bug #36: the webview re-posts `ready` after VS Code reloads it (e.g. on hide->show),
                // which drops both the in-place structural update and the pushed icon CSS. Restore the
                // update first (it rebuilds #focustreeplaceholder) then the icon CSS: #ft-progressive-icons
                // lives outside that element and survives the rebuild, so this mirrors a fresh load
                // (structure, then icons stream in) and both orders would in fact work.
                this.repushCachedUpdate();
                this.repushCachedIconStyles();
            }
        });
        // Belt-and-suspenders for bug #36: also restore icons when the panel becomes visible again.
        this.panel.onDidChangeViewState(() => {
            if (this.panel.visible) {
                this.repushCachedIconStyles();
            }
        });
    }

    /**
     * Writes drag moves back into the previewed focus document via a single WorkspaceEdit
     * (undoable). Only focuses that live in this document are moved; shared/joint focuses from
     * dependency files are skipped and reported as a failure so the webview can roll back.
     */
    private async applyFocusMoves(moves: { id: string; x: number; y: number }[]): Promise<void> {
        try {
            const document = getDocumentByUri(this.uri);
            if (!document) {
                this.panel.webview.postMessage({ type: 'focusesMoved', ok: false });
                return;
            }
            const text = document.getText();
            const focusById = new Map<string, Focus>();
            for (const tree of this.lastFocusTrees) {
                for (const focus of Object.values(tree.focuses)) {
                    focusById.set(focus.id, focus);
                }
            }
            const edit = new vscode.WorkspaceEdit();
            let failed = false;
            for (const move of moves) {
                const focus = focusById.get(move.id);
                if (!focus || focus.file !== this.focusTreeLoader.file) {
                    failed = true;
                    continue;
                }
                const specs = buildFocusMoveEdits(text, focus, move.x, move.y);
                if (specs.length === 0) {
                    failed = true;
                    continue;
                }
                for (const spec of specs) {
                    edit.replace(this.uri, new vscode.Range(document.positionAt(spec.start), document.positionAt(spec.end)), spec.text);
                }
            }
            if (failed) {
                this.panel.webview.postMessage({ type: 'focusesMoved', ok: false });
                return;
            }
            const ok = await vscode.workspace.applyEdit(edit);
            this.panel.webview.postMessage({ type: 'focusesMoved', ok });
        } catch (e) {
            error(e);
            this.panel.webview.postMessage({ type: 'focusesMoved', ok: false });
        }
    }

    /**
     * Deletes the focus blocks with the given ids from the previewed document (one undoable
     * WorkspaceEdit covering the whole line of each block).
     */
    private async deleteFocuses(ids: string[]): Promise<void> {
        try {
            const document = getDocumentByUri(this.uri);
            Logger.info(`ftdelete: ids=${JSON.stringify(ids)} doc=${document ? 'yes' : 'NO'} uri=${this.uri.toString()}`);
            if (!document) {
                return;
            }
            const text = document.getText();
            const specs = buildDeleteFocusEdits(text, ids ?? []);
            Logger.info(`ftdelete: textLen=${text.length} specs=${specs.length}${specs.map(s => ` [${s.start}..${s.end}]`).join('')}`);
            if (specs.length === 0) {
                return;
            }
            const edit = new vscode.WorkspaceEdit();
            for (const spec of specs) {
                edit.delete(this.uri, new vscode.Range(document.positionAt(spec.start), document.positionAt(spec.end)));
            }
            const ok = await vscode.workspace.applyEdit(edit);
            Logger.info(`ftdelete: applyEdit ok=${ok}`);
        } catch (e) {
            error(e);
        }
    }

    /**
     * Inserts a new focus block just before the closing brace of the last focus_tree block.
     * The name/description go in as comments (no localisation entries); the id is required.
     */
    private async createFocus(focus: { id: string; name?: string; desc?: string; icon?: string; cost?: number; x?: number; y?: number }): Promise<void> {
        try {
            const document = getDocumentByUri(this.uri);
            if (!document || !focus?.id) {
                return;
            }
            const text = document.getText();
            const insertPos = findFocusTreeInsertPosition(text);
            if (insertPos === undefined) {
                return;
            }
            const edit = new vscode.WorkspaceEdit();
            edit.insert(this.uri, document.positionAt(insertPos), '\n' + buildFocusInsertBlock(focus));
            await vscode.workspace.applyEdit(edit);
        } catch (e) {
            error(e);
        }
    }

    /**
     * Two-stage picker protocol, phase 1: sends just the sorted icon-name list (cheap, served from
     * the file/parse caches) so the webview can render the grid immediately with placeholders, then
     * starts the background stream that resolves images in batches and pushes them as they complete.
     */
    private async sendFocusIconNames(): Promise<void> {
        try {
            const names = await collectFocusIconNames();
            if (this.isDisposed) {
                return;
            }
            this.panel.webview.postMessage({ type: 'focusIconNames', names, total: names.length });
            // Few icons: push them all up front so the picker fills progressively without any
            // per-window request traffic. Many icons: let the webview pull only what its visible
            // window needs, so the host does not decode hundreds of images the user never scrolls to.
            if (names.length <= pickerIconPullThreshold) {
                void this.requestIconImages(names);
            }
        } catch (e) {
            error(e);
        }
    }

    /**
     * Resolves picker icon names to data URIs in batches and streams them to the webview (phase 2
     * of the two-stage protocol). Names already in the session memo resolve instantly; a short
     * debounce coalesces bursts of pull requests (e.g. window-scroll driven) into a single flush.
     */
    private async requestIconImages(names: string[]): Promise<void> {
        const missing: string[] = [];
        for (const name of names ?? []) {
            if (this.resolvedIconImages.has(name) || this.inFlightIconImages.has(name) || this.pendingIconImageRequests.has(name)) {
                continue;
            }
            this.pendingIconImageRequests.add(name);
            missing.push(name);
        }
        if (missing.length === 0) {
            return;
        }
        if (this.iconImageFlushTimer === undefined) {
            this.iconImageFlushTimer = setTimeout(() => void this.flushIconImageRequests(), 100);
        }
    }

    private async flushIconImageRequests(): Promise<void> {
        this.iconImageFlushTimer = undefined;
        const names = [...this.pendingIconImageRequests];
        this.pendingIconImageRequests.clear();
        if (names.length === 0 || this.isDisposed) {
            return;
        }
        const missing = names.filter(n => !this.resolvedIconImages.has(n) && !this.inFlightIconImages.has(n));
        if (missing.length === 0) {
            return;
        }
        await resolveFocusIconImages(missing, {
            batchSize: 16,
            resolver: (name) => this.getPickerImageUri(name),
            onBatch: (batch, done) => {
                for (const item of batch) {
                    this.resolvedIconImages.set(item.name, item.imageUri);
                }
                if (!this.isDisposed) {
                    this.panel.webview.postMessage({ type: 'focusIconImages', images: batch, done });
                }
            },
        });
    }

    // Resolves a single picker icon to its data URI. The in-flight promise is shared so a repeated
    // request during a flush never double-decodes, and the result (including a negative) is memoized
    // so a later request for the same name returns instantly.
    private async getPickerImageUri(name: string): Promise<string | undefined> {
        if (this.resolvedIconImages.has(name)) {
            return this.resolvedIconImages.get(name);
        }
        const existing = this.inFlightIconImages.get(name);
        if (existing) {
            return existing;
        }
        const promise = (async () => {
            try {
                return (await getFocusIconPickerImage(name))?.uri;
            } catch {
                return undefined;
            }
        })();
        this.inFlightIconImages.set(name, promise);
        try {
            const uri = await promise;
            this.resolvedIconImages.set(name, uri);
            return uri;
        } finally {
            this.inFlightIconImages.delete(name);
        }
    }

    private repushCachedIconStyles(): void {
        if (this.lastPushedIconCss !== undefined && this.lastPushedIconGeneration === this.iconRenderGeneration && !this.isDisposed) {
            this.panel.webview.postMessage({ type: 'iconStyles', css: this.lastPushedIconCss });
        }
    }

    /**
     * Prewarms the localised display names for the given focus ids (using the editor language) and
     * posts them back to the webview for its ID/name toggle. The localisation index is built on
     * demand here (and lazily in the background otherwise), so the toggle works without the
     * localisationIndex setting; opening this preview already upgraded a pending background build
     * to the fast path, so this await is never subject to the slow build.
     */
    private async sendFocusNames(ids: string[]): Promise<void> {
        try {
            await ensureLocalisationIndex();
            if (this.isDisposed) {
                return;
            }
            const language = vscode.env.language;
            const names: Record<string, string> = {};
            for (const id of ids) {
                const name = getLocalisedTextUnchecked(id, language);
                if (name !== undefined && name !== id) {
                    names[id] = name;
                }
            }
            this.panel.webview.postMessage({ type: 'focusNames', names });
        } catch (e) {
            error(e);
        }
    }

    // 这些设置会改变页面网格、焦点标记或连线取帧，改了就整页重载（焦点树的渲染结果随设置变化，
    // 而不是随文档内容变化）。inlayWindowGfxRoots 以前没有任何监听，修好缺失的内插贴图要等下次编辑。
    protected override get reloadOnConfigurationChange(): readonly string[] {
        return [
            'useConditionInFocus',
            'focusTreeLayout',
            'focusTreePrerequisiteLines',
            'focusOverlayGfxFiles',
            'sharedFocusIndex',
            'inlayWindowGfxRoots',
            'gfxIndex',
            'localisationIndex',
            'previewLocalisation',
        ];
    }

    private repushCachedUpdate(): void {
        if (this.lastUpdateMessage !== undefined && this.lastUpdateGeneration === this.iconRenderGeneration && !this.isDisposed) {
            this.panel.webview.postMessage(this.lastUpdateMessage);
        }
    }

    private fingerprintsFor(payload: FocusTreePayload): FocusTreeFingerprints {
        // Always computed from a structure-only payload so the same edit fingerprints identically
        // whether or not the (real-icon) background pass has run.
        const styleRecords = (payload.styleTable as any).records as Record<string, string>;
        return {
            structural: computeStructuralFingerprint({
                focusTrees: payload.focusTrees,
                renderedFocus: payload.renderedFocus,
                renderedInlayWindows: payload.renderedInlayWindows,
                gridBox: payload.gridBox,
                useConditionInFocus: payload.useConditionInFocus,
                xGridSize: payload.xGridSize,
                styleRecords,
            }),
            iconSource: computeIconSourceFingerprint(styleRecords),
        };
    }

    // Object-level fingerprints of the parsed trees. gridBox 与 xGridSize 由布局派生，和完整载荷
    // 携带的值一致，让早退分支不必持有 payload 就能与已渲染基线比较。
    // The localisation config is deliberately NOT folded in: the focus-tree render never embeds localised
    // text, so a config flip cannot change the rendered structure and must not move the hash. Read the
    // layout-derived inputs here per call so the early-out compare and the baseline seed use the same values.
    private treeFingerprintsFor(focusTrees: FocusTree[], layout: FocusTreeLayout): { structural: string; icon: string } {
        return {
            structural: computeTreeStructuralFingerprint({
                focusTrees,
                gridBox: focusTreeGridBoxFor(layout),
                useConditionInFocus,
                xGridSize: layout.spacing.x,
            }),
            icon: computeTreeIconFingerprint(focusTrees),
        };
    }

    // Seeds the text-hash early-out state. Only ever called with a hash/length that is paired with
    // the rendered baseline (the text the structure on screen was built from); failure paths must
    // not call it, so a later identical-text event retries instead of being swallowed.
    private seedTextState(hash: number, length: number): void {
        this.lastTextHash = hash;
        this.lastTextLength = length;
    }

    public onDocumentChange(document: vscode.TextDocument, dependencyChanged = false): Promise<void> {
        // Chain onto the previous update so renders are serialized. By the time a queued
        // render runs it reads the live document text, coalescing intermediate edits.
        const run = this.updateQueue.then(() => super.onDocumentChange(document, dependencyChanged));
        this.updateQueue = run.catch(() => undefined);
        return run;
    }

    protected async getContent(document: vscode.TextDocument, dependencyChanged = false): Promise<string> {
        this.content = document.getText();
        // Captured synchronously at entry: the loader's content provider reads the same text (the
        // parse starts in the same sync slice), so this is the text the rendered baseline was built
        // from. Using it (not a later document.getText(), which could reflect an edit that landed
        // during the await) keeps lastTextHash/lastTextLength paired with lastTreeStructural.
        const contentHash = fnv1a(this.content);
        const contentLength = this.content.length;
        const generation = ++this.iconRenderGeneration;
        // A full (re)render embeds the current structure directly in the returned html, so any cached
        // in-place update belongs to a superseded page and must never be re-posted over this render.
        this.lastUpdateMessage = undefined;
        this.webviewReady = new Promise<void>(resolve => { this.signalWebviewReady = resolve; });
        const progress = (message: string, current?: number, total?: number) => {
            this.panel.webview.postMessage({ type: 'progress', message, current, total });
        };
        this.focusTreeLoader.setProgressListener(progress);
        try {
            // Phase 1 (cheap): render the focus-tree structure with placeholder icons so the tree
            // appears immediately even when the (slow) DDS->PNG icon conversion would blow the
            // render budget. The timeout now only guards this fast structural pass. (plan Stap 3)
            const structure = await withTimeout(
                buildFocusTreePayload(this.focusTreeLoader, progress, { resolveIcons: false, dependencyChanged }),
                focusTreeRenderTimeout,
                () => {
                    progress(localize('focustree.loading.slow', 'Still working on a heavy focus tree...'));
                    return new TimeoutError();
                },
            );
            if (structure) {
                const fingerprints = this.fingerprintsFor(structure);
                this.lastStructuralFingerprint = fingerprints.structural;
                this.lastIconSourceFingerprint = fingerprints.iconSource;
                const treeFingerprints = this.treeFingerprintsFor(structure.focusTrees, structure.layout);
                this.lastTreeStructural = treeFingerprints.structural;
                this.lastTreeIcon = treeFingerprints.icon;
                this.seedTextState(contentHash, contentLength);
                this.lastToolbarFlags = structure.toolbarFlags;
                this.lastGoodHadFocusTrees = true;
                this.lastFocusTrees = structure.focusTrees;
                // Phase 2 (background): resolve the real focus icons and stream their CSS into the
                // already-visible preview. No hard timeout: slow icons fill in when ready.
                void this.pushIconStyles(generation);
                return await buildFocusTreeHtml(structure, this.panel.webview, document.uri);
            }

            this.lastStructuralFingerprint = undefined;
            this.lastIconSourceFingerprint = undefined;
            this.lastTreeStructural = undefined;
            this.lastTreeIcon = undefined;
            this.lastTextHash = undefined;
            this.lastTextLength = -1;
            this.lastToolbarFlags = undefined;
            this.lastGoodHadFocusTrees = false;
            this.lastFocusTrees = [];
            return buildNoFocusTreeHtml(this.panel.webview, document.uri);
        } catch (e) {
            // Timeout or unexpected failure: show a recoverable panel with a Reload button
            // instead of leaving the user stuck on a dead loading spinner.
            error(e);
            // The error page carries no update listener, so reset the structure state (mirroring the
            // no-tree branch above). Clearing lastToolbarFlags makes the next edit take the full-reload
            // path via the toolbar-flags mismatch instead of posting into a listener-less page or
            // skipping forever on a stale fingerprint. (lastUpdateMessage was already cleared on entry.)
            this.lastStructuralFingerprint = undefined;
            this.lastIconSourceFingerprint = undefined;
            this.lastTreeStructural = undefined;
            this.lastTreeIcon = undefined;
            this.lastTextHash = undefined;
            this.lastTextLength = -1;
            this.lastToolbarFlags = undefined;
            this.lastGoodHadFocusTrees = false;
            this.lastFocusTrees = [];
            return buildFocusTreeErrorHtml(this.panel.webview, document.uri, e);
        } finally {
            this.focusTreeLoader.setProgressListener(undefined);
            this.content = undefined;
        }
    }

    /**
     * Resolves the real focus-icon images (the expensive DDS->PNG pass) in the background and
     * streams the resulting CSS into the already-rendered structure via an `iconStyles` message.
     * Waits for the webview's `ready` signal so the message is never dropped, and drops itself if a
     * newer load superseded it (generation mismatch) or the panel was disposed.
     */
    private async pushIconStyles(generation: number): Promise<void> {
        try {
            const full = await buildFocusTreePayload(this.focusTreeLoader);
            if (!full || generation !== this.iconRenderGeneration || this.isDisposed) {
                return;
            }
            await this.webviewReady;
            if (generation !== this.iconRenderGeneration || this.isDisposed) {
                return;
            }
            const css = full.styleTable.toRawCss();
            this.lastPushedIconCss = css;
            this.lastPushedIconGeneration = generation;
            this.panel.webview.postMessage({ type: 'iconStyles', css });
            // Background warm-up for the create-focus picker: resolve a bounded set of picker icons
            // into the shared imageCache while the preview is idle, so a later picker open (which
            // reuses that cache) starts warm. Best-effort and low-concurrency so it never competes
            // with the preview's own icon streaming.
            void this.prewarmPickerIcons();
        } catch (e) {
            error(e);
        }
    }

    // Resolves a bounded prefix of the picker icon list into the shared image caches. Only runs when
    // the picker has not already resolved icons (resolvedIconImages empty), so a picker opened
    // before the preview finished never triggers a duplicate scan. Fire-and-forget: a failure here
    // only means the picker opens colder.
    private async prewarmPickerIcons(): Promise<void> {
        try {
            if (this.resolvedIconImages.size > 0) {
                return;
            }
            const names = await collectFocusIconNames();
            await resolveFocusIconImages(names.slice(0, pickerIconPullThreshold), { limit: 4 });
        } catch { /* prewarm is best-effort */ }
    }

    protected getLoadingShellHtml(): string {
        return loadingShellHtml(localize('focustree.loading.start', 'Preparing focus tree...'));
    }

    protected async sendPartialUpdate(document: vscode.TextDocument, dependencyChanged = false): Promise<void> {
        if (!this.panel.visible) {
            // A hidden panel silently drops posted messages and never refreshes the stored
            // webview.html, so an in-place update would be lost while its advanced fingerprint made
            // later identical edits skip forever, and a re-show would restore stale structure. Take
            // the full-reload path: getContent writes webview.html directly (works while hidden) and
            // re-derives the fingerprints; its phase-2 icon push waits on webviewReady, which fires
            // from the `ready` handler when the panel is shown and the reloaded webview loads.
            this.panelInitialized = false;
            await super.onDocumentChange(document);
            return;
        }
        this.content = document.getText();
        const textHash = fnv1a(this.content);
        // Text-hash early-out (cheaper than the object-level one below): unchanged text and no
        // dependency change means the parsed FocusTree[] is byte-identical, so skip the object-level
        // load and its fingerprint serialization entirely. This fires on the common while-typing
        // pattern where an edit is undone back to a previously-seen document (identical fnv1a).
        // The baseline guard mirrors the object-level early-out below: the hash is only trusted when
        // a successful render seeded it at the same point as lastTreeStructural. lastTextHash is
        // advanced only on success paths (below), so a failed pass leaves it stale and the next
        // identical-text event retries instead of being swallowed.
        if (shouldSkipTextEarlyOut({
            textHash,
            lastTextHash: this.lastTextHash,
            textLength: this.content.length,
            lastTextLength: this.lastTextLength,
            dependencyChanged,
            hasBaseline: this.lastTreeStructural !== undefined,
        })) {
            this.lastGoodHadFocusTrees = true;
            return;
        }
        try {
            // Object-level early-out (bug #37): parse the focus trees only and, before paying for any
            // per-focus HTML/style rendering, skip when the parsed structure and icon set are both
            // unchanged. loadFocusTreesOnly shares the loader's content-hash cache, so the fall-through
            // buildFocusTreePayload reuses this same parse -- there is no double parse.
            let trees: { focusTrees: FocusTree[]; layout: FocusTreeLayout } | null = null;
            try {
                trees = await withTimeout(loadFocusTreesOnly(this.focusTreeLoader, dependencyChanged), focusTreeRenderTimeout);
            } catch (e) {
                // A slow/stuck object-level load must not throw; drop the early-out and let the existing
                // structure pass (with its own timeout handling) take over.
                error(e);
                trees = null;
            }
            if (trees !== null && !dependencyChanged &&
                this.lastTreeStructural !== undefined && this.lastTreeIcon !== undefined) {
                const treeFingerprints = this.treeFingerprintsFor(trees.focusTrees, trees.layout);
                if (treeFingerprints.structural === this.lastTreeStructural && treeFingerprints.icon === this.lastTreeIcon) {
                    // Unchanged parsed structure + icon set and no dependency changed => the focuses and
                    // icons already on screen are current, so we can skip the whole render (mirrors the
                    // post-render skip below). !dependencyChanged is required: a dependency (resolved icon
                    // bytes, .gfx sprite swap, .gui window) alters the render without touching the FocusTree
                    // objects, so its fingerprint would not move. Localised names are never embedded in the
                    // render (they are resolved on demand by the webview ID/name toggle), so a .yml edit
                    // cannot change the structure and needs no special-case here.
                    this.lastGoodHadFocusTrees = true;
                    // The text changed (otherwise the text-hash early-out above would have fired), but
                    // the parsed structure did not: re-seed the text state so a later identical-text
                    // event can use the cheaper text-hash early-out. The entry hash is safe here: the
                    // object-level fingerprints matched, so the structure for this text is already on
                    // screen.
                    this.seedTextState(textHash, this.content.length);
                    return;
                }
            }

            // Cheap structure-only pass: the rendered focus/inlay HTML is identical to a full render,
            // only the styleTable's icon CSS differs. That lets us fingerprint the change without
            // paying for the expensive DDS->PNG icon resolution on every keystroke (bug #37).
            let structure: FocusTreePayload | null = null;
            try {
                structure = await withTimeout(
                    buildFocusTreePayload(this.focusTreeLoader, undefined, { resolveIcons: false, dependencyChanged }),
                    focusTreeRenderTimeout,
                );
            } catch (e) {
                // Slow/stuck transient render: keep the current preview rather than flipping to
                // an error or empty state. A later edit (or reload) will refresh it.
                error(e);
                return;
            }

            if (structure === null) {
                if (this.lastGoodHadFocusTrees) {
                    // Transient empty result (e.g. mid-save race or in-progress edit). Keep the
                    // last good render instead of showing "No focus tree".
                    return;
                }
                // No good render yet and the file is genuinely empty: do a full reload so the
                // "No focus tree" panel is shown. Use the base (non-queued) method to avoid
                // deadlocking on the update queue we are already running inside.
                this.panelInitialized = false;
                await super.onDocumentChange(document);
                return;
            }

            if (!toolbarFlagsEqual(structure.toolbarFlags, this.lastToolbarFlags)) {
                // The toolbar lives in the baked-in shell, not in the updatable content, so a
                // change to which toggles it shows needs a full HTML reload.
                this.panelInitialized = false;
                await super.onDocumentChange(document);
                return;
            }

            const fingerprints = this.fingerprintsFor(structure);
            const previous: FocusTreeFingerprints | undefined =
                this.lastStructuralFingerprint === undefined || this.lastIconSourceFingerprint === undefined
                    ? undefined
                    : { structural: this.lastStructuralFingerprint, iconSource: this.lastIconSourceFingerprint };
            const decision = decideFocusTreeUpdate(previous, fingerprints);

            // A dependency .gfx edit can swap a sprite's texturefile without changing the structure
            // or the icon identity (same GFX name -> same icon key), so neither fingerprint moves.
            // previewmanager re-invokes us with our OWN document even for a dependency change, so the
            // document identity can't flag it; the dependencyChanged signal, threaded from the
            // subscription path, is what forces the (expensive) icon re-resolution in that case.
            const forceIcons = dependencyChanged;

            if (!decision.postUpdate && !decision.pushIcons && !forceIcons) {
                // Nothing the webview renders changed (the common while-typing case): skip entirely.
                this.lastGoodHadFocusTrees = true;
                // The rendered structure is current for this text (the fingerprints matched), so the
                // text state can be seeded for the cheaper text-hash early-out on a later event.
                // Seed from the loader's parsed-content hash: it is the text the structure pass
                // actually parsed (the entry snapshot may be stale after the load's IO window).
                this.seedTextState(this.focusTreeLoader.parsedContentHash, this.focusTreeLoader.parsedContentLength);
                return;
            }

            this.lastStructuralFingerprint = fingerprints.structural;
            this.lastIconSourceFingerprint = fingerprints.iconSource;
            const treeFingerprints = this.treeFingerprintsFor(structure.focusTrees, structure.layout);
            this.lastTreeStructural = treeFingerprints.structural;
            this.lastTreeIcon = treeFingerprints.icon;
            // The render baseline now matches the text the structure pass parsed (the loader's
            // parsed-content hash/length, updated by shouldReloadImpl before the load and read back
            // with no await between the load and here), so the text state is seeded together with
            // it. Failure paths above never reach here, keeping the seed paired with a real baseline.
            this.seedTextState(this.focusTreeLoader.parsedContentHash, this.focusTreeLoader.parsedContentLength);
            this.lastToolbarFlags = structure.toolbarFlags;
            this.lastGoodHadFocusTrees = true;
            this.lastFocusTrees = structure.focusTrees;

            if (decision.postUpdate) {
                const updateMsg: FocusTreeUpdatePayload & { type: string } = {
                    type: 'update',
                    focusTrees: structure.focusTrees,
                    renderedFocus: structure.renderedFocus,
                    renderedInlayWindows: structure.renderedInlayWindows,
                    gridBox: structure.gridBox,
                    useConditionInFocus: structure.useConditionInFocus,
                    xGridSize: structure.xGridSize,
                    layout: structure.layout,
                };
                this.panel.webview.postMessage(updateMsg);
                this.lastUpdateMessage = updateMsg;
            }

            if (decision.pushIcons || forceIcons) {
                await this.repushResolvedIconStyles();
            }

            // Re-tag the cached update with the current generation (bumped by repushResolvedIconStyles
            // if it ran) so it stays in lockstep with the icon cache and a later full reload, which
            // bumps the generation, invalidates it. The cached update still reflects the current
            // structure here: a full reload would have cleared it, and decision.postUpdate === false
            // only when the structure is unchanged from the last render.
            if (this.lastUpdateMessage !== undefined) {
                this.lastUpdateGeneration = this.iconRenderGeneration;
            }
        } finally {
            this.content = undefined;
        }
    }

    /**
     * Icon identities changed: resolve the real icons and refresh the pushed CSS. Awaited (not
     * backgrounded) so it stays on the update queue and never runs a second concurrent load against
     * the loader. The `#ft-progressive-icons` element the CSS lands in survives the webview's
     * in-place DOM rebuild, so this needs no full reload.
     */
    private async repushResolvedIconStyles(): Promise<void> {
        let full: FocusTreePayload | null = null;
        try {
            full = await withTimeout(buildFocusTreePayload(this.focusTreeLoader), focusTreeRenderTimeout);
        } catch (e) {
            // Slow icon pass: keep the previously pushed icons rather than blanking them.
            error(e);
            return;
        }
        if (!full || this.isDisposed) {
            return;
        }
        // Advance the generation so a still-in-flight background pushIconStyles from an earlier load
        // fails its post-await guard instead of overwriting this newer icon CSS (and the cache).
        // The bump + tag + post run without an await between them, so the older push can only post
        // before the bump (then this fresh post lands after it) or drop after seeing the new value.
        const generation = ++this.iconRenderGeneration;
        const css = full.styleTable.toRawCss();
        this.lastPushedIconCss = css;
        this.lastPushedIconGeneration = generation;
        this.panel.webview.postMessage({ type: 'iconStyles', css });
    }

    // Called by PreviewManager when the GFX sprite index finishes building. If this preview
    // resolved its icons while the index was still building (a panel restored right after VS Code
    // startup, racing the background build), the misses were permanently rendered as the
    // goal_unknown/grey fallback. The index is ready now, so re-resolve and re-push the icon CSS.
    // Guarded on a successfully rendered tree: loading/error/no-tree pages have no pushed icon CSS
    // to refresh, and their pending or next full load already sees the completed index.
    public refreshIcons(): void {
        if (this.isDisposed || this.lastStructuralFingerprint === undefined) {
            return;
        }
        // Drop picker negative-cache entries (undefined image URIs) so icons the picker resolved
        // as unresolvable while the index was building are retried on the next pull instead of
        // staying memoized as permanent misses.
        for (const [name, imageUri] of this.resolvedIconImages) {
            if (imageUri === undefined) {
                this.resolvedIconImages.delete(name);
            }
        }
        // Chain onto the update queue like every other render: repushResolvedIconStyles runs a
        // full load against the loader and must never run concurrently with a pending update.
        const run = this.updateQueue.then(() => this.repushResolvedIconStyles());
        this.updateQueue = run.catch(() => undefined);
    }
}

export const focusTreePreviewDef: PreviewProviderDef = {
    type: 'focustree',
    displayName: () => localize('preview.type.focustree', 'Focus tree (common/national_focus/*.txt)'),
    canPreview: canPreviewFocusTree,
    previewConstructor: FocusTreePreview,
};

// Per-file preview UI state (conditions, name mode, toggles, ...) persisted across panel
// close/reopen. Keyed by the previewed file's URI so each focus file keeps its own settings.
function previewUiStateKey(uri: vscode.Uri): string {
    return 'focustreePreviewState.' + encodeURIComponent(uri.toString());
}

async function savePreviewUiState(preview: FocusTreePreview, state: unknown): Promise<void> {
    try {
        await contextContainer.current?.globalState.update(previewUiStateKey(preview.uri), state ?? {});
    } catch (e) {
        error(e);
    }
}

async function sendPreviewUiState(preview: FocusTreePreview): Promise<void> {
    try {
        const state = await contextContainer.current?.globalState.get(previewUiStateKey(preview.uri));
        if (preview.isDisposed) {
            return;
        }
        preview.panel.webview.postMessage({ type: 'uiState', state: state ?? {} });
    } catch (e) {
        error(e);
    }
}

// Legacy single-shot picker payload: all icon names with their images resolved in one message.
// Kept only for webview panels that request without the v:2 flag (loaded before this extension
// update and not yet reloaded); the two-stage protocol on FocusTreePreview replaces it for new
// panels.
async function sendFocusIcons(preview: FocusTreePreview): Promise<void> {
    try {
        const names = await collectFocusIconNames();
        const icons = await resolveFocusIconImages(names);
        if (preview.isDisposed) {
            return;
        }
        preview.panel.webview.postMessage({ type: 'focusIcons', icons });
    } catch (e) {
        error(e);
    }
}
