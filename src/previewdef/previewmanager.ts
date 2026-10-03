import * as vscode from 'vscode';
import { focusTreePreviewDef } from './focustree';
import { localize } from '../util/i18n';
import { gfxPreviewDef } from './gfx';
import { Commands, WebviewType, ContextName } from '../constants';
import { technologyPreviewDef } from './technology';
import { matchPathEnd } from '../util/nodecommon';
import { debounceByInput } from '../util/common';
import { debug, error } from '../util/debug';
import { PreviewBase } from './previewbase';
import { contextContainer, setVscodeContext } from '../context';
import { basename, getDocumentByUri } from '../util/vsccommon';
import { onGfxIndexBuilt } from '../util/gfxindex';
import { invalidateFileDiscoveryCache } from '../util/fileloader';
import { worldMapPreviewDef } from './worldmap';
import { eventPreviewDef } from './event';
import { chain } from 'lodash';
import { sendEvent } from '../util/telemetry';
import { guiPreviewDef } from './gui';
import { mioPreviewDef } from './mio';
import { ideaPreviewDef } from './idea';
import { characterPreviewDef } from './character';
import { decisionPreviewDef } from './decision';
import { bopPreviewDef } from './bop';

interface PreviewProviderDefCommon {
    type: string;
    /**
     * What the "can't preview this file" message calls this preview, naming the paths it
     * recognises -- that is the half of the answer the reader can act on.
     *
     * A function rather than a string: these defs are module-level constants, and a localize()
     * call at module load would freeze the English text in before extension.ts runs loadI18n().
     */
    displayName(): string;
    /**
     * False when the preview's feature-flag setting is off, so the message does not offer a type
     * that would refuse the file anyway. Omitted by the previews that are always on.
     */
    isEnabled?(): boolean;
    canPreview(document: vscode.TextDocument): number | undefined;
}

export type PreviewProviderDef = PreviewProviderDefNormal | PreviewProviderDefAlternative;

interface PreviewProviderDefNormal extends PreviewProviderDefCommon {
    previewConstructor: new (uri: vscode.Uri, panel: vscode.WebviewPanel) => PreviewBase;
}

interface PreviewProviderDefAlternative extends PreviewProviderDefCommon {
    onPreview(document: vscode.TextDocument): Promise<void>;
}

export class PreviewManager implements vscode.WebviewPanelSerializer {
    private _previews: Record<string, PreviewBase> = {};

    private _previewProviders: PreviewProviderDef[] = [
        focusTreePreviewDef,
        gfxPreviewDef,
        technologyPreviewDef,
        worldMapPreviewDef,
        eventPreviewDef,
        guiPreviewDef,
        mioPreviewDef,
        ideaPreviewDef,
        characterPreviewDef,
        decisionPreviewDef,
        bopPreviewDef,
    ];
    private _updateSubscriptions: Map<string[], PreviewBase[]> = new Map();

    public register(): vscode.Disposable {
        const disposables: vscode.Disposable[] = [];
        disposables.push(vscode.commands.registerCommand(Commands.Preview, this.showPreview, this));
        disposables.push(vscode.workspace.onDidCloseTextDocument(this.onCloseTextDocument, this));
        disposables.push(vscode.workspace.onDidChangeTextDocument(this.onChangeTextDocument, this));
        // A file appearing or disappearing moves the dependency lists of every open preview that
        // scans a folder (a new national_focus file is a new dependency of the focus tree preview),
        // so the discovery caches are dropped and the folder subscribers are re-checked.
        disposables.push(vscode.workspace.onDidCreateFiles(this.onFilesChanged, this));
        disposables.push(vscode.workspace.onDidDeleteFiles(this.onFilesChanged, this));
        // The create/delete events only fire for files the extension host already knows; a file the
        // editor has never opened is announced by the watcher instead, which is what catches a file
        // added by an external tool while a preview is open.
        const files = vscode.workspace.createFileSystemWatcher('**/*.txt', false, true, false);
        disposables.push(files, files.onDidCreate(uri => this.onFileAddedOrRemoved(uri)),
            files.onDidDelete(uri => this.onFileAddedOrRemoved(uri)));
        disposables.push(vscode.window.onDidChangeActiveTextEditor(this.updateHoi4PreviewContextValue, this));
        disposables.push(vscode.window.registerWebviewPanelSerializer(WebviewType.Preview, this));
        // A preview restored right after VS Code startup races the background GFX index build and
        // can lose sprite lookups to the not-yet-built index (authoritative miss). When the build
        // settles, let every open preview re-resolve what it resolved against the empty index.
        disposables.push(onGfxIndexBuilt(() => {
            for (const preview of Object.values(this._previews)) {
                preview.refreshIcons();
            }
        }));

        // Trigger context value setting
        this.updateHoi4PreviewContextValue(vscode.window.activeTextEditor);

        return vscode.Disposable.from(...disposables);
    }

