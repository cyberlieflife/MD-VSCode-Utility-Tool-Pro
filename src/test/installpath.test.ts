import * as assert from 'assert';
import * as vscode from 'vscode';
import { UserError } from '../util/common';
import { checkInstallPath, clearInstallPathCache, getInstallPathUri, setInstallPathUri } from '../util/installpath';

// 安装路径是手输的字符串（资源管理器「复制为路径」会带引号），解析前必须归一化；归一化失败
// 会让每个 hoi4installpath: 查找静默落空。测试直接改写 stub 的 getConfiguration 返回值。

describe('util/installpath', () => {
    let config: Record<string, unknown> = {};
    const realGetConfiguration = (vscode.workspace as any).getConfiguration;
    const realStat = (vscode.workspace.fs as any).stat;
    const realShowErrorMessage = (vscode.window as any).showErrorMessage;

    beforeEach(() => {
        (vscode.workspace as any).getConfiguration = () => config;
        clearInstallPathCache();
    });

    afterEach(() => {
        (vscode.workspace as any).getConfiguration = realGetConfiguration;
        (vscode.workspace.fs as any).stat = realStat;
        (vscode.window as any).showErrorMessage = realShowErrorMessage;
        config = {};
        clearInstallPathCache();
    });

    describe('getInstallPathUri', () => {
        it('strips the surrounding double quotes Windows "Copy as path" adds', () => {
            config = { installPath: '"C:\\Program Files (x86)\\Steam\\steamapps\\common\\Hearts of Iron IV"' };

            assert.strictEqual(getInstallPathUri().fsPath, 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Hearts of Iron IV');
        });

        it('strips surrounding single quotes', () => {
            config = { installPath: "'C:\\HOI4'" };

            assert.strictEqual(getInstallPathUri().fsPath, 'C:\\HOI4');
        });

        it('trims surrounding whitespace', () => {
            config = { installPath: '  C:\\HOI4  ' };

            assert.strictEqual(getInstallPathUri().fsPath, 'C:\\HOI4');
        });

        it('leaves an already clean path untouched', () => {
            config = { installPath: 'C:\\HOI4' };

            assert.strictEqual(getInstallPathUri().fsPath, 'C:\\HOI4');
        });

        it('throws a UserError when the setting holds nothing usable', () => {
            for (const installPath of ['', '   ', '""', "''", undefined]) {
                config = { installPath };
                clearInstallPathCache();

                assert.throws(() => getInstallPathUri(), UserError, `expected a UserError for ${JSON.stringify(installPath)}`);
            }
        });

        it('caches the resolved path until the cache is cleared', () => {
            config = { installPath: 'C:\\HOI4' };
            assert.strictEqual(getInstallPathUri().fsPath, 'C:\\HOI4');

            config = { installPath: 'D:\\Other' };
            assert.strictEqual(getInstallPathUri().fsPath, 'C:\\HOI4');

            clearInstallPathCache();
            assert.strictEqual(getInstallPathUri().fsPath, 'D:\\Other');
        });

        it('returns the folder picked by the select folder command over the setting', () => {
            config = { installPath: 'C:\\HOI4' };
            setInstallPathUri(vscode.Uri.file('D:\\Picked'));

            assert.strictEqual(getInstallPathUri().fsPath, 'D:\\Picked');
        });
    });

    describe('checkInstallPath', () => {
        function recordErrorMessages(): string[] {
            const messages: string[] = [];
            (vscode.window as any).showErrorMessage = (message: string) => { messages.push(message); return Promise.resolve(undefined); };
            return messages;
        }

        it('reports the resolved path when it is not an existing directory', async () => {
            config = { installPath: '"C:\\HOI4"' };
            (vscode.workspace.fs as any).stat = () => Promise.reject(new Error('ENOENT'));
            const messages = recordErrorMessages();

            await checkInstallPath();

            assert.strictEqual(messages.length, 1);
            assert.ok(messages[0].includes('C:\\HOI4'), messages[0]);
            assert.ok(!messages[0].includes('"'), `the reported path should be the normalized one: ${messages[0]}`);
        });

        it('reports a path that exists but is a file', async () => {
            config = { installPath: 'C:\\HOI4' };
            (vscode.workspace.fs as any).stat = () => Promise.resolve({ type: vscode.FileType.File, mtime: 0, ctime: 0, size: 0 });
            const messages = recordErrorMessages();

            await checkInstallPath();

            assert.strictEqual(messages.length, 1);
        });

        it('stays silent when the install path is a directory', async () => {
            config = { installPath: 'C:\\HOI4' };
            (vscode.workspace.fs as any).stat = () => Promise.resolve({ type: vscode.FileType.Directory, mtime: 0, ctime: 0, size: 0 });
            const messages = recordErrorMessages();

            await checkInstallPath();

            assert.deepStrictEqual(messages, []);
        });

        it('stays silent when the setting is not set at all', async () => {
            config = { installPath: '' };
            (vscode.workspace.fs as any).stat = () => Promise.reject(new Error('ENOENT'));
            const messages = recordErrorMessages();

            await checkInstallPath();

            assert.deepStrictEqual(messages, []);
        });
    });
});
