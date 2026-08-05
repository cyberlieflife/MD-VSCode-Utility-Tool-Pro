import * as assert from 'assert';
import { parseHoi4File } from '../hoiformat/hoiparser';
import { convertFocusFileNodeToJson, getFocusTreeWithFocusFile } from '../previewdef/focustree/schema';
import {
    buildFocusMoveEdits, TextEditSpec, buildDeleteFocusEdits, findFocusTreeInsertPosition, buildFocusInsertBlock,
} from '../previewdef/focustree/move';

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

describe('previewdef/focustree/move delete & create', () => {
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

    const content = `focus_tree = {
	id = test
	focus = { id = focus_a x = 3 }
	focus = { id = focus_b x = 5 }
}
focus_tree = {
	id = second
	focus = { id = focus_c x = 9 }
}`;

    describe('buildDeleteFocusEdits', () => {
        it('deletes a whole focus block including its line', () => {
            const result = applyEdits(content, buildDeleteFocusEdits(content, ['focus_b']));
            assert.ok(!result.includes('focus_b'), result);
            assert.ok(!result.includes('x = 5'), result);
            assert.ok(result.includes('focus_a') && result.includes('focus_c'), result);
        });

        it('deletes nothing for an unknown id', () => {
            assert.deepStrictEqual(buildDeleteFocusEdits(content, ['nope']), []);
        });

        it('handles multiple ids and keeps order', () => {
            const edits = buildDeleteFocusEdits(content, ['focus_c', 'focus_a']);
            assert.strictEqual(edits.length, 2);
            const result = applyEdits(content, edits);
            assert.ok(!result.includes('focus_a') && !result.includes('focus_c'), result);
            assert.ok(result.includes('focus_b'), result);
        });
    });

    describe('findFocusTreeInsertPosition', () => {
        it('points just before the closing brace of the LAST focus_tree block', () => {
            const pos = findFocusTreeInsertPosition(content);
            assert.ok(pos !== undefined);
            // The position is the last `}` of the second focus_tree block.
            assert.strictEqual(content[pos!], '}');
            const inserted = content.slice(0, pos) + '\n\tfocus = { id = new_focus }\n' + content.slice(pos);
            const tree = convertFocusFileNodeToJson(parseHoi4File(inserted), {});
            assert.strictEqual(getFocusTreeWithFocusFile(tree, [], 't.txt', {})[1].focuses['new_focus'].id, 'new_focus');
        });

        it('returns undefined for text without a focus tree', () => {
            assert.strictEqual(findFocusTreeInsertPosition('nothing = { x = 1 }'), undefined);
        });
    });

    describe('buildFocusInsertBlock', () => {
        it('puts the name as a comment on the id line in the requested format', () => {
            const block = buildFocusInsertBlock({ id: 'NEW_FOCUS', name: 'New Focus' });
            assert.ok(block.includes('id = NEW_FOCUS    #New Focus'), block);
        });

        it('omits the comment when the name is empty', () => {
            const block = buildFocusInsertBlock({ id: 'NEW_FOCUS' });
            assert.ok(block.includes('id = NEW_FOCUS\n'), block);
            assert.ok(!block.includes('#'), block);
        });

        it('adds the description as a comment line and the icon line', () => {
            const block = buildFocusInsertBlock({ id: 'NEW_FOCUS', desc: 'A new focus', icon: 'GFX_goal_new' });
            assert.ok(block.includes('#A new focus'), block);
            assert.ok(block.includes('icon = GFX_goal_new'), block);
        });

        it('uses the given grid coordinates (default 0) and ends with a newline so the tree brace stays alone', () => {
            const block = buildFocusInsertBlock({ id: 'NEW_FOCUS', x: 7, y: -3 });
            assert.ok(block.includes('\tx = 7\n'), block);
            assert.ok(block.includes('\ty = -3\n'), block);
            assert.ok(block.endsWith('\t}\n'), 'block must end with a newline: ' + JSON.stringify(block.slice(-8)));
        });

        it('inserting the block before the tree closing brace never produces a doubled brace', () => {
            const text = 'focus_tree = {\n\tid = test\n\tfocus = { id = a x = 1 }\n}';
            const pos = findFocusTreeInsertPosition(text)!;
            const inserted = text.slice(0, pos) + buildFocusInsertBlock({ id: 'NEW' }) + text.slice(pos);
            assert.ok(!inserted.includes('}}\n'), inserted);
            assert.ok(inserted.includes('\t}\n}'), inserted);
        });
    });
});

