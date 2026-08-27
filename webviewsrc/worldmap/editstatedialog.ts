import { vscode } from "../util/vscode";
import { feLocalize } from "../util/i18n";
import { FEWorldMap } from "./loader";
import { State, WorldMapMessage } from "../../src/previewdef/worldmap/definitions";

// Modal "Edit state" dialog opened from the map's right-click menu. Mirrors the focus tree's
// create panel: inline-styled overlay + box so common.css's 20x20 toolbar button style does not
// crush the dialog buttons. The overlay covers the whole viewport and stops canvas interaction
// behind it while open.

let overlayEl: HTMLDivElement | null = null;

function closeDialog() {
    overlayEl?.remove();
    overlayEl = null;
}

// Dialog buttons: common.css styles bare <button> as a 20x20 toolbar icon button; give modal
// buttons explicit sizing instead.
function makeDialogButton(text: string): HTMLButtonElement {
    const b = document.createElement('button');
    b.textContent = text;
    b.style.cssText = 'width:auto;height:auto;min-width:72px;padding:4px 12px;white-space:nowrap;' +
        'background:var(--vscode-button-background);color:var(--vscode-button-foreground);' +
        'border:1px solid var(--vscode-button-border);border-radius:2px;cursor:pointer;transform:none;';
    return b;
}

function makeField(box: HTMLDivElement, label: string): HTMLInputElement {
    const row = document.createElement('div');
    row.style.cssText = 'margin-bottom:8px;';
    const lab = document.createElement('label');
    lab.style.cssText = 'display:block;margin-bottom:2px;';
    lab.textContent = label;
    const input = document.createElement('input');
    input.type = 'text';
    input.style.cssText = 'width:100%;box-sizing:border-box;';
    row.appendChild(lab);
    row.appendChild(input);
    box.appendChild(row);
    return input;
}

function makeNumberField(box: HTMLDivElement, label: string, value: number): HTMLInputElement {
    const input = makeField(box, label);
    input.type = 'number';
    input.step = '1';
    input.value = String(value);
    return input;
}

// Splits "GER ITA" into ['GER', 'ITA'], tolerating extra whitespace; duplicates are dropped so
// the write-back matches the loader's deduplicated read-out.
function parseTagList(value: string): string[] {
    return [...new Set(value.trim().length === 0 ? [] : value.trim().split(/\s+/))];
}

// Option text for a key with a localised display name: the translation first, the key always
// visible so the value that lands in the file stays recognizable.
function displayNameFor(names: Record<string, string>, key: string): string {
    const translated = names[key];
    return translated && translated !== key ? `${translated} (${key})` : key;
}

