import * as assert from 'assert';
import { PNG } from 'pngjs';
import { Sprite, Image } from '../util/image/imagecache';
import { pickPickerImage, resolveFocusIconImages, collectFocusIconNames } from '../previewdef/focustree/iconpicker';
import { parseHoi4File } from '../hoiformat/hoiparser';

// A stub vscode.Uri (the real one only exists in the extension host); Image only stores it.
const dummyUri = { fsPath: 'atlas.dds', path: '/atlas.dds', scheme: 'file' } as any;

function makePng(width: number, height: number): Image {
    const png = new PNG({ width, height });
    png.data.fill(0);
    return new Image(PNG.sync.write(png), width, height, dummyUri);
}

describe('previewdef/focustree/iconpicker', () => {
    describe('pickPickerImage', () => {
        it('returns the first frame for a small multi-frame atlas', () => {
            // A 2-frame 200x100 atlas -> each frame is 100x100.
            const image = makePng(200, 100);
            const sprite = new Sprite('GFX_atlas', image, 2);
            const frame = pickPickerImage(sprite);
            assert.ok(frame, 'picker image should resolve a frame');
            assert.strictEqual(frame!.width, 100);
            assert.strictEqual(frame!.height, 100);
            assert.notStrictEqual(frame, image, 'a cropped frame must be a distinct Image');
        });

        it('returns the whole image for a single-frame sprite', () => {
            const image = makePng(64, 64);
            const sprite = new Sprite('GFX_single', image, 1);
            assert.strictEqual(pickPickerImage(sprite), image);
        });

        it('falls back to the whole image for a huge atlas (no expensive crop)', () => {
            // 600x600 > the 512x512 crop ceiling.
            const image = makePng(600, 600);
            const sprite = new Sprite('GFX_huge', image, 2);
            assert.strictEqual(pickPickerImage(sprite), image);
        });

        it('returns undefined for a missing sprite', () => {
            assert.strictEqual(pickPickerImage(undefined), undefined);
        });
    });

    describe('resolveFocusIconImages', () => {
        it('deduplicates names and returns the full result list', async () => {
            const seen: string[] = [];
            const result = await resolveFocusIconImages(['b', 'a', 'b', 'c'], {
                resolver: async (name) => { seen.push(name); return name + '-uri'; },
            });
            assert.deepStrictEqual(seen, ['b', 'a', 'c'], 'each name must resolve exactly once');
            assert.deepStrictEqual(result, [
                { name: 'b', imageUri: 'b-uri' },
                { name: 'a', imageUri: 'a-uri' },
                { name: 'c', imageUri: 'c-uri' },
            ]);
        });

        it('streams index-contiguous batches and marks the last batch done', async () => {
            const batches: { names: string[]; done: boolean }[] = [];
            await resolveFocusIconImages(['a', 'b', 'c', 'd', 'e'], {
                batchSize: 2,
                resolver: async (name) => name + '-uri',
                onBatch: (images, done) => { batches.push({ names: images.map(i => i.name), done }); },
            });
            assert.deepStrictEqual(batches.map(b => b.names), [['a', 'b'], ['c', 'd'], ['e']]);
            assert.deepStrictEqual(batches.map(b => b.done), [false, false, true]);
        });

        it('emits the empty list done for no names', async () => {
            const doneFlags: boolean[] = [];
            const result = await resolveFocusIconImages([], {
                onBatch: (_images, done) => { doneFlags.push(done); },
            });
            assert.deepStrictEqual(result, []);
            assert.deepStrictEqual(doneFlags, [true]);
        });

        it('turns resolver failures into name-only entries', async () => {
            const result = await resolveFocusIconImages(['x'], {
                resolver: async () => { throw new Error('not resolvable'); },
            });
            assert.deepStrictEqual(result, [{ name: 'x', imageUri: undefined }]);
        });
    });

    describe('collectFocusIconNames', () => {
        // The source module reads listFilesFromModOrHOI4/parseHoi4FileCached off the shared module
        // object at call time (commonjs), so swapping them here controls what it sees.
        let origList: any;
        let origParse: any;

        before(() => {
            const fileloader = require('../util/fileloader');
            origList = fileloader.listFilesFromModOrHOI4;
            origParse = fileloader.parseHoi4FileCached;
        });
        after(() => {
            const fileloader = require('../util/fileloader');
            fileloader.listFilesFromModOrHOI4 = origList;
            fileloader.parseHoi4FileCached = origParse;
        });

        it('collects, deduplicates and sorts icon names across focus files', async () => {
            const fileloader = require('../util/fileloader');
            fileloader.listFilesFromModOrHOI4 = async () => ['a.txt', 'b.txt'];
            fileloader.parseHoi4FileCached = async (rel: string) => {
                // a.txt uses both block and string icon syntax; b.txt reuses GFX_B and adds GFX_C.
                const text = rel.endsWith('a.txt')
                    ? 'focus_tree = { focus = { id = A icon = { GFX_B = yes } } focus = { id = B icon = GFX_A } }'
                    : 'focus_tree = { focus = { id = C icon = GFX_B } focus = { id = D icon = GFX_C } }';
                return parseHoi4File(text, 'test');
            };
            const names = await collectFocusIconNames();
            assert.deepStrictEqual(names, ['GFX_A', 'GFX_B', 'GFX_C']);
        });
    });
});
