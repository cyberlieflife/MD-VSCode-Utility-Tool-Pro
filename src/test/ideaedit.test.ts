import * as assert from "assert";
import {
	buildCreateIdeaEdits,
	buildIdeaModifierEdits,
	buildIdeaPictureEdits,
	IdeaTextEdit,
} from "../previewdef/idea/editor";

// Applies edit specs back to front, the way VS Code applies non-overlapping edits.
function applyEdits(text: string, edits: IdeaTextEdit[]): string {
	let result = text;
	for (const edit of edits.slice().sort((a, b) => b.start - a.start)) {
		result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
	}
	return result;
}

const source = [
	"ideas = {",
	"\tcountry = {",
	"\t\tidea_one = {",
	"\t\t\tpicture = GFX_idea_one",
	"\t\t\tmodifier = {",
	"\t\t\t\tstability_factor = 0.1",
	"\t\t\t\twar_support_factor = -0.05",
	"\t\t\t}",
	"\t\t}",
	"\t\tidea_bare = {",
	"\t\t}",
	"\t}",
	"",
	"\tlaws = {",
	"\t\tlaw_one = {",
	"\t\t\tmodifier = {",
	"\t\t\t\tstability_factor = 0.2",
	"\t\t\t}",
	"\t\t}",
	"\t}",
	"}",
	"",
].join("\n");

describe('idea/editor', () => {
	describe("buildIdeaPictureEdits", () => {
		it("replaces the value of an existing picture line", () => {
			const edits = buildIdeaPictureEdits(source, "idea_one", "GFX_idea_two");
			const result = applyEdits(source, edits);
			assert.ok(result.includes("picture = GFX_idea_two"));
			assert.ok(!result.includes("picture = GFX_idea_one"));
			// Everything else is untouched.
			assert.ok(result.includes("stability_factor = 0.1"));
		});

		it("inserts a picture line when the idea has none", () => {
			const edits = buildIdeaPictureEdits(source, "idea_bare", "GFX_idea_bare");
			const result = applyEdits(source, edits);
			assert.ok(result.includes("picture = GFX_idea_bare"));
			// The inserted line sits inside the idea block, on its own indented line.
			assert.ok(/\t\tidea_bare = \{\n\t\t\tpicture = GFX_idea_bare\n\t\t\}/.test(result));
		});

		it("edits nothing for an unknown idea", () => {
			assert.deepStrictEqual(buildIdeaPictureEdits(source, "missing", "GFX_x"), []);
		});
	});

	describe("buildIdeaModifierEdits", () => {
		it("rewrites the modifier block with the given values", () => {
			const edits = buildIdeaModifierEdits(source, "idea_one", [
				{ key: "stability_factor", value: "0.3" },
				{ key: "war_support_factor", value: "-0.05" },
			]);
			const result = applyEdits(source, edits);
			assert.ok(result.includes("stability_factor = 0.3"));
			assert.ok(result.includes("war_support_factor = -0.05"));
			assert.ok(!result.includes("stability_factor = 0.1"));
		});

		it("removes a key the list dropped", () => {
			const edits = buildIdeaModifierEdits(source, "idea_one", [
				{ key: "stability_factor", value: "0.1" },
			]);
			const result = applyEdits(source, edits);
			assert.ok(!result.includes("war_support_factor"));
			assert.ok(result.includes("stability_factor = 0.1"));
		});

		it("creates a modifier block when the idea has none", () => {
			const edits = buildIdeaModifierEdits(source, "idea_bare", [
				{ key: "stability_factor", value: "0.4" },
			]);
			const result = applyEdits(source, edits);
			assert.ok(/idea_bare = \{\n\t\t\tmodifier = \{\n\t\t\t\tstability_factor = 0.4\n\t\t\t\}\n\t\t\}/.test(result));
		});

		it("deletes the whole modifier block when the list is emptied", () => {
			const edits = buildIdeaModifierEdits(source, "law_one", []);
			const result = applyEdits(source, edits);
			// The law keeps its name and closes right after it: its modifier block is gone (the
			// country ideas' own blocks are untouched).
			const lawSection = result.slice(result.indexOf("law_one = {"));
			assert.ok(!lawSection.includes("modifier = {"));
			assert.ok(/law_one = \{\n\t\t\}/.test(result));
		});

		it("edits nothing for an unknown idea", () => {
			assert.deepStrictEqual(buildIdeaModifierEdits(source, "missing", []), []);
		});
	});

	describe("buildCreateIdeaEdits", () => {
		it("appends a new idea to an existing category", () => {
			const edits = buildCreateIdeaEdits(source, "country", "idea_new", {
				picture: "GFX_idea_new",
				modifiers: [{ key: "stability_factor", value: "0.15" }],
			});
			const result = applyEdits(source, edits);
			assert.ok(/idea_new = \{\n\t\t\tpicture = GFX_idea_new\n\t\t\tmodifier = \{/.test(result));
			// The new idea is inside the country category, before its closing brace.
			const countryStart = result.indexOf("\tcountry = {");
			const lawsStart = result.indexOf("\tlaws = {");
			const newStart = result.indexOf("idea_new = {");
			assert.ok(countryStart < newStart && newStart < lawsStart);
		});

		it("creates the category when it does not exist", () => {
			const edits = buildCreateIdeaEdits(source, "air", "idea_air", { modifiers: [] });
			const result = applyEdits(source, edits);
			assert.ok(/\tair = \{\n\t\tidea_air = \{/.test(result));
		});

		it("creates an ideas root when the file has none", () => {
			const edits = buildCreateIdeaEdits("", "country", "idea_new", { modifiers: [] });
			const result = applyEdits("", edits);
			assert.ok(/^ideas = \{\n\tcountry = \{\n\t\tidea_new = \{/.test(result));
		});

		it("does not duplicate an idea that already exists", () => {
			assert.deepStrictEqual(buildCreateIdeaEdits(source, "country", "idea_one", { modifiers: [] }), []);
		});
	});
});
