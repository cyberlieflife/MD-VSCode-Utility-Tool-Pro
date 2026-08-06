import './setup';
import * as assert from 'assert';
import { JSDOM } from 'jsdom';

// Drives the real focus-tree webview icon picker (focustree.ts openIconPicker) in jsdom to verify
// the two-stage loading protocol: names render immediately with placeholders, image batches fill
// only their own cell (and never rebuild a decoded cell), search debounces and reuses cells from a
// pool, column switches do not rebuild, and the legacy single-shot payload still works.
describe('webview/focustree icon picker', function () {
    this.timeout(15000);

    const messages: any[] = [];
    const uiState: Record<string, any> = {};
    let readyPromise: Promise<void>;
    let resolveReady: () => void;
    // Original globals restored in `after` so later test files see the shared setup jsdom again.
    let savedGlobals: { window: any; document: any; acquireVsCodeApi: any; eventCtors: Record<string, any> };

    before(async function () {
        // Isolate this file in a fresh jsdom: every test file's `import './setup'` hits the same
        // cached jsdom, and focustree.ts binds document/window listeners at module-execution time.
        // Without a dedicated dom here, listeners a previous test registered on the shared document
        // would hijack this file's overlay queries (the wrong instance wins), and its messages would
        // land in the wrong array. The original globals are restored in `after`.
        savedGlobals = {
            window: (global as any).window,
            document: (global as any).document,
            acquireVsCodeApi: (global as any).acquireVsCodeApi,
            eventCtors: {},
        };
        for (const name of ['Event', 'MessageEvent', 'MouseEvent', 'KeyboardEvent', 'FocusEvent', 'PointerEvent', 'WheelEvent']) {
            savedGlobals.eventCtors[name] = (global as any)[name];
        }
        const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', { url: 'https://localhost', pretendToBeVisual: true });
        (global as any).window = dom.window;
        (global as any).document = dom.window.document;
        for (const name of Object.keys(savedGlobals.eventCtors)) {
            (global as any)[name] = (dom.window as any)[name];
        }
        (dom.window as any).__i18ntable = {};

        delete require.cache[require.resolve('../../../webviewsrc/util/vscode')];
        delete require.cache[require.resolve('../../../webviewsrc/util/common')];
        // focustree.ts binds its load listener and reads the globals at module-execution time, so a
        // cached copy from an earlier test (which used a different jsdom window) must be dropped and
        // re-executed against this file's window.
        delete require.cache[require.resolve('../../../webviewsrc/focustree')];
        let ready = false;
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
        await readyPromise;
    });

    after(function () {
        (global as any).window = savedGlobals.window;
        (global as any).document = savedGlobals.document;
        (global as any).acquireVsCodeApi = savedGlobals.acquireVsCodeApi;
        for (const name of Object.keys(savedGlobals.eventCtors)) {
            (global as any)[name] = savedGlobals.eventCtors[name];
        }
    });

    const tick = (ms = 20) => new Promise<void>(resolve => setTimeout(resolve, ms));

    // Right-click blank canvas -> Create focus -> Pick to open the icon picker.
    function openPicker() {
        document.body.dispatchEvent(new MouseEvent('contextmenu', { clientX: 200, clientY: 200, bubbles: true, cancelable: true }));
        const menu = document.querySelector('.ft-context-menu');
        assert.ok(menu, 'context menu should open');
        const createItem = [...menu!.querySelectorAll('div')].find(d => d.textContent === 'Create focus');
        assert.ok(createItem, 'menu should offer Create focus, got: ' + JSON.stringify(menu!.textContent));
        createItem!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        assert.ok(document.querySelector('.ft-create'), 'create panel should open');
        const pickBtn = [...document.querySelectorAll('.ft-create button')].find(b => b.textContent?.includes('Pick'));
        assert.ok(pickBtn, 'create panel should have a Pick button, got: ' + JSON.stringify([...document.querySelectorAll('.ft-create button')].map(b => b.textContent)));
        pickBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        assert.ok(document.querySelector('.ft-iconpicker'), 'icon picker should open');
    }

    // Closes the picker (Cancel) and the create panel so no modal blocks the next contextmenu.
    function closeAll() {
        const pickerCancel = [...document.querySelectorAll('.ft-iconpicker button')].find(b => b.textContent === 'Cancel');
        pickerCancel?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        const createCancel = [...document.querySelectorAll('.ft-create button')].find(b => b.textContent === 'Cancel');
        createCancel?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        document.querySelector('.ft-context-menu')?.remove();
    }

    const gridCells = () => [...document.querySelectorAll('.ft-iconpicker-grid > [data-name]')] as HTMLDivElement[];
    const cellByName = (name: string) => gridCells().find(c => c.dataset.name === name);
    const cellImg = (cell: HTMLDivElement) => cell.querySelector('img') as HTMLImageElement | null;

    it('two-stage flow: requests icons with v:2, renders sorted names, then pulls the first window', async function () {
        messages.length = 0;
        try {
            openPicker();
            const req = messages.find(m => m.command === 'requestFocusIcons');
            assert.ok(req, 'picker should request focus icons, got: ' + JSON.stringify(messages));
            assert.strictEqual(req.v, 2, 'the two-stage stream must be requested');

            // Phase 1: names arrive and the grid renders sorted with placeholders.
            window.dispatchEvent(new MessageEvent('message', {
                data: { type: 'focusIconNames', names: ['GFX_B', 'GFX_A', 'GFX_C'], total: 3 },
            }));
            await tick();
            const cells = gridCells();
            assert.deepStrictEqual(cells.map(c => c.dataset.name), ['GFX_A', 'GFX_B', 'GFX_C'], 'grid order must be sorted');
            for (const cell of cells) {
                assert.strictEqual(cellImg(cell), null, 'no image before it arrives');
                assert.ok(cell.textContent!.includes('?'), 'a placeholder is shown');
            }

            // The visible window (jsdom can't measure, so the fallback block = all 3) is pulled.
            await tick(60);
            const pull = messages.find(m => m.command === 'requestFocusIconImages');
            assert.ok(pull, 'visible window should be pulled, got: ' + JSON.stringify(messages));
            assert.deepStrictEqual(pull.names, ['GFX_A', 'GFX_B', 'GFX_C']);
        } finally {
            closeAll();
        }
    });

    it('focusIconImages fills only its own cell and never rebuilds a decoded cell', async function () {
        messages.length = 0;
        try {
            openPicker();
            window.dispatchEvent(new MessageEvent('message', {
                data: { type: 'focusIconNames', names: ['GFX_A', 'GFX_B'], total: 2 },
            }));
            await tick();

            const a = cellByName('GFX_A')!;
            const b = cellByName('GFX_B')!;
            window.dispatchEvent(new MessageEvent('message', {
                data: { type: 'focusIconImages', images: [{ name: 'GFX_A', imageUri: 'data:image/png;base64,AAAA' }], done: false },
            }));
            await tick();
            const imgA = cellImg(a);
            assert.ok(imgA, 'GFX_A should get its image');
            assert.strictEqual(imgA!.getAttribute('src'), 'data:image/png;base64,AAAA');
            assert.strictEqual(a.dataset.imgSet, '1');
            assert.strictEqual(cellImg(b), null, 'an unrelated cell must not be touched');

            // A second batch re-sending GFX_A must not rebuild (or re-decode) its img.
            window.dispatchEvent(new MessageEvent('message', {
                data: { type: 'focusIconImages', images: [{ name: 'GFX_A', imageUri: 'data:image/png;base64,BBBB' }], done: true },
            }));
            await tick();
            assert.strictEqual(cellImg(a), imgA, 'decoded img must not be rebuilt');
            assert.strictEqual(imgA!.getAttribute('src'), 'data:image/png;base64,AAAA', 'src must not be re-set');
        } finally {
            closeAll();
        }
    });

    it('search debounces and reuses already-decoded cells from the pool', async function () {
        messages.length = 0;
        try {
            openPicker();
            window.dispatchEvent(new MessageEvent('message', {
                data: { type: 'focusIconNames', names: ['GFX_A', 'GFX_B', 'GFX_C'], total: 3 },
            }));
            await tick();
            window.dispatchEvent(new MessageEvent('message', {
                data: { type: 'focusIconImages', images: [{ name: 'GFX_A', imageUri: 'data:image/png;base64,AAAA' }], done: false },
            }));
            await tick();
            const imgA = cellImg(cellByName('GFX_A')!)!;

            const search = document.querySelector('.ft-iconpicker input[type="text"]') as HTMLInputElement;
            search.value = 'GFX_B';
            search.dispatchEvent(new Event('input', { bubbles: true }));
            await tick(250); // search debounce
            assert.deepStrictEqual(gridCells().map(c => c.dataset.name), ['GFX_B'], 'only matching cells remain');

            // Clearing the search brings GFX_A back with its image (recycled cell, not re-decoded).
            search.value = '';
            search.dispatchEvent(new Event('input', { bubbles: true }));
            await tick(250);
            const restoredA = cellByName('GFX_A')!;
            assert.strictEqual(restoredA.dataset.imgSet, '1', 'recycled cell must keep its decoded image');
            assert.strictEqual(cellImg(restoredA), imgA, 'the decoded img must be the same element');
        } finally {
            closeAll();
        }
    });

    it('column switch changes the grid template without rebuilding cells', async function () {
        messages.length = 0;
        try {
            openPicker();
            window.dispatchEvent(new MessageEvent('message', {
                data: { type: 'focusIconNames', names: ['GFX_A', 'GFX_B', 'GFX_C', 'GFX_D'], total: 4 },
            }));
            await tick();
            const a = cellByName('GFX_A')!;

            const select = document.querySelector('.ft-iconpicker select') as HTMLSelectElement;
            select.value = '3';
            select.dispatchEvent(new Event('change', { bubbles: true }));
            const grid = document.querySelector('.ft-iconpicker-grid') as HTMLElement;
            assert.ok(grid.style.gridTemplateColumns.includes('repeat(3, 1fr)'), 'grid must reflow to 3 columns');
            assert.strictEqual(cellByName('GFX_A'), a, 'cells must not be rebuilt on a column switch');
        } finally {
            closeAll();
        }
    });

    it('legacy focusIcons payload migrates into the grid in one step', async function () {
        messages.length = 0;
        try {
            openPicker();
            window.dispatchEvent(new MessageEvent('message', {
                data: { type: 'focusIcons', icons: [{ name: 'GFX_X', imageUri: 'data:image/png;base64,XXXX' }] },
            }));
            await tick();
            const cells = gridCells();
            assert.deepStrictEqual(cells.map(c => c.dataset.name), ['GFX_X']);
            assert.ok(cellImg(cells[0]), 'legacy payload renders the image immediately');
        } finally {
            closeAll();
        }
    });
});
