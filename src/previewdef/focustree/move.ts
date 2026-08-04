// Pure helpers for writing focus drag moves back into the focus file. Import-free on purpose so
// unit tests can exercise them without pulling in vscode.
import { Focus } from './schema';

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
