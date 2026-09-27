import * as assert from 'assert';
import * as vscode from 'vscode';
import { parseHoi4File } from '../hoiformat/hoiparser';
import {
    buildModifierLocalisationKeys,
    collectModifierHints,
    formatInlayText,
    isModifierScriptFile,
} from '../inlayhint/modifierInlayHint';

// Mirrors a real common/ideas/*.txt file: a modifier block nested at depth 3, a modifier name that
// exists under both the MODIFIERS_ and MODIFIER_ key shapes, and a custom_modifier_tooltip whose
// value is a localisation key.
const scriptContent = [
    'ideas = {',
    '\tRSC_idea = {',
    '\t\tmodifier = {',
    '\t\t\twar_support_factor = 0.1',
    '\t\t\tarmy_infantry_attack_factor = 0.05',
    '\t\t}',
    '\t\tcustom_modifier_tooltip = ETH_balance_range_tt',
    '\t}',
    '}',
].join('\n');

const localisation: Record<string, string> = {
    MODIFIER_WAR_SUPPORT_FACTOR: '战争支持度',
    // The game tooltips reference the MODIFIERS_ form, so it must win over the MODIFIER_ one.
    MODIFIERS_ARMY_INFANTRY_ATTACK_FACTOR: '步兵攻击',
    MODIFIER_ARMY_INFANTRY_ATTACK_FACTOR: '步兵师攻击',
    ETH_balance_range_tt: '\\n§Y地区修正：§!\\n$MODIFIER_WAR_SUPPORT_FACTOR$：§Y0%§!',
};

const lookup = (key: string): string | undefined => localisation[key];

function offsetOf(content: string, needle: string): number {
    const index = content.indexOf(needle);
    assert.notStrictEqual(index, -1, 'test fixture is missing ' + needle);
    return index;
}

describe('modifierInlayHint', () => {
    describe('isModifierScriptFile', () => {
        it('accepts txt files in both script schemes', () => {
            assert.strictEqual(isModifierScriptFile(vscode.Uri.file('D:\\mod\\common\\ideas\\test.txt')), true);
            assert.strictEqual(isModifierScriptFile(vscode.Uri.file('/mod/common/ideas/test.TXT')), true);
            assert.strictEqual(
                isModifierScriptFile({ scheme: 'hoi4installpath', path: '/common/ideas/test.txt' } as vscode.Uri),
                true
            );
        });

        it('rejects other extensions and schemes', () => {
            assert.strictEqual(isModifierScriptFile(vscode.Uri.file('D:\\mod\\localisation\\test.yml')), false);
            assert.strictEqual(
                isModifierScriptFile({ scheme: 'untitled', path: '/common/ideas/test.txt' } as vscode.Uri),
                false
            );
        });
    });

    describe('buildModifierLocalisationKeys', () => {
        it('tries the MODIFIERS_, MODIFIER_ and lower-case key shapes in order', () => {
            assert.deepStrictEqual(buildModifierLocalisationKeys('army_attack_factor'), [
                'MODIFIERS_ARMY_ATTACK_FACTOR',
                'MODIFIER_ARMY_ATTACK_FACTOR',
                'modifier_army_attack_factor',
            ]);
        });

        it('skips MODIFIER_ keys that are UI strings rather than modifier names', () => {
            assert.deepStrictEqual(buildModifierLocalisationKeys('none'), ['MODIFIERS_NONE', 'modifier_none']);
            assert.deepStrictEqual(buildModifierLocalisationKeys('base_value'), ['MODIFIERS_BASE_VALUE', 'modifier_base_value']);
            assert.deepStrictEqual(buildModifierLocalisationKeys('stability_factor_desc'), [
                'MODIFIERS_STABILITY_FACTOR_DESC',
                'modifier_stability_factor_desc',
            ]);
        });
    });

    describe('formatInlayText', () => {
        it('drops colour codes, replaces modifier placeholders and removes formatting ones', () => {
            const raw = '§Y基础设施§!建设速度 $RIGHT|+=%1$';
            assert.strictEqual(formatInlayText(raw, lookup), '基础设施建设速度');
        });

        it('strips colour codes carried by a replaced placeholder', () => {
            const colouredLookup = (key: string): string | undefined =>
                key === 'modifier_production_speed_infrastructure_factor' ? '§Y基础设施§!建设速度' : undefined;
            assert.strictEqual(
                formatInlayText('$modifier_production_speed_infrastructure_factor$', colouredLookup),
                '基础设施建设速度'
            );
        });

        it('removes icon tokens', () => {
            assert.strictEqual(formatInlayText('£prod_eff_cap 生产效率上限', lookup), '生产效率上限');
        });

        it('replaces a referenced modifier name with its localised text', () => {
            assert.strictEqual(
                formatInlayText('$MODIFIER_WAR_SUPPORT_FACTOR$：$RIGHT|+=%1$', lookup),
                '战争支持度：'
            );
        });

        it('folds line breaks and whitespace into a single line', () => {
            assert.strictEqual(formatInlayText('\\n地区修正：\\n  战争支持度\\n', lookup), '地区修正： 战争支持度');
        });

        it('truncates overly long hints', () => {
            const formatted = formatInlayText('a'.repeat(200), lookup);
            assert.strictEqual(formatted.length, 81);
            assert.strictEqual(formatted.endsWith('…'), true);
        });
    });

    describe('collectModifierHints', () => {
        it('collects hints for modifier names at any depth and for custom_modifier_tooltip', () => {
            const hints = collectModifierHints(parseHoi4File(scriptContent), lookup);
            assert.strictEqual(hints.length, 3);

            const warSupportOffset = offsetOf(scriptContent, 'war_support_factor') + 'war_support_factor'.length;
            assert.deepStrictEqual(hints[0], { offset: warSupportOffset, text: '战争支持度' });

            const infantryOffset =
                offsetOf(scriptContent, 'army_infantry_attack_factor') + 'army_infantry_attack_factor'.length;
            assert.deepStrictEqual(hints[1], { offset: infantryOffset, text: '步兵攻击' });

            const tooltipOffset = offsetOf(scriptContent, 'ETH_balance_range_tt') + 'ETH_balance_range_tt'.length;
            assert.deepStrictEqual(hints[2], { offset: tooltipOffset, text: '地区修正： 战争支持度：0%' });
        });

        it('skips names and tooltip keys without localisation', () => {
            const content = ['modifier = {', '\tfactor = 0.1', '\tcustom_modifier_tooltip = MISSING_tt', '}'].join('\n');
            assert.deepStrictEqual(collectModifierHints(parseHoi4File(content), lookup), []);
        });

        it('falls back to the MODIFIER_ and lower-case key shapes', () => {
            const content = ['a = {', '\twar_support_factor = 0.1', '\tproduction_speed_infrastructure_factor = 0.1', '}'].join('\n');
            const fallbackLookup = (key: string): string | undefined =>
                key === 'MODIFIER_WAR_SUPPORT_FACTOR' || key === 'modifier_production_speed_infrastructure_factor'
                    ? '命中'
                    : undefined;
            const hints = collectModifierHints(parseHoi4File(content), fallbackLookup);
            assert.strictEqual(hints.length, 2);
            assert.deepStrictEqual(
                hints.map((hint) => hint.text),
                ['命中', '命中']
            );
        });
    });
});
