import * as assert from 'assert';
import { parseHoi4File } from '../hoiformat/hoiparser';
import { convertFocusFileNodeToJson, getFocusTreeWithFocusFile } from '../previewdef/focustree/schema';

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