    public async deserializeWebviewPanel(panel: vscode.WebviewPanel, state: any): Promise<void> {
        const uriStr = state?.uri as string | undefined;
        if (!uriStr) {
            panel.dispose();
            debug(`dispose panel ??? because uri not exist`);
            return;
        }

        try {
            const uri = vscode.Uri.parse(uriStr, true);
            await vscode.workspace.openTextDocument(uri);
            await this.showPreviewImpl(uri, panel);
        } catch (e) {
            error(e);
            panel.dispose();
            debug(`dispose panel ${uriStr} because reopen error`);
        }
    }

    private showPreview(uri?: vscode.Uri): Promise<void> {
        return this.showPreviewImpl(uri);
    }

    private onCloseTextDocument(document: vscode.TextDocument): void {
        if (!vscode.window.visibleTextEditors.some(e => e.document.uri.toString() === document.uri.toString())) {
            const key = document.uri.toString();
            this._previews[key]?.panel.dispose();
            debug(`dispose panel ${key} because text document closed`);
        }

        this.updatePreviewItemsInSubscription(document.uri);
    }
    
    private onChangeTextDocument(e: vscode.TextDocumentChangeEvent): void {
        const document = e.document;
        const key = document.uri.toString();
        const preview = this._previews[key];
        if (preview !== undefined) {
            this.updatePreviewItem(preview, document);
        }

        this.updatePreviewItemsInSubscription(document.uri);
    }

    private onFilesChanged(e: vscode.FileCreateEvent | vscode.FileDeleteEvent): void {
        for (const uri of e.files) {
            this.onFileAddedOrRemoved(uri);
        }
    }

    private onFileAddedOrRemoved(uri: vscode.Uri): void {
        invalidateFileDiscoveryCache();
        this.updatePreviewItemsInSubscription(uri);
    }

    private updateHoi4PreviewContextValue(textEditor: vscode.TextEditor | undefined): void {
        let shouldShowPreviewButton = false;
        let hoi4PreviewType = '';
        if (textEditor) {
            try {
                const provider = this.findPreviewProvider(textEditor.document);
                if (provider) {
                    shouldShowPreviewButton = true;
                    hoi4PreviewType = provider.type;
                }
            } catch (e) {
                error(e);
            }
        }

        setVscodeContext(ContextName.ShouldShowHoi4Preview, shouldShowPreviewButton);
        setVscodeContext(ContextName.ShouldHideHoi4Preview, !shouldShowPreviewButton);
        setVscodeContext(ContextName.Hoi4PreviewType, hoi4PreviewType);
    }

    private async showPreviewImpl(requestUri?: vscode.Uri, panel?: vscode.WebviewPanel): Promise<void> {
        let document: vscode.TextDocument | undefined;
        if (requestUri === undefined) {
            document = vscode.window.activeTextEditor?.document;
        } else {
            document = getDocumentByUri(requestUri);
        }

        if (document === undefined) {
            if (requestUri === undefined) {
                vscode.window.showErrorMessage(localize('preview.noactivedoc', "No active document."));
            } else {
                vscode.window.showErrorMessage(localize('preview.cantfinddoc', "Can't find opened document {0}.", requestUri?.toString()));
            }
            panel?.dispose();
            debug(`dispose panel ${requestUri} because document not opened`);
            return;
        }

        const uri = document.uri;
        const key = uri.toString();
        if (key in this._previews) {
            this._previews[key].panel.reveal();
            panel?.dispose();
            debug(`dispose panel ${uri} because preview already open`);
            return;
        }

        const previewProvider = this.findPreviewProvider(document);
        if (!previewProvider) {
            vscode.window.showInformationMessage(
                localize('preview.cantpreviewfile', "Can't preview this file.\nValid types: {0}.", this._previewProviders.filter(p => p.isEnabled?.() !== false).map(p => p.displayName()).join(', ')));
            panel?.dispose();
            debug(`dispose panel ${uri} because no preview provider`);
            // Re-evaluate the editor on screen: hiding the button outright left it gone until the
            // reader switched editors, even though the file they are looking at did not change.
            this.updateHoi4PreviewContextValue(vscode.window.activeTextEditor);
            return;
        }

        if ('onPreview' in previewProvider) {
            return previewProvider.onPreview(document);
        }

        if (!panel) {
            sendEvent('preview.show.' + previewProvider.type);
        }

        const filename = basename(uri);
        panel = panel ?? vscode.window.createWebviewPanel(
            WebviewType.Preview,
            localize('preview.viewtitle', "HOI4: {0}", filename),
            vscode.ViewColumn.Beside,
            {
                enableScripts: true
            }
        );

        if (contextContainer.current) {
            panel.iconPath = {
                light: vscode.Uri.joinPath(contextContainer.current.extensionUri, 'static/preview-right-light.svg'),
                dark: vscode.Uri.joinPath(contextContainer.current.extensionUri, 'static/preview-right-dark.svg'),
            };
        }

        const previewItem = new previewProvider.previewConstructor(uri, panel);
        this._previews[key] = previewItem;

        previewItem.onDispose(() => {
            const preview = this._previews[key];
            if (preview) {
                this.removePreviewFromSubscription(preview);
                delete this._previews[key];
            }
        });

        previewItem.onDependencyChanged((newDep) => {
            this.removePreviewFromSubscription(previewItem);
            this.addPreviewToSubscription(previewItem, newDep);
        });

        void previewItem.initializePanelContent(document);
    }

