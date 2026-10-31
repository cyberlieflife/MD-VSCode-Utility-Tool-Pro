import * as assert from 'assert';
import { decodeTga } from '../util/image/tga';
import { tgaToPng } from '../util/image/converter';

interface TgaOptions {
    width?: number;
    height?: number;
    type?: number;
    depth?: number;
    descriptor?: number;
    id?: Buffer;
    colourMap?: Buffer;
    colourMapFirst?: number;
    colourMapDepth?: number;
    payload: Buffer;
}

function tgaFile(options: TgaOptions): Buffer {
    const header = Buffer.alloc(18);
    header[0] = options.id?.length ?? 0;
    header[2] = options.type ?? 2;
    header.writeUInt16LE(options.width ?? 1, 12);
    header.writeUInt16LE(options.height ?? 1, 14);
    header[16] = options.depth ?? 32;
    header[17] = options.descriptor ?? 0;
    if (options.colourMap) {
        const entryBytes = (options.colourMapDepth ?? 24) / 8;
        header[1] = 1;
        header.writeUInt16LE(options.colourMapFirst ?? 0, 3);
        header.writeUInt16LE(options.colourMap.length / entryBytes, 5);
        header[7] = options.colourMapDepth ?? 24;
    }
    return Buffer.concat([
        header,
        options.id ?? Buffer.alloc(0),
        options.colourMap ?? Buffer.alloc(0),
        options.payload,
    ]);
}

describe('util/image/tga decodeTga', () => {
    it('reads true-colour pixels from their BGR bytes', () => {
        const image = tgaFile({ depth: 24, payload: Buffer.from([0, 0, 255]) });
        assert.deepStrictEqual(Array.from(decodeTga(image).pixels), [255, 0, 0, 255]);
    });

    it('keeps the alpha byte of a 32-bit pixel', () => {
        const image = tgaFile({ depth: 32, descriptor: 0x08, payload: Buffer.from([0, 0, 255, 128]) });
        assert.deepStrictEqual(Array.from(decodeTga(image).pixels), [255, 0, 0, 128]);
    });

    it('expands an 8-bit greyscale pixel', () => {
        const image = tgaFile({ type: 3, depth: 8, payload: Buffer.from([12]) });
        assert.deepStrictEqual(Array.from(decodeTga(image).pixels), [12, 12, 12, 255]);
    });

    // 16-bit greyscale stores the grey value and its alpha in two separate bytes.
    it('keeps both the grey value and the alpha of a 16-bit greyscale pixel', () => {
        const image = tgaFile({ type: 3, depth: 16, descriptor: 0x08, payload: Buffer.from([80, 64]) });
        assert.deepStrictEqual(Array.from(decodeTga(image).pixels), [80, 80, 80, 64]);
    });

    it('maps palette indices through the colour map and its first index', () => {
        const colourMap = Buffer.from([0, 0, 255, 0, 255, 0]);
        const red = tgaFile({ type: 1, depth: 8, colourMap, colourMapFirst: 1, payload: Buffer.from([1]) });
        assert.deepStrictEqual(Array.from(decodeTga(red).pixels), [255, 0, 0, 255]);

        const green = tgaFile({ type: 1, depth: 8, colourMap, colourMapFirst: 1, payload: Buffer.from([2]) });
        assert.deepStrictEqual(Array.from(decodeTga(green).pixels), [0, 255, 0, 255]);
    });

    it('leaves an index outside the colour map transparent black', () => {
        const colourMap = Buffer.from([0, 0, 255]);
        const image = tgaFile({ type: 1, depth: 8, colourMap, colourMapFirst: 1, payload: Buffer.from([0]) });
        assert.deepStrictEqual(Array.from(decodeTga(image).pixels), [0, 0, 0, 0]);
    });

    it('expands a run-length encoded packet', () => {
        const image = tgaFile({
            type: 10,
            width: 2,
            depth: 24,
            payload: Buffer.from([0x81, 0, 0, 255]),
        });
        assert.deepStrictEqual(Array.from(decodeTga(image).pixels), [255, 0, 0, 255, 255, 0, 0, 255]);
    });

    it('flips a bottom-up image back to top-down rows', () => {
        const image = tgaFile({
            width: 1,
            height: 2,
            depth: 24,
            // Bottom row first: red, then the blue top row.
            payload: Buffer.from([255, 0, 0, 0, 0, 255]),
        });
        assert.deepStrictEqual(Array.from(decodeTga(image).pixels), [255, 0, 0, 255, 0, 0, 255, 255]);
    });

    it('rejects a truncated header, an unsupported type and short pixel data', () => {
        assert.throws(() => decodeTga(Buffer.alloc(10)), /TGA header is truncated/);
        assert.throws(
            () => decodeTga(tgaFile({ type: 4, depth: 24, payload: Buffer.alloc(3) })),
            /Unsupported tga format/,
        );
        assert.throws(
            () => decodeTga(tgaFile({ width: 2, depth: 24, payload: Buffer.from([0, 0, 255]) })),
            /TGA pixel data is truncated/,
        );
    });

    it('converts the decoded pixels into a PNG of the same size', () => {
        const image = tgaFile({
            width: 2,
            height: 1,
            depth: 24,
            payload: Buffer.from([0, 0, 255, 0, 255, 0]),
        });
        const png = tgaToPng(image);
        assert.strictEqual(png.width, 2);
        assert.strictEqual(png.height, 1);
        assert.deepStrictEqual(Array.from(png.data), [255, 0, 0, 255, 0, 255, 0, 255]);
    });
});
