import { localize } from "../../util/i18n";
import * as vscode from "vscode";
import { renderBopFile } from "./contentbuilder";
import { matchPathEnd } from "../../util/nodecommon";
import { PreviewProviderDef } from "../previewmanager";
import { LoaderPreview } from "../loaderpreview";
import { BopLoader } from "./loader";
import { bopPreview } from "../../util/featureflags";

// The head of a document scanned for the block a preview file opens with, capped so the scan
// stays cheap on a multi-megabyte file.
const previewSniffLength = 64 * 1024;

export function canPreviewBop(document: vscode.TextDocument): number | undefined {
	if (!bopPreview) {
		return undefined;
	}

	const uri = document.uri;
	if (
		matchPathEnd(uri.toString().toLowerCase(), ["common", "bop", "*"]) &&
		uri.path.toLowerCase().endsWith(".txt")
	) {
		return 0;
	}

	// A BoP kept somewhere else still previews, as long as its first line inside the block is the
	// `initial_value` every balance of power opens with. Only a .txt file is sniffed, and only its
	// head (see the idea preview). The block is located with a flat pattern and the marker looked
	// up separately, where the previous single pattern nested a quantifier over comment lines and
	// backtracked catastrophically on a large script file that never mentions initial_value.
	if (!uri.path.toLowerCase().endsWith(".txt")) {
		return undefined;
	}
	const head = document.getText().substring(0, previewSniffLength);
	const opening = head.match(/^[ \t]*[A-Za-z_][A-Za-z0-9_]*[ \t]*=[ \t]*\{/m);
	if (opening === null || opening.index === undefined) {
		return undefined;
	}
	return /initial_value[ \t]*=/.test(head.substring(opening.index, opening.index + 4096)) ? opening.index : undefined;
}

class BopPreview extends LoaderPreview<BopLoader> {
	constructor(uri: vscode.Uri, panel: vscode.WebviewPanel) {
		super(
			uri,
			panel,
			(file, contentProvider) => new BopLoader(file, contentProvider),
			renderBopFile,
		);
	}

	// previewLocalisation changes the text in the payload; localisationIndex changes whether there
	// is any text to show; gfxIndex changes which side icons resolve.
	protected override get reloadOnConfigurationChange(): readonly string[] {
		return ["previewLocalisation", "localisationIndex", "gfxIndex"];
	}
}

export const bopPreviewDef: PreviewProviderDef = {
	type: "bop",
	displayName: () => localize("preview.type.bop", "Balance of power (common/bop/*.txt)"),
	isEnabled: () => bopPreview,
	canPreview: canPreviewBop,
	previewConstructor: BopPreview,
};
