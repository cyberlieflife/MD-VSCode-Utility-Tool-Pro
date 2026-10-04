import * as assert from 'assert';
import * as vscode from 'vscode';
import { auditFocusTrees, buildFocusTreeAuditReport, copyTreeWarnings } from '../previewdef/focustree/warningreport';
import { uncancelledToken } from '../util/progress';
import { clearDlcZipCache } from '../util/fileloader';

// 审计报告与复制的测试：文件系统按 HOI4 安装路径挂桩（mod 侧为空），剪贴板与提示被捕获。
// 与 focustreeloader.test.ts 同一套桩手法。

const installPath = 'C:/game';

const files: Record<string, string> = {};

const realGetConfig = (vscode.workspace as any).getConfiguration;
const realStat = (vscode.workspace.fs as any).stat;
const realReadDir = (vscode.workspace.fs as any).readDirectory;
const realReadFile = (vscode.workspace.fs as any).readFile;
const realOpenTextDocument = (vscode.workspace as any).openTextDocument;
const realShowTextDocument = (vscode.window as any).showTextDocument;
const realWriteFile = (vscode.workspace.fs as any).writeFile;
const realCreateDirectory = (vscode.workspace.fs as any).createDirectory;
const realWorkspaceFolders = (vscode.workspace as any).workspaceFolders;
const realClipboard = (vscode.env as any).clipboard;
const realShowInformationMessage = (vscode.window as any).showInformationMessage;
const realShowErrorMessage = (vscode.window as any).showErrorMessage;
const realWithProgress = (vscode.window as any).withProgress;

let clipboardText: string | undefined;
let infoMessages: string[] = [];
let errorMessages: string[] = [];
let openedDocuments: any[] = [];
let written: { path: string; content: string }[] = [];

function uriPath(uri: any): string {
    return String(uri.fsPath ?? uri.path ?? '');
}

