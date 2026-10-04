import * as assert from 'assert';
import { parseHoi4File } from '../hoiformat/hoiparser';
import { convertFocusFileNodeToJson, getFocusTreeWithFocusFile, getGfxNameForSearchFilter, FocusTree, focusTreesToDisplay, importedPseudoTreesToShow } from '../previewdef/focustree/schema';
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

// 树选择器列出的树：有真正的 focus_tree 时只列它们，共享焦点在合并它的树里看。
describe('previewdef/focustree focusTreesToDisplay', () => {
    const own = { id: 'AAA_tree', isSharedFocues: false, focuses: { a: {} } } as unknown as FocusTree;
    const shared = { id: '<Shared focuses>', isSharedFocues: true, focuses: { sh: {} } } as unknown as FocusTree;
    const joint = { id: '<Joint focus tree> (x)', isSharedFocues: false, focuses: { j: {} } } as unknown as FocusTree;

    it('lists only the real trees when the file has one', () => {
        assert.deepStrictEqual(focusTreesToDisplay([own, shared]), [own]);
    });

    it('keeps the pseudo-trees of a file that has no real tree', () => {
        assert.deepStrictEqual(focusTreesToDisplay([shared]), [shared]);
        // 联合焦点树的 isSharedFocues 是 false，本身就属于"真正的树"，只有共享伪树被滤掉。
        assert.deepStrictEqual(focusTreesToDisplay([shared, joint]), [joint]);
    });

    it('leaves an empty list empty', () => {
        assert.deepStrictEqual(focusTreesToDisplay([]), []);
    });
});

// 依赖文件的伪树：已被本文件的树合并走的不再单独列出，否则只有一棵国策树的文件也会弹出选择器。
describe('previewdef/focustree importedPseudoTreesToShow', () => {
    function tree(id: string, isShared: boolean, focusIds: string[]): FocusTree {
        return {
            id,
            isSharedFocues: isShared,
            focuses: Object.fromEntries(focusIds.map(f => [f, {}])),
        } as unknown as FocusTree;
    }

    it('drops an imported shared tree whose focuses were merged into the file tree', () => {
        const host = tree('AAA_tree', false, ['AAA_start', 'sh_a1']);
        const donor = tree('<Shared focuses>', true, ['sh_a1', 'sh_a2']);
        assert.deepStrictEqual(importedPseudoTreesToShow([host], [donor]), []);
    });

    it('keeps an imported shared tree the file tree does not merge from', () => {
        const host = tree('AAA_tree', false, ['AAA_start']);
        const donor = tree('<Shared focuses>', true, ['sh_a1']);
        assert.deepStrictEqual(importedPseudoTreesToShow([host], [donor]), [donor]);
    });

    it('never re-lists a non-shared imported tree', () => {
        const host = tree('AAA_tree', false, ['AAA_start']);
        const foreign = tree('BBB_tree', false, ['BBB_start']);
        assert.deepStrictEqual(importedPseudoTreesToShow([host], [foreign]), []);
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