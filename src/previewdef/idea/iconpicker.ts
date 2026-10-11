import { getSpriteTypes } from "../../hoiformat/spritetype";
import { parseHoi4FileToleratingUnclosedTail } from "../../hoiformat/hoiparser";
import { readFileFromModOrHOI4 } from "../../util/fileloader";
import { getSpriteByGfxName, Image } from "../../util/image/imagecache";
import { getIndexedGfxNames } from "../../util/gfxindex";
import { pickPickerImage } from "../focustree/iconpicker";
import { debug } from "../../util/debug";

// The idea sprites are not the focus-tree icons: they live in interface/ideas.gfx under the
// GFX_idea_ prefix, which is also the prefix the game resolves an idea's `picture` through.

const IDEAS_GFX = "interface/ideas.gfx";
const IDEA_SPRITE_PREFIX = /^GFX_idea_/i;

/**
 * Every idea sprite name the picker can offer. The gfx index, when it is on, knows them by prefix;
 * with the index off the mod's and vanilla interface/ideas.gfx is read directly, so the picker works
 * in either mode. Only names under GFX_idea_ are offered: mixing in other sprites would show icons
 * that cannot be written into an idea's picture.
 */
export async function collectIdeaIconNames(): Promise<string[]> {
	const names = new Set<string>();

	for (const name of await getIndexedGfxNames()) {
		if (IDEA_SPRITE_PREFIX.test(name)) {
			names.add(name);
		}
	}

	if (names.size === 0) {
		try {
			const [buffer] = await readFileFromModOrHOI4(IDEAS_GFX);
			const node = parseHoi4FileToleratingUnclosedTail(buffer.toString("utf-8"), "");
			for (const sprite of getSpriteTypes(node)) {
				if (IDEA_SPRITE_PREFIX.test(sprite.name)) {
					names.add(sprite.name);
				}
			}
		} catch (e) {
			debug(`Failed to read idea sprites from ${IDEAS_GFX}`, e);
		}
	}

	return [...names].sort((a, b) => a.localeCompare(b));
}

export async function getIdeaIconPickerImage(name: string): Promise<Image | undefined> {
	const sprite = await getSpriteByGfxName(name, [IDEAS_GFX]);
	return pickPickerImage(sprite);
}
