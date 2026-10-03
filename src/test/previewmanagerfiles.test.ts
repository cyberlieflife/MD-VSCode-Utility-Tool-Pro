import * as assert from 'assert';
import * as vscode from 'vscode';
import * as fileloader from '../util/fileloader';
import { PreviewManager } from '../previewdef/previewmanager';

// 文件的出现与消失要立刻反映到预览的依赖清单上：发现缓存必须作废（否则刚创建的文件在几秒内
// 仍查不到），订阅该文件夹的预览也要被重新检查。这里驱动真实的事件处理器，断言缓存失效被调用。

describe('previewdef/previewmanager file events', () => {
    const realOnDidCreateFiles = (vscode.workspace as any).onDidCreateFiles;
    const realOnDidDeleteFiles = (vscode.workspace as any).onDidDeleteFiles;
    const realInvalidate = (fileloader as any).invalidateFileDiscoveryCache;

    let createHandlers: ((e: any) => void)[] = [];
    let deleteHandlers: ((e: any) => void)[] = [];
    let invalidated = 0;

    beforeEach(() => {
        createHandlers = [];
        deleteHandlers = [];
        invalidated = 0;
        (vscode.workspace as any).onDidCreateFiles = (cb: (e: any) => void, thisArg?: unknown) => {
            createHandlers.push(e => cb.call(thisArg, e));
            return { dispose: () => undefined };
        };
        (vscode.workspace as any).onDidDeleteFiles = (cb: (e: any) => void, thisArg?: unknown) => {
            deleteHandlers.push(e => cb.call(thisArg, e));
            return { dispose: () => undefined };
        };
        (fileloader as any).invalidateFileDiscoveryCache = () => { invalidated++; };
    });

    afterEach(() => {
        (vscode.workspace as any).onDidCreateFiles = realOnDidCreateFiles;
        (vscode.workspace as any).onDidDeleteFiles = realOnDidDeleteFiles;
        (fileloader as any).invalidateFileDiscoveryCache = realInvalidate;
    });

    it('invalidates the discovery caches on create and on delete', () => {
        const manager = new PreviewManager();
        const disposable = manager.register();
        try {
            assert.ok(createHandlers.length > 0, 'the create event must be subscribed');
            assert.ok(deleteHandlers.length > 0, 'the delete event must be subscribed');

            const uri = vscode.Uri.file('/ws/common/national_focus/new_tree.txt');
            createHandlers.forEach(handler => handler({ files: [uri] }));
            assert.strictEqual(invalidated, 1);

            deleteHandlers.forEach(handler => handler({ files: [uri] }));
            assert.strictEqual(invalidated, 2);
        } finally {
            disposable.dispose();
        }
    });
});