function relativeToInstall(uri: any): string | undefined {
    // fsPath 可能为空串（scheme URI），此时退回 path。
    const p = String(uri.fsPath || uri.path || '').replace(/\\+/g, '/');
    // 安装目录是 hoi4installpath: scheme 的 URI；桩的 joinPath 拼成 'file://hoi4installpath://<rel>'。
    const hoi4Match = p.match(/(?:^|\/\/)hoi4installpath:\/*(.*)$/i);
    if (hoi4Match) {
        return hoi4Match[1];
    }
    const prefix = installPath + '/';
    return p.toLowerCase().startsWith(prefix.toLowerCase()) ? p.slice(prefix.length) : undefined;
}

describe('previewdef/focustree audit and copy', function () {
    this.timeout(10000);

    beforeEach(function () {
        for (const key of Object.keys(files)) {
            delete files[key];
        }
        clipboardText = undefined;
        infoMessages = [];
        errorMessages = [];
        openedDocuments = [];
        written = [];

        (vscode.workspace as any).getConfiguration = () => ({
            get: (key: string) => {
                if (key === 'installPath') { return installPath; }
                if (key === 'auditor.reportFolder') { return (global as any).__reportFolder ?? ''; }
                if (key === 'auditor.includeVanilla') { return (global as any).__includeVanilla ?? true; }
                return undefined;
            },
            update: () => Promise.resolve(), inspect: () => undefined,
            installPath, modFile: '', loadDlcContents: false, inlayWindowGfxRoots: [],
        });
        (vscode.workspace as any).workspaceFolders = [{ uri: vscode.Uri.file('C:/ws'), name: 'ws', index: 0 }];

        (vscode.workspace.fs as any).stat = async (uri: any) => {
            const rel = relativeToInstall(uri);
            // 工作区侧没有这些文件（真实环境里 mod 只覆盖自己有的东西）。
            if (rel === undefined) {
                throw new Error('ENOENT: ' + uriPath(uri));
            }
            const isDir = rel === '' ||
                Object.keys(files).some(f => f.toLowerCase().startsWith(rel.toLowerCase() + '/'));
            return { type: isDir ? vscode.FileType.Directory : vscode.FileType.File, mtime: 1, ctime: 0, size: 0 };
        };
        (vscode.workspace.fs as any).readDirectory = async (uri: any) => {
            const rel = relativeToInstall(uri);
            if (rel === undefined) {
                return [];
            }
            const names = new Set<string>();
            for (const file of Object.keys(files)) {
                if (rel === '' || file.toLowerCase().startsWith(rel.toLowerCase() + '/')) {
                    const rest = rel === '' ? file : file.slice(rel.length + 1);
                    names.add(rest.split('/')[0]);
                }
            }
            return [...names].map(name => [name, vscode.FileType.File]);
        };
        (vscode.workspace.fs as any).readFile = async (uri: any) => {
            const rel = relativeToInstall(uri) ?? '';
            const content = files[rel] ?? files[Object.keys(files).find(k => k.toLowerCase() === rel.toLowerCase()) ?? ''];
            if (content === undefined) {
                throw new Error('no such file: ' + rel);
            }
            return Buffer.from(content);
        };
        (vscode.workspace as any).openTextDocument = async (arg: any) => {
            openedDocuments.push(arg);
            return { uri: vscode.Uri.file('untitled:audit'), getText: () => arg?.content ?? '' };
        };
        (vscode.window as any).showTextDocument = async () => undefined;
        (vscode.workspace.fs as any).writeFile = async (uri: any, content: any) => {
            written.push({ path: uriPath(uri), content: content.toString() });
        };
        (vscode.workspace.fs as any).createDirectory = async () => undefined;

        (vscode.env as any).clipboard = {
            writeText: async (text: string) => { clipboardText = text; },
        };
        (vscode.window as any).showInformationMessage = async (msg: string) => { infoMessages.push(msg); };
        (vscode.window as any).showErrorMessage = async (msg: string) => { errorMessages.push(msg); };
        // 提示立即回调：真实现等通知关闭才 resolve，测试不需要那个生命周期。
        (vscode.window as any).withProgress = (options: any, task: any) => {
            const report = { report: () => undefined };
            void task(report, uncancelledToken);
            return Promise.resolve();
        };
    });

    afterEach(async function () {
        // 每个测试都把整套桩装回去，谁也不能把桩留给下一个文件。
        (vscode.workspace as any).getConfiguration = realGetConfig;
        (vscode.workspace.fs as any).stat = realStat;
        (vscode.workspace.fs as any).readDirectory = realReadDir;
        (vscode.workspace.fs as any).readFile = realReadFile;
        (vscode.workspace as any).openTextDocument = realOpenTextDocument;
        (vscode.window as any).showTextDocument = realShowTextDocument;
        (vscode.workspace.fs as any).writeFile = realWriteFile;
        (vscode.workspace.fs as any).createDirectory = realCreateDirectory;
        (vscode.workspace as any).workspaceFolders = realWorkspaceFolders;
        (vscode.env as any).clipboard = realClipboard;
        (vscode.window as any).showInformationMessage = realShowInformationMessage;
        (vscode.window as any).showErrorMessage = realShowErrorMessage;
        (vscode.window as any).withProgress = realWithProgress;
        delete (global as any).__reportFolder;
        delete (global as any).__includeVanilla;
        // 文件列表有 3 秒 TTL 缓存、文件内容有 60 秒缓存；它清掉两者，下一个测试才读到自己的 files。
        await clearDlcZipCache();
    });

    const noProgress = { token: uncancelledToken, report: () => undefined };

    it('checks every focus file and reports the ones with problems, parse failures included', async () => {
        files['common/national_focus/clean.txt'] = 'focus_tree = { id = clean_tree\n focus = { id = fine x = 0 y = 0 } }';
        files['common/national_focus/problem.txt'] = 'focus_tree = { id = problem_tree\n focus = { id = a x = 0 y = 0 }\n focus = { id = b x = 0 y = 0 } }';
        files['common/national_focus/broken.txt'] = 'focus_tree = {';

        const report = await buildFocusTreeAuditReport(noProgress, true);
        assert.ok(report, 'a report must be produced');
        assert.ok(report!.includes('Checked 3 focus tree files'), report);
        assert.ok(report!.includes('## common/national_focus/problem.txt'), report);
        assert.ok(report!.includes('share the same position'), report);
        assert.ok(report!.includes('Could not parse this file:'), report);
        assert.ok(!report!.includes('## common/national_focus/clean.txt'), report);
    });

    it('opens the report in an untitled editor when no folder is configured', async () => {
        files['common/national_focus/clean.txt'] = 'focus_tree = { id = clean_tree }';
        await auditFocusTrees();
        assert.strictEqual(written.length, 0, 'nothing may be written without a folder');
        assert.strictEqual(openedDocuments.length, 1, `the report must open in a document; errors=${JSON.stringify(errorMessages)}`);
        assert.strictEqual(openedDocuments[0].language, 'markdown');
        assert.ok(openedDocuments[0].content.includes('Focus tree warnings'));
    });

    it('writes focus-tree-audit.md into the configured folder', async () => {
        (global as any).__reportFolder = 'reports';
        files['common/national_focus/clean.txt'] = 'focus_tree = { id = clean_tree }';
        await auditFocusTrees();
        assert.strictEqual(written.length, 1, `the report must be written to the folder; errors=${JSON.stringify(errorMessages)}`);
        assert.ok(written[0].path.endsWith('focus-tree-audit.md'), written[0].path);
        assert.ok(written[0].content.includes('Focus tree warnings'));
        assert.strictEqual(openedDocuments.length, 0);
    });

    it('skips the vanilla install when includeVanilla is off', async () => {
        (global as any).__includeVanilla = false;
        files['common/national_focus/clean.txt'] = 'focus_tree = { id = clean_tree\n focus = { id = a x = 0 y = 0 }\n focus = { id = b x = 0 y = 0 } }';
        const report = await buildFocusTreeAuditReport(noProgress, false);
        assert.ok(report, 'a report must still be produced');
        assert.ok(report!.includes('Checked 0 focus tree files'), report);
        assert.ok(!report!.includes('clean.txt'), report);
    });

    it('returns nothing when the reader cancels', async () => {
        files['common/national_focus/clean.txt'] = 'focus_tree = { id = clean_tree }';
        const cancelledToken = { isCancellationRequested: true, onCancellationRequested: () => ({ dispose: () => undefined }) };
        const report = await buildFocusTreeAuditReport({ token: cancelledToken as any, report: () => undefined }, true);
        assert.strictEqual(report, undefined, 'a cancelled audit must not produce a report');
    });

    it('keeps the task running when the progress notification cannot open', async () => {
        (vscode.window as any).withProgress = () => { throw new Error('no notifications'); };
        files['common/national_focus/clean.txt'] = 'focus_tree = { id = clean_tree }';
        await auditFocusTrees();
        assert.strictEqual(openedDocuments.length, 1, `the audit must finish; errors=${JSON.stringify(errorMessages)}`);
    });

    it('asks for an absolute path when a relative folder has no workspace', async () => {        (global as any).__reportFolder = 'reports';
        (vscode.workspace as any).workspaceFolders = undefined;
        files['common/national_focus/clean.txt'] = 'focus_tree = { id = clean_tree }';
        await auditFocusTrees();
        assert.strictEqual(written.length, 0, 'nothing may be written without a workspace');
        assert.ok(errorMessages.some(m => m.includes('absolute path')), JSON.stringify(errorMessages));
    });

    describe('copyTreeWarnings', () => {
        it('writes the file section to the clipboard for a well-formed message', async () => {
            await copyTreeWarnings(
                { treeId: 'test_tree', warnings: [{ source: 'a', text: 'Focuses a and b overlap.' }] },
                'common/national_focus/test.txt',
            );
            assert.ok(clipboardText, 'the clipboard must receive text');
            assert.ok(clipboardText!.includes('## common/national_focus/test.txt'), clipboardText);
            assert.ok(clipboardText!.includes('- `a` (`test_tree`): Focuses a and b overlap.'), clipboardText);
            assert.ok(infoMessages.some(m => m.includes('1')), JSON.stringify(infoMessages));
        });

        it('says so instead of copying when the tree has no warnings', async () => {
            await copyTreeWarnings({ treeId: 'test_tree', warnings: [] }, 'common/national_focus/test.txt');
            assert.strictEqual(clipboardText, undefined);
            assert.ok(infoMessages.some(m => m.includes('no warnings')), JSON.stringify(infoMessages));
        });

        it('ignores a message that is not a well-formed warning list', async () => {
            await copyTreeWarnings(null, 'common/national_focus/test.txt');
            await copyTreeWarnings({ treeId: 7, warnings: 'nope' }, 'common/national_focus/test.txt');
            await copyTreeWarnings({ treeId: 't', warnings: [{ source: 1, text: 2 }] }, 'common/national_focus/test.txt');
            assert.strictEqual(clipboardText, undefined);
            assert.strictEqual(infoMessages.length, 0);
        });

        it('reports a failure instead of rejecting when the clipboard is unavailable', async () => {
            (vscode.env as any).clipboard = {
                writeText: async () => { throw new Error('clipboard locked'); },
            };
            await copyTreeWarnings(
                { treeId: 'test_tree', warnings: [{ source: 'a', text: 'w' }] },
                'common/national_focus/test.txt',
            );
            assert.ok(errorMessages.some(m => m.includes('clipboard locked')), JSON.stringify(errorMessages));
        });
    });
});
