import './setup';
import * as assert from 'assert';

// Drives the real focus-tree webview interaction code (focustree.ts) in jsdom to verify the
// pointer event chain: a clean click navigates, a drag-click does not navigate, and a drag
// moves the focus while clearing the selection.
describe('webview/focustree interactions', function () {
    this.timeout(10000);

    const messages: any[] = [];
    let readyPromise: Promise<void>;
    let resolveReady: () => void;

    before(async function () {
        // The entry script reads (window as any).focusTrees etc. at load time, so the globals
        // must be in place before the dynamic import (static import would run first).
        // Other webview tests cache util/vscode with a no-op postMessage; drop it so the freshly
        // imported focustree.js posts into OUR message array.
        delete require.cache[require.resolve('../../../webviewsrc/util/vscode')];
        let ready = false;
        // tsconfig.webview.test.json targets es2022, so Promise.withResolvers (es2024) is
        // unavailable here.
        readyPromise = new Promise<void>(resolve => { resolveReady = resolve; });
        (global as any).acquireVsCodeApi = () => ({
            postMessage: (m: any) => {
                messages.push(m);
                if (m.command === 'ready' && !ready) {
                    ready = true;
                    resolveReady();
                }
            },
            getState: () => ({}),
            setState: () => {},
        });

        const focus = {
            id: 'a', x: 0, y: 0, icon: [], textIcon: undefined, overlay: undefined,
            prerequisite: [], exclusive: [], hasAllowBranch: false, inAllowBranch: [],
            allowBranch: undefined, relativePositionId: undefined, offset: [],
            token: { start: 10, end: 20 }, xToken: undefined, yToken: undefined, file: 'x.txt',
        };
        (window as any).focusTrees = [{
            id: 'test', focuses: { a: focus },
            inlayWindowRefs: [], inlayWindows: [], inlayConditionExprs: [],
            allowBranchOptions: [], conditionExprs: [], isSharedFocues: false, warnings: [],
        }];
        (window as any).renderedFocus = {
            a: '<div class="navigator" data-focus-id="a" start="10" end="20">' +
                '<span data-focus-id="a">{{iconClass}} {{position}}</span></div>',
        };
        (window as any).renderedInlayWindows = {};
        (window as any).gridBox = { position: { x: 50, y: 50 }, slotsize: { width: 96, height: 130 } };
        (window as any).useConditionInFocus = false;
        (window as any).xGridSize = 96;
        (window as any).styleNonce = 'testnonce';
        (window as any).__showInlayWindows = false;
        (window as any).previewedFileUri = 'file:///x.txt';

        document.body.innerHTML = [
            '<div id="focustreecontent"></div>',
            '<div id="focustreeplaceholder"></div>',
            '<div id="inlaywindowplaceholder"></div>',
            '<div id="continuousFocuses"></div>',
            '<input id="searchbox" type="text"/>',
            '<div id="condition-container"></div>',
            '<div id="allowbranch-container"></div>',
        ].join('');

        await import('../../../webviewsrc/focustree');
        window.dispatchEvent(new Event('load'));
        // The load handler posts 'ready' after buildContent, which also binds the interactions.
        await readyPromise;
    });

    it('clean press-release navigates; drag neither navigates nor leaves a selection box', function () {
        const nav = document.querySelector('.navigator') as HTMLElement;
        assert.ok(nav, 'navigator should be rendered');

        // --- Clean press-release navigates to the source line (on mouseup, no click needed) ---
        nav.dispatchEvent(new MouseEvent('mousedown', { clientX: 100, clientY: 100, button: 0, bubbles: true }));
        window.dispatchEvent(new MouseEvent('mouseup', { clientX: 100, clientY: 100, button: 0, bubbles: true }));

        const navigate = messages.find(m => m.command === 'navigate');
        assert.ok(navigate, 'expected a navigate message, got: ' + JSON.stringify(messages));
        assert.strictEqual(navigate.start, 10);
        assert.strictEqual(navigate.end, 20);

        // --- Dragging the focus moves it, does not navigate, and clears the selection ---
        messages.length = 0;
        const nav2 = document.querySelector('.navigator') as HTMLElement;
        nav2.dispatchEvent(new MouseEvent('mousedown', { clientX: 100, clientY: 100, button: 0, bubbles: true }));
        window.dispatchEvent(new MouseEvent('mousemove', { clientX: 300, clientY: 300, button: 0, bubbles: true }));
        window.dispatchEvent(new MouseEvent('mouseup', { clientX: 300, clientY: 300, button: 0, bubbles: true }));

        assert.ok(messages.some(m => m.command === 'moveFocuses'), 'expected moveFocuses, got: ' + JSON.stringify(messages));
        assert.ok(!messages.some(m => m.command === 'navigate'), 'drag release must not navigate: ' + JSON.stringify(messages));
        // The selection clear is synchronous; the rebuilt navigator must not carry an outline.
        const nav3 = document.querySelector('.navigator') as HTMLElement;
        assert.strictEqual(nav3.style.outline, '', 'selection highlight must be cleared after a move');
    });
});
