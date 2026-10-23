import * as assert from 'assert';
import * as vscode from 'vscode';
import { hoi4FsProvider } from '../util/hoifs';

// 安装路径 provider 只读：即使有代码绕过 `isReadonly: true` 直接调用它，也必须被拒绝。

const uri = vscode.Uri.file('/game/common/decisions/a.txt');
const otherUri = vscode.Uri.file('/game/common/decisions/b.txt');

describe('util/hoifs install path provider', () => {
    function isNoPermissions(e: unknown): boolean {
        return e instanceof Error && (e as Error & { code?: string }).code === 'NoPermissions';
    }

    it('refuses createDirectory', () => {
        assert.throws(() => hoi4FsProvider.createDirectory(uri), isNoPermissions);
    });

    it('refuses writeFile', () => {
        assert.throws(() => hoi4FsProvider.writeFile(uri, new Uint8Array(1), { create: true, overwrite: true }), isNoPermissions);
    });

    it('refuses delete', () => {
        assert.throws(() => hoi4FsProvider.delete(uri, { recursive: false }), isNoPermissions);
    });

    it('refuses rename', () => {
        assert.throws(() => hoi4FsProvider.rename(uri, otherUri, { overwrite: false }), isNoPermissions);
    });

    it('refuses copy', () => {
        assert.throws(() => hoi4FsProvider.copy(uri, otherUri, { overwrite: false }), isNoPermissions);
    });
});
