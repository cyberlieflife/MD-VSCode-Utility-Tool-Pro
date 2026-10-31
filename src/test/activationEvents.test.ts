import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

// 激活事件决定扩展在什么工作区里启动。仅有 GUI 或仅有 MIO 文件的工程不会命中任何
// common/* 目录，因此它们的预览在这些工程里根本不会出现；工作区根目录下还可能有嵌套的
// mod 文件夹，所以这些路径都从任意深度开始匹配。这里锁定这些入口存在。

const packageJson = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', '..', '..', 'package.json'), 'utf8'),
) as { activationEvents: string[] };

describe('package.json activation events', () => {
    it('activates for a workspace whose only interface file is a .gui', () => {
        assert.ok(
            packageJson.activationEvents.includes('workspaceContains:**/interface/**/*.gui'),
            packageJson.activationEvents.join('\n'),
        );
    });

    it('activates for a workspace whose only content is MIO organizations', () => {
        assert.ok(
            packageJson.activationEvents.includes(
                'workspaceContains:**/common/military_industrial_organization/organizations/*.txt',
            ),
            packageJson.activationEvents.join('\n'),
        );
    });

    it('activates for a nested mod that supplies the only event file', () => {
        assert.ok(
            packageJson.activationEvents.includes('workspaceContains:**/events/*.txt'),
            packageJson.activationEvents.join('\n'),
        );
    });
});
