import * as vscode from 'vscode';
import { localize } from './util/i18n';
import { html, htmlEscape, loadingShellHtml } from './util/html';
import { StyleTable } from './util/styletable';
import { sendEvent } from './util/telemetry';
import { forceError } from './util/common';
import { readFile } from './util/vsccommon';
import { decodeImageToPng, type DecodedImage } from './util/image/imagedecoder';

abstract class CommonViewProvider implements vscode.CustomReadonlyEditorProvider {
    public async openCustomDocument(uri: vscode.Uri) {
        // Don't try opening it as text
        return { uri, dispose: () => { } };
    }

    public async resolveCustomEditor(document: vscode.CustomDocument, webviewPanel: vscode.WebviewPanel, token: vscode.CancellationToken): Promise<void> {
        try {
            this.onOpen();

            // Show the shared loading spinner while the (potentially large) texture is read
            // and decoded. It is replaced by the rendered image as soon as decoding finishes.
            webviewPanel.webview.html = loadingShellHtml();

            const buffer = await Promise.race([
                readFile(document.uri),
                new Promise<null>(resolve => token.onCancellationRequested(_ => resolve(null))),
            ]);

            if (buffer === null) {
                return;
            }

            // Decoding runs off the host thread in the image worker. A torn-down panel aborts its
            // request, so a decode still waiting in the queue is dropped before it is ever copied
            // or posted, instead of starting for a view that is already closed.
            const controller = new AbortController();
            const cancellation = token.onCancellationRequested(() => controller.abort());
            let decoded: DecodedImage | null = null;
            try {
                decoded = await decodeImageToPng(Buffer.from(buffer), this.imageKind, controller.signal);
            } catch (e) {
                if (!controller.signal.aborted) {
                    throw e;
                }
            } finally {
                cancellation.dispose();
            }

            if (decoded === null) {
                return;
            }

            const { pngBuffer, width, height } = decoded;
            const styleTable = new StyleTable();

            webviewPanel.webview.html = html(
                webviewPanel.webview,
                `<div class="${styleTable.oneTimeStyle('imagePreview', () => `width:${width}px;height:${height}px;`)}">
                    <img src="data:image/png;base64,${pngBuffer.toString('base64')}"/>
                </div>`,
                [],
                [styleTable]
            );
        } catch (e) {
            webviewPanel.webview.html = `${localize('error', 'Error')}: <br/>  <pre>${htmlEscape(forceError(e).toString())}</pre>`;
        }
    }

    protected abstract onOpen(): void;
    protected abstract readonly imageKind: 'dds' | 'tga';
}

export class DDSViewProvider extends CommonViewProvider {
    protected readonly imageKind: 'dds' | 'tga' = 'dds';

    protected onOpen(): void {
        sendEvent('preview.dds');
    }
}

export class TGAViewProvider extends CommonViewProvider {
    protected readonly imageKind: 'dds' | 'tga' = 'tga';

    protected onOpen(): void {
        sendEvent('preview.tga');
    }
}
