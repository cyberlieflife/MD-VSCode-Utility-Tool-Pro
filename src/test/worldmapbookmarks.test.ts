import * as assert from 'assert';
import { loadStateFromContent } from '../previewdef/worldmap/loader/states';
import { Bookmark, BookmarkDate } from '../previewdef/worldmap/definitions';
import { applyCondition } from '../hoiformat/condition';
import { bookmarkDateToString, compareBookmarkDate, toBookmarkDate } from '../previewdef/worldmap/loader/bookmarks';

// The bookmark loader turns `common/bookmarks` dates into conditions on a state's dated history
// blocks; these tests pin the date helpers and the conditional history resolution.
describe('previewdef/worldmap/loader bookmarks', () => {
    function bookmark(date: string): Bookmark {
        return { name: date, date: toBookmarkDate(date) };
    }

    it('parses a bookmark date with all four fields', () => {
        assert.deepStrictEqual(toBookmarkDate('1936.1.1.12'), { year: 1936, month: 1, day: 1, hour: 12 });
    });

    it('defaults missing date fields to zero', () => {
        assert.deepStrictEqual(toBookmarkDate('1936.1.1'), { year: 1936, month: 1, day: 1, hour: 0 });
    });

    it('orders dates by year, month, day then hour', () => {
        const dates: BookmarkDate[] = ['1939.1.1.0', '1936.6.1.0', '1936.1.2.0', '1936.1.1.6', '1936.1.1.0'].map(toBookmarkDate);
        const sorted = [...dates].sort(compareBookmarkDate).map(bookmarkDateToString);
        assert.deepStrictEqual(sorted, ['1936.1.1.0', '1936.1.1.6', '1936.1.2.0', '1936.6.1.0', '1939.1.1.0']);
    });

    it('keeps every dated entry as a value + condition pair', () => {
        const content = 'state = {\n\tid = 42\n\tprovinces = { 1 }\n\thistory = {\n\t\t1936.1.1 = { owner = GER }\n\t\t1939.1.1 = { owner = SOV }\n\t}\n}\n';
        const states = loadStateFromContent(content, 'history/states/42.txt', [], [bookmark('1936.1.1.0'), bookmark('1939.1.1.0')]);

        assert.strictEqual(states.length, 1);
        // Newest first: the 1939 entry is tried before the 1936 one.
        assert.deepStrictEqual(states[0].owner.map(o => o.value), ['SOV', 'GER']);
    });

    it('selects the owner matching the selected bookmark date', () => {
        const content = 'state = {\n\tid = 42\n\tprovinces = { 1 }\n\thistory = {\n\t\t1936.1.1 = { owner = GER }\n\t\t1939.1.1 = { owner = SOV }\n\t}\n}\n';
        const bookmarks = [bookmark('1936.1.1.0'), bookmark('1939.1.1.0')];
        const states = loadStateFromContent(content, 'history/states/42.txt', [], bookmarks);
        const owner = states[0].owner;

        const at1936 = [{ scopeName: '', nodeContent: bookmarkDateToString(bookmarks[0].date) }];
        assert.strictEqual(owner.find(o => applyCondition(o.condition, at1936))?.value, 'GER');

        const at1939 = [{ scopeName: '', nodeContent: bookmarkDateToString(bookmarks[1].date) }];
        assert.strictEqual(owner.find(o => applyCondition(o.condition, at1939))?.value, 'SOV');
    });

    it('keeps undated history unconditional when no bookmark is defined', () => {
        const content = 'state = {\n\tid = 42\n\tprovinces = { 1 }\n\thistory = {\n\t\towner = GER\n\t}\n}\n';
        const states = loadStateFromContent(content, 'history/states/42.txt', [], []);

        assert.deepStrictEqual(states[0].owner.map(o => o.value), ['GER']);
        assert.deepStrictEqual(states[0].owner.map(o => o.condition), [true]);
    });

    it('reports no owner when the history is only dated and no bookmark exists to pick one', () => {
        // Without bookmarks there is no date to select, so a purely dated history has no current
        // value; the game always ships bookmarks, this only pins the degenerate case.
        const content = 'state = {\n\tid = 42\n\tprovinces = { 1 }\n\thistory = {\n\t\t1936.1.1 = { owner = GER }\n\t}\n}\n';
        const states = loadStateFromContent(content, 'history/states/42.txt', [], []);

        assert.deepStrictEqual(states[0].owner, []);
    });

    it('applies remove_core_of so the tag stops being a core from that date on', () => {
        const content = 'state = {\n\tid = 42\n\tprovinces = { 1 }\n\thistory = {\n\t\t1936.1.1 = { add_core_of = GER }\n\t\t1939.1.1 = { remove_core_of = GER }\n\t}\n}\n';
        const bookmarks = [bookmark('1936.1.1.0'), bookmark('1939.1.1.0')];
        const states = loadStateFromContent(content, 'history/states/42.txt', [], bookmarks);
        const core = states[0].cores.find(c => c.value === 'GER');

        assert.ok(core, 'GER should be listed as a core at some point');
        const at1936 = [{ scopeName: '', nodeContent: bookmarkDateToString(bookmarks[0].date) }];
        const at1939 = [{ scopeName: '', nodeContent: bookmarkDateToString(bookmarks[1].date) }];
        assert.strictEqual(applyCondition(core.condition, at1936), true);
        assert.strictEqual(applyCondition(core.condition, at1939), false);
    });
});
