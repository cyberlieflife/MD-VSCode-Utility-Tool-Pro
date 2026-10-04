import * as assert from 'assert';
import { parseMinimumProvinceSize } from '../previewdef/worldmap/loader/defines';

// The defines loader reads MINIMUM_PROVINCE_SIZE_IN_PIXELS out of common/defines; the province map
// then flags provinces at or below it. These tests pin the comment stripping and last-wins rule
// against the shapes real define files use.
describe('previewdef/worldmap/loader defines', () => {
    it('reads the define value from a plain assignment', () => {
        assert.strictEqual(parseMinimumProvinceSize('MINIMUM_PROVINCE_SIZE_IN_PIXELS = 8\n'), 8);
    });

    it('ignores values inside --[[ ]] block comments', () => {
        assert.strictEqual(parseMinimumProvinceSize('--[[ MINIMUM_PROVINCE_SIZE_IN_PIXELS = 99 ]]\nMINIMUM_PROVINCE_SIZE_IN_PIXELS = 4\n'), 4);
    });

    it('ignores values on -- line comments', () => {
        assert.strictEqual(parseMinimumProvinceSize('-- MINIMUM_PROVINCE_SIZE_IN_PIXELS = 99\nMINIMUM_PROVINCE_SIZE_IN_PIXELS = 6\n'), 6);
    });

    it('takes the last definition when the value is set twice', () => {
        assert.strictEqual(parseMinimumProvinceSize('MINIMUM_PROVINCE_SIZE_IN_PIXELS = 8\nMINIMUM_PROVINCE_SIZE_IN_PIXELS = 12\n'), 12);
    });

    it('returns undefined when the define is absent', () => {
        assert.strictEqual(parseMinimumProvinceSize('SOME_OTHER_DEFINE = 3\n'), undefined);
    });

    it('does not match a longer identifier that contains the define name', () => {
        assert.strictEqual(parseMinimumProvinceSize('NOT_MINIMUM_PROVINCE_SIZE_IN_PIXELS_EXTRA = 5\n'), undefined);
    });

    it('accepts a trailing comma and comment on the assignment line', () => {
        const content = 'MINIMUM_PROVINCE_SIZE_IN_PIXELS = 8, -- provinces smaller than this are rejected\n';
        assert.strictEqual(parseMinimumProvinceSize(content), 8);
    });

    it('parses a decimal value', () => {
        assert.strictEqual(parseMinimumProvinceSize('MINIMUM_PROVINCE_SIZE_IN_PIXELS = 7.5\n'), 7.5);
    });
});
