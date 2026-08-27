import * as vscode from 'vscode';
import { localize } from '../../../util/i18n';
import { copyFilesIntoWorkspace } from '../../../util/previewfileopener';
import { EditStateMessage, WorldMapData, WorldMapMessage } from '../definitions';
import { parseHoi4File, Node, Token } from '../../../hoiformat/hoiparser';

// State attribute editing: rewrites owner / cores / claims / state_category / civilian and
// military factory counts / resource amounts in the state's history file. The write-back
// re-parses the current document (never the load-time snapshot), locates every field through the
// original token tree, and builds the whole WorkspaceEdit before applying it, so a failure in any
// field leaves the file untouched.

interface StateNodes {
    stateNode: Node;
    historyNode: Node | undefined;
}

export async function editState(msg: EditStateMessage, cachedWorldMap: WorldMapData): Promise<WorldMapMessage[]> {
    const result: WorldMapMessage[] = [];
    const state = cachedWorldMap.states[msg.id];
    if (!state) {
        await vscode.window.showErrorMessage(localize('worldmap.edit.state.failed.notfoundstate', 'The state {0} does not exist in the world map data. Please reload the world map and try again.', msg.id));
        return result;
    }

    const [uri] = await copyFilesIntoWorkspace([msg.file], {
        mustOpenFolderMessage: localize('worldmap.mustopenafolder.edit', 'Must open a folder before editing {0} file.', localize('worldmap.openfiletype.state', 'state')),
        selectFolderMessage: localize('worldmap.selectafolder', 'Select a folder to copy {0} file', localize('worldmap.openfiletype.state', 'state')),
        failedToOpenMessage: (errorMessage) => localize('worldmap.failedtoopenstate', 'Failed to open {0} file: {1}.', localize('worldmap.openfiletype.state', 'state'), errorMessage),
    });
    if (!uri) {
        return result;
    }

    const document = await vscode.workspace.openTextDocument(uri);
    const text = document.getText();
    const root = parseHoi4File(text, localize('infile', 'In file {0}:\n', msg.file));
    const stateNode = findChild(root, 'state');
    if (!stateNode) {
        await vscode.window.showErrorMessage(localize('worldmap.edit.state.failed.notfoundstate', 'The state {0} does not exist in the world map data. Please reload the world map and try again.', msg.id));
        return result;
    }

    const nodes: StateNodes = { stateNode, historyNode: findChild(stateNode, 'history') };
    const workspaceEdit = new vscode.WorkspaceEdit();
    // Lines destined for a history/buildings/resources block that the file does not have yet are
    // collected in these buffers instead of each field editor creating its own block; after all
    // field editors ran, a single summary step emits at most one block per buffer. Without this,
    // two fields both missing the same block would each insert a duplicate of it.
    const context: EditContext = {
        document,
        workspaceEdit,
        text,
        indent: detectIndent(text),
        eol: text.includes('\r\n') ? '\r\n' : '\n',
        pendingHistoryLines: [],
        pendingBuildingsLines: [],
        pendingBuildingsAnchor: undefined,
        pendingResourceLines: [],
    };

    // Every field edit either schedules its changes into workspaceEdit or reports failure; any
    // failure aborts the whole edit before applyEdit, leaving no partial writes behind.
    const builders: (() => boolean)[] = [
        () => applyOwner(context, nodes, msg.owner),
        () => applyTagLines(context, nodes, 'add_core_of', msg.cores),
        () => applyTagLines(context, nodes, 'add_claim_by', msg.claims),
        () => applyCategory(context, nodes, msg.category),
        () => applyManpower(context, nodes, msg.manpower),
        () => applyBuildingCount(context, nodes, 'civilian', msg.civilianFactories),
        () => applyBuildingCount(context, nodes, 'military', msg.militaryFactories),
        () => applyResourceCounts(context, nodes, msg.resources),
    ];
    if (!builders.every(build => build())) {
        return result;
    }

    // Emit the collected pending blocks (at most one per block, in vanilla's typical order).
    if (!commitPendingBlocks(context, nodes)) {
        return result;
    }

    const applied = await vscode.workspace.applyEdit(workspaceEdit);
    if (applied === false) {
        await vscode.window.showErrorMessage(localize('worldmap.edit.failed.apply', 'The change could not be applied. The file may have changed on disk. Please try again.'));
        return result;
    }

    // Commit the cached state only after the edit is on disk, mirroring moveProvince.
    state.owner = msg.owner;
    state.cores = msg.cores;
    state.claims = msg.claims;
    state.category = msg.category;
    if (msg.manpower !== undefined) {
        state.manpower = msg.manpower;
    }
    if (!state.buildings) {
        state.buildings = {};
    }
    if (msg.civilianFactories !== undefined) {
        state.buildings[buildingKey(state.buildings, 'civilian')] = msg.civilianFactories === 0 ? undefined : msg.civilianFactories;
    }
    if (msg.militaryFactories !== undefined) {
        state.buildings[buildingKey(state.buildings, 'military')] = msg.militaryFactories === 0 ? undefined : msg.militaryFactories;
    }
    for (const key in msg.resources) {
        state.resources[key] = msg.resources[key] === 0 ? undefined : msg.resources[key];
    }
    result.push({ command: 'states', data: JSON.stringify([state]), start: msg.id, end: msg.id + 1 });

    return result;
}

