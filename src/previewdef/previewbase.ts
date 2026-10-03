import * as vscode from 'vscode';
import { localize } from '../util/i18n';
import { error, debug } from '../util/debug';
import { getDocumentByUri } from '../util/vsccommon';
import { isEqual } from 'lodash';
import { sendByMessage } from '../util/telemetry';
import { loadingShellHtml } from '../util/html';
import { openOrCopyHoiFile } from '../util/previewfileopener';
import { setPreviewOption } from '../util/previewoptions';
import { ConfigurationKey } from '../constants';
import { Logger } from '../util/logger';

export abstract class PreviewBase {
    private cachedDependencies: string[] | undefined = undefined;

    private dependencyChangedEmitter = new vscode.EventEmitter<string[]>();
    public onDependencyChanged = this.dependencyChangedEmitter.event;

    private disposeEmitter = new vscode.EventEmitter<undefined>();
    public onDispose = this.disposeEmitter.event;

    private disposed = false;
    // Everything subscribed on the panel. Released in dispose() so a closed panel stops holding
    // the preview (and its cached dependencies) through its subscriptions.
    protected readonly subscriptions: vscode.Disposable[] = [];
    // Renders run one at a time, so a slow render can never land after a newer one and overwrite
    // it. A queued render reads the live document when it starts, so edits in between coalesce.
    private renderQueue: Promise<void> = Promise.resolve();
    protected panelInitialized = false;

    constructor(
        readonly uri: vscode.Uri,
        readonly panel: vscode.WebviewPanel,
    ) {
        this.registerEvents(panel);
    }

    public onDocumentChange(document: vscode.TextDocument, dependencyChanged = false): Promise<void> {
        return this.enqueueRender(() => this.renderDocument(document, dependencyChanged));
    }

    protected enqueueRender(task: () => Promise<void>): Promise<void> {
        const run = this.renderQueue.then(task);
        this.renderQueue = run.catch(() => undefined);
        return run;
    }

    private async renderDocument(document: vscode.TextDocument, dependencyChanged: boolean): Promise<void> {
        if (this.disposed) {
            return;
        }
        try {
            if (!this.panelInitialized) {
                await this.renderFullContent(document, dependencyChanged);
            } else {
                await this.sendPartialUpdate(document, dependencyChanged);
            }
        } catch(e) {
            error(e);
        }
    }

    /**
     * Writes the full page html and marks the panel initialized. Runs in place without enqueueing,
     * so a partial update that discovers it needs a full reload -- the toolbar shell changed, the
     * page was torn down while hidden, the tree became empty -- can call it from inside the render
     * queue; enqueueing another render there would deadlock on the queue it is already running on.
     */
    protected async renderFullContent(document: vscode.TextDocument, dependencyChanged = false): Promise<void> {
        if (this.disposed) {
            return;
        }
        const html = await this.getContent(document, dependencyChanged);
        if (this.disposed) {
            return;
        }
        this.panel.webview.html = html;
        this.panelInitialized = true;
    }

    protected async sendPartialUpdate(document: vscode.TextDocument, dependencyChanged = false): Promise<void> {
        this.panel.webview.html = await this.getContent(document, dependencyChanged);
    }
    
    public dispose(): void {
        if (this.disposed) {
            return;
        }
        vscode.Disposable.from(...this.subscriptions).dispose();
        this.subscriptions.length = 0;
        this.dependencyChangedEmitter.dispose();
        this.disposed = true;
        this.disposeEmitter.fire(undefined);
        this.disposeEmitter.dispose();
    }

    public get isDisposed(): boolean {
        return this.disposed;
    }

    public async initializePanelContent(document: vscode.TextDocument): Promise<void> {
        this.panelInitialized = false;
        this.panel.webview.html = this.getLoadingShellHtml();
        await this.onDocumentChange(document);
    }

    protected getLoadingShellHtml(): string {
        return loadingShellHtml(localize('preview.loading', 'Loading preview...'));
    }

