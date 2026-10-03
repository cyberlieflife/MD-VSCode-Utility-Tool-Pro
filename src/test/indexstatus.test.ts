import * as assert from 'assert';
import * as vscode from 'vscode';
import { describeLiveIndexBuilds, IndexTimer } from '../util/indexCache';
import { registerIndexStatusCommand } from '../util/indexStatus';
import { Commands } from '../constants';

// 索引构建的可观测性：「显示索引状态」命令列出一行行正在进行的构建。计时器在 log 之后从
// 活构建登记里移除，所以正常完成的构建不会一直挂在状态里。

describe('util/indexStatus', () => {
    it('describes a running build with its phase and progress, and drops it once logged', () => {
        const timer = new IndexTimer('testIndex.workspace');
        const startLine = describeLiveIndexBuilds().find(l => l.startsWith('testIndex.workspace'));
        assert.ok(startLine, 'a fresh timer must be listed while it runs');
        assert.ok(startLine!.includes('starting for '), startLine);

        timer.mark('parse');
        timer.report(3, 10);
        const line = describeLiveIndexBuilds().find(l => l.startsWith('testIndex.workspace'));
        assert.ok(line!.includes('phase=parse'), line);
        assert.ok(line!.includes('3/10'), line);

        timer.log(10, 4);
        assert.ok(!describeLiveIndexBuilds().some(l => l.startsWith('testIndex.workspace')));
    });

    it('reports the idle state through the command', async () => {
        const messages: string[] = [];
        const realRegisterCommand = (vscode.commands as any).registerCommand;
        const realShowInformationMessage = (vscode.window as any).showInformationMessage;
        let registeredId: string | undefined;
        let handler: (() => void) | undefined;
        (vscode.commands as any).registerCommand = (id: string, cb: any) => {
            registeredId = id;
            handler = cb;
            return { dispose: () => undefined };
        };
        (vscode.window as any).showInformationMessage = async (m: string) => { messages.push(m); };

        try {
            const disposable = registerIndexStatusCommand();
            assert.strictEqual(registeredId, Commands.ShowIndexStatus);
            assert.ok(handler, 'the command handler must be registered');

            // 本套件没有任何构建在跑（上一个用例的计时器已 log）。
            handler!();
            assert.strictEqual(messages.length, 1);
            assert.ok(messages[0].includes('No index build is running.'), messages[0]);

            disposable.dispose();
        } finally {
            (vscode.commands as any).registerCommand = realRegisterCommand;
            (vscode.window as any).showInformationMessage = realShowInformationMessage;
        }
    });
});