interface EditContext {
    document: vscode.TextDocument;
    workspaceEdit: vscode.WorkspaceEdit;
    text: string;
    indent: string;
    // Line ending detected from the document so inserted lines match the file's existing style.
    eol: string;
    // Body lines (already indented, each ending with the document EOL) for blocks the file lacks;
    // flushed by commitPendingBlocks after every field editor has run. pendingBuildingsAnchor
    // records the existing history node a new buildings block must be inserted into (history
    // present, buildings missing); when undefined a pending buildings block nests into the new
    // history.
    pendingHistoryLines: string[];
    pendingBuildingsLines: string[];
    pendingBuildingsAnchor: Node | undefined;
    pendingResourceLines: string[];
}

// --- token-tree helpers -----------------------------------------------------

function findChild(node: Node, name: string): Node | undefined {
    if (!Array.isArray(node.value)) {
        return undefined;
    }
    return node.value.find(child => child.name === name);
}

function findChildren(node: Node, name: string): Node[] {
    if (!Array.isArray(node.value)) {
        return [];
    }
    return node.value.filter(child => child.name === name);
}

// Offset of the first character of the line containing `offset`.
function lineStart(text: string, offset: number): number {
    return text.lastIndexOf('\n', offset - 1) + 1;
}

// Offset just past the line's newline (or end of text for the last line).
function lineEndInclusive(text: string, offset: number): number {
    const end = text.indexOf('\n', offset);
    return end === -1 ? text.length : end + 1;
}

function replaceRange(context: EditContext, start: number, end: number, newText: string) {
    context.workspaceEdit.replace(context.document.uri, new vscode.Range(context.document.positionAt(start), context.document.positionAt(end)), newText);
}

function deleteRange(context: EditContext, start: number, end: number) {
    context.workspaceEdit.delete(context.document.uri, new vscode.Range(context.document.positionAt(start), context.document.positionAt(end)));
}

function deleteWholeLine(context: EditContext, token: Token) {
    deleteRange(context, lineStart(context.text, token.start), lineEndInclusive(context.text, token.end));
}

// Removes a `key = value` field without touching its line's other content: when the field shares
// its line with the rest of a compact-format block, only the field's own text plus following
// whitespace goes away; on a standard line the whole (otherwise empty) line is removed. Returns
// false instead of throwing when the parser tokens are missing, so the caller's boolean contract
// ("any field failure aborts the whole edit") holds for every failure shape.
function deleteField(context: EditContext, field: Node): boolean {
    const startToken = field.nameToken ?? field.valueStartToken;
    const endToken = field.valueEndToken;
    // Both tokens are always present: parseHoi4File keeps tokens by default and every caller
    // checks valueStartToken/valueEndToken before reaching here. If a parser change ever breaks
    // that premise, report failure rather than deleting a wrong range.
    if (!startToken || !endToken) {
        return false;
    }
    const text = context.text;
    const lineStartOffset = lineStart(text, startToken.start);
    const lineEndOffset = lineEndInclusive(text, endToken.end);
    const lineContent = text.substring(lineStartOffset, lineEndOffset).trim();
    if (lineContent !== text.substring(startToken.start, endToken.end).trim()) {
        // Other content shares the line (compact format): drop just the field and the whitespace
        // right after it so the remaining tokens stay on one line.
        let end = endToken.end;
        while (end < text.length && (text.charAt(end) === ' ' || text.charAt(end) === '\t')) {
            end++;
        }
        deleteRange(context, startToken.start, end);
        return true;
    }
    deleteWholeLine(context, startToken);
    return true;
}

