import * as assert from 'assert';
import { parseHoi4File } from '../hoiformat/hoiparser';
import { convertFocusFileNodeToJson, getFocusTreeWithFocusFile } from '../previewdef/focustree/schema';
import { buildFocusMoveEdits, TextEditSpec } from '../previewdef/focustree/move';

// Coordinate token support: Focus.xToken/yToken must point at the exact source span of the x/y
// values so drag-move edits can be written back without re-parsing or text scanning.
describe('previewdef/focustree/schema coordinate tokens', () => {
    function parseFocusFile(content: string) {
        const file = convertFocusFileNodeToJson(parseHoi4File(content), {});
        return getFocusTreeWithFocusFile(file, [], 'test_tree.txt', {});
    }

    it('keeps x/y values and their exact source spans', () => {
        const content = `focus_tree = {
	id = test
	focus = { id = focus_a x = 3 y = 7 }
}`;
        const focus = parseFocusFile(content)[0].focuses['focus_a'];
        assert.strictEqual(focus.x, 3);
        assert.strictEqual(focus.y, 7);
        assert.strictEqual(content.slice(focus.xToken!.start, focus.xToken!.end), '3');
        assert.strictEqual(content.slice(focus.yToken!.start, focus.yToken!.end), '7');
    });

    it('defaults missing coordinates to 0 with no token', () => {
        const focus = parseFocusFile(`focus_tree = {
	id = test
	focus = { id = focus_b }
}`)[0].focuses['focus_b'];
        assert.strictEqual(focus.x, 0);
        assert.strictEqual(focus.y, 0);
        assert.strictEqual(focus.xToken, undefined);
        assert.strictEqual(focus.yToken, undefined);
    });

    it('keeps the x token when only one coordinate is written', () => {
        const content = `focus_tree = {
	id = test
	focus = { id = focus_c x = 5 }
}`;
        const focus = parseFocusFile(content)[0].focuses['focus_c'];
        assert.strictEqual(focus.x, 5);
        assert.strictEqual(focus.y, 0);
        assert.strictEqual(content.slice(focus.xToken!.start, focus.xToken!.end), '5');
        assert.strictEqual(focus.yToken, undefined);
    });
});

// Drag-move write-back: buildFocusMoveEdits must produce precise, applyable source edits.
describe('previewdef/focustree/move buildFocusMoveEdits', () => {
    function parseFocusFile(content: string) {
        const file = convertFocusFileNodeToJson(parseHoi4File(content), {});
        return getFocusTreeWithFocusFile(file, [], 'test_tree.txt', {});
    }

    // Applies edits the way a text editor would (position-ordered, insert before replace at the
    // same position) and returns the resulting text.
    function applyEdits(text: string, edits: TextEditSpec[]): string {
        const sorted = [...edits].sort((a, b) => a.start - b.start || a.end - b.end);
        let result = '';
        let pos = 0;
        for (const e of sorted) {
            result += text.slice(pos, e.start) + e.text;
            pos = e.end;
        }
        return result + text.slice(pos);
    }

    const treeWithXY = `focus_tree = {
	id = test
	focus = { id = focus_a x = 3 y = 7 }
}`;

    it('replaces existing x/y values in place', () => {
        const focus = parseFocusFile(treeWithXY)[0].focuses['focus_a'];
        const edits = buildFocusMoveEdits(treeWithXY, focus, 10, -2);
        assert.strictEqual(edits.length, 2);
        const result = applyEdits(treeWithXY, edits);
        assert.ok(result.includes('focus = { id = focus_a x = 10 y = -2 }'), result);
    });

    it('only edits the coordinate that changed', () => {
        const focus = parseFocusFile(treeWithXY)[0].focuses['focus_a'];
        const edits = buildFocusMoveEdits(treeWithXY, focus, 3, 8);
        assert.strictEqual(edits.length, 1);
        assert.strictEqual(treeWithXY.slice(edits[0].start, edits[0].end), '7');
        assert.strictEqual(edits[0].text, '8');
    });

    it('returns no edits when nothing changed', () => {
        const focus = parseFocusFile(treeWithXY)[0].focuses['focus_a'];
        assert.deepStrictEqual(buildFocusMoveEdits(treeWithXY, focus, 3, 7), []);
    });

    it('inserts missing coordinates as new lines after the focus block opening', () => {
        const content = `focus_tree = {
	id = test
	focus = {
		id = focus_b
	}
}`;
        const focus = parseFocusFile(content)[0].focuses['focus_b'];
        const edits = buildFocusMoveEdits(content, focus, 4, 5);
        assert.strictEqual(edits.length, 1);
        const result = applyEdits(content, edits);
        assert.ok(result.includes('focus = {\n\tx = 4\n\ty = 5\n\t\tid = focus_b'), result);
    });

    it('inserts only the missing y when x exists', () => {
        const content = `focus_tree = {
	id = test
	focus = {
		id = focus_c x = 5
	}
}`;
        const focus = parseFocusFile(content)[0].focuses['focus_c'];
        const edits = buildFocusMoveEdits(content, focus, 5, 9);
        assert.strictEqual(edits.length, 1);
        const result = applyEdits(content, edits);
        assert.ok(result.includes('focus = {\n\ty = 9\n\t\tid = focus_c x = 5'), result);
    });

    it('returns no edits for a single-line focus block without coordinates', () => {
        const singleLine = `focus_tree = { id = test focus = { id = focus_d } }`;
        const focus = parseFocusFile(singleLine)[0].focuses['focus_d'];
        assert.deepStrictEqual(buildFocusMoveEdits(singleLine, focus, 2, 2), []);
    });
});

