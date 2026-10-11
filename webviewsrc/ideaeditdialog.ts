import { vscode } from "./util/vscode";
import { feLocalize } from "./util/i18n";
import { openIconPicker, makeDialogButton } from "./util/iconpicker";
import { IdeaCard } from "../src/previewdef/idea/payload";

// The idea edit dialog: a picture picker (the same grid the focus tree uses) and a modifier list
// whose rows pick a key from the host's known-modifier set and carry a value. It also builds the
// create form, which is the same two fields plus a category and a key.

export interface ModifierKeyOption {
	key: string;
	name: string;
}

interface ModifierRow {
	key: string;
	value: string;
}

interface DialogHost {
	setModifierKeys(keys: ModifierKeyOption[]): void;
	setResult(ok: boolean): void;
}

let activeDialog: DialogHost | null = null;
// The host's key list is fetched once per page and reused by every dialog opened afterwards.
let modifierKeys: ModifierKeyOption[] = [];
let modifierKeysRequested = false;

/**
 * Feeds a message from the host into the open dialog. Returns true when it was the dialog's.
 */
export function handleIdeaEditorMessage(msg: any): boolean {
	if (msg?.type === "ideaEditorData") {
		modifierKeys = Array.isArray(msg.modifiers) ? msg.modifiers as ModifierKeyOption[] : [];
		activeDialog?.setModifierKeys(modifierKeys);
		return true;
	}
	if (msg?.type === "ideaEditResult") {
		activeDialog?.setResult(msg.ok === true);
		return true;
	}
	return false;
}

// Asks the host for the modifier key list the first time a dialog needs it.
function requestModifierKeys(): void {
	if (modifierKeysRequested) {
		return;
	}
	modifierKeysRequested = true;
	vscode.postMessage({ command: "requestIdeaEditorData" });
}

function closeOverlay(overlay: HTMLDivElement, host: DialogHost): void {
	overlay.remove();
	if (activeDialog === host) {
		activeDialog = null;
	}
}

function fieldRow(box: HTMLElement, labelText: string): HTMLDivElement {
	const row = document.createElement("div");
	row.style.cssText = "margin-bottom:8px;";
	const label = document.createElement("label");
	label.style.cssText = "display:block;margin-bottom:2px;";
	label.textContent = labelText;
	row.appendChild(label);
	box.appendChild(row);
	return row;
}

function makeModal(titleText: string): { overlay: HTMLDivElement; box: HTMLDivElement } {
	const overlay = document.createElement("div");
	overlay.className = "idea-edit";
	overlay.style.cssText = "position:fixed;inset:0;z-index:3000;background:rgba(0,0,0,.4);" +
		"display:flex;align-items:center;justify-content:center;";
	const box = document.createElement("div");
	box.style.cssText = "background:var(--vscode-editor-background);color:var(--vscode-editor-foreground);" +
		"border:1px solid var(--vscode-widget-border);padding:16px;min-width:420px;max-width:640px;" +
		"max-height:80vh;overflow-y:auto;display:flex;flex-direction:column;";
	const title = document.createElement("div");
	title.style.cssText = "font-weight:bold;margin-bottom:12px;";
	title.textContent = titleText;
	box.appendChild(title);
	overlay.appendChild(box);
	document.body.appendChild(overlay);
	return { overlay, box };
}

// The picture row: the current sprite name and a Choose button that opens the shared icon grid
// (source "idea", so the host answers with the idea sprites rather than the focus icons).
function buildPictureRow(
	box: HTMLElement,
	initial: string | undefined,
	setSprite: (sprite: string) => void,
): void {
	const row = fieldRow(box, feLocalize("ideapreview.edit.picture", "Icon"));
	const wrap = document.createElement("div");
	wrap.style.cssText = "display:flex;gap:4px;";
	const name = document.createElement("input");
	name.type = "text";
	name.readOnly = true;
	name.value = initial ?? "";
	name.style.cssText = "flex:1;min-width:0;";
	wrap.appendChild(name);
	const pick = makeDialogButton(feLocalize("ideapreview.edit.chooseicon", "Choose…"));
	pick.style.minWidth = "auto";
	pick.addEventListener("click", () => openIconPicker({
		source: "idea",
		onPick: (sprite) => {
			name.value = sprite;
			setSprite(sprite);
		},
	}));
	wrap.appendChild(pick);
	row.appendChild(wrap);
}

function displayName(key: string): string {
	return modifierKeys.find((option) => option.key === key)?.name ?? key;
}

