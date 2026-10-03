import * as assert from 'assert';
import * as vscode from 'vscode';
import { parseHoi4File } from '../hoiformat/hoiparser';
import { convertFocusFileNodeToJson, FocusTree, getFocusTreeWithFocusFile } from '../previewdef/focustree/schema';
import { collectFocusWarnings, formatFocusWarningReport, ParsedFocusFile } from '../previewdef/focustree/warningreport';
import { registerWarningStyles, warningBadgeClass, warningBoxClass, warningEntryClass, warningFlashClass, warningListClass } from '../previewdef/focustree/warningstyles';
import { StyleTable } from '../util/styletable';
import { refreshFeatureFlags } from '../util/featureflags';

// 布局检查与警告报告的测试：用真实解析器把小的焦点文件读成树，断言生成的警告。
function treeOf(content: string): FocusTree[] {
    const file = convertFocusFileNodeToJson(parseHoi4File(content), {});
    return getFocusTreeWithFocusFile(file, [], 'common/national_focus/test.txt', {});
}

function warningsOf(content: string): string[] {
    return treeOf(content).flatMap(t => t.warnings.map(w => w.text));
}

function hasWarning(content: string, fragment: string): boolean {
    return warningsOf(content).some(t => t.includes(fragment));
}

const tree = (focuses: string) => `focus_tree = {
    id = test_tree
${focuses}
}`;

