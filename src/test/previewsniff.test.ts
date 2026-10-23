import * as assert from 'assert';
import * as vscode from 'vscode';
import * as featureflags from '../util/featureflags';
import { eventPreviewDef } from '../previewdef/event';
import { technologyPreviewDef } from '../previewdef/technology';

// 预览的 canPreview 对每个切换到的文档都会执行。文件不在预览自己的目录里时，只有 .txt 才值得
// 读正文；本地化、JSON、Markdown 文件不能被读一遍再放弃。

function spyDocument(path: string, text: string): { document: vscode.TextDocument, reads: () => number } {
    let reads = 0;
    const document = {
        uri: vscode.Uri.file(path),
        getText: () => {
            reads++;
            return text;
        },
    } as unknown as vscode.TextDocument;
    return { document, reads: () => reads };
}

describe('preview file sniffing', () => {
    const flags = featureflags as unknown as Record<string, unknown>;
    let originalEventPreview: unknown;

    before(() => {
        originalEventPreview = flags.eventTreePreview;
        flags.eventTreePreview = true;
    });

    after(() => {
        flags.eventTreePreview = originalEventPreview;
    });

    it('does not read a non-.txt document for the event preview', () => {
        const { document, reads } = spyDocument('/ws/notes.md', 'country_event = { id = test.1 }');

        assert.strictEqual(eventPreviewDef.canPreview(document), undefined);
        assert.strictEqual(reads(), 0);
    });

    it('still sniffs a .txt document for the event preview', () => {
        const { document, reads } = spyDocument('/ws/events_copy.txt', 'country_event = { id = test.1 }');

        assert.strictEqual(eventPreviewDef.canPreview(document), 0);
        assert.strictEqual(reads(), 1);
    });

    it('does not read a non-.txt document for the technology preview', () => {
        const { document, reads } = spyDocument('/ws/notes.json', 'technologies = { }');

        assert.strictEqual(technologyPreviewDef.canPreview(document), undefined);
        assert.strictEqual(reads(), 0);
    });

    it('still sniffs a .txt document for the technology preview', () => {
        const { document, reads } = spyDocument('/ws/tech_copy.txt', 'technologies = { }');

        assert.strictEqual(technologyPreviewDef.canPreview(document), 0);
        assert.strictEqual(reads(), 1);
    });
});
