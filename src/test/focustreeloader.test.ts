import * as assert from 'assert';
import * as vscode from 'vscode';
import { FocusTreeLoader } from '../previewdef/focustree/loader';
import { LoaderSession } from '../util/loader/loader';
import { listGuiGfxFiles, resolveInlayGuiWindows, resolveInlayGfxFiles } from '../previewdef/focustree/inlay';
import { clearDlcZipCache } from '../util/fileloader';
import { refreshFeatureFlags } from '../util/featureflags';

// Drives FocusTreeLoader.postLoad against a stubbed interface/ tree (two .gfx, one .gui) served from
// the HOI4 install path (no workspace folders). Feature flags are off, so getGfxContainerFiles is a
// no-op and focus icons resolve by scanning result.gfxFiles -- which the short-circuit must keep the
// interface gfx listing in for a no-inlay tree, or focus icons defined outside goals.gfx stop
// resolving. This is the render-safety guarantee the short-circuit rests on.
describe('previewdef/focustree/loader inlay short-circuit', function () {
    const File = vscode.FileType.File;
    const Directory = vscode.FileType.Directory;
    const realGetConfig = (vscode.workspace as any).getConfiguration;
    const realStat = (vscode.workspace.fs as any).stat;
    const realReadDir = (vscode.workspace.fs as any).readDirectory;

    function uriPath(uri: any): string {
        return String(uri.fsPath ?? uri.path ?? '');
    }
    function underInterface(uri: any): boolean {
        return /(^|[/:])interface(\/|$)/.test(uriPath(uri));
    }

    beforeEach(function () {
        (vscode.workspace as any).getConfiguration = () => ({
            get: () => undefined, update: () => Promise.resolve(), inspect: () => undefined,
            modFile: '', loadDlcContents: false, inlayWindowGfxRoots: [],
        });
        (vscode.workspace.fs as any).stat = async (uri: any) => ({
            type: underInterface(uri) && !/\.(gfx|gui)$/.test(uriPath(uri)) ? Directory : File,
            mtime: 1, ctime: 0, size: 0,
        });
        (vscode.workspace.fs as any).readDirectory = async (uri: any) =>
            underInterface(uri) ? [['a.gfx', File], ['b.gfx', File], ['c.gui', File]] : [];
    });

    afterEach(async function () {
        (vscode.workspace as any).getConfiguration = realGetConfig;
        (vscode.workspace.fs as any).stat = realStat;
        (vscode.workspace.fs as any).readDirectory = realReadDir;
        await clearDlcZipCache(); // drop the 3s directory-listing cache so listings don't leak between tests
    });

    function postLoad(content: string): Promise<any> {
        const loader = new FocusTreeLoader('common/national_focus/test_tree.txt');
        return (loader as any).postLoad(content, [], undefined, new LoaderSession(true));
    }

    const noInlayTree = `focus_tree = {
    id = test_no_inlay
    focus = { id = focus_a x = 0 y = 0 }
}`;

    const inlayTree = `focus_tree = {
    id = test_with_inlay
    inlay_window = { id = my_inlay position = { x = 10 y = 20 } }
    focus = { id = focus_b x = 0 y = 0 }
}`;

    it('short-circuits a no-inlay tree: empty inlayWindows, but the interface gfx listing stays in gfxFiles', async function () {
        const result = await postLoad(noInlayTree);
        const trees = result.result.focusTrees;
        assert.strictEqual(trees.length, 1);
        assert.strictEqual(trees[0].inlayWindowRefs.length, 0);
        assert.deepStrictEqual(trees[0].inlayWindows, []);
        assert.deepStrictEqual(trees[0].inlayConditionExprs, []);
        // Render-safety: the focus-icon scan set still contains every interface gfx file.
        assert.ok(result.result.gfxFiles.includes('interface/a.gfx'));
        assert.ok(result.result.gfxFiles.includes('interface/b.gfx'));
        // The inlay pipeline was skipped, so no missing-inlay warning is produced.
        assert.ok(!trees[0].warnings.some((w: any) => w.source === 'my_inlay'));
    });

    it('runs the inlay pipeline for a tree with an inlay ref, keeping the same gfx set', async function () {
        const result = await postLoad(inlayTree);
        const trees = result.result.focusTrees;
        assert.strictEqual(trees.length, 1);
        assert.strictEqual(trees[0].inlayWindowRefs.length, 1);
        assert.deepStrictEqual(trees[0].inlayWindows, []); // unresolved: no inlay window files on disk
        // Proof the pipeline ran (not short-circuited): the unresolved ref produced a warning.
        assert.ok(trees[0].warnings.some((w: any) => w.source === 'my_inlay'));
        assert.ok(result.result.gfxFiles.includes('interface/a.gfx'));
    });

    it('short-circuit reproduces the pipeline gfx set: resolveInlayGuiWindows([]).gfxFiles === listGuiGfxFiles(), resolveInlayGfxFiles([]).resolvedFiles === []', async function () {
        const listed = await listGuiGfxFiles();
        const gui = await resolveInlayGuiWindows([]);
        const gfx = await resolveInlayGfxFiles([]);
        assert.deepStrictEqual(gui.gfxFiles, listed);
        assert.deepStrictEqual(gfx.resolvedFiles, []);
        assert.deepStrictEqual(listed, ['interface/a.gfx', 'interface/b.gfx']);
    });

    // 焦点覆盖层清单与布局设置是本轮新增的 loader 输出：覆盖层清单每次加载都重新解析（设置与
    // descriptor 都能改它），布局只在 gui 模式构建。
    describe('overlay gfx list and layout mode', function () {
        const File = vscode.FileType.File;
        const Directory = vscode.FileType.Directory;
        const realGetConfig = (vscode.workspace as any).getConfiguration;
        const realStat = (vscode.workspace.fs as any).stat;
        const realReadDir = (vscode.workspace.fs as any).readDirectory;
        const config: any = {
            get: () => undefined, update: () => Promise.resolve(), inspect: () => undefined,
            modFile: '', loadDlcContents: false, inlayWindowGfxRoots: [],
            focusTreeLayout: 'standard', focusOverlayGfxFiles: [],
        };

        function uriPath(uri: any): string {
            return String(uri.fsPath ?? uri.path ?? '');
        }
        function underInterface(uri: any): boolean {
            return /(^|[/:])interface(\/|$)/.test(uriPath(uri));
        }

        beforeEach(function () {
            config.focusTreeLayout = 'standard';
            config.focusOverlayGfxFiles = [];
            (vscode.workspace as any).getConfiguration = () => config;
            refreshFeatureFlags();
            (vscode.workspace.fs as any).stat = async (uri: any) => ({
                type: underInterface(uri) && !/\.(gfx|gui)$/.test(uriPath(uri)) ? Directory : File,
                mtime: 1, ctime: 0, size: 0,
            });
            (vscode.workspace.fs as any).readDirectory = async (uri: any) =>
                underInterface(uri) ? [['a.gfx', File], ['b.gfx', File], ['c.gui', File]] : [];
        });

        afterEach(async function () {
            (vscode.workspace as any).getConfiguration = realGetConfig;
            (vscode.workspace.fs as any).stat = realStat;
            (vscode.workspace.fs as any).readDirectory = realReadDir;
            refreshFeatureFlags();
            await clearDlcZipCache();
        });

        function postLoad2(content: string): Promise<any> {
            const loader = new FocusTreeLoader('common/national_focus/test_tree.txt');
            return (loader as any).postLoad(content, [], undefined, new LoaderSession(true));
        }

        it('lists the game goals.gfx for overlays, then the configured files', async function () {
            const plain = await postLoad2(noInlayTree);
            assert.deepStrictEqual(plain.result.overlayGfxFiles, ['interface/goals.gfx']);
            // 未声明 national_focus_center 之外的东西：标准模式下不构建布局。
            assert.strictEqual(plain.result.layout, undefined);

            config.focusOverlayGfxFiles = ['interface/extra_overlays.gfx'];
            const configured = await postLoad2(noInlayTree);
            assert.deepStrictEqual(configured.result.overlayGfxFiles, ['interface/goals.gfx', 'interface/extra_overlays.gfx']);
        });

        it('forces a reload once the layout setting differs from the last load', async function () {
            const loader = new FocusTreeLoader('common/national_focus/test_tree.txt');
            (loader as any).loadedLayoutMode = 'standard';
            config.focusTreeLayout = 'gui';
            refreshFeatureFlags();
            assert.strictEqual(await loader.shouldReloadImpl(new LoaderSession(false)), true);
        });

        // 快捷键块与 gui 片段的解析都在 postLoad 里定形。
        const shortcutTree = `focus_tree = {
    id = test_shortcuts
    shortcut = { name = TST_shortcut_one target = focus_a }
    shortcut = { name = TST_shortcut_two target = focus_b }
    focus = { id = focus_a x = 0 y = 0 }
    focus = { id = focus_b x = 0 y = 1 }
}`;

        it('parses a tree shortcut block in file order and drops incomplete entries', async function () {
            const result = await postLoad2(shortcutTree);
            assert.deepStrictEqual(result.result.focusTrees[0].shortcuts, [
                { name: 'TST_shortcut_one', target: 'focus_a' },
                { name: 'TST_shortcut_two', target: 'focus_b' },
            ]);

            // name 与 target 缺一不可：缺的那条被丢掉，其余照常解析。
            const partial = await postLoad2(`focus_tree = {
    id = test_partial_shortcuts
    shortcut = { name = TST_only_name }
    shortcut = { target = focus_a }
    shortcut = { name = TST_complete target = focus_a }
    focus = { id = focus_a x = 0 y = 0 }
}`);
            assert.deepStrictEqual(partial.result.focusTrees[0].shortcuts, [
                { name: 'TST_complete', target: 'focus_a' },
            ]);
        });

        it('reads the shortcut item and toggle from nationalfocusview.gui when a tree has shortcuts', async function () {
            // 该文件必须被接口目录列出，才会进入 GuiFileLoader 的加载集合。
            const realReadDir2 = (vscode.workspace.fs as any).readDirectory;
            (vscode.workspace.fs as any).readDirectory = async (uri: any) =>
                underInterface(uri)
                    ? [['a.gfx', File], ['b.gfx', File], ['c.gui', File], ['nationalfocusview.gui', File]]
                    : [];
            const realReadFile = (vscode.workspace.fs as any).readFile;
            (vscode.workspace.fs as any).readFile = async (uri: any) => {
                if (/nationalfocusview\.gui$/.test(uriPath(uri))) {
                    return Buffer.from(`guiTypes = {
    containerWindowType = {
        name = "focus_tree_shortcut_item"
        size = { width = 190 height = 72 }
    }
    containerWindowType = {
        name = "nationalfocusview"
        buttonType = { name = "toggle_shortcuts" spriteType = "GFX_toggle" }
    }
}`, 'utf-8');
                }
                return Buffer.from('', 'utf-8');
            };
            try {
                const withShortcuts = await postLoad2(shortcutTree);
                assert.ok(withShortcuts.result.shortcutGui, 'a tree with shortcuts loads the gui file');
                assert.strictEqual(withShortcuts.result.shortcutGui.item?.name, 'focus_tree_shortcut_item');
                assert.strictEqual(withShortcuts.result.shortcutGui.toggle?.name, 'toggle_shortcuts');

                // 没有快捷键的树不付这份解析成本。
                const plain = await postLoad2(noInlayTree);
                assert.strictEqual(plain.result.shortcutGui, undefined);
            } finally {
                (vscode.workspace.fs as any).readDirectory = realReadDir2;
                (vscode.workspace.fs as any).readFile = realReadFile;
            }
        });
    });
});