    protected registerEvents(panel: vscode.WebviewPanel): void {
        this.subscriptions.push(panel.webview.onDidReceiveMessage((msg) => {
            if (msg === null || typeof msg !== 'object') {
                return;
            }
            switch (msg.command) {
                case 'navigate':
                    // `end` is optional in the protocol; a message that names only the start selects
                    // the single character at it.
                    if (typeof msg.start === 'number') {
                        if (msg.file == null) {
                            const document = getDocumentByUri(this.uri);
                            if (document === undefined) {
                                return;
                            }
        
                            vscode.window.showTextDocument(this.uri, {
                                selection: new vscode.Range(document.positionAt(msg.start), document.positionAt(typeof msg.end === 'number' ? msg.end : msg.start)),
                                viewColumn: vscode.ViewColumn.One
                            });
                        } else {
                            void this.openOrCopyFile(msg.file, msg.start, typeof msg.end === 'number' ? msg.end : undefined);
                        }
                    }
                    break;
                case 'telemetry':
                    sendByMessage(msg);
                    break;
                case 'reload':
                    this.reload();
                    break;
                // A toolbar toggle the reader flipped. Held on this side because the webview's own
                // state dies with the panel; see previewoptions.ts.
                case 'setPreviewOption':
                    if (typeof msg.key === 'string') {
                        void this.onPreviewOptionSet(msg.key, msg.value);
                    }
                    break;
                // A diagnostic line a preview page reports about its own state; written to the
                // HOI4 Modding channel so a blank page can be investigated without the webview
                // developer tools.
                case 'debug':
                    if (typeof msg.message === 'string') {
                        Logger.info(`[page] ${msg.message}`);
                    }
                    break;
            }
        }));
        
        this.subscriptions.push(panel.onDidDispose(() => {
            this.dispose();
        }));

        // registerFeatureFlags subscribes to this same event during activation, long before any
        // preview exists, and VS Code fires listeners in subscription order -- so the module flags
        // a render reads are already refreshed by the time this runs.
        const keys = this.reloadOnConfigurationChange;
        if (keys.length > 0) {
            this.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
                if (keys.some(key => e.affectsConfiguration(`${ConfigurationKey}.${key}`))) {
                    this.reload(this.configurationChangeForcesReload);
                }
            }));
        }
    }

    /**
     * Settings whose change makes this preview's rendered page stale, without the `mdHoi4Utilities.`
     * prefix. A getter rather than a field: registerEvents runs from the constructor, before a
     * subclass's field initializers have, and a field would still be undefined there.
     */
    protected get reloadOnConfigurationChange(): readonly string[] {
        return [];
    }

    /**
     * Whether a configuration-driven reload has to force the loader session. Almost always yes: a
     * setting change does not move the document's hash, so without it the loader answers from its
     * cache and the page repaints exactly what it had. A preview that reads its settings while
     * rendering, rather than through a loader, can leave this false.
     */
    protected get configurationChangeForcesReload(): boolean {
        return true;
    }
    
    /**
     * Persists a toolbar option the page just changed. Most previews draw the option themselves and
     * need nothing more; one whose content is rendered on this side overrides this to re-render
     * after the write, which is why the write is awaited rather than fired and forgotten.
     */
    protected async onPreviewOptionSet(key: string, value: unknown): Promise<void> {
        await setPreviewOption(key, value);
    }

    protected updateDependencies(dependencies: string[]): void {
        if (this.cachedDependencies === undefined || !isEqual(this.cachedDependencies, dependencies)) {
            this.dependencyChangedEmitter.fire(dependencies);
            debug("dependencies: ", this.uri.toString(), JSON.stringify(dependencies));
        }

        this.cachedDependencies = dependencies;
    }

    protected async openOrCopyFile(file: string, start: number | undefined, end: number | undefined): Promise<void> {
        await openOrCopyHoiFile(file, start, end, {
            viewColumn: vscode.ViewColumn.One,
            mustOpenFolderMessage: localize('preview.mustopenafolder', 'Must open a folder before opening "{0}".', file),
            selectFolderMessage: localize('preview.selectafolder', 'Select a folder to copy "{0}"', file),
            failedToOpenMessage: (errorMessage) => localize('preview.failedtoopen', 'Failed to open file "{0}": {1}.', file, errorMessage),
        });
    }

    // `dependencyChanged` forces the loader session the re-render runs in. A reload triggered by
    // something other than the document -- a setting change -- does not move the document's hash, so
    // without it a loader answers from its cache and the page repaints exactly what it had.
    protected reload(dependencyChanged = false) {
        const document = getDocumentByUri(this.uri);
        if (document === undefined) {
            return;
        }

        this.panelInitialized = false;
        void this.onDocumentChange(document, dependencyChanged);
    }

    // PreviewManager calls this when a background index (the GFX sprite index) finishes building.
    // A preview that resolved sprites while the index was still in flight may have lost the misses
    // permanently: an index miss is authoritative in index mode and nothing else re-triggers icon
    // resolution. Default is a no-op, and only FocusTreePreview opts in (its icon CSS re-push is
    // cheap and state-safe). The other previews skip self-healing deliberately: the index wait in
    // getGfxContainerFile already removes their loss window on startup restore, and a full reload
    // would disturb their interactive state for the marginal residual gap (workspace-folder
    // rebuilds and failed rebuilds).
    public refreshIcons(): void {
    }

    protected abstract getContent(document: vscode.TextDocument, dependencyChanged?: boolean): Promise<string>;
}
