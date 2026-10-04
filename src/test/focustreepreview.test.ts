import * as assert from 'assert';
import * as vscode from 'vscode';
import { focusTreePreviewDef } from '../previewdef/focustree';
import { PreviewBase } from '../previewdef/previewbase';
import { clearDlcZipCache } from '../util/fileloader';
import { clearGfxCaches } from '../util/image/imagecache';

// FocusTreePreview 的实例级测试：用真实解析与渲染路径驱动 sendPartialUpdate 的三条全量重载分支
// （工具栏旗标变化、隐藏面板、空树），断言重载在同一渲染任务里就地完成、后续编辑仍能推进。
// 文件系统按 HOI4 安装路径挂桩（工作区侧为空），与 focustreeaudit.test.ts 同一套手法。

const installPath = 'C:/game';
const focusFile = 'common/national_focus/test.txt';

const noWarningTree = `focus_tree = {
    id = test_tree
    focus = { id = fa x = 0 y = 0 }
    focus = { id = fb x = 4 y = 0 }
}`;

// 两个焦点同位置：产生 same position 警告，hasWarnings 因此从 false 变 true。
const warningTree = `focus_tree = {
    id = test_tree
    focus = { id = fa x = 0 y = 0 }
    focus = { id = fb x = 0 y = 0 }
}`;

// 结构变了但警告仍在（多一个不同位置的焦点）：用于断言旗标不变时的就地更新路径。
const warningTree2 = `focus_tree = {
    id = test_tree
    focus = { id = fa x = 0 y = 0 }
    focus = { id = fb x = 0 y = 0 }
    focus = { id = fc x = 4 y = 0 }
}`;

function uriPath(uri: any): string {
    return String(uri.fsPath ?? uri.path ?? '');
}