describe('previewdef/focustree layout warnings', () => {
    it('reports a prerequisite that is not positioned above its dependent', () => {
        // y 越大越靠下：前置在上方时正常。
        assert.ok(!hasWarning(tree(`
    focus = { id = above x = 0 y = 0 }
    focus = { id = below x = 0 y = 1 prerequisite = { focus = above } }`), 'is not positioned above'));

        // 依赖者在 y=0、前置在 y=1（下方）时报告。
        assert.ok(hasWarning(tree(`
    focus = { id = above x = 0 y = 0 }
    focus = { id = below x = 0 y = 1 }
    focus = { id = dependent x = 2 y = 0 prerequisite = { focus = below } }`), 'is not positioned above'));
    });

    it('excuses a prerequisite that shares an exclusive row with its dependent', () => {
        const content = tree(`
    focus = { id = a x = 0 y = 0 mutually_exclusive = { focus = b } }
    focus = { id = b x = 2 y = 0 prerequisite = { focus = a } }`);
        assert.ok(!hasWarning(content, 'is not positioned above'), warningsOf(content).join(' | '));
    });

    // OR 块（任一满足即可）在真实 mod 里很常见，块内允许裸 id 与 focus = 两种写法。
    it('reads OR blocks inside prerequisite and mutually_exclusive', () => {
        const prereq = tree(`
    focus = { id = a x = 0 y = 2 }
    focus = { id = b x = 2 y = 2 }
    focus = { id = below x = 0 y = 0 prerequisite = { OR = { a b } } }`);
        assert.ok(hasWarning(prereq, 'is not positioned above'), warningsOf(prereq).join(' | '));

        const exclusive = tree(`
    focus = { id = a x = 0 y = 0 mutually_exclusive = { OR = { b } } }
    focus = { id = b x = 2 y = 1 }`);
        assert.ok(hasWarning(exclusive, 'not on the same row'), warningsOf(exclusive).join(' | '));
    });

    it('reads the single-symbol OR form and focus = keys inside OR blocks', () => {
        const single = tree(`
    focus = { id = a x = 0 y = 2 }
    focus = { id = below x = 0 y = 0 prerequisite = { OR = a } }`);
        assert.ok(hasWarning(single, 'is not positioned above'), warningsOf(single).join(' | '));

        const focusKeys = tree(`
    focus = { id = a x = 0 y = 2 }
    focus = { id = below x = 0 y = 0 prerequisite = { OR = { focus = a } } }`);
        assert.ok(hasWarning(focusKeys, 'is not positioned above'), warningsOf(focusKeys).join(' | '));
    });

    it('reports mutually exclusive focuses that are not on the same row', () => {
        const content = tree(`
    focus = { id = a x = 0 y = 0 mutually_exclusive = { focus = b } }
    focus = { id = b x = 2 y = 1 }`);
        assert.ok(hasWarning(content, 'not on the same row'), warningsOf(content).join(' | '));

        const sameRow = tree(`
    focus = { id = a x = 0 y = 0 mutually_exclusive = { focus = b } }
    focus = { id = b x = 2 y = 0 }`);
        assert.ok(!hasWarning(sameRow, 'not on the same row'));
    });

    it('folds focuses sharing one position into a single warning naming all of them', () => {
        const trees = treeOf(tree(`
    focus = { id = a x = 0 y = 0 }
    focus = { id = b x = 0 y = 0 }
    focus = { id = c x = 0 y = 0 }`));
        const stack = trees.flatMap(t => t.warnings).filter(w => w.text.includes('same position'));
        assert.strictEqual(stack.length, 1, 'one warning for the stack');
        assert.deepStrictEqual(stack[0].relatedSources, ['b', 'c']);
    });

    it('reports same-row icons closer than two grid units apart', () => {
        const tooClose = tree(`
    focus = { id = a x = 0 y = 0 }
    focus = { id = b x = 1 y = 0 }`);
        assert.ok(hasWarning(tooClose, 'less than 2 apart'));

        const farEnough = tree(`
    focus = { id = a x = 0 y = 0 }
    focus = { id = b x = 2 y = 0 }`);
        assert.ok(!hasWarning(farEnough, 'less than 2 apart'));
    });

    // 一对永远不同时显示的替代项（一正一反的 allow_branch）画在同一个位置是常规写法。
    it('does not call one spot a collision when allow_branch keeps the pair apart', () => {
        const content = tree(`
    focus = { id = a x = 0 y = 0 allow_branch = { has_country_flag = X } }
    focus = { id = b x = 0 y = 0 allow_branch = { NOT = { has_country_flag = X } } }`);
        assert.ok(!hasWarning(content, 'same position'), warningsOf(content).join(' | '));
    });

    // 位置沿 relative_position_id 链解析，链上的偏移被计入。
    it('resolves positions through relative_position_id', () => {
        const content = tree(`
    focus = { id = anchor x = 0 y = 0 }
    focus = { id = dependent x = 0 y = 0 }
    focus = { id = far x = 0 y = 3 relative_position_id = anchor }
    focus = { id = below x = 2 y = 0 prerequisite = { focus = far } }`);
        assert.ok(hasWarning(content, 'is not positioned above'), warningsOf(content).join(' | '));
    });

    // 联合焦点文件同样是焦点树定义：布局问题在那里也要报。
    it('checks joint focus files too', () => {
        const content = `joint_focus = { id = a x = 0 y = 0 }
joint_focus = { id = b x = 0 y = 0 }`;
        const warnings = treeOf(content).flatMap(t => t.warnings);
        assert.ok(warnings.some(w => w.text.includes('same position')), warnings.map(w => w.text).join(' | '));
        assert.ok(warnings.every(w => w.layout === true), 'layout warnings are tagged');
    });

    // 共享焦点文件是片段：指向另一个文件焦点的相对位置锚点不报告，但布局检查照跑。
    it('checks shared focus files too, without reporting missing anchors', () => {
        const content = `shared_focus = { id = SH_a x = 0 y = 0 relative_position_id = OTHER_FILE_FOCUS }
shared_focus = { id = SH_b x = 0 y = 0 relative_position_id = OTHER_FILE_FOCUS }`;
        const warnings = treeOf(content).flatMap(t => t.warnings);
        assert.ok(!warnings.some(w => w.text.includes('not exist')), warnings.map(w => w.text).join(' | '));
        assert.ok(warnings.some(w => w.text.includes('same position')), warnings.map(w => w.text).join(' | '));
    });
});

