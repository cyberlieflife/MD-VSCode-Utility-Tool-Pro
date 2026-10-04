import * as assert from 'assert';
import { UserError } from '../util/common';
import {
    assertImageDimensions,
    MAX_IMAGE_DIMENSION,
    MAX_IMAGE_PIXELS,
} from '../util/image/imagelimits';

// 尺寸校验是打开一个头部损坏的 DDS/TGA/BMP 时不冻结扩展的唯一防线：宽高直接决定解码时的分配量。

function isUserError(pattern: RegExp): (e: unknown) => boolean {
    return (e: unknown) => e instanceof UserError && pattern.test(e.message);
}

describe('util/image/imagelimits assertImageDimensions', () => {
    it('accepts a wide texture within the per-side and pixel bounds', () => {
        assert.doesNotThrow(() => assertImageDimensions(MAX_IMAGE_DIMENSION, 1, 'DDS'));
    });

    it('rejects a side over the limit even when the pixel count is small', () => {
        assert.throws(
            () => assertImageDimensions(MAX_IMAGE_DIMENSION + 1, 1, 'DDS'),
            isUserError(/exceeds the supported maximum/),
        );
    });

    it('accepts the pixel limit and rejects one pixel over it', () => {
        assert.doesNotThrow(() => assertImageDimensions(6000, 4000, 'DDS'));
        assert.strictEqual(6000 * 4000, MAX_IMAGE_PIXELS);
        assert.throws(
            () => assertImageDimensions(6000, 4001, 'DDS'),
            isUserError(/exceeds the supported maximum/),
        );
    });

    it('rejects zero and negative sides', () => {
        assert.throws(() => assertImageDimensions(0, 4, 'TGA'), isUserError(/is not valid/));
        assert.throws(() => assertImageDimensions(4, -4, 'TGA'), isUserError(/is not valid/));
    });

    it('rejects a non-integer side, which no decoder can allocate for', () => {
        assert.throws(() => assertImageDimensions(4.5, 4, 'TGA'), isUserError(/is not valid/));
        assert.throws(() => assertImageDimensions(4, Number.NaN, 'TGA'), isUserError(/is not valid/));
    });

    it('names the format in the message, so a report says which decoder refused', () => {
        assert.throws(
            () => assertImageDimensions(65535, 65535, 'DDS'),
            isUserError(/^DDS image size 65535x65535/),
        );
    });
});
