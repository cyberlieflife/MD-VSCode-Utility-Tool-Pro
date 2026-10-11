// The game's colour codes (`§R...§!`) turned into HTML, for the previews that show a localisation
// value the way the game does rather than as its raw text.
//
// Pure and dependency-free: the webviews bundle this along with the payload modules.

// The colours the game ships with, keyed by the single character after `§`, at the exact RGB the
// game's own table uses. A mod can add more through `textcolors` in interface/core.gfx; those are
// left as written, the same way the game leaves a code it does not know.
const colours: Record<string, string> = {
	"0": "#cb00cb",
	"1": "#8078d3",
	"2": "#5170f3",
	"3": "#518fdc",
	"4": "#5abee7",
	"5": "#3fb5c2",
	"6": "#77ccba",
	"7": "#99d199",
	"8": "#cca333",
	"9": "#fca97d",
	b: "#000000",
	g: "#b0b0b0",
	t: "#ff4c4d",
	C: "#23ceff",
	L: "#c3b091",
	W: "#ffffff",
	T: "#ffffff",
	B: "#0000ff",
	G: "#009f03",
	R: "#ff3232",
	O: "#ff7019",
	Y: "#ffbd00",
	H: "#ffbd00",
};

const escaped: Record<string, string> = {
	"&": "&amp;",
	"<": "&lt;",
	">": "&gt;",
	'"': "&quot;",
};

/**
 * Renders a localisation value as HTML: text is escaped, every `§X` opens a coloured span and `§!`
 * closes it. Text after an unterminated code keeps that colour to the end of the string, which is
 * what the game does -- it colours until told otherwise, even past the end of the value.
 *
 * A `§` followed by anything but a colour character or `!` is not a code, and is left as written,
 * so a typo in the file reads as the typo rather than hiding text.
 */
export function localisationToHtml(raw: string): string {
	let html = "";
	let open = false;

	for (let i = 0; i < raw.length; i++) {
		const char = raw[i];
		if (char === "§") {
			const code = raw[i + 1];
			if (code === "!") {
				if (open) {
					html += "</span>";
					open = false;
				}
				i++;
				continue;
			}
			const colour = code === undefined ? undefined : colours[code];
			if (colour !== undefined) {
				if (open) {
					html += "</span>";
				}
				html += `<span style="color:${colour}">`;
				open = true;
				i++;
				continue;
			}
		}
		html += escaped[char] ?? char;
	}

	if (open) {
		html += "</span>";
	}
	return html;
}

/**
 * The same value with its colour codes dropped and nothing else changed, for the places that show a
 * string rather than HTML: a `<select>` option, a `title` attribute.
 */
export function localisationToText(raw: string): string {
	let text = "";
	for (let i = 0; i < raw.length; i++) {
		const code = raw[i] === "§" ? raw[i + 1] : undefined;
		if (code !== undefined && (code === "!" || colours[code] !== undefined)) {
			i++;
			continue;
		}
		text += raw[i];
	}
	return text;
}
