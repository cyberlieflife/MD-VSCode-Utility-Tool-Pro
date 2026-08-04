import * as assert from 'assert';
import * as vscode from 'vscode';
import { parseLocalisation, getLocalisedTextUnchecked, ensureLocalisationIndex } from '../util/localisationIndex';
import { clearDlcZipCache } from '../util/fileloader';

describe('util/localisationIndex', () => {
    describe('parseLocalisation', () => {
        it('parses entries with and without a version number', () => {
            const result = parseLocalisation([
                'l_english:',
                ' KEY_A:0 "value a"',
                ' KEY_B:3 "value b"',
                ' KEY_C: "value c"',
            ].join('\n'));
            assert.deepStrictEqual(result.l_english, {
                KEY_A: 'value a',
                KEY_B: 'value b',
                KEY_C: 'value c',
            });
        });

        it('accepts a missing space around the colon (ID:"Name" style)', () => {
            const result = parseLocalisation([
                'l_english:',
                ' KEY_A:"value a"',
                ' KEY_B:0"value b"',
            ].join('\n'));
            assert.deepStrictEqual(result.l_english, {
                KEY_A: 'value a',
                KEY_B: 'value b',
            });
        });

        it('does not let a malformed entry (missing closing quote) corrupt later entries', () => {
            // Regression for #26: a value with no closing quote used to poison every entry after
            // it in the same file when parsed through js-yaml.
            const result = parseLocalisation([
                'l_russian:',
                ' EYE_ALV_fascism_ADJ:0 "Великозёрск',
                ' EYE_KRV_neutrality:0 "Хестрайская Конфедерация"',
            ].join('\n'));
            assert.strictEqual(result.l_russian.EYE_KRV_neutrality, 'Хестрайская Конфедерация');
            assert.strictEqual(result.l_russian.EYE_ALV_fascism_ADJ, undefined);
        });

        it('preserves quotes embedded inside a value', () => {
            const result = parseLocalisation([
                'l_english:',
                ' KEY:0 "a "b" c"',
            ].join('\n'));
            assert.strictEqual(result.l_english.KEY, 'a "b" c');
        });

        it('ignores comment lines and blank lines', () => {
            const result = parseLocalisation([
                '# a comment',
                'l_english:',
                '',
                '   # indented comment',
                ' KEY:0 "value"',
            ].join('\n'));
            assert.deepStrictEqual(result.l_english, { KEY: 'value' });
        });

        it('does not capture a trailing comment into the value', () => {
            const result = parseLocalisation('l_english:\n KEY:0 "value" # trailing comment');
            assert.strictEqual(result.l_english.KEY, 'value');
        });

        it('switches language buckets on each header', () => {
            const result = parseLocalisation([
                'l_english:',
                ' KEY:0 "english"',
                'l_russian:',
                ' KEY:0 "russian"',
            ].join('\n'));
            assert.strictEqual(result.l_english.KEY, 'english');
            assert.strictEqual(result.l_russian.KEY, 'russian');
        });
    });

    describe('getLocalisedTextUnchecked', () => {
        it('returns the key itself when the index has no entry', () => {
            assert.strictEqual(getLocalisedTextUnchecked('GER_focus_nonexistent', 'en'), 'GER_focus_nonexistent');
        });

        it('passes undefined keys through', () => {
            assert.strictEqual(getLocalisedTextUnchecked(undefined, 'en'), undefined);
        });
    });
});

// End-to-end repro of the focus-tree name toggle: the index is built on demand (no
// localisationIndex setting required) from the workspace localisation files, then names resolve
// per editor language with the key as the fallback.
describe('util/localisationIndex on-demand index', function () {
    const File = vscode.FileType.File;
    const Directory = vscode.FileType.Directory;
    const realGetConfig = (vscode.workspace as any).getConfiguration;
    const realStat = (vscode.workspace.fs as any).stat;
    const realReadFile = (vscode.workspace.fs as any).readFile;
    const realReadDirectory = (vscode.workspace.fs as any).readDirectory;
    const realWorkspaceFolders = (vscode.workspace as any).workspaceFolders;

    const englishYml = [
        'l_english:',
        ' TEST_FOCUS_A:0 "Test Focus A"',
        ' TEST_FOCUS_B: "Test Focus B without version"',
    ].join('\n');
    const simpChineseYml = [
        'l_simp_chinese:',
        ' TEST_FOCUS_A:0 "测试国策A"',
    ].join('\n');

    function fsPath(uri: any): string {
        return String(uri.fsPath ?? uri.path ?? '').replace(/\\/g, '/');
    }

    beforeEach(function () {
        (vscode.workspace as any).workspaceFolders = [{ uri: vscode.Uri.parse('file:///mod'), name: 'mod', index: 0 }];
        (vscode.workspace as any).getConfiguration = () => ({
            get: () => undefined, update: () => Promise.resolve(), inspect: () => undefined,
            modFile: '', loadDlcContents: false, inlayWindowGfxRoots: [],
        });
        (vscode.workspace.fs as any).stat = async (uri: any) => {
            const p = fsPath(uri);
            if (p.endsWith('/localisation') || p.endsWith('/english') || p.endsWith('/simp_chinese')) {
                return { type: Directory, mtime: 1, ctime: 0, size: 0 };
            }
            return { type: File, mtime: 1, ctime: 0, size: 0 };
        };
        (vscode.workspace.fs as any).readDirectory = async (uri: any) => {
            const p = fsPath(uri);
            if (p.endsWith('/localisation')) { return [['english', Directory], ['simp_chinese', Directory]]; }
            if (p.endsWith('/localisation/english')) { return [['test_l_english.yml', File]]; }
            if (p.endsWith('/localisation/simp_chinese')) { return [['test_l_simp_chinese.yml', File]]; }
            return [];
        };
        (vscode.workspace.fs as any).readFile = async (uri: any) => {
            const p = fsPath(uri);
            if (p.endsWith('test_l_english.yml')) { return Buffer.from(englishYml); }
            if (p.endsWith('test_l_simp_chinese.yml')) { return Buffer.from(simpChineseYml); }
            throw new Error('unexpected read: ' + p);
        };
    });

    afterEach(async function () {
        (vscode.workspace as any).workspaceFolders = realWorkspaceFolders;
        (vscode.workspace as any).getConfiguration = realGetConfig;
        (vscode.workspace.fs as any).stat = realStat;
        (vscode.workspace.fs as any).readDirectory = realReadDirectory;
        (vscode.workspace.fs as any).readFile = realReadFile;
        await clearDlcZipCache();
    });

    it('builds the index on demand and resolves names per language, falling back to the key', async function () {
        await ensureLocalisationIndex();
        assert.strictEqual(getLocalisedTextUnchecked('TEST_FOCUS_A', 'en'), 'Test Focus A');
        assert.strictEqual(getLocalisedTextUnchecked('TEST_FOCUS_A', 'zh-cn'), '测试国策A');
        assert.strictEqual(getLocalisedTextUnchecked('TEST_FOCUS_B', 'en'), 'Test Focus B without version');
        assert.strictEqual(getLocalisedTextUnchecked('TEST_FOCUS_MISSING', 'en'), 'TEST_FOCUS_MISSING');
    });
});