function insertAt(context: EditContext, offset: number, newText: string) {
    context.workspaceEdit.insert(context.document.uri, context.document.positionAt(offset), newText);
}

function detectIndent(text: string): string {
    // Counts leading-space and leading-tab prefixes line by line and picks the most common one.
    const counts: Record<string, number> = {};
    for (const line of text.split('\n')) {
        let spaces = 0;
        while (line.charAt(spaces) === ' ') {
            spaces++;
        }
        let tabs = 0;
        while (line.charAt(tabs) === '\t') {
            tabs++;
        }
        const indent = spaces > 0 ? ' '.repeat(spaces) : '\t'.repeat(tabs);
        if (indent.length > 0) {
            counts[indent] = (counts[indent] ?? 0) + 1;
        }
    }

    let best = '\t';
    let bestCount = 0;
    for (const indent of Object.keys(counts)) {
        if (counts[indent] > bestCount) {
            best = indent;
            bestCount = counts[indent];
        }
    }

    return best;
}

// Insertion point before a block's closing brace, following the file's brace placement: at the
// start of the brace's own line for standard formatting, right before the brace (with a leading
// newline) for single-line compact format.
function blockEndInsertion(context: EditContext, block: Node): { offset: number; prefix: string } | undefined {
    const valueEndOffset = block.valueEndToken?.start;
    if (valueEndOffset === undefined) {
        return undefined;
    }
    const lineBeforeBrace = context.text.substring(lineStart(context.text, valueEndOffset), valueEndOffset);
    const compactFormat = lineBeforeBrace.trim() !== '';
    return {
        offset: compactFormat ? valueEndOffset : lineStart(context.text, valueEndOffset),
        prefix: compactFormat ? context.eol : '',
    };
}

// --- field editors ----------------------------------------------------------

// owner lives inside history as `owner = TAG`. An empty target removes the line; when the line is
// missing it is inserted into the existing history block, or deferred to the shared
// pending-history buffer when the whole block is absent (created once at the end).
function applyOwner(context: EditContext, nodes: StateNodes, target: string | undefined): boolean {
    const existing = nodes.historyNode ? findChild(nodes.historyNode, 'owner') : undefined;

    if (!target) {
        if (!existing?.valueEndToken) {
            return true;
        }
        return deleteField(context, existing);
    }

    if (existing) {
        if (!existing.valueStartToken || !existing.valueEndToken) {
            return false;
        }
        replaceRange(context, existing.valueStartToken.start, existing.valueEndToken.end, target);
        return true;
    }

    if (nodes.historyNode) {
        // History exists but carries no owner line: insert into that block, mirroring
        // applyTagLines, instead of routing through the pending buffer, which appends a second
        // top-level history block to the file.
        const insertion = blockEndInsertion(context, nodes.historyNode);
        if (!insertion) {
            return false;
        }
        insertAt(context, insertion.offset, insertion.prefix + context.indent + context.indent + 'owner = ' + target + context.eol);
        return true;
    }

    context.pendingHistoryLines.push(context.indent + context.indent + 'owner = ' + target + context.eol);
    return true;
}

// add_core_of / add_claim_by: one TAG per line, multiple entries are repeated lines. Rebuilds the
// whole group: existing lines are deleted and the requested tags are inserted in their place.
function applyTagLines(context: EditContext, nodes: StateNodes, key: 'add_core_of' | 'add_claim_by', tags: string[]): boolean {
    const renderLines = () => tags.map(tag => context.indent + context.indent + key + ' = ' + tag + context.eol).join('');

    if (!nodes.historyNode) {
        if (tags.length === 0) {
            return true;
        }
        context.pendingHistoryLines.push(...tags.map(tag => context.indent + context.indent + key + ' = ' + tag + context.eol));
        return true;
    }

    const existing = findChildren(nodes.historyNode, key);
    if (existing.length === 0) {
        if (tags.length === 0) {
            return true;
        }
        const insertion = blockEndInsertion(context, nodes.historyNode);
        if (!insertion) {
            return false;
        }
        insertAt(context, insertion.offset, insertion.prefix + renderLines());
        return true;
    }

    for (const line of existing) {
        if (!line.valueEndToken) {
            return false;
        }
    }

    // Delete every existing line, then put the new lines at the position of the first one.
    const firstStart = lineStart(context.text, existing[0].nameToken?.start ?? existing[0].valueEndToken!.start);
    for (const line of existing) {
        if (!deleteField(context, line)) {
            return false;
        }
    }

    if (tags.length > 0) {
        insertAt(context, firstStart, renderLines());
    }
    return true;
}

