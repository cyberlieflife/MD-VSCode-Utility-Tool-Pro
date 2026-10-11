import { localize } from "../../util/i18n";
import * as vscode from "vscode";
import { renderIdeaFile } from "./contentbuilder";
import { matchPathEnd } from "../../util/nodecommon";
import { PreviewProviderDef } from "../previewmanager";
import { LoaderPreview } from "../loaderpreview";
import { IdeasLoader } from "./loader";
import { ideaPreview } from "../../util/featureflags";
import { getDocumentByUri } from "../../util/vsccommon";
import { error } from "../../util/debug";
import { isRecord } from "../../util/messageguards";
import { listModifierKeysWithNames, ModifierKeyOption } from "../../util/modifiers";
import { buildCreateIdeaEdits, buildIdeaModifierEdits, buildIdeaPictureEdits, IdeaTextEdit } from "./editor";
import { collectIdeaIconNames, getIdeaIconPickerImage } from "./iconpicker";

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

// The icon picker names sprites (GFX_idea_x); the game's `picture` field takes the bare name.
function pictureLiteral(sprite: string): string {
	return sprite.replace(/^GFX_idea_/i, "");
}

// The modifier rows the dialog sends back: objects with a non-empty key and a string value. A
// malformed list is rejected outright rather than written out half-parsed.
function readIdeaModifiers(raw: unknown): { key: string; value: string }[] | undefined {
	if (!Array.isArray(raw)) {
		return undefined;
	}

	const modifiers: { key: string; value: string }[] = [];
	for (const entry of raw) {
		if (isRecord(entry) && typeof entry.key === "string" && typeof entry.value === "string") {
			const key = entry.key.trim();
			if (key !== "") {
				modifiers.push({ key, value: entry.value });
			}
		}
	}
	return modifiers;
}

class IdeaPreview extends LoaderPreview<IdeasLoader> {
	// The picker's key list is the same for every request and costs a localisation scan, so it is
	// built once per panel and only dropped when that build failed.
	private modifierKeys: Promise<ModifierKeyOption[]> | undefined;
	// Same for the sprite list the idea icon picker shows.
	private ideaIconNames: Promise<string[]> | undefined;

	constructor(uri: vscode.Uri, panel: vscode.WebviewPanel) {
		super(
			uri,
			panel,
			(file, contentProvider) => new IdeasLoader(file, contentProvider),
			renderIdeaFile,
		);

		// The right-click edit actions. Every file change goes through the pure functions in
		// editor.ts and one WorkspaceEdit, the same shape as the focus-tree editors; the document
		// change that follows repaints the preview, so nothing is re-rendered here.
		panel.webview.onDidReceiveMessage((msg) => {
			if (!isRecord(msg)) {
				return;
			}
			switch (msg.command) {
				case "requestIdeaEditorData":
					void this.sendIdeaEditorData();
					break;
				case "requestIdeaIcons":
					void this.sendIdeaIcons();
					break;
				case "requestIdeaIconImages":
					void this.sendIdeaIconImages(msg.names);
					break;
				case "editIdeaPicture": {
					if (typeof msg.id === "string" && typeof msg.sprite === "string") {
						const id = msg.id;
						const picture = pictureLiteral(msg.sprite);
						void this.applyIdeaEdit((text) => buildIdeaPictureEdits(text, id, picture));
					}
					break;
				}
				case "editIdeaModifiers": {
					const modifiers = readIdeaModifiers(msg.modifiers);
					if (typeof msg.id === "string" && modifiers) {
						const id = msg.id;
						void this.applyIdeaEdit((text) => buildIdeaModifierEdits(text, id, modifiers));
					}
					break;
				}
				case "createIdea": {
					const modifiers = readIdeaModifiers(msg.modifiers) ?? [];
					if (typeof msg.category === "string" && typeof msg.id === "string") {
						const category = msg.category;
						const id = msg.id;
						const picture = typeof msg.sprite === "string" ? pictureLiteral(msg.sprite) : undefined;
						void this.applyIdeaEdit((text) =>
							buildCreateIdeaEdits(text, category, id, { picture, modifiers }));
					}
					break;
				}
			}
		});
	}

	private async sendIdeaEditorData(): Promise<void> {
		this.modifierKeys ??= listModifierKeysWithNames();
		let modifiers: ModifierKeyOption[] = [];
		try {
			modifiers = await this.modifierKeys;
		} catch (e) {
			error(e);
			this.modifierKeys = undefined;
		}
		void this.panel.webview.postMessage({ type: "ideaEditorData", modifiers });
	}

	private async sendIdeaIcons(): Promise<void> {
		this.ideaIconNames ??= collectIdeaIconNames();
		let names: string[] = [];
		try {
			names = await this.ideaIconNames;
		} catch (e) {
			error(e);
			this.ideaIconNames = undefined;
		}
		void this.panel.webview.postMessage({ type: "ideaIconNames", names, total: names.length });
	}

	private async sendIdeaIconImages(rawNames: unknown): Promise<void> {
		const requested = Array.isArray(rawNames)
			? rawNames.filter((name): name is string => typeof name === "string")
			: [];
		if (requested.length === 0) {
			return;
		}
		const images = await Promise.all(requested.map(async (name) => ({
			name,
			imageUri: (await getIdeaIconPickerImage(name))?.uri,
		})));
		void this.panel.webview.postMessage({ type: "ideaIconImages", images, done: true });
	}

	private async applyIdeaEdit(build: (text: string) => IdeaTextEdit[]): Promise<void> {
		let ok = false;
		try {
			const document = getDocumentByUri(this.uri);
			if (document) {
				const edits = build(document.getText());
				if (edits.length > 0) {
					const workspaceEdit = new vscode.WorkspaceEdit();
					for (const edit of edits) {
						workspaceEdit.replace(
							this.uri,
							new vscode.Range(document.positionAt(edit.start), document.positionAt(edit.end)),
							edit.text,
						);
					}
					ok = await vscode.workspace.applyEdit(workspaceEdit);
				}
			}
		} catch (e) {
			error(e);
		}
		void this.panel.webview.postMessage({ type: "ideaEditResult", ok });
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
