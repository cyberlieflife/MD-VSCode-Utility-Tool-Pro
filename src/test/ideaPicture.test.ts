import * as assert from 'assert';
import { ideaPictureSpriteNames } from '../util/ideaPicture';

describe('util/ideaPicture', () => {
    describe('ideaPictureSpriteNames', () => {
        it('prefers the GFX_idea_ spelling for a bare name', () => {
            assert.deepStrictEqual(
                ideaPictureSpriteNames('shell_idea'),
                ['GFX_idea_shell_idea', 'GFX_shell_idea'],
            );
        });

        // A mod may write the full sprite name in `picture`; adding the prefix again finds nothing.
        it('uses a value that already carries the GFX_ prefix as-is', () => {
            assert.deepStrictEqual(
                ideaPictureSpriteNames('GFX_idea_ARG_rapid_militarization'),
                ['GFX_idea_ARG_rapid_militarization'],
            );
        });

        it('treats the GFX_ prefix case-insensitively', () => {
            assert.deepStrictEqual(ideaPictureSpriteNames('gfx_custom'), ['gfx_custom']);
        });
    });
});
