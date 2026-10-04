import * as assert from 'assert';
import * as vscode from 'vscode';
import * as nodeFs from 'fs';
import * as nodePath from 'path';
import * as nodeOs from 'os';
import {
    checkParentModPaths,
    clearParentModCache,
    getExplicitParentModUris,
    getParentModUris,
    normalizeParentModPathSetting,
    onDidChangeParentMods,
    publishParentMods,
    resetParentModsForTest,
    setResolvedDependencies,
} from '../util/parentmods';
import { defaultUserDataDirs, findUserDataDir, loadModRegistry } from '../util/moddependencies';
import { clearDlcZipCache, getFilePathFromModOrHOI4, listFilesFromModOrHOI4 } from '../util/fileloader';

// 父模组支持：设置规范化、生效列表（显式优先、去重、排除工作区文件夹）、descriptor 依赖经启动器
// 注册表解析，以及 fileloader 的查找顺序（工作区 → 父模组 → 本体）。文件系统走真实临时目录。

describe('util/parentmods + moddependencies + fileloader ordering', function () {
    this.timeout(15000);

    const realStat = (vscode.workspace.fs as any).stat;
    const realReadFile = (vscode.workspace.fs as any).readFile;
    const realReadDirectory = (vscode.workspace.fs as any).readDirectory;
    const realGetConfiguration = (vscode.workspace as any).getConfiguration;
    const realWorkspaceFolders = (vscode.workspace as any).workspaceFolders;
    const realShowErrorMessage = (vscode.window as any).showErrorMessage;

    let root: string;
    let config: Record<string, unknown>;
    let errorMessages: string[];

    function write(relative: string, content: string): void {
        const target = nodePath.join(root, relative);
        nodeFs.mkdirSync(nodePath.dirname(target), { recursive: true });
        nodeFs.writeFileSync(target, content);
    }

    // 桩的 Uri 只是最小实现：经过 toString→parse 往返后 fsPath 会带上 'file://' 前缀（甚至被前
    // 面的覆盖逻辑拼成单斜杠），这里统一还原成真正的磁盘路径再交给 node fs。
    function diskPath(uri: any): string {
        let value = String(uri?.fsPath ?? uri?.path ?? '');
        while (value.startsWith('file://')) {
            value = value.slice('file://'.length);
        }
        value = value.replace(/^\/+([A-Za-z]:)/, '$1');
        return nodePath.normalize(value);
    }

    function configure(values: Record<string, unknown>): void {
        config = {
            installPath: nodePath.join(root, 'install'),
            modFile: '',
            loadDlcContents: false,
            parentModPaths: [],
            userDataPath: '',
            ...values,
        };
        (vscode.workspace as any).getConfiguration = () => config;
        // 只清缓存，不动监听者：用例会在中途改设置，注册过的监听要继续收得到发布。
        clearParentModCache();
    }

    beforeEach(() => {
        root = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'hoi4parent-'));
        errorMessages = [];
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
        (vscode.window as any).showErrorMessage = async (message: string) => { errorMessages.push(message); };
        (vscode.workspace as any).workspaceFolders = undefined;
        configure({});
    });

    afterEach(async () => {
        (vscode.workspace.fs as any).stat = realStat;
        (vscode.workspace.fs as any).readFile = realReadFile;
        (vscode.workspace.fs as any).readDirectory = realReadDirectory;
        (vscode.workspace as any).getConfiguration = realGetConfiguration;
        (vscode.workspace as any).workspaceFolders = realWorkspaceFolders;
        (vscode.window as any).showErrorMessage = realShowErrorMessage;
        resetParentModsForTest();
        await clearDlcZipCache();
        nodeFs.rmSync(root, { recursive: true, force: true });
    });

    describe('parent mods list', () => {
        it('normalizes the setting, accepting a lone string and dropping blanks', () => {
            assert.deepStrictEqual(normalizeParentModPathSetting('D:/mods/parent'), ['D:/mods/parent']);
            assert.deepStrictEqual(normalizeParentModPathSetting(['a', '  ', '', 'b']), ['a', 'b']);
            assert.deepStrictEqual(normalizeParentModPathSetting(undefined), []);
            assert.deepStrictEqual(normalizeParentModPathSetting(7), []);
        });

        it('lists the explicit entries first, then resolved dependencies, deduplicated', () => {
            nodeFs.mkdirSync(nodePath.join(root, 'mods', 'parentA'), { recursive: true });
            nodeFs.mkdirSync(nodePath.join(root, 'mods', 'parentB'), { recursive: true });
            configure({ parentModPaths: [nodePath.join(root, 'mods', 'parentA')] });

            setResolvedDependencies(
                [vscode.Uri.file(nodePath.join(root, 'mods', 'parentA')), vscode.Uri.file(nodePath.join(root, 'mods', 'parentB'))],
                [],
            );

            const uris = getParentModUris().map(uri => uri.fsPath.replace(/\\/g, '/'));
            assert.deepStrictEqual(uris, [
                nodePath.join(root, 'mods', 'parentA').replace(/\\/g, '/'),
                nodePath.join(root, 'mods', 'parentB').replace(/\\/g, '/'),
            ]);
        });

        it('leaves a parent that is also a workspace folder out of the list', () => {
            const shared = nodePath.join(root, 'mods', 'shared');
            nodeFs.mkdirSync(shared, { recursive: true });
            configure({ parentModPaths: [shared] });
            (vscode.workspace as any).workspaceFolders = [{ uri: vscode.Uri.file(shared), name: 'shared', index: 0 }];

            assert.deepStrictEqual(getParentModUris(), []);
        });

        it('reports an explicit path that is not a directory', async () => {
            configure({ parentModPaths: [nodePath.join(root, 'nope')] });
            await checkParentModPaths();
            assert.strictEqual(errorMessages.length, 1);
            assert.ok(errorMessages[0].includes('Parent mod path does not exist'), errorMessages[0]);
        });

        it('tells listeners only when the effective list or the unresolved names change', () => {
            const seen: { folders: boolean; unresolved: boolean }[] = [];
            const disposable = onDidChangeParentMods(e => seen.push(e));
            try {
                assert.strictEqual(publishParentMods(), false, 'nothing published yet, both lists are empty');
                assert.deepStrictEqual(seen, []);

                nodeFs.mkdirSync(nodePath.join(root, 'mods', 'parentA'), { recursive: true });
                configure({ parentModPaths: [nodePath.join(root, 'mods', 'parentA')] });
                assert.strictEqual(publishParentMods(), true);
                assert.deepStrictEqual(seen, [{ folders: true, unresolved: false }]);

                // Same list again: quiet.
                assert.strictEqual(publishParentMods(), false);
                assert.strictEqual(seen.length, 1);

                setResolvedDependencies([], ['Missing Mod']);
                publishParentMods();
                assert.strictEqual(seen.length, 2);
                assert.deepStrictEqual(seen[1], { folders: false, unresolved: true });
            } finally {
                disposable.dispose();
            }
        });

        it('drops the cached list when asked, so the setting is re-read', () => {
            nodeFs.mkdirSync(nodePath.join(root, 'mods', 'one'), { recursive: true });
            configure({ parentModPaths: [nodePath.join(root, 'mods', 'one')] });
            assert.strictEqual(getExplicitParentModUris().length, 1);
            assert.strictEqual(getParentModUris().length, 1);
        });
    });

    describe('user data directory and launcher registry', () => {
        it('names the platform default user data directories', () => {
            const win = defaultUserDataDirs('win32', { USERPROFILE: 'C:/Users/x' }).map(uri => uri.fsPath.replace(/\\/g, '/'));
            assert.ok(win.some(p => p.endsWith('Documents/Paradox Interactive/Hearts of Iron IV')), win.join(', '));

            const linux = defaultUserDataDirs('linux', { HOME: '/home/x' }).map(uri => uri.fsPath.replace(/\\/g, '/'));
            assert.deepStrictEqual(linux, ['/home/x/.local/share/Paradox Interactive/Hearts of Iron IV']);
        });

        it('reads the registry from <user data>/mod, preferring the launcher-enabled copy', async () => {
            const localFolder = nodePath.join(root, 'mods', 'local').replace(/\\/g, '/');
            const steamFolder = nodePath.join(root, 'mods', 'steam').replace(/\\/g, '/');
            nodeFs.mkdirSync(nodePath.join(root, 'mods', 'local'), { recursive: true });
            nodeFs.mkdirSync(nodePath.join(root, 'mods', 'steam'), { recursive: true });
            write('userdata/dlc_load.json', JSON.stringify({ enabled_mods: ['mod/b_steam.mod'] }));
            write('userdata/mod/a_local.mod', `name="Parent Mod"\npath="${localFolder}"`);
            write('userdata/mod/b_steam.mod', `name="Parent Mod"\npath="${steamFolder}"`);
            write('userdata/mod/zip_only.mod', 'name="Zipped"\narchive="x.zip"');

            const registry = await loadModRegistry(vscode.Uri.file(nodePath.join(root, 'userdata')));
            assert.deepStrictEqual([...registry.keys()], ['Parent Mod']);
            assert.strictEqual(registry.get('Parent Mod')!.fsPath.replace(/\\/g, '/'), steamFolder);
        });

        it('takes the user data directory from the setting when it looks like one', async () => {
            write('userdata/dlc_load.json', '{}');
            nodeFs.mkdirSync(nodePath.join(root, 'userdata', 'mod'), { recursive: true });
            configure({ userDataPath: nodePath.join(root, 'userdata') });

            const found = await findUserDataDir(undefined);
            assert.strictEqual(found?.fsPath.replace(/\\/g, '/'), nodePath.join(root, 'userdata').replace(/\\/g, '/'));

            configure({ userDataPath: nodePath.join(root, 'not-userdata') });
            assert.strictEqual(await findUserDataDir(undefined), undefined);
        });
    });

    describe('file lookup order', () => {
        it('reads a file from the parent mod when the workspace does not override it, and lists parents', async () => {
            const parent = nodePath.join(root, 'parent');
            const replaceOnly = nodePath.join(root, 'submod');
            write('parent/interface/only_in_parent.gfx', 'parent');
            write('parent/interface/shared.gfx', 'parent');
            write('submod/interface/shared.gfx', 'submod');
            nodeFs.mkdirSync(replaceOnly, { recursive: true });
            configure({ parentModPaths: [parent] });
            (vscode.workspace as any).workspaceFolders = [{ uri: vscode.Uri.file(replaceOnly), name: 'submod', index: 0 }];

            // 工作区没有这个文件 → 从父模组读。
            const fromParent = await getFilePathFromModOrHOI4('interface/only_in_parent.gfx');
            assert.ok(fromParent, 'expected the parent mod copy');
            assert.strictEqual(fromParent!.fsPath.replace(/\\/g, '/'), nodePath.join(parent, 'interface/only_in_parent.gfx').replace(/\\/g, '/'));

            // 工作区覆盖了同名文件 → 工作区赢。
            const overridden = await getFilePathFromModOrHOI4('interface/shared.gfx');
            assert.strictEqual(overridden!.fsPath.replace(/\\/g, '/'), nodePath.join(replaceOnly, 'interface/shared.gfx').replace(/\\/g, '/'));

            // 目录列举合并两边，且覆盖过的名字只出现一次。
            const listed = await listFilesFromModOrHOI4('interface', { hoi4: false });
            assert.strictEqual(listed.filter(f => f === 'shared.gfx').length, 1, JSON.stringify(listed));
            assert.ok(listed.includes('only_in_parent.gfx'), JSON.stringify(listed));
        });

        it('skips the parent half when the caller asks it to', async () => {
            const parent = nodePath.join(root, 'parent');
            write('parent/interface/only_in_parent.gfx', 'parent');
            configure({ parentModPaths: [parent] });

            assert.strictEqual(await getFilePathFromModOrHOI4('interface/only_in_parent.gfx', { parent: false }), undefined);
            assert.deepStrictEqual(await listFilesFromModOrHOI4('interface', { hoi4: false, parent: false }), []);
        });

        it('keeps parent lookups apart in the path memo', async () => {
            const parentA = nodePath.join(root, 'parentA');
            const parentB = nodePath.join(root, 'parentB');
            write('parentA/interface/same.gfx', 'A');
            write('parentB/interface/same.gfx', 'B');

            const viaA = await getFilePathFromModOrHOI4('interface/same.gfx', { parentModUris: [vscode.Uri.file(parentA)] });
            const viaB = await getFilePathFromModOrHOI4('interface/same.gfx', { parentModUris: [vscode.Uri.file(parentB)] });
            assert.strictEqual(viaA!.fsPath.replace(/\\/g, '/'), nodePath.join(parentA, 'interface/same.gfx').replace(/\\/g, '/'));
            assert.strictEqual(viaB!.fsPath.replace(/\\/g, '/'), nodePath.join(parentB, 'interface/same.gfx').replace(/\\/g, '/'));
        });
    });
});
