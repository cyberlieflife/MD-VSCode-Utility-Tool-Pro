import * as assert from 'assert';
import * as vscode from 'vscode';
import { parseHoi4File } from '../hoiformat/hoiparser';
import {
    buildModifierLocalisationKeys,
    collectModifierHints,
    formatInlayText,
    isModifierScriptFile,
    registerModifierInlayHint,
} from '../inlayhint/modifierInlayHint';
import * as localisationIndex from '../util/localisationIndex';

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
        it('tries the MODIFIERS_, MODIFIER_, lower-case and tooltip key shapes in order', () => {
            assert.deepStrictEqual(buildModifierLocalisationKeys('army_attack_factor'), [
                'MODIFIERS_ARMY_ATTACK_FACTOR',
                'MODIFIER_ARMY_ATTACK_FACTOR',
                'modifier_army_attack_factor',
                'army_attack_factor_tt',
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

        it('resolves a name that is only mapped through its tooltip key', () => {
            const content = ['modifier = {', '\tmonthly_population = 0.05', '\texperience_gain_army_factor = 0.1', '}'].join('\n');
            const ttLookup = (key: string): string | undefined => {
                const entries: Record<string, string> = {
                    monthly_population_tt: ' $MODIFIER_GLOBAL_MONTHLY_POPULATION$：$RIGHT|+=%1$',
                    MODIFIER_GLOBAL_MONTHLY_POPULATION: '每月人口',
                    experience_gain_army_factor_tt: '$MODIFIER_XP_GAIN_ARMY_FACTOR$：$RIGHT|+=%1$',
                    MODIFIER_XP_GAIN_ARMY_FACTOR: '陆军经验增长',
                };
                return entries[key];
            };
            assert.deepStrictEqual(
                collectModifierHints(parseHoi4File(content), ttLookup).map((hint) => hint.text),
                ['每月人口', '陆军经验增长']
            );
        });

        it('resolves an unprefixed reference inside a tooltip value', () => {
            const content = ['modifier = {', '\tcommunism_drift = 0.05', '}'].join('\n');
            const ttLookup = (key: string): string | undefined => {
                const entries: Record<string, string> = {
                    communism_drift_tt: ' $communism_drift$: $RIGHT|+=2$',
                    communism_drift: 'Daily Communism Support',
                };
                return entries[key];
            };
            assert.deepStrictEqual(collectModifierHints(parseHoi4File(content), ttLookup), [
                {
                    offset: offsetOf(content, 'communism_drift') + 'communism_drift'.length,
                    text: 'Daily Communism Support',
                },
            ]);
        });

        it('resolves an unprefixed reference with the same key order as name lookup', () => {
            const content = ['modifier = {', '\torder_check_factor = 0.1', '}'].join('\n');
            const ttLookup = (key: string): string | undefined => {
                const entries: Record<string, string> = {
                    order_check_factor_tt: ' $ORDER_CHECK$: $RIGHT|+=%1$',
                    MODIFIERS_ORDER_CHECK: 'MODIFIERS wins',
                    MODIFIER_ORDER_CHECK: 'MODIFIER loses',
                };
                return entries[key];
            };
            assert.deepStrictEqual(
                collectModifierHints(parseHoi4File(content), ttLookup).map((hint) => hint.text),
                ['MODIFIERS wins']
            );
        });

        it('prefers a direct name key over the tooltip key', () => {
            const content = ['modifier = {', '\tarmy_org_factor = 0.1', '}'].join('\n');
            const ttLookup = (key: string): string | undefined => {
                const entries: Record<string, string> = {
                    MODIFIER_ARMY_ORG_FACTOR: '陆军师组织度',
                    army_org_factor_tt: ' $MODIFIER_OTHER_FACTOR$: $RIGHT|+=%1$',
                    MODIFIER_OTHER_FACTOR: '错误文本',
                };
                return entries[key];
            };
            assert.deepStrictEqual(collectModifierHints(parseHoi4File(content), ttLookup), [
                {
                    offset: offsetOf(content, 'army_org_factor') + 'army_org_factor'.length,
                    text: '陆军师组织度',
                },
            ]);
        });

        it('falls back to formatting the whole tooltip when no reference resolves', () => {
            const name = 'resistance_damage_to_garrison_on_our_occupied_states';
            const content = ['modifier = {', '\t' + name + ' = 0.1', '}'].join('\n');
            const ttLookup = (key: string): string | undefined =>
                key === name + '_tt' ? '我们被敌方占领地区的驻军所受伤害：$RIGHT|+=%1$' : undefined;
            assert.deepStrictEqual(collectModifierHints(parseHoi4File(content), ttLookup), [
                { offset: offsetOf(content, name) + name.length, text: '我们被敌方占领地区的驻军所受伤害：' },
            ]);
        });

        it('ignores tooltip keys that do not bind a value', () => {
            // transfer_state (decision effect) and is_literally_china (AI weight) also have _tt keys,
            // but their tooltips are plain text and must not be shown as modifier hints.
            const content = [
                'modifier = {',
                '\ttransfer_state = 951',
                '\tis_literally_china = yes',
                '}',
            ].join('\n');
            const ttLookup = (key: string): string | undefined => {
                const entries: Record<string, string> = {
                    transfer_state_tt: '我们收复了该地区',
                    is_literally_china_tt: '§YChinese§!',
                };
                return entries[key];
            };
            assert.deepStrictEqual(collectModifierHints(parseHoi4File(content), ttLookup), []);
        });

        it('skips a tooltip that formats to an empty string', () => {
            // A tooltip that only carries formatting directives resolves to no name and formats to
            // an empty string; an empty inlay hint must not be produced.
            const content = ['modifier = {', '\tformatting_only_factor = 0.1', '}'].join('\n');
            const ttLookup = (key: string): string | undefined =>
                key === 'formatting_only_factor_tt' ? '$RIGHT|+=%1$' : undefined;
            assert.deepStrictEqual(collectModifierHints(parseHoi4File(content), ttLookup), []);
        });
    });

    describe('registerModifierInlayHint', () => {
        interface ProviderLike {
            provideInlayHints(
                document: unknown,
                range: unknown,
                token: { isCancellationRequested: boolean }
            ): Promise<Array<{ position: vscode.Position; label: string; paddingLeft?: boolean }>>;
        }
        // The vscode stub is shared by every module, but esModuleInterop copies its top-level
        // properties; patch nested objects in place so the module under test sees the changes.
        const mutableLanguages = vscode.languages as unknown as {
            registerInlayHintsProvider: (selector: unknown, provider: ProviderLike) => { dispose: () => void };
        };
        const mutableEnv = vscode.env as unknown as { language?: string };
        const mutableLocalisation = localisationIndex as unknown as {
            ensureLocalisationIndex: () => Promise<void>;
            getLocalisedTextUnchecked: (key: string, language: string | undefined) => string;
        };
        const mutableWorkspace = vscode.workspace as unknown as { getConfiguration: unknown };
        const originalRegister = mutableLanguages.registerInlayHintsProvider;
        const originalLanguage = mutableEnv.language;
        const originalEnsure = mutableLocalisation.ensureLocalisationIndex;
        const originalGet = mutableLocalisation.getLocalisedTextUnchecked;
        const originalGetConfiguration = mutableWorkspace.getConfiguration;

        let captured: ProviderLike;
        let ensureCalls = 0;
        let enabled = true;

        beforeEach(() => {
            ensureCalls = 0;
            enabled = true;
            mutableEnv.language = 'zh-cn';
            mutableLanguages.registerInlayHintsProvider = (_selector: unknown, provider: ProviderLike) => {
                captured = provider;
                return { dispose: () => undefined };
            };
            mutableLocalisation.ensureLocalisationIndex = async () => {
                ensureCalls++;
            };
            mutableLocalisation.getLocalisedTextUnchecked = (key: string) => {
                if (key === 'MODIFIER_WAR_SUPPORT_FACTOR') {
                    return '战争支持度';
                }
                if (key === 'MODIFIER_ARMY_ORG_FACTOR') {
                    return '陆军师组织度';
                }
                return key;
            };
            mutableWorkspace.getConfiguration = () => ({
                get: (_key: string, fallback: boolean) => (enabled ? fallback : false),
            });
            registerModifierInlayHint();
        });

        afterEach(() => {
            mutableLanguages.registerInlayHintsProvider = originalRegister;
            mutableEnv.language = originalLanguage;
            mutableLocalisation.ensureLocalisationIndex = originalEnsure;
            mutableLocalisation.getLocalisedTextUnchecked = originalGet;
            mutableWorkspace.getConfiguration = originalGetConfiguration;
        });

        function createDocument(uriPath: string, content: string, version: number) {
            const lineStarts = [0];
            for (let index = 0; index < content.length; index++) {
                if (content[index] === '\n') {
                    lineStarts.push(index + 1);
                }
            }
            const positionAt = (offset: number) => {
                let line = 0;
                while (line + 1 < lineStarts.length && lineStarts[line + 1] <= offset) {
                    line++;
                }
                return new vscode.Position(line, offset - lineStarts[line]);
            };
            return {
                uri: vscode.Uri.file(uriPath),
                version,
                getText: () => content,
                offsetAt: (position: { line: number; character: number }) => lineStarts[position.line] + position.character,
                positionAt,
            };
        }

        const token = { isCancellationRequested: false };

        it('caches hints per document and rebuilds when the version changes', async () => {
            const content = 'modifier = {\n\twar_support_factor = 0.1\n}\n';
            const document = createDocument('D:/mod/common/ideas/cache.txt', content, 1);
            const range = new vscode.Range(document.positionAt(0), document.positionAt(content.length));

            const first = await captured.provideInlayHints(document, range, token);
            assert.deepStrictEqual(first.map((hint) => hint.label), ['战争支持度']);
            assert.strictEqual(first[0].paddingLeft, true);
            assert.strictEqual(ensureCalls, 1);

            await captured.provideInlayHints(document, range, token);
            assert.strictEqual(ensureCalls, 1);

            const updated = createDocument('D:/mod/common/ideas/cache.txt', content, 2);
            const updatedRange = new vscode.Range(updated.positionAt(0), updated.positionAt(content.length));
            const second = await captured.provideInlayHints(updated, updatedRange, token);
            assert.deepStrictEqual(second.map((hint) => hint.label), ['战争支持度']);
            assert.strictEqual(ensureCalls, 2);
        });

        it('returns no hints when the setting is disabled', async () => {
            enabled = false;
            const content = 'modifier = {\n\twar_support_factor = 0.1\n}\n';
            const document = createDocument('D:/mod/common/ideas/disabled.txt', content, 1);
            const range = new vscode.Range(document.positionAt(0), document.positionAt(content.length));
            assert.deepStrictEqual(await captured.provideInlayHints(document, range, token), []);
            assert.strictEqual(ensureCalls, 0);
        });

        it('filters hints to the requested range', async () => {
            const content = 'modifier = {\n\twar_support_factor = 0.1\n\tarmy_org_factor = 0.1\n}\n';
            const document = createDocument('D:/mod/common/ideas/range.txt', content, 1);
            const fullRange = new vscode.Range(document.positionAt(0), document.positionAt(content.length));
            const all = await captured.provideInlayHints(document, fullRange, token);
            assert.deepStrictEqual(all.map((hint) => hint.label), ['战争支持度', '陆军师组织度']);

            const firstLineRange = new vscode.Range(
                document.positionAt(0),
                document.positionAt(content.indexOf('army_org_factor'))
            );
            const first = await captured.provideInlayHints(document, firstLineRange, token);
            assert.deepStrictEqual(first.map((hint) => hint.label), ['战争支持度']);
        });

        it('evicts the least recently used document from the hint cache', async () => {
            const content = 'modifier = {\n\twar_support_factor = 0.1\n}\n';
            const first = createDocument('D:/mod/common/ideas/lru-0.txt', content, 1);
            const firstRange = new vscode.Range(first.positionAt(0), first.positionAt(content.length));
            await captured.provideInlayHints(first, firstRange, token);
            assert.strictEqual(ensureCalls, 1);

            for (let index = 1; index <= 64; index++) {
                const document = createDocument('D:/mod/common/ideas/lru-' + index + '.txt', content, 1);
                const range = new vscode.Range(document.positionAt(0), document.positionAt(content.length));
                await captured.provideInlayHints(document, range, token);
            }
            assert.strictEqual(ensureCalls, 65);

            await captured.provideInlayHints(first, firstRange, token);
            assert.strictEqual(ensureCalls, 66);
        });
    });
});
