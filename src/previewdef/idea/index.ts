import { localize } from "../../util/i18n";
import * as vscode from "vscode";
import { renderIdeaFile } from "./contentbuilder";
import { matchPathEnd } from "../../util/nodecommon";
import { PreviewProviderDef } from "../previewmanager";
import { LoaderPreview } from "../loaderpreview";
import { IdeasLoader } from "./loader";
import { ideaPreview } from "../../util/featureflags";

// The head of a document scanned for the block a preview file opens with, capped so the scan
// stays cheap on a multi-megabyte file.
const previewSniffLength = 64 * 1024;

function canPreviewIdea(document: vscode.TextDocument) {
	if (!ideaPreview) {
		return undefined;
	}

	const uri = document.uri;
	if (
		matchPathEnd(uri.toString().toLowerCase(), ["common", "ideas", "*"]) &&
		uri.path.toLowerCase().endsWith(".txt")
	) {
		return 0;
	}

	// An ideas file kept somewhere else still previews, as long as it opens with the `ideas` block
	// the game reads. Anchored to the start of a line so a stray `swap_ideas = {` in a focus file
	// does not claim the preview. Only a .txt file is sniffed, and only its head: this runs for
	// every document the active editor moves through, so a full scan would cost a pause on every
	// tab switch. A flat pattern keeps the scan linear, where `\s` would cross lines and made it
	// quadratic on large scripts.
	if (!uri.path.toLowerCase().endsWith(".txt")) {
		return undefined;
	}
	const head = document.getText().substring(0, previewSniffLength);
	const opening = head.match(/^[ \t]*ideas[ \t]*=[ \t]*\{/m);
	return opening === null ? undefined : opening.index;
}

class IdeaPreview extends LoaderPreview<IdeasLoader> {
	constructor(uri: vscode.Uri, panel: vscode.WebviewPanel) {
		super(
			uri,
			panel,
			(file, contentProvider) => new IdeasLoader(file, contentProvider),
			renderIdeaFile,
		);
	}

	// previewLocalisation changes the text in the payload; localisationIndex changes whether
	// there is any text to show, and so whether the localisation toggle is offered at all;
	// gfxIndex changes which icons resolve; ideaSwapIndex changes whether chains are found;
	// ideaPlaceholderIcon changes what an icon that does not resolve is drawn with;
	// modifierFormatFiles changes how modifier values read.
	protected get reloadOnConfigurationChange(): readonly string[] {
		return [
			"previewLocalisation",
			"localisationIndex",
			"gfxIndex",
			"ideaSwapIndex",
			"ideaPlaceholderIcon",
			"modifierFormatFiles",
		];
	}
}

export const ideaPreviewDef: PreviewProviderDef = {
	type: "idea",
	displayName: () => localize("preview.type.idea", "Ideas (common/ideas/*.txt)"),
	isEnabled: () => ideaPreview,
	canPreview: canPreviewIdea,
	previewConstructor: IdeaPreview,
};
