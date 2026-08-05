// Pure helpers for writing focus drag moves back into the focus file. Import-free on purpose so
// unit tests can exercise them without pulling in vscode.
import { Focus } from './schema';
import { parseHoi4File, Node } from '../../hoiformat/hoiparser';

export interface TextEditSpec {
    start: number;
    end: number;
    text: string;
}

// Builds the source edits that move `focus` to (newX, newY). Coordinates that exist in the file
// are replaced in place via their value tokens; missing ones are inserted as new lines right
// after the `focus = {` opening line. Returns an empty array when nothing changed or when a
// missing coordinate cannot be inserted (single-line focus blocks).
export function buildFocusMoveEdits(documentText: string, focus: Focus, newX: number, newY: number): TextEditSpec[] {
    const edits: TextEditSpec[] = [];
    if (focus.x !== newX && focus.xToken) {
        edits.push({ start: focus.xToken.start, end: focus.xToken.end, text: String(newX) });
    }
    if (focus.y !== newY && focus.yToken) {
        edits.push({ start: focus.yToken.start, end: focus.yToken.end, text: String(newY) });
    }

    const missingX = focus.x !== newX && !focus.xToken ? newX : undefined;
    const missingY = focus.y !== newY && !focus.yToken ? newY : undefined;
    if (missingX !== undefined || missingY !== undefined) {
        // Insert after the first line of the focus block (the `focus = {` line).
        const insertPos = findInsertPosition(documentText, focus);
        if (insertPos !== undefined) {
            let text = '';
            if (missingX !== undefined) { text += `\tx = ${missingX}\n`; }
            if (missingY !== undefined) { text += `\ty = ${missingY}\n`; }
            edits.push({ start: insertPos, end: insertPos, text });
        }
    }

    return edits;
}

function findInsertPosition(documentText: string, focus: Focus): number | undefined {
    if (focus.token === undefined) {
        return undefined;
    }
    // Locate the focus block's opening brace, then its first interior line break (the end of the
    // `focus = {` line). Single-line blocks have no line break before their closing brace and are
    // skipped (no safe line boundary to insert at).
    const brace = documentText.indexOf('{', focus.token.start);
    if (brace === -1) {
        return undefined;
    }
    const newline = documentText.indexOf('\n', brace);
    const closeBrace = documentText.indexOf('}', brace);
    if (newline === -1 || (closeBrace !== -1 && closeBrace < newline)) {
        return undefined;
    }
    return newline + 1;
}

// Visits every focus block (focus_tree/shared_focus/joint_focus contents) with its parsed id.
export function forEachFocusBlock(node: Node, cb: (focusNode: Node, id: string | undefined) => void): void {
    const visit = (n: Node): void => {
        if (n.name === 'focus' && Array.isArray(n.value)) {
            let id: string | undefined;
            for (const child of n.value) {
                if (child.name === 'id') {
                    // `id = focus_a` parses as a SymbolNode (bare identifier), `id = "focus_a"`
                    // as a plain string, and numeric ids like `id = 123` as a number; all must
                    // resolve to the same string the webview sends.
                    if (typeof child.value === 'string') {
                        id = child.value;
                    } else if (typeof child.value === 'number') {
                        id = String(child.value);
                    } else if (child.value && typeof child.value === 'object' && 'name' in child.value) {
                        const name = child.value.name;
                        id = typeof name === 'string' ? name : undefined;
                    }
                    break;
                }
            }
            cb(n, id);
            return;
        }
        if (Array.isArray(n.value)) {
            for (const child of n.value) {
                visit(child);
            }
        }
    };
    visit(node);
}

// Builds the source edits that delete the focus blocks with the given ids, each including its
// own line (leading indentation and trailing newline) so the file stays tidy. Order of the
// returned edits is source order.
export function buildDeleteFocusEdits(documentText: string, ids: string[]): TextEditSpec[] {
    const idSet = new Set(ids);
    const edits: TextEditSpec[] = [];
    const node = parseHoi4File(documentText, '');
    forEachFocusBlock(node, (focusNode, id) => {
        if (id === undefined || !idSet.has(id)) {
            return;
        }
        const start = focusNode.nameToken?.start;
        const end = focusNode.valueEndToken?.end;
        if (start === undefined || end === undefined) {
            return;
        }
        const lineStart = documentText.lastIndexOf('\n', start - 1) + 1;
        const lineEnd = documentText.indexOf('\n', end);
        const endPos = lineEnd === -1 ? documentText.length : lineEnd + 1;
        edits.push({ start: lineStart, end: endPos, text: '' });
    });
    return edits;
}

// Finds where a new focus block belongs: just before the closing brace of the LAST focus_tree
// block ("at the bottom of the file"). Returns undefined when the file has no focus tree.
export function findFocusTreeInsertPosition(documentText: string): number | undefined {
    let insertPos: number | undefined;
    const visit = (n: Node): void => {
        if (n.name === 'focus_tree' && Array.isArray(n.value) && n.valueEndToken) {
            insertPos = n.valueEndToken.start;
        }
        if (Array.isArray(n.value)) {
            for (const child of n.value) {
                visit(child);
            }
        }
    };
    visit(parseHoi4File(documentText, ''));
    return insertPos;
}

// Renders the new focus block. The name (and description) are comments only - no localisation
// entry is created - formatted as `id = XXX    #name` per the requested style; an empty name
// leaves the id line without a comment. x/y default to 0; cost (the focus duration in weeks,
// days = cost * 7) is written only when given, like icon. The block ends with a newline so the
// focus_tree closing brace stays on its own line after insertion.
export function buildFocusInsertBlock(focus: { id: string; name?: string; desc?: string; icon?: string; cost?: number; x?: number; y?: number }): string {
    const lines: string[] = [];
    lines.push('\tfocus = {');
    const idComment = focus.name ? `    #${focus.name}` : '';
    lines.push(`\t\tid = ${focus.id}${idComment}`);
    if (focus.desc) {
        lines.push(`\t\t#${focus.desc}`);
    }
    if (focus.icon) {
        lines.push(`\t\ticon = ${focus.icon}`);
    }
    if (focus.cost !== undefined) {
        lines.push(`\t\tcost = ${focus.cost}`);
    }
    lines.push(`\t\tx = ${focus.x ?? 0}`);
    lines.push(`\t\ty = ${focus.y ?? 0}`);
    lines.push('\t\tprerequisite = {');
    lines.push('\t\t}');
    lines.push('\t\tcompletion_reward = {');
    lines.push('\t\t}');
    lines.push('\t}');
    return lines.join('\n') + '\n';
}