// One modifier line: the key's localised name and its value. Rows are held in the caller's array
// and rewritten from it on confirm, so adding and removing is order-safe.
function buildModifierRow(
	list: HTMLElement,
	row: ModifierRow,
	rows: ModifierRow[],
	render: () => void,
): void {
	const line = document.createElement("div");
	line.className = "idea-edit-modifier";
	line.style.cssText = "display:flex;align-items:center;gap:6px;margin-bottom:4px;";

	const name = document.createElement("span");
	name.style.cssText = "flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
	name.textContent = displayName(row.key);
	line.appendChild(name);

	const value = document.createElement("input");
	value.type = "text";
	value.value = row.value;
	value.title = feLocalize("ideapreview.edit.valuehint", "Value");
	value.style.cssText = "width:110px;";
	value.addEventListener("change", () => {
		row.value = value.value;
	});
	line.appendChild(value);

	const remove = makeDialogButton(feLocalize("ideapreview.edit.remove", "Remove"));
	remove.style.minWidth = "auto";
	remove.addEventListener("click", () => {
		const index = rows.indexOf(row);
		if (index >= 0) {
			rows.splice(index, 1);
		}
		render();
	});
	line.appendChild(remove);

	list.appendChild(line);
}

// The add-modifier panel: a search box over the host's key list. Picking an entry appends a row.
function openModifierPicker(onPick: (key: string) => void): void {
	const overlay = document.createElement("div");
	overlay.className = "idea-edit-picker";
	overlay.style.cssText = "position:fixed;inset:0;z-index:3100;background:rgba(0,0,0,.4);" +
		"display:flex;align-items:center;justify-content:center;";
	const box = document.createElement("div");
	box.style.cssText = "background:var(--vscode-editor-background);color:var(--vscode-editor-foreground);" +
		"border:1px solid var(--vscode-widget-border);padding:12px;width:420px;max-height:70vh;" +
		"display:flex;flex-direction:column;";

	const search = document.createElement("input");
	search.type = "text";
	search.placeholder = feLocalize("ideapreview.edit.search", "Search: ");
	search.style.cssText = "margin-bottom:8px;";
	box.appendChild(search);

	const list = document.createElement("div");
	list.style.cssText = "overflow:auto;flex:1;";
	box.appendChild(list);

	const empty = document.createElement("div");
	empty.style.cssText = "color:var(--vscode-descriptionForeground);padding:8px;";
	empty.textContent = feLocalize("ideapreview.edit.nomodifiers", "No modifiers available.");
	box.appendChild(empty);

	const close = () => overlay.remove();
	const cancel = makeDialogButton(feLocalize("focustree.cancel", "Cancel"));
	cancel.style.cssText += "margin-top:8px;align-self:flex-end;";
	cancel.addEventListener("click", close);
	box.appendChild(cancel);

	const render = () => {
		const query = search.value.trim().toLowerCase();
		const matches = query
			? modifierKeys.filter((option) =>
				option.name.toLowerCase().includes(query) || option.key.toLowerCase().includes(query))
			: modifierKeys;
		list.textContent = "";
		empty.style.display = modifierKeys.length === 0 ? "" : "none";
		for (const option of matches) {
			const item = document.createElement("div");
			item.className = "idea-edit-modifier-option";
			item.style.cssText = "padding:4px 6px;cursor:pointer;white-space:nowrap;" +
				"overflow:hidden;text-overflow:ellipsis;";
			item.textContent = option.name;
			item.addEventListener("click", () => {
				close();
				onPick(option.key);
			});
			list.appendChild(item);
		}
	};
	search.addEventListener("input", render);
	render();

	overlay.appendChild(box);
	document.body.appendChild(overlay);
	search.focus();
}

function buildModifierSection(box: HTMLElement, initial: ModifierRow[]): {
	rows: ModifierRow[];
	refresh: () => void;
} {
	const section = document.createElement("div");
	section.style.cssText = "margin-bottom:8px;";
	const label = document.createElement("div");
	label.style.cssText = "margin-bottom:2px;";
	label.textContent = feLocalize("ideapreview.edit.modifiers", "Modifiers");
	section.appendChild(label);

	const list = document.createElement("div");
	section.appendChild(list);
	const empty = document.createElement("div");
	empty.style.cssText = "color:var(--vscode-descriptionForeground);font-size:11px;margin-bottom:4px;";
	empty.textContent = feLocalize("ideapreview.edit.selecthint", "Select a modifier to add.");
	section.appendChild(empty);

	// Rows are copies: the value inputs write through to the row objects, and the initial list is
	// still needed untouched to tell whether anything actually changed on confirm.
	const state = { rows: initial.map((row) => ({ ...row })) };
	const render = () => {
		list.textContent = "";
		empty.style.display = state.rows.length === 0 ? "" : "none";
		for (const row of state.rows) {
			buildModifierRow(list, row, state.rows, render);
		}
	};
	render();

	const add = makeDialogButton(feLocalize("ideapreview.edit.addmodifier", "Add modifier"));
	add.style.minWidth = "auto";
	add.style.cssText += "margin-bottom:4px;";
	add.addEventListener("click", () => {
		requestModifierKeys();
		openModifierPicker((key) => {
			state.rows.push({ key, value: "0" });
			render();
		});
	});
	section.appendChild(add);
	box.appendChild(section);

	// The key list may arrive after the dialog opened; the dialog re-renders through `refresh`, so
	// rows show localised names rather than raw keys.
	return { rows: state.rows, refresh: render };
}

