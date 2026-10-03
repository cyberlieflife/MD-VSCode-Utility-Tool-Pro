import { localize } from "../../util/i18n";
import * as vscode from "vscode";
import { renderCharacterFile } from "./contentbuilder";
import { matchPathEnd } from "../../util/nodecommon";
import { PreviewProviderDef } from "../previewmanager";
import { LoaderPreview } from "../loaderpreview";
import { CharactersLoader } from "./loader";
import { characterPreview } from "../../util/featureflags";

// The head of a document scanned for the block a preview file opens with, capped so the scan
// stays cheap on a multi-megabyte file.
const previewSniffLength = 64 * 1024;

function canPreviewCharacter(document: vscode.TextDocument) {
	if (!characterPreview) {
		return undefined;
	}

	const uri = document.uri;
	if (
		matchPathEnd(uri.toString().toLowerCase(), ["common", "characters", "*"]) &&
		uri.path.toLowerCase().endsWith(".txt")
	) {
		return 0;
	}

	// A characters file kept somewhere else still previews, as long as it opens with the
	// `characters` block the game reads. Only a .txt file is sniffed, and only its head: this runs
	// for every document the active editor moves through, so a full scan would cost a pause on
	// every tab switch. A flat pattern keeps the scan linear, where `\s` would cross lines and
	// made it quadratic on large scripts.
	if (!uri.path.toLowerCase().endsWith(".txt")) {
		return undefined;
	}
	const head = document.getText().substring(0, previewSniffLength);
	const opening = head.match(/^[ \t]*characters[ \t]*=[ \t]*\{/m);
	return opening === null ? undefined : opening.index;
}

class CharacterPreview extends LoaderPreview<CharactersLoader> {
	constructor(uri: vscode.Uri, panel: vscode.WebviewPanel) {
		super(
			uri,
			panel,
			(file, contentProvider) => new CharactersLoader(file, contentProvider),
			renderCharacterFile,
		);
	}

	// previewLocalisation changes the text in the payload; localisationIndex changes whether
	// there is any text to show, and so whether the localisation toggle is offered at all;
	// gfxIndex changes which of the GFX_-named portraits resolve; characterTraitStructuralKeys
	// changes which trait keys are drawn as modifier lines; modifierFormatFiles changes how modifier
	// values read.
	protected override get reloadOnConfigurationChange(): readonly string[] {
		return ["previewLocalisation", "localisationIndex", "gfxIndex", "characterTraitStructuralKeys", "modifierFormatFiles"];
	}
}

export const characterPreviewDef: PreviewProviderDef = {
	type: "character",
	displayName: () => localize("preview.type.character", "Characters (common/characters/*.txt)"),
	isEnabled: () => characterPreview,
	canPreview: canPreviewCharacter,
	previewConstructor: CharacterPreview,
};
