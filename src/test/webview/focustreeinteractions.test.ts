import './setup';
import * as assert from 'assert';

// Drives the real focus-tree webview interaction code (focustree.ts) in jsdom to verify the
// pointer event chain: a clean click navigates, a drag-click does not navigate, and a drag
// moves the focus while clearing the selection.
describe('webview/focustree interactions', function () {
    this.timeout(10000);

    const messages: any[] = [];
    const uiState: Record<string, any> = {};
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
            getState: () => uiState,
            setState: (s: any) => { Object.assign(uiState, s); },
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
            '<input id="show-focus-names" type="checkbox"/>',
            '<div id="condition-container"></div>',
            '<div id="allowbranch-container"></div>',
            '<div class="toolbar"><button id="tb">W</button><div class="select-container"><div class="select">dropdown</div></div></div>',
        ].join('');

        await import('../../../webviewsrc/focustree');
        window.dispatchEvent(new Event('load'));
        // The load handler posts 'ready' after buildContent, which also binds the interactions.
        await readyPromise;
    });

    it('clean press-release navigates; drag neither navigates nor leaves a selection box', async function () {
        const nav = document.querySelector('.navigator') as HTMLElement;
        assert.ok(nav, 'navigator should be rendered');

        // --- Clean press-release on the FOCUS BODY navigates (no click needed) ---
        const label = document.querySelector('.navigator [data-focus-id]') as HTMLElement;
        label.dispatchEvent(new PointerEvent('pointerdown', { clientX: 100, clientY: 100, button: 0, bubbles: true, pointerId: 1 }));
        window.dispatchEvent(new PointerEvent('pointerup', { clientX: 100, clientY: 100, button: 0, bubbles: true, pointerId: 1 }));

        const navigate = messages.find(m => m.command === 'navigate');
        assert.ok(navigate, 'expected a navigate message, got: ' + JSON.stringify(messages));
        assert.strictEqual(navigate.start, 10);
        assert.strictEqual(navigate.end, 20);

        // --- Dragging the FOCUS BODY moves it (unselected body selects it first) ---
        messages.length = 0;
        label.dispatchEvent(new PointerEvent('pointerdown', { clientX: 100, clientY: 100, button: 0, bubbles: true, pointerId: 1 }));
        window.dispatchEvent(new PointerEvent('pointermove', { clientX: 300, clientY: 300, button: 0, bubbles: true, pointerId: 1 }));
        window.dispatchEvent(new PointerEvent('pointerup', { clientX: 300, clientY: 300, button: 0, bubbles: true, pointerId: 1 }));

        assert.ok(messages.some(m => m.command === 'moveFocuses'), 'focus-body drag should move, got: ' + JSON.stringify(messages));
        assert.ok(!messages.some(m => m.command === 'navigate'), 'drag release must not navigate: ' + JSON.stringify(messages));
        const nav3 = document.querySelector('.navigator') as HTMLElement;
        assert.strictEqual(nav3.style.outline, '', 'selection highlight must be cleared after a move');

        // --- Dragging the cell's empty margin box-selects instead of moving ---
        messages.length = 0;
        const nav4 = document.querySelector('.navigator') as HTMLElement;
        // jsdom returns all-zero bounds; give the cell a real rect so the box-select hits it.
        Object.defineProperty(nav4, 'getBoundingClientRect', {
            value: () => ({ left: 50, top: 50, right: 150, bottom: 150, width: 100, height: 100 }),
        });
        // Pressing the cell background resolves to the navigator itself (gap, not the body).
        nav4.dispatchEvent(new PointerEvent('pointerdown', { clientX: 100, clientY: 100, button: 0, bubbles: true, pointerId: 1 }));
        window.dispatchEvent(new PointerEvent('pointermove', { clientX: 300, clientY: 300, button: 0, bubbles: true, pointerId: 1 }));
        window.dispatchEvent(new PointerEvent('pointerup', { clientX: 300, clientY: 300, button: 0, bubbles: true, pointerId: 1 }));

        assert.ok(!messages.some(m => m.command === 'moveFocuses'), 'gap drag must box-select, not move');
        const navSel = document.querySelector('.navigator') as HTMLElement;
        assert.notStrictEqual(navSel.style.outline, '', 'box-select should highlight the focus');

        // --- Dragging the now-SELECTED focus body moves it and clears the box ---
        messages.length = 0;
        const label2 = document.querySelector('.navigator [data-focus-id]') as HTMLElement;
        label2.dispatchEvent(new PointerEvent('pointerdown', { clientX: 100, clientY: 100, button: 0, bubbles: true, pointerId: 1 }));
        window.dispatchEvent(new PointerEvent('pointermove', { clientX: 300, clientY: 300, button: 0, bubbles: true, pointerId: 1 }));
        window.dispatchEvent(new PointerEvent('pointerup', { clientX: 300, clientY: 300, button: 0, bubbles: true, pointerId: 1 }));
        assert.ok(messages.some(m => m.command === 'moveFocuses'), 'selected focus body should move');

        // --- A no-op sub-cell drag on the body must clear the box ---
        messages.length = 0;
        const label3 = document.querySelector('.navigator [data-focus-id]') as HTMLElement;
        label3.dispatchEvent(new PointerEvent('pointerdown', { clientX: 0, clientY: 0, button: 0, bubbles: true, pointerId: 1 }));
        window.dispatchEvent(new PointerEvent('pointermove', { clientX: 30, clientY: 40, button: 0, bubbles: true, pointerId: 1 }));
        window.dispatchEvent(new PointerEvent('pointerup', { clientX: 30, clientY: 40, button: 0, bubbles: true, pointerId: 1 }));
        assert.ok(!messages.some(m => m.command === 'moveFocuses'), 'no moves for a sub-cell drag');
        const nav6 = document.querySelector('.navigator') as HTMLElement;
        assert.strictEqual(nav6.style.outline, '', 'no highlight after a no-op drag');

        // --- Far blank canvas (outside the tree container) also box-selects ---
        messages.length = 0;
        document.body.dispatchEvent(new PointerEvent('pointerdown', { clientX: 0, clientY: 0, button: 0, bubbles: true, pointerId: 1 }));
        window.dispatchEvent(new PointerEvent('pointermove', { clientX: 300, clientY: 300, button: 0, bubbles: true, pointerId: 1 }));
        window.dispatchEvent(new PointerEvent('pointerup', { clientX: 300, clientY: 300, button: 0, bubbles: true, pointerId: 1 }));
        assert.ok(!messages.some(m => m.command === 'moveFocuses'), 'blank canvas must not move');
        const nav7 = document.querySelector('.navigator') as HTMLElement;
        assert.notStrictEqual(nav7.style.outline, '', 'blank-canvas box-select should highlight the cell');

        // --- Toolbar controls keep their own behavior (no box-select, no move) ---
        messages.length = 0;
        const before = nav7.style.outline;
        const toolbarBtn = document.getElementById('tb') as HTMLElement;
        toolbarBtn.dispatchEvent(new PointerEvent('pointerdown', { clientX: 10, clientY: 10, button: 0, bubbles: true, pointerId: 1 }));
        window.dispatchEvent(new PointerEvent('pointermove', { clientX: 300, clientY: 300, button: 0, bubbles: true, pointerId: 1 }));
        window.dispatchEvent(new PointerEvent('pointerup', { clientX: 300, clientY: 300, button: 0, bubbles: true, pointerId: 1 }));
        assert.ok(!messages.some(m => m.command === 'moveFocuses'), 'toolbar drag must not move');
        assert.strictEqual(nav7.style.outline, before, 'toolbar drag must not touch the selection');
        // The button still receives its own click.
        toolbarBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));

        // --- Dropdown popup (a body-level ul, not inside .toolbar) also keeps its behavior ---
        const ul = document.createElement('ul');
        ul.className = 'select-dropdown';
        const li = document.createElement('li');
        li.setAttribute('role', 'option');
        ul.appendChild(li);
        document.body.appendChild(ul);
        const before2 = nav7.style.outline;
        li.dispatchEvent(new PointerEvent('pointerdown', { clientX: 10, clientY: 10, button: 0, bubbles: true, pointerId: 1 }));
        window.dispatchEvent(new PointerEvent('pointermove', { clientX: 300, clientY: 300, button: 0, bubbles: true, pointerId: 1 }));
        window.dispatchEvent(new PointerEvent('pointerup', { clientX: 300, clientY: 300, button: 0, bubbles: true, pointerId: 1 }));
        assert.ok(!messages.some(m => m.command === 'moveFocuses'), 'dropdown drag must not move');
        assert.strictEqual(nav7.style.outline, before2, 'dropdown drag must not touch the selection');
        ul.remove();

        // --- UI state persistence: restored state is re-applied, toggles save ---
        messages.length = 0;
        window.dispatchEvent(new MessageEvent('message', {
            data: { type: 'uiState', state: { showFocusNames: true, selectedExprs: [], selectedFocusTreeIndex: 0 } },
        }));
        for (let i = 0; i < 20; i++) { await Promise.resolve(); }
        assert.ok(messages.some(m => m.command === 'requestFocusNames'), 'restored name mode should request names: ' + JSON.stringify(messages));

        messages.length = 0;
        const nameToggle = document.getElementById('show-focus-names') as HTMLInputElement;
        nameToggle.checked = true;
        nameToggle.dispatchEvent(new Event('change'));
        const saveMsg = messages.find(m => m.command === 'saveUiState');
        assert.ok(saveMsg, 'expected saveUiState, got: ' + JSON.stringify(messages));
        assert.strictEqual(saveMsg.state.showFocusNames, true, 'name mode must be saved');
    });

    it('modal dialogs block canvas interaction behind them', async function () {
        // Open the create panel: right-click blank canvas, then pick "Create focus".
        document.body.dispatchEvent(new MouseEvent('contextmenu', { clientX: 200, clientY: 200, bubbles: true, cancelable: true }));
        const menu = document.querySelector('.ft-context-menu');
        assert.ok(menu, 'context menu should open on blank-canvas right-click');
        const createItem = [...menu!.querySelectorAll('div')].find(d => d.textContent === 'Create focus');
        assert.ok(createItem, 'menu should offer Create focus, got: ' + JSON.stringify(menu!.textContent));
        createItem!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        assert.ok(document.querySelector('.ft-create'), 'create panel should open');

        // While a modal is open, a press on a focus body must neither navigate nor drag.
        messages.length = 0;
        const label = document.querySelector('.navigator [data-focus-id]') as HTMLElement;
        label.dispatchEvent(new PointerEvent('pointerdown', { clientX: 100, clientY: 100, button: 0, bubbles: true, pointerId: 1 }));
        window.dispatchEvent(new PointerEvent('pointerup', { clientX: 100, clientY: 100, button: 0, bubbles: true, pointerId: 1 }));
        assert.ok(!messages.some(m => m.command === 'navigate'), 'no navigation while a modal is open: ' + JSON.stringify(messages));
        assert.ok(!messages.some(m => m.command === 'moveFocuses'), 'no drag while a modal is open: ' + JSON.stringify(messages));

        // Blank canvas must not box-select while a modal is open.
        const nav = document.querySelector('.navigator') as HTMLElement;
        const before = nav.style.outline;
        document.body.dispatchEvent(new PointerEvent('pointerdown', { clientX: 0, clientY: 0, button: 0, bubbles: true, pointerId: 1 }));
        window.dispatchEvent(new PointerEvent('pointermove', { clientX: 300, clientY: 300, button: 0, bubbles: true, pointerId: 1 }));
        window.dispatchEvent(new PointerEvent('pointerup', { clientX: 300, clientY: 300, button: 0, bubbles: true, pointerId: 1 }));
        assert.strictEqual(nav.style.outline, before, 'no box-select while a modal is open');

        // Wheel zoom is disabled while a modal is open (scale stays put).
        const scaleBefore = uiState.scale;
        window.dispatchEvent(new WheelEvent('wheel', { deltaY: 120, bubbles: true, cancelable: true }));
        assert.strictEqual(uiState.scale, scaleBefore, 'no zoom while a modal is open');

        // Cancel closes the panel and restores canvas interaction.
        const cancelBtn = [...document.querySelectorAll('.ft-create button')].find(b => b.textContent === 'Cancel');
        assert.ok(cancelBtn, 'create panel should have a Cancel button');
        cancelBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        assert.ok(!document.querySelector('.ft-create'), 'create panel should close');

        messages.length = 0;
        const label2 = document.querySelector('.navigator [data-focus-id]') as HTMLElement;
        label2.dispatchEvent(new PointerEvent('pointerdown', { clientX: 100, clientY: 100, button: 0, bubbles: true, pointerId: 1 }));
        window.dispatchEvent(new PointerEvent('pointerup', { clientX: 100, clientY: 100, button: 0, bubbles: true, pointerId: 1 }));
        assert.ok(messages.some(m => m.command === 'navigate'), 'navigation works again after the modal closes');
    });
});
