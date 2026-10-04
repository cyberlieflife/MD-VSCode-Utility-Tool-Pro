import * as assert from 'assert';
import * as vscode from 'vscode';
import { describeLiveIndexBuilds, IndexTimer } from '../util/indexCache';
import { registerIndexStatusCommand } from '../util/indexBuild';
import { Commands } from '../constants';

// 索引构建的可观测性：「显示索引状态」命令列出一行行正在进行的构建。计时器在 end 之后从
// 活构建登记里移除，所以正常完成的构建不会一直挂在状态里。

describe('util/indexStatus', () => {
    it('describes a running build with its phase and progress, and drops it once ended', () => {
        const timer = new IndexTimer('testIndex.workspace');
        // 尚未 begin 的计时器不算活构建：没有阶段可说，也就没有「卡在哪一步」的信息。
        assert.ok(!describeLiveIndexBuilds().some(l => l.startsWith('testIndex.workspace')));

        timer.begin('list');
        const startLine = describeLiveIndexBuilds().find(l => l.startsWith('testIndex.workspace'));
        assert.ok(startLine, 'a begun timer must be listed while it runs');
        assert.ok(startLine!.includes('phase=list'), startLine);

        timer.begin('parse');
        timer.progress(3, 10);
        const line = describeLiveIndexBuilds().find(l => l.startsWith('testIndex.workspace'));
        assert.ok(line!.includes('phase=parse'), line);
        assert.ok(line!.includes('3/10'), line);

        timer.end(10, 4);
        assert.ok(!describeLiveIndexBuilds().some(l => l.startsWith('testIndex.workspace')));
    });

    it('drops a failed build from the live list without logging a breakdown', () => {
        const timer = new IndexTimer('testIndex.failed');
        timer.begin('parse');
        assert.ok(describeLiveIndexBuilds().some(l => l.startsWith('testIndex.failed')));

        timer.dispose();
        assert.ok(!describeLiveIndexBuilds().some(l => l.startsWith('testIndex.failed')));
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

            // 本套件没有任何构建在跑（上一个用例的计时器已 end/dispose）。
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
