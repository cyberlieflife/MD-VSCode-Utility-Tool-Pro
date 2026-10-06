import * as assert from 'assert';
import { PNG } from 'pngjs';
import { Image, CorneredTileSprite } from '../../util/image/sprite';

// A stub vscode.Uri (the real one only exists in the extension host); Image only stores it.
const dummyUri = { fsPath: 'tile.dds', path: '/tile.dds', scheme: 'file' } as any;

function makeImage(width: number, height: number): Image {
    const png = new PNG({ width, height });
    png.data.fill(0);
    return new Image(PNG.sync.write(png), width, height, dummyUri);
}

describe('util/image/sprite CorneredTileSprite', () => {
    // `getTiles` falls back to frame 0 for a frame index the sprite does not have. The boundary is
    // `noOfFrames` itself: frame indices run 0..noOfFrames-1, so an index equal to `noOfFrames`
    // must fall back too. Treating it as valid reads `frames[noOfFrames]`, which is undefined, and
    // the tile extraction then throws on `frame.width`.
    it('falls back to frame 0 when the frame index equals the frame count', () => {
        const sprite = new CorneredTileSprite('GFX_tile', makeImage(200, 100), 2, { x: 0, y: 0 }, { x: 4, y: 4 });
        const tiles = sprite.getTiles(2);
        assert.strictEqual(tiles.length, 9);
        assert.deepStrictEqual(tiles, sprite.getTiles(0));
    });

    it('falls back to frame 0 for an index past the frame count', () => {
        const sprite = new CorneredTileSprite('GFX_tile', makeImage(200, 100), 2, { x: 0, y: 0 }, { x: 4, y: 4 });
        assert.deepStrictEqual(sprite.getTiles(5), sprite.getTiles(0));
    });

    it('keeps a valid frame index distinct from frame 0', () => {
        const sprite = new CorneredTileSprite('GFX_tile', makeImage(200, 100), 2, { x: 0, y: 0 }, { x: 4, y: 4 });
        const frame0 = sprite.getTiles(0);
        const frame1 = sprite.getTiles(1);
        assert.strictEqual(frame1.length, 9);
        // The two frames come from the same atlas but are different crops; the corner tile keeps the
        // frame's own width, so compare identity to prove frame 1 was not silently reset to 0.
        assert.notStrictEqual(frame1, frame0);
    });
});
