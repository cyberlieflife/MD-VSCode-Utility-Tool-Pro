import { getSpriteByGfxName, Sprite } from './image/imagecache';

/**
 * The sprite names a `picture = ...` value may stand for. Ideas name their icon by bare name and
 * the sprite is conventionally `GFX_idea_<picture>`, with the plain `GFX_<picture>` spelling also
 * seen in the wild; a value that already carries the `GFX_` prefix is used as-is, because writing
 * the full sprite name in `picture` is legal too. The idea preview and the `picture` hover share
 * this so one value resolves to the same sprite in both.
 */
export function ideaPictureSpriteNames(picture: string): string[] {
    if (/^gfx_/i.test(picture)) {
        return [picture];
    }
    return ['GFX_idea_' + picture, 'GFX_' + picture];
}

/** The first of `names` that resolves against `gfxFiles`, so a caller can try the spellings in order. */
export async function resolveIdeaSprite(
    names: string[],
    gfxFiles: string | string[],
): Promise<Sprite | undefined> {
    for (const name of names) {
        const sprite = await getSpriteByGfxName(name, gfxFiles);
        if (sprite) {
            return sprite;
        }
    }
    return undefined;
}
