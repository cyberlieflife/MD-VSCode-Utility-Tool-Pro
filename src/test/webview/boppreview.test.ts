import { loadEntrypoint, useEntrypoint, resetWebviewState } from "./setup";
import * as assert from "assert";
import { BopPreviewPayload } from "../../previewdef/bop/payload";

// The bar's ranges carry the modifiers the game prints when the pointer rests on one, and the
// window's texts are localisation values that may carry the game's colour codes. Both are drawn by
// the webview, so this drives the real module against a hand-built payload.

const payload: BopPreviewPayload = {
	hasLocalisation: true,
	cards: [
		{
			key: "test_balance",
			id: "test_balance",
			title: { key: "test_balance", text: "§R权力平衡§!" },
			initialValue: 0,
			ranges: [
				{
					id: "test_left_range",
					name: { key: "test_left_range", text: "§B左翼§!" },
					min: -1,
					max: -0.1,
					modifiers: [],
					customTooltips: [],
				},
				{
					id: "test_mid_range",
					name: { key: "test_mid_range", text: "§G中间§!" },
					min: -0.1,
					max: 0.1,
					modifiers: [{ key: "stability_factor", name: "稳定度", value: "-5.00%", tone: "bad" }],
					customTooltips: [{ key: "test_mid_tt", text: "§Y提示§!" }],
				},
				{
					id: "test_right_range",
					name: { key: "test_right_range", text: "§R右翼§!" },
					min: 0.1,
					max: 1,
					modifiers: [],
					customTooltips: [],
				},
			],
			window: {
				html:
					'<div class="bop-gui-window" style="width:200px;height:60px">' +
					'<div class="bop-slot-title"></div><div class="bop-slot-active-range"></div>' +
					'<div class="bop-slot-value"></div><div class="bop-slot-hover"></div><div class="bop-slot-marks"></div>' +
					"</div>",
				width: 200,
				height: 60,
				bar: { x: 10, y: 20, width: 180, height: 16 },
				texts: [],
			},
			decisions: [],
			warnings: [],
		},
	],
};

(global as any).window.bopPreview = payload;

const shellHtml = `<div class="toolbar-outer">
	<div class="toolbar">
		<div id="bop-select-container"><select id="bops"></select></div>
		<div class="bop-controls">
			<input type="range" id="bop-slider">
			<input type="number" id="bop-number">
			<button id="bop-reset" class="bop-reset"></button>
		</div>
		<label for="show-localisation">Show localisation</label>
		<input type="checkbox" id="show-localisation">
	</div>
</div>
<div id="boppreviewcontent"></div>`;

// Loaded for its side effect: the module renders on the load event its listeners deliver.
const { listeners } = loadEntrypoint(
	() => require("../../../webviewsrc/boppreview") as typeof import("../../../webviewsrc/boppreview"),
);

function content(): HTMLElement {
	const element = document.getElementById("boppreviewcontent");
	assert.ok(element, "expected the shell content element");
	return element!;
}

const tick = (ms = 220) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("webview/boppreview rendering", () => {
	useEntrypoint(listeners);

	let previousBody = "";

	before(() => {
		resetWebviewState();
		previousBody = document.body.innerHTML;
		document.body.innerHTML = shellHtml;
		// The module binds its renderer to window load, as the webview does.
		window.dispatchEvent(new (window as any).Event("load"));
	});

	after(() => {
		document.body.innerHTML = previousBody;
	});

	it("renders the window's title and active range with the colour codes drawn", () => {
		const title = content().querySelector(".bop-slot-title") as HTMLElement;
		assert.ok(title);
		assert.ok(title.innerHTML.includes('<span style="color:#ff3232">'), "the title's §R must become a span");
		assert.ok(title.innerHTML.includes("权力平衡"));

		// The initial value 0 sits in the centre range, whose name carries §G.
		const active = content().querySelector(".bop-slot-active-range") as HTMLElement;
		assert.ok(active);
		assert.ok(active.innerHTML.includes('<span style="color:#009f03">'), "the active range's §G must become a span");
	});

	it("puts a hover area over every range, at its stretch of the bar", () => {
		const areas = Array.from(content().querySelectorAll<HTMLElement>(".bop-slot-range"));
		assert.strictEqual(areas.length, 3);
		// bar.x 10, width 180: value -0.1 is x 91, value 0.1 is x 109, so the centre range is 18 wide.
		const mid = areas[1];
		assert.ok(Math.abs(parseFloat(mid.style.left) - 91) < 1e-6, `left was ${mid.style.left}`);
		assert.ok(Math.abs(parseFloat(mid.style.width) - 18) < 1e-6, `width was ${mid.style.width}`);
		assert.strictEqual(mid.style.top, "20px");
		assert.strictEqual(mid.style.height, "16px");
	});

	it("opens the range's modifiers on hover, and closes them on leave", async () => {
		const mid = Array.from(content().querySelectorAll<HTMLElement>(".bop-slot-range"))[1];
		mid.dispatchEvent(new (window as any).Event("mouseenter"));
		await tick();

		const panel = document.querySelector<HTMLElement>(".bop-range-tip");
		assert.ok(panel, "expected the range's panel");
		assert.ok(panel!.innerHTML.includes('<span style="color:#009f03">'), "the panel head draws its colour code");
		assert.strictEqual(panel!.querySelector(".bop-range-tip-name")?.textContent, "稳定度");
		const value = panel!.querySelector(".bop-range-tip-value");
		assert.strictEqual(value?.textContent, "-5.00%");
		assert.ok(value!.classList.contains("bop-range-tip-bad"));
		// The custom_modifier_tooltip line is drawn under the modifiers, colour code and all.
		const text = panel!.querySelector(".bop-range-tip-text") as HTMLElement;
		assert.ok(text);
		assert.ok(text.innerHTML.includes('<span style="color:#ffbd00">'));

		mid.dispatchEvent(new (window as any).Event("mouseleave"));
		assert.strictEqual(document.querySelector(".bop-range-tip"), null);
	});

	it("opens nothing over a range with no modifiers", async () => {
		const left = Array.from(content().querySelectorAll<HTMLElement>(".bop-slot-range"))[0];
		left.dispatchEvent(new (window as any).Event("mouseenter"));
		await tick();
		assert.strictEqual(document.querySelector(".bop-range-tip"), null);
		left.dispatchEvent(new (window as any).Event("mouseleave"));
	});
});
