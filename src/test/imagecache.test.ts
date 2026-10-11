import * as assert from 'assert';
import * as vscode from 'vscode';
import { PNG } from 'pngjs';
import { readPngHeaderDimensions, getSpriteByGfxName, clearGfxCaches } from '../util/image/imagecache';
import * as featureflags from '../util/featureflags';
import * as fileloader from '../util/fileloader';

function makePng(width: number, height: number): Buffer {
    const png = new PNG({ width, height });
    png.data.fill(0);
    return PNG.sync.write(png);
}

describe('util/image/imagecache', () => {
    describe('readPngHeaderDimensions', () => {
        it('reads width/height from the IHDR chunk of a valid PNG', () => {
            const buffer = makePng(3, 5);
            const result = readPngHeaderDimensions(buffer);
            assert.deepStrictEqual(result, { width: 3, height: 5 });
        });

        it('agrees with a full PNG.sync.read decode', () => {
            const buffer = makePng(16, 9);
            const decoded = PNG.sync.read(buffer);
            const result = readPngHeaderDimensions(buffer);
            assert.deepStrictEqual(result, { width: decoded.width, height: decoded.height });
        });

        it('returns undefined for a non-PNG buffer without throwing', () => {
            const buffer = Buffer.from('not a png, just some plain text bytes here');
            assert.strictEqual(readPngHeaderDimensions(buffer), undefined);
        });

        it('returns undefined for a buffer shorter than the IHDR chunk', () => {
            const buffer = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
            assert.strictEqual(readPngHeaderDimensions(buffer), undefined);
        });

        it('returns undefined when the signature matches but the chunk type does not', () => {
            const buffer = makePng(3, 5);
            buffer.write('BAD!', 12, 'ascii');
            assert.strictEqual(readPngHeaderDimensions(buffer), undefined);
        });
    });

    describe('getSpriteByGfxName', () => {
        const gfxContent = [
            'spriteTypes = {',
            '    spriteType = {',
            '        name = "GFX_case_test_sprite"',
            '        texturefile = "gfx/interface/case_test.png"',
            '    }',
            '}',
        ].join('\n');
        const png = makePng(4, 4);
        let flagsBefore: Record<string, unknown>;
        const realReadFile = (fileloader as any).readFileFromModOrHOI4;
        const realHoiFileExpiryToken = (fileloader as any).hoiFileExpiryToken;
        const realExpiryToken = (fileloader as any).expiryToken;
        const realGetConfiguration = (vscode.workspace as any).getConfiguration;

        before(() => {
            flagsBefore = {
                useConditionInFocus: featureflags.useConditionInFocus,
                eventTreePreview: featureflags.eventTreePreview,
                sharedFocusIndex: featureflags.sharedFocusIndex,
                gfxIndex: featureflags.gfxIndex,
                localisationIndex: featureflags.localisationIndex,
                ideaPreview: featureflags.ideaPreview,
                decisionPreview: featureflags.decisionPreview,
                characterPreview: featureflags.characterPreview,
                bopPreview: featureflags.bopPreview,
                ideaSwapIndex: featureflags.ideaSwapIndex,
                technologyCountryIcons: featureflags.technologyCountryIcons,
                previewWheel: featureflags.previewWheel,
                focusTreeLayout: featureflags.focusTreeLayout,
                focusTreePrerequisiteLines: featureflags.focusTreePrerequisiteLines,
            };
            // Index off: the lookup then takes the single-file fallback, which is the gfxMap path
            // this test is about (the index path has its own case-insensitive test in gfxindex).
            (vscode.workspace as any).getConfiguration = () => ({ ...flagsBefore, gfxIndex: false });
            featureflags.refreshFeatureFlags();

            const files: Record<string, Buffer> = {
                'interface/case_test.gfx': Buffer.from(gfxContent),
                'gfx/interface/case_test.png': png,
            };
            (fileloader as any).readFileFromModOrHOI4 = async (path: string) => {
                const buffer = files[path.toLowerCase()];
                if (buffer === undefined) {
                    throw new Error('no such file: ' + path);
                }
                return [buffer, vscode.Uri.file('/mod/' + path)];
            };
            // Static expiry tokens: neither cache may drop mid-test, and the real token stats the disk.
            (fileloader as any).hoiFileExpiryToken = async () => 'static';
            (fileloader as any).expiryToken = async () => 'static';
            clearGfxCaches();
        });

        after(() => {
            // Restore the flags through the stub as well, so the real getConfiguration is never asked
            // to answer for a config key this suite never set.
            (vscode.workspace as any).getConfiguration = () => ({ ...flagsBefore });
            featureflags.refreshFeatureFlags();
            (vscode.workspace as any).getConfiguration = realGetConfiguration;

            (fileloader as any).readFileFromModOrHOI4 = realReadFile;
            (fileloader as any).hoiFileExpiryToken = realHoiFileExpiryToken;
            (fileloader as any).expiryToken = realExpiryToken;
            clearGfxCaches();
        });

        it('resolves a sprite by its exact name', async () => {
            const sprite = await getSpriteByGfxName('GFX_case_test_sprite', 'interface/case_test.gfx');
            assert.strictEqual(sprite?.id, 'GFX_case_test_sprite');
        });

        // A picture or icon may name the sprite in another case than the .gfx file wrote it.
        it('resolves a reference that differs only in case', async () => {
            const sprite = await getSpriteByGfxName('gfx_case_test_sprite', 'interface/case_test.gfx');
            assert.strictEqual(sprite?.id, 'gfx_case_test_sprite');
            assert.ok(sprite?.image, 'the case-insensitive hit must resolve the image too');
        });
    });
});
