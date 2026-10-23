import * as assert from 'assert';
import * as path from 'path';
import { PNG } from 'pngjs';
import { UserError } from '../util/common';
import {
    assertDecodablePng,
    isPngBuffer,
    pngToPng,
    readPngHeaderDimensions,
} from '../util/image/converter';
import {
    decodeImageToPng,
    decodeImageToPngSync,
    _resetImageWorkerPathForTest,
    _setImageWorkerPathForTest,
    _terminateImageWorkerForTest,
} from '../util/image/imagedecoder';
// Emissions only: the module attaches its message handler solely when run as a worker thread.
import '../util/image/imageworker';

function makePng(width: number, height: number, rgba?: number[]): Buffer {
    const png = new PNG({ width, height });
    png.data.fill(0);
    if (rgba) {
        png.data.set(rgba);
    }
    return PNG.sync.write(png);
}

function isUserError(pattern: RegExp): (e: unknown) => boolean {
    return (e: unknown) => e instanceof UserError && pattern.test(e.message);
}

describe('util/image png buffers', () => {
    it('recognises the PNG signature and reads the IHDR dimensions', () => {
        const buffer = makePng(5, 3);

        assert.strictEqual(isPngBuffer(buffer), true);
        assert.deepStrictEqual(readPngHeaderDimensions(buffer), { width: 5, height: 3 });
    });

    it('does not treat other data as PNG', () => {
        assert.strictEqual(isPngBuffer(Buffer.from('not a png')), false);
        assert.strictEqual(readPngHeaderDimensions(Buffer.from('not a png')), undefined);
    });

    it('decodes a valid PNG', () => {
        const png = pngToPng(makePng(2, 2, [255, 0, 0, 255]));

        assert.strictEqual(png.width, 2);
        assert.strictEqual(png.height, 2);
        assert.deepStrictEqual(Array.from(png.data.subarray(0, 4)), [255, 0, 0, 255]);
    });

    it('refuses a buffer whose header is missing', () => {
        assert.throws(
            () => assertDecodablePng(Buffer.from('not a png')),
            isUserError(/header is missing/),
        );
    });

    it('refuses an interlaced PNG, which pngjs inflates with no output limit', () => {
        const buffer = makePng(4, 4);
        buffer[28] = 1; // IHDR interlace method: Adam7

        assert.throws(
            () => assertDecodablePng(buffer),
            isUserError(/interlaced/),
        );
    });

    it('refuses a PNG whose declared size is over the image limit', () => {
        const buffer = makePng(2, 2);
        buffer.writeUInt32BE(65535, 16);
        buffer.writeUInt32BE(65535, 20);

        assert.throws(
            () => assertDecodablePng(buffer),
            isUserError(/exceeds the supported maximum/),
        );
    });

    it('refuses a second IHDR chunk, which could swap the checked header for another', () => {
        const buffer = makePng(4, 4);
        // The first chunk is 25 bytes: 4 length, 4 type, 13 data, 4 CRC.
        const withSecondHeader = Buffer.concat([
            buffer.subarray(0, 33),
            buffer.subarray(8, 33),
            buffer.subarray(33),
        ]);

        assert.throws(
            () => assertDecodablePng(withSecondHeader),
            isUserError(/header is repeated/),
        );
    });

    describe('.dds holding PNG data', () => {
        const buffer = makePng(3, 2, [10, 20, 30, 40]);

        it('decodes on the synchronous path', () => {
            const result = decodeImageToPngSync(buffer, 'dds');

            assert.strictEqual(result.width, 3);
            assert.strictEqual(result.height, 2);
            const decoded = PNG.sync.read(result.pngBuffer);
            assert.deepStrictEqual(Array.from(decoded.data.subarray(0, 4)), [10, 20, 30, 40]);
        });

        describe('worker path', () => {
            before(() => {
                _setImageWorkerPathForTest(path.resolve(__dirname, '../util/image/imageworker.js'));
            });

            after(async () => {
                await _terminateImageWorkerForTest();
                _resetImageWorkerPathForTest();
            });

            it('decodes the same way through the worker', async () => {
                const viaWorker = await decodeImageToPng(buffer, 'dds');
                const viaSync = decodeImageToPngSync(buffer, 'dds');

                assert.strictEqual(viaWorker.width, 3);
                assert.strictEqual(viaWorker.height, 2);
                assert.ok(viaWorker.pngBuffer.equals(viaSync.pngBuffer));
            });
        });
    });
});
