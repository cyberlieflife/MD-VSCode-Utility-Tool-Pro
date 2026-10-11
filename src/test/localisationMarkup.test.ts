import * as assert from "assert";
import { localisationToHtml, localisationToText } from "../util/localisationMarkup";

// HOI4 writes a localisation value with `§<letter>` colour codes closed by `§!`. The previews draw
// those values, so the codes have to become markup rather than reach the page as literal text.

describe("util/localisationMarkup localisationToHtml", () => {
	it("turns a colour code into a span and closes it at §!", () => {
		assert.strictEqual(
			localisationToHtml("§R无作为者§!"),
			'<span style="color:#ff3232">无作为者</span>',
		);
	});

	it("keeps the text between two codes apart", () => {
		assert.strictEqual(
			localisationToHtml("§Bblue§! and §Rred§!"),
			'<span style="color:#0000ff">blue</span> and <span style="color:#ff3232">red</span>',
		);
	});

	it("renders every colour the game ships with", () => {
		// A code with no text after it still opens and closes a span.
		assert.strictEqual(localisationToHtml("§Wx"), '<span style="color:#ffffff">x</span>');
		assert.strictEqual(localisationToHtml("§bx"), '<span style="color:#000000">x</span>');
		assert.strictEqual(localisationToHtml("§gx"), '<span style="color:#b0b0b0">x</span>');
		assert.strictEqual(localisationToHtml("§tx"), '<span style="color:#ff4c4d">x</span>');
		assert.strictEqual(localisationToHtml("§0x"), '<span style="color:#cb00cb">x</span>');
		assert.strictEqual(localisationToHtml("§9x"), '<span style="color:#fca97d">x</span>');
		assert.strictEqual(localisationToHtml("§Hx"), '<span style="color:#ffbd00">x</span>');
	});

	it("closes an unterminated code at the end of the string", () => {
		assert.strictEqual(localisationToHtml("§Ywarning"), '<span style="color:#ffbd00">warning</span>');
	});

	it("starts a new colour without an intervening §!", () => {
		assert.strictEqual(
			localisationToHtml("§Ra§Gb"),
			'<span style="color:#ff3232">a</span><span style="color:#009f03">b</span>',
		);
	});

	it("leaves a code the game does not know as written", () => {
		assert.strictEqual(localisationToHtml("§Mtext"), "§Mtext");
		// A trailing § with nothing after it is not a code either.
		assert.strictEqual(localisationToHtml("text §"), "text §");
	});

	it("escapes HTML in the value", () => {
		assert.strictEqual(
			localisationToHtml('<b>&"'),
			"&lt;b&gt;&amp;&quot;",
		);
		assert.strictEqual(
			localisationToHtml("§R<a>§!"),
			'<span style="color:#ff3232">&lt;a&gt;</span>',
		);
	});

	it("leaves a string with no codes alone", () => {
		assert.strictEqual(localisationToHtml("plain text"), "plain text");
	});
});

describe("util/localisationMarkup localisationToText", () => {
	it("drops the codes and keeps the text", () => {
		assert.strictEqual(localisationToText("§R无作为者§!"), "无作为者");
		assert.strictEqual(localisationToText("§Bblue§! and §Rred§!"), "blue and red");
	});

	it("keeps a § the game would not read as a code", () => {
		assert.strictEqual(localisationToText("§Mtext"), "§Mtext");
	});

	it("does not escape HTML, which the caller's own text sinks handle", () => {
		assert.strictEqual(localisationToText("§R<a>§!"), "<a>");
	});
});