export function openEditStateDialog(worldMap: FEWorldMap, state: State) {
    closeDialog();
    const overlay = document.createElement('div');
    overlay.className = 'wm-editstate';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:3000;background:rgba(0,0,0,.4);' +
        'display:flex;align-items:center;justify-content:center;';
    const box = document.createElement('div');
    box.style.cssText = 'background:var(--vscode-editor-background);color:var(--vscode-editor-foreground);' +
        'border:1px solid var(--vscode-widget-border);padding:16px;min-width:380px;max-height:80vh;overflow-y:auto;';
    const title = document.createElement('div');
    title.style.cssText = 'font-weight:bold;margin-bottom:12px;';
    title.textContent = feLocalize('worldmap.edit.state.title', 'Edit state {0}', String(state.id));
    box.appendChild(title);

    const ownerInput = makeField(box, feLocalize('worldmap.edit.state.owner', 'Owner (tag)'));
    ownerInput.value = state.owner ?? '';
    const coresInput = makeField(box, feLocalize('worldmap.edit.state.cores', 'Cores (space-separated tags)'));
    coresInput.value = state.cores.join(' ');
    const claimsInput = makeField(box, feLocalize('worldmap.edit.state.claims', 'Claimed by (space-separated tags)'));
    claimsInput.value = (state.claims ?? []).join(' ');

    // Category as a dropdown fed by the parsed state_categories definitions; when the definitions
    // are unavailable the field is skipped and the file keeps its current category.
    let categorySelect: HTMLSelectElement | undefined = undefined;
    if (worldMap.stateCategories.length > 0) {
        const categoryRow = document.createElement('div');
        categoryRow.style.cssText = 'margin-bottom:8px;';
        const categoryLab = document.createElement('label');
        categoryLab.style.cssText = 'display:block;margin-bottom:2px;';
        categoryLab.textContent = feLocalize('worldmap.edit.state.category', 'Category');
        const select = document.createElement('select');
        select.style.cssText = 'width:100%;box-sizing:border-box;';
        const slots = worldMap.stateCategorySlots ?? {};
        for (const category of worldMap.stateCategories) {
            const option = document.createElement('option');
            option.value = category;
            const label = displayNameFor(worldMap.stateCategoryNames ?? {}, category);
            // Append the category's base building slots (e.g. "… — 12") when the definition
            // carries one, so the gameplay impact of a switch is visible at a glance.
            option.textContent = slots[category] !== undefined ? `${label} — ${slots[category]}` : label;
            if (category === state.category) {
                option.selected = true;
            }
            select.appendChild(option);
        }
        // The current file value may be undefined in the definitions list; keep it selectable.
        if (!worldMap.stateCategories.includes(state.category)) {
            const option = document.createElement('option');
            option.value = state.category;
            option.textContent = state.category;
            option.selected = true;
            select.appendChild(option);
        }
        categorySelect = select;
        categoryRow.appendChild(categoryLab);
        categoryRow.appendChild(select);
        box.appendChild(categoryRow);
    }

    const manpowerInput = makeNumberField(
        box,
        feLocalize('worldmap.edit.state.manpower', 'Manpower'),
        Math.max(0, state.manpower ?? 0));

    const buildings = state.buildings ?? {};
    const civilianInput = makeNumberField(
        box,
        feLocalize('worldmap.edit.state.civilianfactories', 'Civilian factories'),
        buildings['industrial_complex'] ?? buildings['1'] ?? 0);
    const militaryInput = makeNumberField(
        box,
        feLocalize('worldmap.edit.state.militaryfactories', 'Military factories'),
        buildings['arms_factory'] ?? buildings['4'] ?? 0);

    // One number field per defined resource type; blank counts as 0.
    const resourceInputs: { name: string; input: HTMLInputElement }[] = [];
    const resourcesBox = document.createElement('div');
    const resourcesLab = document.createElement('label');
    resourcesLab.style.cssText = 'display:block;margin-bottom:2px;';
    resourcesLab.textContent = feLocalize('worldmap.edit.state.resources', 'Resources');
    resourcesBox.appendChild(resourcesLab);
    const hint = document.createElement('div');
    hint.style.cssText = 'color:var(--vscode-descriptionForeground);font-size:11px;margin-bottom:6px;';
    hint.textContent = feLocalize('worldmap.edit.state.resourceshint', '0 removes the resource line from the file.');
    resourcesBox.appendChild(hint);
    for (const resource of worldMap.resources) {
        const current = state.resources[resource.name] ?? 0;
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:4px;';
        const nameSpan = document.createElement('span');
        nameSpan.style.cssText = 'flex:1;';
        nameSpan.textContent = resource.displayName && resource.displayName !== resource.name
            ? `${resource.displayName} (${resource.name})`
            : resource.name;
        const input = document.createElement('input');
        input.type = 'number';
        input.step = '1';
        input.min = '0';
        input.value = String(current);
        input.style.cssText = 'width:90px;';
        row.appendChild(nameSpan);
        row.appendChild(input);
        resourcesBox.appendChild(row);
        resourceInputs.push({ name: resource.name, input });
    }
    box.appendChild(resourcesBox);

    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;margin-top:12px;';
    const cancelBtn = makeDialogButton(feLocalize('worldmap.edit.state.cancel', 'Cancel'));
    const okBtn = makeDialogButton(feLocalize('worldmap.edit.state.confirm', 'Confirm'));
    btnRow.appendChild(cancelBtn);
    btnRow.appendChild(okBtn);
    box.appendChild(btnRow);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    overlayEl = overlay;
    ownerInput.focus();

    cancelBtn.addEventListener('click', closeDialog);
    okBtn.addEventListener('click', () => {
        const message: WorldMapMessage = {
            command: 'editstate',
            id: state.id,
            file: state.file,
            owner: ownerInput.value.trim() || undefined,
            cores: parseTagList(coresInput.value),
            claims: parseTagList(claimsInput.value),
            category: categorySelect ? categorySelect.value : state.category,
            manpower: Math.max(0, parseInt(manpowerInput.value, 10) || 0),
            civilianFactories: Math.max(0, parseInt(civilianInput.value, 10) || 0),
            militaryFactories: Math.max(0, parseInt(militaryInput.value, 10) || 0),
            resources: Object.fromEntries(resourceInputs.map(({ name, input }) => [name, Math.max(0, parseInt(input.value, 10) || 0)])),
        };
        closeDialog();
        vscode.postMessage(message);
    });
}
