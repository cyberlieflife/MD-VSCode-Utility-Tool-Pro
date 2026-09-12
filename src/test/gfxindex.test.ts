import * as assert from 'assert';
import * as vscode from 'vscode';
import * as featureflags from '../util/featureflags';
import * as fileloader from '../util/fileloader';
import * as gfxindex from '../util/gfxindex';

// Minimal goals-style .gfx content whose sprite survives parseHoi4File + getSpriteTypes, so the
// patched readFileFromModOrHOI4 produces a real index entry.
const testGfxContent = [
    'spriteTypes = {',
    '	spriteType = {',
    '		name = "GFX_focus_test_sprite"',
    '		texturefile = "gfx/interface/goals/goal_unknown.dds"',
    '	}',
    '}',
].join('\n');

describe('util/gfxindex', () => {
    // The gfx index is a module-level singleton (one build per process). The fileloader patches
    // swap the commonjs exports object the same way the TS import reads it (dynamic property
    // access), letting the test gate the build mid-flight. Flag changes go through
    // refreshFeatureFlags because the flag is read at call time from the featureflags module.
    const originalListFiles = (fileloader as any).listFilesFromModOrHOI4;
    const originalReadFile = (fileloader as any).readFileFromModOrHOI4;
    const originalGetConfiguration = (vscode.workspace as any).getConfiguration;
    let config: Record<string, unknown> = {};

    function setFlags(flags: Record<string, unknown>): void {
        config = flags;
        // Point the stub's getConfiguration at our config before refreshing, so refreshFeatureFlags
        // reads exactly what this test set.
        (vscode.workspace as any).getConfiguration = () => config;
        featureflags.refreshFeatureFlags();
    }

    afterEach(() => {
        (fileloader as any).listFilesFromModOrHOI4 = originalListFiles;
        (fileloader as any).readFileFromModOrHOI4 = originalReadFile;
        (vscode.workspace as any).getConfiguration = originalGetConfiguration;
    });

    describe('with the gfxIndex flag off', () => {
        let flagsBefore: Record<string, unknown>;

        before(() => {
            flagsBefore = {
                useConditionInFocus: featureflags.useConditionInFocus,
                eventTreePreview: featureflags.eventTreePreview,
                sharedFocusIndex: featureflags.sharedFocusIndex,
                gfxIndex: featureflags.gfxIndex,
                localisationIndex: featureflags.localisationIndex,
            };
            setFlags({ ...flagsBefore, gfxIndex: false });
        });

        after(() => {
            setFlags(flagsBefore);
            (vscode.workspace as any).getConfiguration = originalGetConfiguration;
        });

        it('short-circuits lookups to undefined / [] without starting a build', async () => {
            assert.strictEqual(await gfxindex.getGfxContainerFile('GFX_focus_test_sprite'), undefined);
            assert.deepStrictEqual(await gfxindex.getGfxContainerFiles(['GFX_a', 'GFX_b']), []);
        });
    });

    describe('with the gfxIndex flag on and a gated (slow) build', () => {
        let flagsBefore: Record<string, unknown>;
        let releaseBuild: () => void = () => {};
        let builtFiredCount = 0;

        before(() => {
            flagsBefore = {
                useConditionInFocus: featureflags.useConditionInFocus,
                eventTreePreview: featureflags.eventTreePreview,
                sharedFocusIndex: featureflags.sharedFocusIndex,
                gfxIndex: featureflags.gfxIndex,
                localisationIndex: featureflags.localisationIndex,
            };
            setFlags({ ...flagsBefore, gfxIndex: true });
            gfxindex.onGfxIndexBuilt(() => { builtFiredCount++; });

            const buildGate = new Promise<void>(resolve => { releaseBuild = resolve; });
            (fileloader as any).listFilesFromModOrHOI4 = async () => {
                await buildGate;
                return ['goals_test.gfx'];
            };
            (fileloader as any).readFileFromModOrHOI4 = async () =>
                [Buffer.from(testGfxContent), vscode.Uri.file('/mod/interface/goals_test.gfx')];
        });

        after(() => {
            // Never leave the gated build pending (a failed assert above must not hang mocha).
            releaseBuild();
            setFlags(flagsBefore);
            (vscode.workspace as any).getConfiguration = originalGetConfiguration;
        });

        it('holds index lookups until the build settles, then serves the indexed file', async () => {
            // The lookup must not resolve while the build is still in flight: a miss during the
            // build window is authoritative in index mode (see getSpriteByGfxName), so an early
            // return would permanently lose the sprite for the preview's lifetime.
            const lookup = gfxindex.getGfxContainerFile('GFX_focus_test_sprite');
            let lookupSettled = false;
            void lookup.then(() => { lookupSettled = true; });
            await new Promise(resolve => setImmediate(resolve));
            assert.strictEqual(lookupSettled, false);

            releaseBuild();
            assert.strictEqual(await lookup, 'interface/goals_test.gfx');
            // The build-completed notification (PreviewManager's re-resolve trigger) fired.
            assert.ok(builtFiredCount >= 1);
        });

        it('reuses one build promise for repeated ensureGfxIndex calls', () => {
            assert.strictEqual(gfxindex.ensureGfxIndex(), gfxindex.ensureGfxIndex());
        });

        it('serves batch lookups from the built index', async () => {
            assert.deepStrictEqual(
                await gfxindex.getGfxContainerFiles(['GFX_focus_test_sprite', 'GFX_missing']),
                ['interface/goals_test.gfx'],
            );
        });
    });
});