function relativeToInstall(uri: any): string | undefined {
    const p = String(uri.fsPath || uri.path || '').replace(/\\+/g, '/');
    const hoi4Match = p.match(/(?:^|\/\/)hoi4installpath:\/*(.*)$/i);
    if (hoi4Match) {
        return hoi4Match[1];
    }
    const prefix = installPath + '/';
    return p.toLowerCase().startsWith(prefix.toLowerCase()) ? p.slice(prefix.length) : undefined;
}

describe('previewdef/focustree preview full-reload paths', function () {
    this.timeout(15000);

    const realGetConfig = (vscode.workspace as any).getConfiguration;
    const realStat = (vscode.workspace.fs as any).stat;
    const realReadDir = (vscode.workspace.fs as any).readDirectory;
    const realReadFile = (vscode.workspace.fs as any).readFile;
    const realWorkspaceFolders = (vscode.workspace as any).workspaceFolders;

    // 安装路径侧的文件；空 gfx/gui 文件让后台图标管线安静地跑空，不影响结构渲染。
    const files: Record<string, string> = {
        [focusFile]: noWarningTree,
        'interface/goals.gfx': 'spriteTypes = { }',
        'interface/nationalfocusview.gfx': 'spriteTypes = { }',
        'common/national_focus/00_titlebar_styles.txt': '',
    };

    let mtimeCounter = 1;

    beforeEach(function () {
        files[focusFile] = noWarningTree;
        mtimeCounter = 1;
        (vscode.workspace as any).getConfiguration = () => ({
            get: () => undefined, update: () => Promise.resolve(), inspect: () => undefined,
            installPath, modFile: '', loadDlcContents: false, inlayWindowGfxRoots: [],
            useConditionInFocus: false,
        });
        (vscode.workspace as any).workspaceFolders = [{ uri: vscode.Uri.file('C:/ws'), name: 'ws', index: 0 }];

        // 每次 stat 都换一个 mtime：图标与 gfx 解析的缓存（gfxMap/sprite/内容）都以文件的
        // expiry token 判过期，固定 mtime 会把本测试解析出的空 gfx 结果留给后面的测试。
        (vscode.workspace.fs as any).stat = async (uri: any) => {
            const rel = relativeToInstall(uri);
            if (rel === undefined) {
                throw new Error('ENOENT: ' + uriPath(uri));
            }
            const isDir = rel === '' ||
                Object.keys(files).some(f => f.toLowerCase().startsWith(rel.toLowerCase() + '/'));
            return { type: isDir ? vscode.FileType.Directory : vscode.FileType.File, mtime: mtimeCounter++, ctime: 0, size: 0 };
        };
        (vscode.workspace.fs as any).readDirectory = async (uri: any) => {
            const rel = relativeToInstall(uri);
            if (rel === undefined) {
                return [];
            }
            const names = new Set<string>();
            for (const file of Object.keys(files)) {
                if (rel !== '' && file.toLowerCase().startsWith(rel.toLowerCase() + '/')) {
                    names.add(file.slice(rel.length + 1).split('/')[0]);
                }
            }
            return [...names].map(name => [name, vscode.FileType.File]);
        };
        (vscode.workspace.fs as any).readFile = async (uri: any) => {
            const rel = relativeToInstall(uri) ?? '';
            const content = files[rel];
            if (content === undefined) {
                throw new Error('no such file: ' + rel);
            }
            return Buffer.from(content);
        };
    });

    afterEach(async function () {
        (vscode.workspace as any).getConfiguration = realGetConfig;
        (vscode.workspace.fs as any).stat = realStat;
        (vscode.workspace.fs as any).readDirectory = realReadDir;
        (vscode.workspace.fs as any).readFile = realReadFile;
        (vscode.workspace as any).workspaceFolders = realWorkspaceFolders;
        // 目录列表 3 秒 TTL、内容 60 秒缓存：清掉，别把桩数据漏给下一个测试。图标/gfx 的解析
        // 缓存（含 200ms 内无条件命中的窗口与 miss 记忆）同理，否则其它测试查同一个图标名会拿到
        // 本测试用空 gfx 解析出的结果。
        await clearDlcZipCache();
        clearGfxCaches();
    });

    function makePreview() {
        let html = '';
        let htmlWrites = 0;
        const messages: any[] = [];
        const webview = {
            postMessage: (msg: any) => { messages.push(msg); return Promise.resolve(true); },
            get html() { return html; },
            set html(v: string) { html = v; htmlWrites++; },
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
        // provider def 是联合类型：焦点树这一支带 previewConstructor，测试直接取它来建实例。
        const def = focusTreePreviewDef as { previewConstructor: new (uri: vscode.Uri, panel: any) => PreviewBase };
        const preview = new def.previewConstructor(vscode.Uri.file('C:/ws/' + focusFile), panel as any);
        return {
            preview,
            panel,
            messages,
            get html() { return html; },
            get htmlWrites() { return htmlWrites; },
        };
    }

    // 首帧之后 pushIconStyles 会启动一次后台解析并占用 loader 的并发槽（其 loadingPromise），
    // 期间发起的编辑会复用那次解析的结果。等它跑完再编辑，测试才对应"图标空闲时的编辑"这条
    // 常规路径（真实环境里 webview 的 ready 与图标解析同样会在几帧内走完）。
    async function settleBackground(preview: PreviewBase): Promise<void> {
        const loader = (preview as any).focusTreeLoader;
        for (let i = 0; i < 200; i++) {
            await new Promise(resolve => setTimeout(resolve, 2));
            if (loader.loadingPromise === undefined) {
                // 再多让两轮微任务，确保图标推送的后续步骤也走完。
                await new Promise(resolve => setTimeout(resolve, 0));
                await new Promise(resolve => setTimeout(resolve, 0));
                return;
            }
        }
    }

    const document = {
        getText: () => files[focusFile] ?? '',
        uri: vscode.Uri.file('C:/ws/' + focusFile),
    } as any;

    it('keeps the warning buttons in the shell, disabled while no tree warns, then updates in place', async function () {
        const h = makePreview();

        // 第一次：全量渲染。警告按钮常驻外壳，没有警告时画成禁用态。
        await h.preview.onDocumentChange(document);
        assert.strictEqual(h.htmlWrites, 1);
        assert.ok(h.html.includes('show-warnings'), 'the warning buttons stay in the shell');
        assert.ok(/id="show-warnings"[^>]*disabled/.test(h.html), 'a clean tree draws them disabled');
        await settleBackground(h.preview);

        // 制造一条布局警告（两个焦点同位置）：hasWarnings 从 false 变 true，按钮转为可用。
        files[focusFile] = warningTree;
        await h.preview.onDocumentChange(document);
        assert.ok(h.html.includes('show-warnings'), 'the shell carries the warning buttons');
        assert.ok(!/id="show-warnings"[^>]*disabled/.test(h.html), 'the buttons are enabled with the warnings');
        await settleBackground(h.preview);

        // 旗标不变（警告仍是同一类）、只有结构变化：走就地更新（不重写 html，给网页端发结构更新消息）。
        const htmlWritesAfterWarnings = h.htmlWrites;
        const updatesBefore = h.messages.filter(m => m?.type === 'update').length;
        files[focusFile] = warningTree2;
        await h.preview.onDocumentChange(document);
        assert.strictEqual(h.htmlWrites, htmlWritesAfterWarnings, 'structure-only edits stay in place');
        assert.ok(
            h.messages.filter(m => m?.type === 'update').length > updatesBefore,
            `later edits must post a structure update; messages=${JSON.stringify(h.messages.map(m => m?.type))}`,
        );
        await settleBackground(h.preview);

        // 反向：警告消失，按钮回到禁用态。
        files[focusFile] = noWarningTree;
        await h.preview.onDocumentChange(document);
        assert.ok(h.html.includes('show-warnings'), 'the buttons stay in the shell');
        assert.ok(/id="show-warnings"[^>]*disabled/.test(h.html), 'the buttons are disabled again without warnings');
    });

    it('takes the full-reload path while the panel is hidden', async function () {
        const h = makePreview();
        await h.preview.onDocumentChange(document);
        assert.strictEqual(h.htmlWrites, 1);
        await settleBackground(h.preview);

        // 隐藏面板时 postMessage 会被丢弃，必须改用重写 html 的全量路径，且要能完成。
        (h.panel as any).visible = false;
        files[focusFile] = warningTree;
        await h.preview.onDocumentChange(document);
        assert.strictEqual(h.htmlWrites, 2);
        assert.ok(h.html.includes('show-warnings'));
    });

    it('keeps the last render when the tree becomes empty mid-edit', async function () {
        const h = makePreview();
        await h.preview.onDocumentChange(document);
        assert.strictEqual(h.htmlWrites, 1);
        await settleBackground(h.preview);

        // 空文件是编辑过程中的瞬态：保留上一次渲染，既不重写 html 也不报错。
        files[focusFile] = '';
        await h.preview.onDocumentChange(document);
        assert.strictEqual(h.htmlWrites, 1);
    });

    it('shows the empty-tree panel when the very first render is empty, then renders once focuses appear', async function () {
        files[focusFile] = '';
        const h = makePreview();
        await h.preview.onDocumentChange(document);
        assert.strictEqual(h.htmlWrites, 1);
        assert.ok(h.html.includes('No focus tree'), h.html.slice(0, 200));
        await settleBackground(h.preview);

        // 文件里出现焦点后照常渲染，不再是"空树"页面。
        files[focusFile] = noWarningTree;
        await h.preview.onDocumentChange(document);
        assert.strictEqual(h.htmlWrites, 2);
        assert.ok(!h.html.includes('No focus tree'));
    });
});
