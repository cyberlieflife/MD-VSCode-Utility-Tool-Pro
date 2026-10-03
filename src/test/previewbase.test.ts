import * as assert from 'assert';
import * as vscode from 'vscode';
import { PreviewBase } from '../previewdef/previewbase';

// PreviewBase 重载路径的实例级测试。基类把全量渲染抽成不排队的 renderFullContent：部分更新在
// 渲染队列里发现要换外壳（工具栏旗标变化、隐藏后重建、空树）时必须在当前任务里就地完成，
// 再去排一个新任务会等自己结束而挂死，且之后队列上的编辑全部不再推进。

class TestPreview extends PreviewBase {
    fullRenders = 0;
    partialUpdates = 0;
    // 模拟 sendPartialUpdate 发现需要全量重载时的处理（焦点树预览的工具栏旗标分支就是这么做的）。
    fullReloadFromPartial = false;

    protected async getContent(document: vscode.TextDocument): Promise<string> {
        this.fullRenders++;
        return `<html>full:${document.getText()}</html>`;
    }

    protected async sendPartialUpdate(document: vscode.TextDocument): Promise<void> {
        this.partialUpdates++;
        if (this.fullReloadFromPartial) {
            this.panelInitialized = false;
            await this.renderFullContent(document);
            return;
        }
        this.panel.webview.html = `<html>partial:${document.getText()}</html>`;
    }
}

function makePreview() {
    let html = '';
    let htmlWrites = 0;
    const webview = {
        postMessage: () => Promise.resolve(true),
        get html() {
            return html;
        },
        set html(v: string) {
            html = v;
            htmlWrites++;
        },
        onDidReceiveMessage: () => ({ dispose() { /* no-op */ } }),
        asWebviewUri: (u: unknown) => u,
        cspSource: '',
    };
    const panel = {
        webview,
        visible: true,
        onDidDispose: () => ({ dispose() { /* no-op */ } }),
        onDidChangeViewState: () => ({ dispose() { /* no-op */ } }),
    };
    const preview = new TestPreview(vscode.Uri.file('/tmp/previewbase-test.txt'), panel as any);
    return {
        preview,
        get html() {
            return html;
        },
        get htmlWrites() {
            return htmlWrites;
        },
    };
}

const document = { getText: () => 'v1' } as any;

describe('previewdef/previewbase render paths', function () {
    it('renders the full page on the first update', async function () {
        const h = makePreview();
        await h.preview.onDocumentChange(document);
        assert.strictEqual(h.preview.fullRenders, 1);
        assert.strictEqual(h.htmlWrites, 1);
        assert.ok(h.html.includes('full:v1'), h.html);
    });

    it('completes a full reload requested from inside a partial update, and the queue keeps advancing', async function () {
        const h = makePreview();
        await h.preview.onDocumentChange(document);
        assert.strictEqual(h.htmlWrites, 1);

        // 第二次：部分更新发现外壳要换 —— 就地全量重载，必须完成（修复前这一步永不返回）。
        h.preview.fullReloadFromPartial = true;
        await h.preview.onDocumentChange(document);
        assert.strictEqual(h.preview.fullRenders, 2);
        assert.strictEqual(h.htmlWrites, 2);
        assert.ok(h.html.includes('full:v1'), h.html);

        // 队列没有被死锁卡住：后续编辑照常推进。
        h.preview.fullReloadFromPartial = false;
        await h.preview.onDocumentChange(document);
        assert.strictEqual(h.preview.partialUpdates, 2);
        assert.ok(h.html.includes('partial:v1'), h.html);
    });
});
