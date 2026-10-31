import * as assert from 'assert';
import { getProvincesByPosition } from '../previewdef/worldmap/loader/provincebmp';

// provinces.bmp 的取色是地图加载里最重的逐像素循环。改写后每个像素只多一次“与前一色比较”，
// 只有颜色变化时才查集合；这里锁定结果仍然是原来的颜色集合与逐位置映射。

function bmpOf(width: number, height: number, pixels: Uint8Array) {
    return {
        width,
        height,
        bytesPerRow: width * 3,
        data: pixels,
    } as unknown as Parameters<typeof getProvincesByPosition>[0];
}

// BMP 的像素按 bottom-up 存储；颜色是 (blue << 16) | (green << 8) | red。
function setPixel(pixels: Uint8Array, index: number, red: number, green: number, blue: number): void {
    pixels[index * 3] = blue;
    pixels[index * 3 + 1] = green;
    pixels[index * 3 + 2] = red;
}

describe('worldmap/loader/provincebmp getProvincesByPosition', () => {
    it('collects each colour once and keeps the position map', () => {
        const width = 256;
        const height = 256;
        const pixels = new Uint8Array(width * height * 3);
        for (let i = 0; i < width * height; i++) {
            setPixel(pixels, i, 1, 2, 3);
        }
        // 最后一个像素换成另一种颜色。
        setPixel(pixels, width * height - 1, 4, 5, 6);

        const { colorByPosition, provinces, colorToProvince } = getProvincesByPosition(bmpOf(width, height, pixels));

        assert.strictEqual(provinces.length, 2);
        assert.deepStrictEqual(provinces.map(p => p.color).sort((a, b) => a - b), [0x010203, 0x040506]);
        assert.ok(colorToProvince[0x010203]);
        assert.ok(colorToProvince[0x040506]);
        assert.strictEqual(colorToProvince[0x040506]!.color, 0x040506);
        // 最后一行的第一个像素对应最后写入的那一行（y=0 在 data 开头）。
        assert.strictEqual(colorByPosition[(height - 1) * width], 0x010203);
        // 最后一个数据像素画在 colorByPosition 的第二行末尾（bottom-up）。
        assert.strictEqual(colorByPosition[width - 1], 0x040506);
    });

    it('refuses a map whose sides are not a multiple of 256', () => {
        assert.throws(
            () => getProvincesByPosition(bmpOf(128, 256, new Uint8Array(128 * 256 * 3))),
            /multiply of 256/,
        );
    });

    it('refuses a map with more distinct colours than the preview allows', () => {
        const width = 256;
        const height = 512;
        const pixels = new Uint8Array(width * height * 3);
        // Every pixel gets its own colour: red and green take the low 16 bits, blue the rest.
        for (let i = 0; i < width * height; i++) {
            setPixel(pixels, i, i & 0xff, (i >> 8) & 0xff, (i >> 16) & 0xff);
        }

        assert.throws(
            () => getProvincesByPosition(bmpOf(width, height, pixels)),
            /distinct colors/,
        );
    });
});
