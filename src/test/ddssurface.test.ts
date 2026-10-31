import * as assert from 'assert';
import { PNG } from 'pngjs';
import { decodeImageToPngSync } from '../util/image/imagedecoder';

// DDS 头是 128 字节的 32 个 int32，随后是像素数据（DX10 还多 20 字节扩展头）。
const DDS_MAGIC = 0x20534444;
const DDPF_FOURCC = 0x4;
const DDPF_RGB = 0x40;
const CAPS_TEXTURE = 0x1000;
const FOURCC_DX10 = 0x30315844; // 'DX10'
const FOURCC_DXT5 = 0x35545844; // 'DXT5'
const DDS_DIMENSION_TEXTURE2D = 3;

interface DDSPixelFormat {
    flags: number;
    fourCC?: number;
    bitCount?: number;
    rMask?: number;
    gMask?: number;
    bMask?: number;
    aMask?: number;
}

function writeHeader(buffer: Buffer, width: number, height: number, pitch: number, pixelFormat: DDSPixelFormat): void {
    const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    const set = (index: number, value: number) => view.setInt32(index * 4, value, true);
    set(0, DDS_MAGIC);
    set(1, 124);
    set(2, 0x1 | 0x2 | 0x4 | 0x1000); // CAPS | HEIGHT | WIDTH | PIXELFORMAT
    set(3, height);
    set(4, width);
    set(5, pitch);
    set(19, 32);
    set(20, pixelFormat.flags);
    set(21, pixelFormat.fourCC ?? 0);
    set(22, pixelFormat.bitCount ?? 0);
    set(23, pixelFormat.rMask ?? 0);
    set(24, pixelFormat.gMask ?? 0);
    set(25, pixelFormat.bMask ?? 0);
    set(26, pixelFormat.aMask ?? 0);
    set(27, CAPS_TEXTURE);
}

function makeLegacyDds(width: number, height: number, pixelFormat: DDSPixelFormat, pixels: Buffer): Buffer {
    const buffer = Buffer.alloc(128 + pixels.length);
    writeHeader(buffer, width, height, pixels.length / height, pixelFormat);
    pixels.copy(buffer, 128);
    return buffer;
}

function makeDx10Dds(width: number, height: number, dxgiFormat: number, pixels: Buffer): Buffer {
    const buffer = Buffer.alloc(128 + 20 + pixels.length);
    writeHeader(buffer, width, height, pixels.length / height, { flags: DDPF_FOURCC, fourCC: FOURCC_DX10 });
    const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    view.setInt32(128, dxgiFormat, true);
    view.setInt32(132, DDS_DIMENSION_TEXTURE2D, true);
    view.setInt32(136, 0, true);
    view.setInt32(140, 1, true);
    view.setInt32(144, 0, true);
    pixels.copy(buffer, 148);
    return buffer;
}

function decodeRgba(buffer: Buffer): number[] {
    const result = decodeImageToPngSync(buffer, 'dds');
    return Array.from(PNG.sync.read(result.pngBuffer).data);
}

// 16 个像素全用同一个 3 位 alpha 索引；DXT5 的索引按 LSB 优先连续排列。
function packAlphaIndices(index: number): Buffer {
    const bytes = Buffer.alloc(6);
    for (let pixel = 0; pixel < 16; pixel++) {
        const bit = pixel * 3;
        for (let offset = 0; offset < 3; offset++) {
            if ((index >> offset) & 1) {
                const position = bit + offset;
                bytes[position >> 3] |= 1 << (position & 7);
            }
        }
    }
    return bytes;
}

describe('util/image/dds surface', () => {
    describe('channel offsets', () => {
        it('reads channels from their own start when the first one does not begin at bit 0', () => {
            // R at bits 8-15, G at 16-23, B at 24-31: a complete byte of leading padding.
            const dds = makeLegacyDds(1, 1, {
                flags: DDPF_RGB,
                bitCount: 32,
                rMask: 0x0000ff00,
                gMask: 0x00ff0000,
                bMask: 0xff000000,
            }, Buffer.from([0xa0, 0x11, 0x22, 0x33]));

            assert.deepStrictEqual(decodeRgba(dds), [0x11, 0x22, 0x33, 255]);
        });

        it('reads a 12-bit pixel format whose second pixel starts part-way into a byte', () => {
            // 4-bit channels, 12 bpp: pixel 0 = R1 G2 B3, pixel 1 = R4 G5 B6, LSB first.
            const dds = makeLegacyDds(2, 1, {
                flags: DDPF_RGB,
                bitCount: 12,
                rMask: 0x0f00,
                gMask: 0x00f0,
                bMask: 0x000f,
            }, Buffer.from([0x23, 0x61, 0x45]));

            // 1..6 of 15 scaled to 255, truncated like the other putters.
            assert.deepStrictEqual(decodeRgba(dds), [17, 34, 51, 255, 68, 85, 102, 255]);
        });
    });

    describe('DXT5 alpha', () => {
        it('interpolates a six-value alpha block in fifths', () => {
            const block = Buffer.alloc(16);
            block[0] = 0; // alpha0
            block[1] = 9; // alpha1: alpha0 <= alpha1 selects the six-value block
            packAlphaIndices(3).copy(block, 2);
            // The colour half stays zero, so only the alpha differs between pixels.
            const dds = makeLegacyDds(4, 4, { flags: DDPF_FOURCC, fourCC: FOURCC_DXT5 }, block);

            // 3/5 of the way from 0 to 9 is 5.4; the block steps in fifths, so index 3 is 3, not 18/7.
            const rgba = decodeRgba(dds);
            for (let pixel = 0; pixel < 16; pixel++) {
                assert.strictEqual(rgba[pixel * 4 + 3], 3);
            }
        });
    });

    describe('sRGB and 4-bit formats', () => {
        it('writes an sRGB texture without a gamma curve, since the PNG is sRGB already', () => {
            // DXGI_FORMAT_R8G8B8A8_UNORM_SRGB
            const dds = makeDx10Dds(1, 1, 29, Buffer.from([128, 64, 32, 255]));

            assert.deepStrictEqual(decodeRgba(dds), [128, 64, 32, 255]);
        });

        it('decodes B4G4R4A4 instead of refusing it as typeless', () => {
            // DXGI_FORMAT_B4G4R4A4_UNORM; value 0xa5c3 is A=0xa, R=0x5, G=0xc, B=0x3.
            const pixels = Buffer.alloc(2);
            pixels.writeUInt16LE(0xa5c3, 0);
            const dds = makeDx10Dds(1, 1, 115, pixels);

            assert.deepStrictEqual(decodeRgba(dds), [85, 204, 51, 170]);
        });
    });

    describe('signed and float channels', () => {
        it('clamps signed channels instead of wrapping them', () => {
            // DXGI_FORMAT_R8G8B8A8_SNORM: 128 and 192 are below zero, 64 is above it.
            const dds = makeDx10Dds(1, 1, 31, Buffer.from([128, 192, 64, 127]));

            assert.deepStrictEqual(decodeRgba(dds), [0, 0, 128, 255]);
        });

        it('clamps float channels to the display range', () => {
            // DXGI_FORMAT_R32G32B32A32_FLOAT: 1.5, -0.5, Infinity and NaN all leave 0..1.
            const pixels = Buffer.alloc(16);
            [1.5, -0.5, Infinity, NaN].forEach((value, index) => pixels.writeFloatLE(value, index * 4));
            const dds = makeDx10Dds(1, 1, 2, pixels);

            assert.deepStrictEqual(decodeRgba(dds), [255, 0, 255, 0]);
        });
    });
});
