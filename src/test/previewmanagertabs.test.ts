import * as assert from 'assert';
import * as vscode from 'vscode';
import { PreviewManager } from '../previewdef/previewmanager';

// A preview panel's lifetime follows its file's tab, not its text document: the document closes as
// soon as its editor loses focus, while the tab (and the preview beside it) stays. These tests
// drive the tab-change handler the manager registers and check that a panel is disposed only when
// its file's last tab is really gone.

describe('previewdef/previewmanager tab close', () => {
    const realTabGroups = (vscode.window as any).tabGroups;
    let tabHandlers: ((e: any) => void)[] = [];
    let openTabs: any[] = [];

    beforeEach(() => {
        tabHandlers = [];
        openTabs = [];
        (vscode.window as any).tabGroups = {
            get all() { return [{ tabs: openTabs }]; },
            onDidChangeTabs: (cb: (e: any) => void, thisArg?: unknown) => {
                tabHandlers.push(e => cb.call(thisArg, e));
                return { dispose: () => undefined };
            },
        };
    });

    afterEach(() => {
        (vscode.window as any).tabGroups = realTabGroups;
    });

    function tabFor(uri: vscode.Uri): any {
        return { input: new (vscode as any).TabInputText(uri) };
    }

    function withPanel(manager: PreviewManager, uri: vscode.Uri): { disposed: () => number } {
        let count = 0;
        (manager as any)._previews[uri.toString()] = {
            panel: { dispose: () => { count++; } },
            uri,
            isDisposed: false,
        };
        return { disposed: () => count };
    }

    it('disposes the preview when its file\u2019s tab closes and no tab for it remains', () => {
        const manager = new PreviewManager();
        const disposable = manager.register();
        try {
            assert.ok(tabHandlers.length > 0, 'the tab-change event must be subscribed');
            const uri = vscode.Uri.file('/ws/common/national_focus/tree.txt');
            const panel = withPanel(manager, uri);

            openTabs = [];
            tabHandlers.forEach(handler => handler({ closed: [tabFor(uri)], opened: [], changed: [] }));

            assert.strictEqual(panel.disposed(), 1, 'the panel must be disposed once its tab is gone');
        } finally {
            disposable.dispose();
        }
    });

    it('keeps the preview when the tab is still open in another group', () => {
        const manager = new PreviewManager();
        const disposable = manager.register();
        try {
            const uri = vscode.Uri.file('/ws/common/national_focus/tree.txt');
            const panel = withPanel(manager, uri);

            // The closed tab is gone from the event, but the same file is still open elsewhere.
            openTabs = [tabFor(uri)];
            tabHandlers.forEach(handler => handler({ closed: [tabFor(uri)], opened: [], changed: [] }));

            assert.strictEqual(panel.disposed(), 0, 'a preview whose tab is still open must stay');
        } finally {
            disposable.dispose();
        }
    });

    it('ignores a closed tab that is not a text tab', () => {
        const manager = new PreviewManager();
        const disposable = manager.register();
        try {
            const uri = vscode.Uri.file('/ws/common/national_focus/tree.txt');
            const panel = withPanel(manager, uri);

            openTabs = [];
            // A webview or custom tab: not a text input, so it cannot name a previewed file.
            tabHandlers.forEach(handler => handler({ closed: [{ input: { someOther: true } }], opened: [], changed: [] }));

            assert.strictEqual(panel.disposed(), 0, 'a non-text tab must not dispose anything');
        } finally {
            disposable.dispose();
        }
    });
});