const civilianBuildingKeys = ['industrial_complex', '1'];
const militaryBuildingKeys = ['arms_factory', '4'];

// Picks the spelling already used by the file so a legacy mod keeps its numeric keys and a
// current file keeps the building names; defaults to the current name.
function buildingKey(buildings: Record<string, unknown>, kind: 'civilian' | 'military'): string {
    const keys = kind === 'civilian' ? civilianBuildingKeys : militaryBuildingKeys;
    return keys.find(key => key in buildings) ?? keys[0];
}

// Sets (or removes) one factory count inside the history buildings block. When the file has no
// buildings block the line goes to the shared pending buffer so both factory counts share one
// newly created block.
function applyBuildingCount(context: EditContext, nodes: StateNodes, kind: 'civilian' | 'military', target: number | undefined): boolean {
    if (target === undefined) {
        return true;
    }

    const name = kind === 'civilian' ? 'industrial_complex' : 'arms_factory';
    const legacyName = kind === 'civilian' ? '1' : '4';
    const buildingsNode = nodes.historyNode ? findChild(nodes.historyNode, 'buildings') : undefined;
    const existing = buildingsNode ? (findChild(buildingsNode, name) ?? findChild(buildingsNode, legacyName)) : undefined;
    const spelling = existing ? existing.name! : name;

    if (existing) {
        if (!existing.valueStartToken || !existing.valueEndToken) {
            return false;
        }
        if (target > 0) {
            // Replace only the number: a trailing comment (e.g. `#was: 6`) survives.
            replaceRange(context, existing.valueStartToken.start, existing.valueEndToken.end, String(target));
            return true;
        }
        return deleteField(context, existing);
    }

    if (target === 0) {
        return true;
    }

    if (!buildingsNode) {
        if (nodes.historyNode) {
            // History exists: create exactly one buildings block inside it. Both factory counts
            // hit this branch, so the second call must not create a second block — mark the
            // history node so later calls append into the same block insertion.
            context.pendingBuildingsLines.push(context.indent + context.indent + context.indent + spelling + ' = ' + target + context.eol);
            if (!context.pendingBuildingsAnchor) {
                context.pendingBuildingsAnchor = nodes.historyNode;
            }
            return true;
        }
        // Neither history nor buildings exists: defer to the pending buffers; commitPendingBlocks
        // nests the buildings block inside the single new history block.
        context.pendingBuildingsLines.push(context.indent + context.indent + context.indent + spelling + ' = ' + target + context.eol);
        return true;
    }

    const insertion = blockEndInsertion(context, buildingsNode);
    if (!insertion) {
        return false;
    }
    insertAt(context, insertion.offset, insertion.prefix + context.indent + context.indent + spelling + ' = ' + target + context.eol);
    return true;
}

// resources sit at the state's top level as `resources = { steel = 5 ... }`. Only keys sent in
// the message are touched; 0 removes the line.
function applyResourceCounts(context: EditContext, nodes: StateNodes, targets: Record<string, number>): boolean {
    const keys = Object.keys(targets);
    if (keys.length === 0) {
        return true;
    }

    const resourcesNode = findChild(nodes.stateNode, 'resources');
    const missingPositive: string[] = [];
    for (const key of keys) {
        const existing = resourcesNode ? findChild(resourcesNode, key) : undefined;
        if (existing) {
            if (!existing.valueStartToken || !existing.valueEndToken) {
                return false;
            }
            if (targets[key] > 0) {
                replaceRange(context, existing.valueStartToken.start, existing.valueEndToken.end, String(targets[key]));
            } else if (!deleteField(context, existing)) {
                return false;
            }
        } else if (targets[key] > 0) {
            missingPositive.push(key);
        }
    }

    if (missingPositive.length === 0) {
        return true;
    }

    if (!resourcesNode) {
        context.pendingResourceLines.push(...missingPositive.map(key => context.indent + context.indent + key + ' = ' + targets[key] + context.eol));
        return true;
    }

    const insertion = blockEndInsertion(context, resourcesNode);
    if (!insertion) {
        return false;
    }
    insertAt(context, insertion.offset, insertion.prefix + missingPositive.map(key => context.indent + context.indent + key + ' = ' + targets[key] + context.eol).join(''));
    return true;
}

