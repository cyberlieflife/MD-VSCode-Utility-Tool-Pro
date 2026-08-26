import * as assert from 'assert';
import { parseHoi4File } from '../hoiformat/hoiparser';
import { convertFocusFileNodeToJson, getFocusTreeWithFocusFile, getGfxNameForSearchFilter } from '../previewdef/focustree/schema';
import { sortConditionExprs, ConditionItem } from '../hoiformat/condition';

// The focus tree search filter (v0.17 feature): each focus may carry search_filters, the tree
// aggregates the distinct values, and the dropdown entries map to GFX_<filter> sprites.
describe('previewdef/focustree search filters', () => {
    function parse(content: string) {
        const file = convertFocusFileNodeToJson(parseHoi4File(content), {});
        return getFocusTreeWithFocusFile(file, [], 'tree.txt', {});
    }

    it('parses search_filters onto each focus', () => {
        const trees = parse(`focus_tree = {
    id = test
    focus = { id = a search_filters = { naval_warfare } }
    focus = { id = b search_filters = { naval_warfare army } }
}`);
        const tree = trees[0];
        assert.deepStrictEqual(tree.focuses['a'].searchFilters, ['naval_warfare']);
        assert.deepStrictEqual(tree.focuses['b'].searchFilters, ['naval_warfare', 'army']);
    });

    it('aggregates the distinct filter values across the tree', () => {
        const trees = parse(`focus_tree = {
    id = test
    focus = { id = a search_filters = { naval_warfare } }
    focus = { id = b search_filters = { army naval_warfare } }
}`);
        assert.deepStrictEqual([...trees[0].searchFilters].sort(), ['army', 'naval_warfare']);
    });

    it('keeps trees without filters empty', () => {
        const trees = parse(`focus_tree = {
    id = test
    focus = { id = a }
}`);
        assert.deepStrictEqual(trees[0].searchFilters, []);
    });

    it('maps a filter to its GFX sprite name', () => {
        assert.strictEqual(getGfxNameForSearchFilter('naval_warfare'), 'GFX_naval_warfare');
    });
});

describe('hoiformat/condition sortConditionExprs', () => {
    it('sorts condition items by encoded value', () => {
        const exprs: ConditionItem[] = [
            { scopeName: '', nodeContent: 'has_completed_focus = b' },
            { scopeName: '', nodeContent: 'has_completed_focus = a' },
            { scopeName: 'GER', nodeContent: 'has_war = true' },
        ];
        sortConditionExprs(exprs);
        assert.deepStrictEqual(exprs.map(e => e.nodeContent), ['has_completed_focus = a', 'has_completed_focus = b', 'has_war = true']);
    });
});