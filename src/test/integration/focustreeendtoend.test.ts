import * as assert from 'assert';
import * as vscode from 'vscode';
import * as nodeFs from 'fs';
import * as nodePath from 'path';
import * as nodeOs from 'os';
import { clearDlcZipCache } from '../../util/fileloader';
import { ensureFocusIndex } from '../../util/sharedFocusIndex';
import { refreshFeatureFlags } from '../../util/featureflags';
import { FocusTreeLoader } from '../../previewdef/focustree/loader';
import { LoaderSession } from '../../util/loader/loader';

// 端到端集成：真实临时 mod 目录 + 真实 fileloader + 共享焦点索引 + 焦点树 loader。单元测试各自
// 打桩，这里走完整链路——文件发现（含父模组层）、共享焦点索引、schema 解析与依赖登记。

describe('integration: focus tree loader over a real mod folder', function () {
    this.timeout(20000);

    const realStat = (vscode.workspace.fs as any).stat;
    const realReadFile = (vscode.workspace.fs as any).readFile;
    const realReadDirectory = (vscode.workspace.fs as any).readDirectory;
    const realGetConfiguration = (vscode.workspace as any).getConfiguration;
    const realWorkspaceFolders = (vscode.workspace as any).workspaceFolders;

    let root: string;

    function write(relative: string, content: string): void {
        const target = nodePath.join(root, relative);
        nodeFs.mkdirSync(nodePath.dirname(target), { recursive: true });
        nodeFs.writeFileSync(target, content);
    }

    function diskPath(uri: any): string {
        let value = String(uri?.fsPath ?? uri?.path ?? '');
        while (value.startsWith('file://')) {
            value = value.slice('file://'.length);
        }
        return nodePath.normalize(value.replace(/^\/+([A-Za-z]:)/, '$1'));
    }

    beforeEach(() => {
        root = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'hoi4integration-'));
        (vscode.workspace.fs as any).stat = async (uri: any) => {
            const stat = nodeFs.statSync(diskPath(uri));
            return {
                type: stat.isDirectory() ? vscode.FileType.Directory : vscode.FileType.File,
                mtime: stat.mtimeMs,
                ctime: stat.ctimeMs,
                size: stat.size,
            };
        };
        (vscode.workspace.fs as any).readFile = async (uri: any) => nodeFs.readFileSync(diskPath(uri));
        (vscode.workspace.fs as any).readDirectory = async (uri: any) =>
            nodeFs.readdirSync(diskPath(uri)).map(name => [name, vscode.FileType.File]);
        (vscode.workspace as any).getConfiguration = () => ({
            get: () => undefined,
            update: () => Promise.resolve(),
            inspect: () => undefined,
            installPath: root,
            modFile: '',
            loadDlcContents: false,
            inlayWindowGfxRoots: [],
            parentModPaths: [],
            userDataPath: '',
            useConditionInFocus: true,
            sharedFocusIndex: true,
            gfxIndex: false,
            localisationIndex: false,
        });
        refreshFeatureFlags();
        (vscode.workspace as any).workspaceFolders = [{ uri: vscode.Uri.file(root), name: 'mod', index: 0 }];

        // 一个最小的模组：共享焦点定义在 shared.txt，国家树引用其中一个。
        write('common/national_focus/shared.txt', `shared_focus = { id = SH_root x = 0 y = 0 }
shared_focus = { id = SH_child x = 0 y = 2 relative_position_id = SH_root }`);
        write('common/national_focus/tree.txt', `focus_tree = {
    id = test_tree
    shared_focus = SH_root
    focus = { id = start x = 10 y = 0 }
}`);
        write('interface/goals.gfx', 'spriteTypes = { }');
    });

    afterEach(async () => {
        (vscode.workspace.fs as any).stat = realStat;
        (vscode.workspace.fs as any).readFile = realReadFile;
        (vscode.workspace.fs as any).readDirectory = realReadDirectory;
        (vscode.workspace as any).getConfiguration = realGetConfiguration;
        (vscode.workspace as any).workspaceFolders = realWorkspaceFolders;
        refreshFeatureFlags();
        await clearDlcZipCache();
        nodeFs.rmSync(root, { recursive: true, force: true });
    });

    it('resolves a shared focus from another file and registers its file as a dependency', async () => {
        await ensureFocusIndex();

        const treeText = nodeFs.readFileSync(nodePath.join(root, 'common/national_focus/tree.txt'), 'utf8');
        const loader = new FocusTreeLoader('common/national_focus/tree.txt', () => Promise.resolve(treeText));
        const result = await loader.load(new LoaderSession(true));

        const tree = result.result.focusTrees.find(t => t.id === 'test_tree');
        assert.ok(tree, result.result.focusTrees.map(t => t.id).join(', '));
        assert.ok(tree!.focuses['SH_root'], `shared focus must be merged in: ${Object.keys(tree!.focuses).join(', ')}`);
        assert.ok(tree!.focuses['start'], 'the tree own focus stays');
        assert.ok(
            result.dependencies.includes('common/national_focus/shared.txt'),
            `the shared focus file must be a dependency: ${result.dependencies.join(', ')}`,
        );
        // 只并入被引用的焦点本身：SH_child 依赖 SH_root 而不是反过来，所以它留在共享树里。
        assert.strictEqual(tree!.focuses['SH_child'], undefined);
    });

    it('keeps the tree when the referenced shared focus cannot be found', async function () {
        write('common/national_focus/tree.txt', `focus_tree = {
    id = test_tree
    shared_focus = SH_absent
    focus = { id = start x = 10 y = 0 }
}`);
        await ensureFocusIndex();

        const treeText = nodeFs.readFileSync(nodePath.join(root, 'common/national_focus/tree.txt'), 'utf8');
        const loader = new FocusTreeLoader('common/national_focus/tree.txt', () => Promise.resolve(treeText));
        const result = await loader.load(new LoaderSession(true));

        const tree = result.result.focusTrees.find(t => t.id === 'test_tree');
        assert.ok(tree, 'a dangling reference must not drop the tree');
        assert.ok(tree!.focuses['start'], Object.keys(tree!.focuses).join(', '));
    });
});