// state_category sits at the state's top level; the dialog always sends a non-empty category.
function applyCategory(context: EditContext, nodes: StateNodes, target: string): boolean {
    if (!target) {
        return true;
    }

    const existing = findChild(nodes.stateNode, 'state_category');
    if (existing) {
        if (!existing.valueStartToken || !existing.valueEndToken) {
            return false;
        }
        replaceRange(context, existing.valueStartToken.start, existing.valueEndToken.end, target);
        return true;
    }

    const insertion = blockEndInsertion(context, nodes.stateNode);
    if (!insertion) {
        return false;
    }
    insertAt(context, insertion.offset, insertion.prefix + context.indent + 'state_category = ' + target + context.eol);
    return true;
}

// manpower sits at the state's top level as a plain number. Undefined or negative targets are
// ignored (the field is left untouched); 0 is a legal value and replaces/inserts normally.
function applyManpower(context: EditContext, nodes: StateNodes, target: number | undefined): boolean {
    if (target === undefined || target < 0) {
        return true;
    }

    const existing = findChild(nodes.stateNode, 'manpower');
    if (existing) {
        if (!existing.valueStartToken || !existing.valueEndToken) {
            return false;
        }
        replaceRange(context, existing.valueStartToken.start, existing.valueEndToken.end, String(target));
        return true;
    }

    const insertion = blockEndInsertion(context, nodes.stateNode);
    if (!insertion) {
        return false;
    }
    insertAt(context, insertion.offset, insertion.prefix + context.indent + 'manpower = ' + target + context.eol);
    return true;
}

// --- block summary ----------------------------------------------------------

// Emits at most one new block per pending buffer. When history exists but its buildings block
// does not (pendingBuildingsAnchor), the new buildings block is inserted into that history node
// directly; otherwise a pending buildings block nests inside a newly created history block.
function commitPendingBlocks(context: EditContext, nodes: StateNodes): boolean {
    if (context.pendingBuildingsLines.length === 0 && context.pendingHistoryLines.length === 0 && context.pendingResourceLines.length === 0) {
        return true;
    }

    // The single insertion anchor at the end of the state block, shared by every new top-level
    // block so multiple pending blocks cannot land at different positions.
    const stateInsertion = blockEndInsertion(context, nodes.stateNode);
    if (!stateInsertion) {
        return false;
    }

    const parts: string[] = [];
    if (context.pendingHistoryLines.length > 0 || (context.pendingBuildingsLines.length > 0 && !context.pendingBuildingsAnchor)) {
        parts.push(context.indent + 'history = {' + context.eol);
        parts.push(...context.pendingHistoryLines);
        // An anchored buildings edit is emitted below into its existing history block; nesting it
        // here as well would write a second buildings block into the file.
        if (context.pendingBuildingsLines.length > 0 && !context.pendingBuildingsAnchor) {
            parts.push(context.indent + context.indent + 'buildings = {' + context.eol);
            parts.push(...context.pendingBuildingsLines);
            parts.push(context.indent + context.indent + '}' + context.eol);
        }
        parts.push(context.indent + '}' + context.eol);
    }
    if (context.pendingResourceLines.length > 0) {
        parts.push(context.indent + 'resources = {' + context.eol);
        parts.push(...context.pendingResourceLines);
        parts.push(context.indent + '}' + context.eol);
    }

    // An anchor-only edit (new buildings block inside an existing history block) has no top-level
    // parts: inserting an empty prefix would add a stray newline before the state's brace.
    if (parts.length > 0) {
        insertAt(context, stateInsertion.offset, stateInsertion.prefix + parts.join(''));
    }

    if (context.pendingBuildingsLines.length > 0 && context.pendingBuildingsAnchor) {
        const insertion = blockEndInsertion(context, context.pendingBuildingsAnchor);
        if (!insertion) {
            return false;
        }
        const body = context.indent + context.indent + 'buildings = {' + context.eol
            + context.pendingBuildingsLines.join('')
            + context.indent + context.indent + '}' + context.eol;
        insertAt(context, insertion.offset, insertion.prefix + body);
    }
    return true;
}
