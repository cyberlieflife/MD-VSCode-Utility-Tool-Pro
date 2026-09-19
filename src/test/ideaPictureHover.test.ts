import * as assert from 'assert';
import * as vscode from 'vscode';
import { PNG } from 'pngjs';
import { Node, parseHoi4File, resolveScriptVariables } from '../hoiformat/hoiparser';
import { Image, Sprite } from '../util/image/sprite';
import * as imagecache from '../util/image/imagecache';
import {
    buildGfxCandidates,
    buildHoverMissMessage,
    buildHoverPicture,
    extractPictureName,
    findPictureNodeAtOffset,
    isIdeaFile,
    resolveSprite,
} from '../hover/ideaPictureHover';

// Mirrors the structure of a real common/ideas/*.txt file: a top-level container, a
// category block, one idea with a bare picture token and a modifier block that must not
// match the picture lookup.
const ideaFileContent = [
    'ideas = {',
    '\tRSC_ELSGJ = {',
    '\t\tRSC_mosikebengkui_1 = {',
    '\t\t\t#comment',
    '\t\t\tallowed = {',
    '\t\t\t\ttag = RSC',
    '\t\t\t}',
    '\t\t\tpicture = FRA_scw_intervention_republicans_focus',
    '\t\t\tmodifier = {',
    '\t\t\t\tfascism_drift = 0.01',
    '\t\t\t}',
    '\t\t}',
    '\t}',
    '}',
].join('\n');

const quotedPictureContent = [
    'ideas = {',
    '\tRSC_a = {',
    '\t\tpicture = "GFX_quoted_icon"',
    '\t}',
    '}',
].join('\n');

const constantPictureContent = [
    // Quoted on purpose: resolveScriptVariables only rewrites constants whose value is a
    // string or number, matching the script conventions the parser supports.
    '@ICON = "GFX_from_constant"',
    'ideas = {',
    '\tRSC_a = {',
    '\t\tpicture = @ICON',
    '\t}',
    '}',
].join('\n');

function parse(content: string): Node {
    // Same pipeline as the hover provider: parse, then rewrite `@constant` references.
    return resolveScriptVariables(parseHoi4File(content));
}

function offsetOf(content: string, needle: string): number {
    const index = content.indexOf(needle);
    assert.notStrictEqual(index, -1, 'test fixture is missing ' + needle);
    return index;
}