function resultNote(box: HTMLElement, ok: boolean): void {
	const note = document.createElement("div");
	note.className = "idea-edit-result";
	note.style.cssText = "font-size:11px;margin-top:8px;";
	note.style.color = ok ? "var(--vscode-descriptionForeground)" : "var(--vscode-errorForeground)";
	note.textContent = ok
		? feLocalize("ideapreview.edit.saved", "Saved.")
		: feLocalize("ideapreview.edit.failed", "The idea could not be found in this file.");
	box.appendChild(note);
}

/**
 * Opens the edit dialog for one card: change its picture and its modifier block.
 */
export function openIdeaEditDialog(card: IdeaCard): void {
	const { overlay, box } = makeModal(
		feLocalize("ideapreview.edit.title", "Edit idea {0}", card.id),
	);

	let sprite: string | undefined;
	buildPictureRow(box, card.edit?.picture, (picked) => {
		sprite = picked;
	});

	const modifiers = buildModifierSection(box, card.edit?.modifiers ?? []);
	const host: DialogHost = {
		setModifierKeys: () => modifiers.refresh(),
		setResult: (ok) => resultNote(box, ok),
	};

	const buttons = document.createElement("div");
	buttons.style.cssText = "display:flex;justify-content:flex-end;gap:8px;margin-top:12px;";
	const cancel = makeDialogButton(feLocalize("focustree.cancel", "Cancel"));
	const ok = makeDialogButton(feLocalize("focustree.confirm", "Confirm"));
	buttons.appendChild(cancel);
	buttons.appendChild(ok);
	box.appendChild(buttons);

	cancel.addEventListener("click", () => closeOverlay(overlay, host));
	ok.addEventListener("click", () => {
		if (sprite !== undefined) {
			vscode.postMessage({ command: "editIdeaPicture", id: card.id, sprite });
		}
		if (modifiersChanged(card.edit?.modifiers ?? [], modifiers.rows)) {
			vscode.postMessage({
				command: "editIdeaModifiers",
				id: card.id,
				modifiers: modifiers.rows.map((row) => ({ key: row.key, value: row.value })),
			});
		}
		closeOverlay(overlay, host);
	});

	requestModifierKeys();
	activeDialog = host;
	modifiers.refresh();
}

/**
 * Opens the create dialog: a category, an idea key, then the same picture and modifier fields.
 */
export function openCreateIdeaDialog(categories: string[]): void {
	const { overlay, box } = makeModal(feLocalize("ideapreview.edit.newtitle", "New idea"));

	const categoryRow = fieldRow(box, feLocalize("ideapreview.edit.category", "Category"));
	const category = document.createElement("select");
	category.style.cssText = "width:100%;box-sizing:border-box;";
	for (const name of categories) {
		const option = document.createElement("option");
		option.value = name;
		option.textContent = name;
		category.appendChild(option);
	}
	categoryRow.appendChild(category);

	const idRow = fieldRow(box, feLocalize("ideapreview.edit.id", "Key"));
	const id = document.createElement("input");
	id.type = "text";
	id.style.cssText = "width:100%;box-sizing:border-box;";
	idRow.appendChild(id);

	let sprite: string | undefined;
	buildPictureRow(box, undefined, (picked) => {
		sprite = picked;
	});

	const modifiers = buildModifierSection(box, []);
	const host: DialogHost = {
		setModifierKeys: () => modifiers.refresh(),
		setResult: (ok) => resultNote(box, ok),
	};

	const error = document.createElement("div");
	error.style.cssText = "color:var(--vscode-errorForeground);font-size:11px;display:none;";
	box.appendChild(error);

	const buttons = document.createElement("div");
	buttons.style.cssText = "display:flex;justify-content:flex-end;gap:8px;margin-top:12px;";
	const cancel = makeDialogButton(feLocalize("focustree.cancel", "Cancel"));
	const ok = makeDialogButton(feLocalize("focustree.confirm", "Confirm"));
	buttons.appendChild(cancel);
	buttons.appendChild(ok);
	box.appendChild(buttons);

	cancel.addEventListener("click", () => closeOverlay(overlay, host));
	ok.addEventListener("click", () => {
		const ideaId = id.value.trim();
		if (ideaId === "" || category.value === "") {
			error.textContent = feLocalize("ideapreview.edit.needkey", "A key and a category are required.");
			error.style.display = "";
			return;
		}
		vscode.postMessage({
			command: "createIdea",
			category: category.value,
			id: ideaId,
			sprite,
			modifiers: modifiers.rows.map((row) => ({ key: row.key, value: row.value })),
		});
		closeOverlay(overlay, host);
	});

	requestModifierKeys();
	activeDialog = host;
	modifiers.refresh();
	id.focus();
}

// The picture and modifier writes are separate messages, so a dialog that changed nothing sends
// nothing and does not disturb the file.
function modifiersChanged(initial: { key: string; value: string }[], rows: ModifierRow[]): boolean {
	if (initial.length !== rows.length) {
		return true;
	}
	return rows.some((row, index) => initial[index].key !== row.key || initial[index].value !== row.value);
}