    private findPreviewProvider(document: vscode.TextDocument): PreviewProviderDef | undefined {
        return chain(this._previewProviders)
            // A provider whose flag getter or matcher throws must not take the whole lookup down:
            // this answer decides whether the preview button is offered at all, for every file type.
            .filter(p => {
                try {
                    return p.isEnabled?.() !== false;
                } catch (e) {
                    error(e);
                    return false;
                }
            })
            .map(p => {
                let priority: number | undefined;
                try {
                    priority = p.canPreview(document);
                } catch (e) {
                    error(e);
                }
                return { provider: p, priority };
            })
            .filter((value): value is ({ provider: PreviewProviderDef; priority: number }) => value.priority !== undefined)
            .minBy(value => value.priority)
            .value()?.provider;
    }

    private addPreviewToSubscription(previewItem: PreviewBase, dependency: string[]): void {
        const matchStrings = Object.values(dependency)
            .map(d => d.split('/').filter(v => v));

        for (const matchString of matchStrings) {
            const subscriptions = this._updateSubscriptions.get(matchString);
            if (subscriptions) {
                subscriptions.push(previewItem);
            } else {
                this._updateSubscriptions.set(matchString, [ previewItem ]);
            }
        }
    }

    private removePreviewFromSubscription(previewItem: PreviewBase): void {
        for (const [matchString, subscriptions] of this._updateSubscriptions.entries()) {
            if (subscriptions.includes(previewItem)) {
                const newSubscriptions = subscriptions.filter(v => v !== previewItem);
                if (newSubscriptions.length === 0) {
                    this._updateSubscriptions.delete(matchString);
                } else {
                    this._updateSubscriptions.set(matchString, newSubscriptions);
                }
            }
        }
    }

    private getPreviewItemsNeedsUpdate(uri: string): PreviewBase[] {
        const result: PreviewBase[] = [];
        for (const [ matchString, previewItems ] of this._updateSubscriptions.entries()) {
            if (matchPathEnd(uri, matchString)) {
                result.push(...previewItems);
            }
        }

        return result;
    }

    private updatePreviewItemsInSubscription = debounceByInput(
        (uri: vscode.Uri): void => {
            for (const otherPreview of this.getPreviewItemsNeedsUpdate(uri.toString())) {
                if (uri.toString() === otherPreview.uri.toString()) {
                    continue;
                }
                const otherDocument = getDocumentByUri(otherPreview.uri);
                if (otherDocument) {
                    // A dependency (not the preview's own file) changed. Flag it so a preview whose
                    // fingerprints can't see the change (e.g. a focus tree when a dependency .gfx
                    // swaps a sprite's texturefile) still refreshes instead of skipping.
                    void otherPreview.onDocumentChange(otherDocument, true);
                }
            }
        },
        uri => uri.toString(),
        1000,
        { trailing: true });

    private updatePreviewItem = debounceByInput(
        (previewItem: PreviewBase, document: vscode.TextDocument) => {
            if (!previewItem.isDisposed) {
                void previewItem.onDocumentChange(document);
            }
        },
        (preview) => preview.uri.toString(),
        1000,
        { trailing: true });
}

export const previewManager = new PreviewManager();