describe('previewdef/focustree warning report', () => {
    const parsed: ParsedFocusFile[] = [
        { path: 'common/national_focus/a.txt', file: convertFocusFileNodeToJson(parseHoi4File(tree(`
    focus = { id = good x = 0 y = 0 }
    focus = { id = bad x = 0 y = 0 }`)), {}) },
        { path: 'common/national_focus/b.txt', file: convertFocusFileNodeToJson(parseHoi4File(tree(`
    focus = { id = fine x = 0 y = 0 }`)), {}) },
    ];

    it('lists a file only when it has something to report', () => {
        const files = collectFocusWarnings(parsed);
        assert.deepStrictEqual(files.map(f => f.file), ['common/national_focus/a.txt']);
        assert.strictEqual(files[0].warnings.length, 1);
        assert.ok(files[0].warnings[0].text.includes('same position'));
    });

    it('summarises what was checked and what was found', () => {
        const report = formatFocusWarningReport(collectFocusWarnings(parsed), parsed.length);
        assert.ok(report.includes('Checked 2 focus tree files'), report);
        assert.ok(report.includes('1 warnings in 1 files'), report);
        assert.ok(report.includes('## common/national_focus/a.txt'), report);
        assert.ok(report.includes('- `good` (`test_tree`)'), report);
    });

    it('says so when nothing was found', () => {
        const report = formatFocusWarningReport([], 3);
        assert.ok(report.includes('No warnings.'), report);
        assert.ok(report.includes('0 warnings in 0 files'), report);
    });

    it('reports an unparsable file instead of dropping it', () => {
        const failed: ParsedFocusFile[] = [];
        const report = formatFocusWarningReport(
            [...collectFocusWarnings(failed), { file: 'common/national_focus/broken.txt', warnings: [], parseError: 'boom' }],
            1,
        );
        assert.ok(report.includes('Could not parse this file: boom'), report);
    });

    // 共享焦点被并入每个引用它的国家树，关于它的警告也随之出现；按定义文件归集才有一次。
    it('lists a shared focus problem once, under the file that defines it', () => {
        const realGetConfig = (vscode.workspace as any).getConfiguration;
        (vscode.workspace as any).getConfiguration = () => ({
            get: () => undefined, update: () => Promise.resolve(), inspect: () => undefined,
            modFile: '', loadDlcContents: false, inlayWindowGfxRoots: [], useConditionInFocus: true,
        });
        refreshFeatureFlags();
        try {
            const shared: ParsedFocusFile = {
                path: 'common/national_focus/shared.txt',
                file: convertFocusFileNodeToJson(parseHoi4File(`shared_focus = { id = SH_root x = 0 y = 0 }
shared_focus = { id = SH_child x = 0 y = 0 }`), {}),
            };
            const country = (tag: string, refs: string): ParsedFocusFile => ({
                path: `common/national_focus/${tag}.txt`,
                file: convertFocusFileNodeToJson(parseHoi4File(`focus_tree = {
    id = ${tag}_tree
${refs}
    focus = { id = ${tag}_start x = 10 y = 0 }
}`), {}),
            });

            // 单符号引用与块引用两种写法都要展开成同样的共享焦点集合。
            const files = collectFocusWarnings([
                shared,
                country('AAA', '    shared_focus = SH_root\n    shared_focus = SH_child'),
                country('BBB', '    shared_focus = { SH_root SH_child }'),
            ]);
            const sharedEntry = files.find(f => f.file === 'common/national_focus/shared.txt');
            assert.ok(sharedEntry, files.map(f => f.file).join(', '));
            assert.strictEqual(
                sharedEntry!.warnings.filter(w => w.text.includes('same position')).length,
                1,
                'the shared problem is listed once under its defining file',
            );
            for (const f of files.filter(f => f.file !== 'common/national_focus/shared.txt')) {
                assert.ok(!f.warnings.some(w => w.text.includes('same position')), f.file);
            }
        } finally {
            (vscode.workspace as any).getConfiguration = realGetConfig;
            refreshFeatureFlags();
        }
    });
});

// 警告样式经 StyleTable.name 推导类名：测试锁定发出的规则与导出常量一致，两侧不会漂移。
describe('previewdef/focustree warning styles', () => {
    it('emits every rule under the exported class name', () => {
        const styleTable = new StyleTable();
        registerWarningStyles(styleTable);
        const css = styleTable.toRawCss();
        for (const cls of [warningBoxClass, warningBadgeClass, warningFlashClass, warningEntryClass, warningListClass]) {
            assert.ok(css.includes('.' + cls), cls);
        }
    });
});
