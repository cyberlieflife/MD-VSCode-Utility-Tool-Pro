import * as assert from "assert";
import { parseHoi4File } from "../hoiformat/hoiparser";
import { getBopsFromFile } from "../previewdef/bop/schema";
import { buildBopPreviewPayload } from "../previewdef/bop/build";
import { BopLoaderResult } from "../previewdef/bop/loader";
import { StyleTable } from "../util/styletable";

// What the webview needs to draw a range's modifiers on hover: the payload has to carry them,
// formatted, out of the range's `modifier` block and its `custom_modifier_tooltip` lines.

// A range with two modifiers and a tooltip key, next to one with none, so the empty range is
// asserted to stay empty rather than gain a panel.
const source = `
test_balance = {
	initial_value = 0
	left_side = test_left
	right_side = test_right
	range = {
		id = test_mid_range
		min = -0.1
		max = 0.1
		modifier = {
			stability_factor = -0.05
			political_power_gain = 0.05
			custom_modifier_tooltip = test_mid_tt
		}
	}
	side = {
		id = test_left
		range = {
			id = test_left_range
			min = -1
			max = -0.1
		}
	}
	side = {
		id = test_right
		range = {
			id = test_right_range
			min = 0.1
			max = 1
		}
	}
}`;

function loadResultOf(text: string): BopLoaderResult {
	return {
		bops: getBopsFromFile(parseHoi4File(text), "common/bop/test.txt"),
		gfxFiles: [],
		window: undefined,
		templates: {},
		decisions: {},
		modifierDefinitions: {},
	};
}

describe("previewdef/bop buildBopPreviewPayload", () => {
	it("carries a range's modifiers and tooltips into the payload", async () => {
		const payload = await buildBopPreviewPayload(loadResultOf(source), new StyleTable());
		const [card] = payload.cards;
		assert.ok(card);

		const mid = card.ranges.find((r) => r.id === "test_mid_range");
		assert.ok(mid, "expected the centre range");
		assert.deepStrictEqual(
			mid.modifiers.map((m) => m.key),
			["stability_factor", "political_power_gain"],
		);
		assert.deepStrictEqual(
			mid.modifiers.map((m) => m.value),
			// `stability_factor` reads as a percentage, the bare key as a plain number.
			["-5%", "+0.05"],
		);
		assert.deepStrictEqual(mid.customTooltips.map((t) => t.key), ["test_mid_tt"]);
	});

	it("leaves a range with no modifier block empty", async () => {
		const payload = await buildBopPreviewPayload(loadResultOf(source), new StyleTable());
		const [card] = payload.cards;
		const left = card.ranges.find((r) => r.id === "test_left_range");
		assert.ok(left, "expected the left range");
		assert.deepStrictEqual(left.modifiers, []);
		assert.deepStrictEqual(left.customTooltips, []);
	});

	it("reports no localisation when the index is off, so the toggle is not offered", async () => {
		const payload = await buildBopPreviewPayload(loadResultOf(source), new StyleTable());
		// With the index off every LocText echoes its key, and so does a custom tooltip.
		assert.strictEqual(payload.hasLocalisation, false);
	});
});