describe('hover/ideaPictureHover', () => {
    describe('isIdeaFile', () => {
        it('accepts mod files under common/ideas including nested folders', () => {
            assert.strictEqual(isIdeaFile(vscode.Uri.file('d:\\mod\\common\\ideas\\RSC.txt')), true);
            assert.strictEqual(isIdeaFile(vscode.Uri.file('d:\\mod\\common\\ideas\\sub\\other.txt')), true);
        });

        it('accepts the hoi4installpath scheme', () => {
            const uri = { scheme: 'hoi4installpath', path: '/common/ideas/history.txt' } as unknown as vscode.Uri;
            assert.strictEqual(isIdeaFile(uri), true);
        });

        it('matches segment names case-insensitively', () => {
            assert.strictEqual(isIdeaFile(vscode.Uri.file('d:\\Mod\\Common\\Ideas\\x.txt')), true);
        });

        it('rejects files outside common/ideas', () => {
            assert.strictEqual(isIdeaFile(vscode.Uri.file('d:\\mod\\common\\events\\x.txt')), false);
            assert.strictEqual(isIdeaFile(vscode.Uri.file('d:\\mod\\interface\\ideas.gfx')), false);
        });

        it('rejects unknown schemes', () => {
            const uri = { scheme: 'output', path: '/common/ideas/x.txt' } as unknown as vscode.Uri;
            assert.strictEqual(isIdeaFile(uri), false);
        });
    });

    describe('findPictureNodeAtOffset', () => {
        const root = parse(ideaFileContent);

        it('finds the picture node when the caret is on its value', () => {
            const node = findPictureNodeAtOffset(root, offsetOf(ideaFileContent, 'FRA_scw'));
            assert.ok(node);
            assert.strictEqual(extractPictureName(node!), 'FRA_scw_intervention_republicans_focus');
        });

        it('still matches at the offset right after the value', () => {
            const start = offsetOf(ideaFileContent, 'FRA_scw');
            const end = start + 'FRA_scw_intervention_republicans_focus'.length;
            assert.ok(findPictureNodeAtOffset(root, end));
        });

        it('finds nothing on non-picture tokens', () => {
            for (const needle of ['RSC_ELSGJ', 'RSC_mosikebengkui_1', 'allowed', 'fascism_drift']) {
                assert.strictEqual(findPictureNodeAtOffset(root, offsetOf(ideaFileContent, needle)), undefined,
                    'expected no picture node at ' + needle);
            }
        });

        it('resolves a quoted picture value to its unquoted name', () => {
            const root = parse(quotedPictureContent);
            const node = findPictureNodeAtOffset(root, offsetOf(quotedPictureContent, 'GFX_quoted_icon'));
            assert.ok(node);
            assert.strictEqual(extractPictureName(node!), 'GFX_quoted_icon');
        });

        it('resolves a picture defined through an @constant', () => {
            const root = parse(constantPictureContent);
            // Anchor past the first '@ICON' occurrence, which is the definition line.
            const anchor = offsetOf(constantPictureContent, 'picture = @ICON') + 'picture = '.length;
            const node = findPictureNodeAtOffset(root, anchor);
            assert.ok(node);
            assert.strictEqual(extractPictureName(node!), 'GFX_from_constant');
        });
    });

    describe('buildGfxCandidates', () => {
        it('expands a bare name to the idea sprite conventions', () => {
            assert.deepStrictEqual(
                buildGfxCandidates('FRA_scw_intervention_republicans_focus'),
                ['GFX_idea_FRA_scw_intervention_republicans_focus', 'GFX_FRA_scw_intervention_republicans_focus'],
            );
        });

        it('uses a value with the GFX_ prefix as-is, preserving its case', () => {
            assert.deepStrictEqual(buildGfxCandidates('GFX_custom'), ['GFX_custom']);
            assert.deepStrictEqual(buildGfxCandidates('gfx_custom'), ['gfx_custom']);
        });
    });

    describe('buildHoverPicture', () => {
        it('shows a single-frame sprite at native size', () => {
            const image = new Image(Buffer.alloc(0), 96, 68, vscode.Uri.file('/icon.dds'));
            const content = buildHoverPicture(new Sprite('GFX_test_icon', image, 1));
            assert.strictEqual(content.gfxName, 'GFX_test_icon');
            assert.ok(content.dataUrl.startsWith('data:image/png;base64,'));
            assert.strictEqual(content.displayWidth, 96);
            assert.strictEqual(content.displayHeight, 68);
            assert.strictEqual(content.sourceWidth, 96);
            assert.strictEqual(content.sourceHeight, 68);
        });

        it('shows the first frame of a multi-frame strip at frame size', () => {
            const png = PNG.sync.write(new PNG({ width: 8, height: 4 }));
            const image = new Image(png, 8, 4, vscode.Uri.file('/strip.dds'));
            const content = buildHoverPicture(new Sprite('GFX_strip', image, 2));
            assert.strictEqual(content.displayWidth, 4);
            assert.strictEqual(content.displayHeight, 4);
            assert.strictEqual(content.sourceWidth, 4);
            assert.strictEqual(content.sourceHeight, 4);
        });

        it('scales images taller than the max hover height down proportionally', () => {
            const image = new Image(Buffer.alloc(0), 256, 512, vscode.Uri.file('/big.dds'));
            const content = buildHoverPicture(new Sprite('GFX_big', image, 1));
            assert.strictEqual(content.displayWidth, 64);
            assert.strictEqual(content.displayHeight, 128);
        });
    });

    describe('buildHoverMissMessage', () => {
        it('lists the attempted sprite names', () => {
            // The i18n table is not loaded under the test runner, so the fallback message
            // (identical to the en string) is asserted.
            assert.strictEqual(
                buildHoverMissMessage(['GFX_idea_a', 'GFX_a']),
                'Picture image not found: GFX_idea_a, GFX_a',
            );
        });
    });

    describe('resolveSprite', () => {
        // Swapping the commonjs exports object works because the source import reads the
        // property dynamically at call time (same patching pattern as gfxindex.test).
        const originalGetSprite = (imagecache as any).getSpriteByGfxName;

        afterEach(() => {
            (imagecache as any).getSpriteByGfxName = originalGetSprite;
        });

        it('returns the first candidate that resolves', async () => {
            const stubSprite = new Sprite('GFX_idea_hit', new Image(Buffer.alloc(0), 10, 10, vscode.Uri.file('/hit.dds')), 1);
            (imagecache as any).getSpriteByGfxName = async (name: string) =>
                name === 'GFX_idea_hit' ? stubSprite : undefined;
            assert.strictEqual(await resolveSprite(['GFX_idea_hit', 'GFX_hit']), stubSprite);
        });

        it('falls through to later candidates', async () => {
            const stubSprite = new Sprite('GFX_bare', new Image(Buffer.alloc(0), 10, 10, vscode.Uri.file('/bare.dds')), 1);
            (imagecache as any).getSpriteByGfxName = async (name: string) =>
                name === 'GFX_bare' ? stubSprite : undefined;
            assert.strictEqual(await resolveSprite(['GFX_idea_bare', 'GFX_bare']), stubSprite);
        });

        it('returns undefined when no candidate resolves', async () => {
            (imagecache as any).getSpriteByGfxName = async () => undefined;
            assert.strictEqual(await resolveSprite(['GFX_idea_none', 'GFX_none']), undefined);
        });
    });
});
