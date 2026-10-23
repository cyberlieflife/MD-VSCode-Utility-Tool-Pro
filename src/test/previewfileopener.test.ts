import * as assert from 'assert';
import * as vscode from 'vscode';
import { copyFilesIntoWorkspace } from '../util/previewfileopener';

// 预览点开一个不在 mod 里的文件时会复制一份到工作区。目标路径来自预览提供的字符串，
// 所以点目录和跳出工作区的路径都必须在读取任何内容之前被拒绝。

const options = {
    mustOpenFolderMessage: 'open a folder first',
    selectFolderMessage: 'pick a folder',
    failedToOpenMessage: (message: string) => `failed: ${message}`,
};

const fileloader = require('../util/fileloader') as typeof import('../util/fileloader');
const vsccommon = require('../util/vsccommon') as typeof import('../util/vsccommon');

let restores: (() => void)[] = [];
function replace(target: object, key: string, value: unknown): void {
    const holder = target as Record<string, unknown>;
    const original = holder[key];
    holder[key] = value;
    restores.push(() => {
        holder[key] = original;
    });
}

let readCalls: string[] = [];
let writtenFiles: string[] = [];
let messages: string[] = [];
let originalWorkspaceFolders: unknown;

describe('util/previewfileopener copy target', () => {
    // 钩子必须放在 describe 内：写在文件顶层会挂到 mocha 根套件上，替身会在别的测试里生效。
    beforeEach(() => {
        readCalls = [];
        writtenFiles = [];
        messages = [];

        replace(fileloader, 'getFilePathFromMod', async () => undefined);
        replace(fileloader, 'getHoiOpenedFileOriginalUri', (uri: unknown) => uri);
        replace(fileloader, 'readFileFromModOrHOI4', async (file: string) => {
            readCalls.push(file);
            return [Buffer.from('content'), vscode.Uri.file(`/game/${file}`)];
        });
        replace(vsccommon, 'dirUri', (uri: vscode.Uri) => uri);
        replace(vsccommon, 'mkdirs', async () => undefined);
        replace(vsccommon, 'writeFile', async (uri: vscode.Uri) => {
            writtenFiles.push(uri.fsPath);
        });

        originalWorkspaceFolders = (vscode.workspace as unknown as Record<string, unknown>).workspaceFolders;
        (vscode.workspace as unknown as Record<string, unknown>).workspaceFolders = [
            { uri: vscode.Uri.file('/ws') },
        ];
        replace(vscode.window, 'showErrorMessage', async (message: string) => {
            messages.push(message);
            return undefined;
        });
    });

    afterEach(() => {
        for (const restore of restores.reverse()) {
            restore();
        }
        restores = [];
        (vscode.workspace as unknown as Record<string, unknown>).workspaceFolders = originalWorkspaceFolders;
    });

    it('copies a game file into the workspace', async () => {
        const [uri] = await copyFilesIntoWorkspace(['gfx/interface/a.dds'], options);

        assert.strictEqual(uri?.fsPath, '/ws/gfx/interface/a.dds');
        assert.deepStrictEqual(readCalls, ['gfx/interface/a.dds']);
        assert.deepStrictEqual(writtenFiles, ['/ws/gfx/interface/a.dds']);
        assert.deepStrictEqual(messages, []);
    });

    it('refuses a dot-prefixed target without reading the file', async () => {
        const [uri] = await copyFilesIntoWorkspace(['.hidden/a.dds'], options);

        assert.strictEqual(uri, undefined);
        assert.deepStrictEqual(readCalls, []);
        assert.deepStrictEqual(writtenFiles, []);
        assert.strictEqual(messages.length, 1);
        assert.match(messages[0], /dot-prefixed/);
    });

    it('refuses a target that resolves outside the workspace before reading it', async () => {
        const [uri] = await copyFilesIntoWorkspace(['../outside.dds'], options);

        assert.strictEqual(uri, undefined);
        assert.deepStrictEqual(readCalls, []);
        assert.deepStrictEqual(writtenFiles, []);
        assert.match(messages[0], /outside the workspace/);
    });
});
