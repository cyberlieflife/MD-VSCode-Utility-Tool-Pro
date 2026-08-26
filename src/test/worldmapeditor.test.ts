import * as assert from 'assert';
import * as vscode from 'vscode';
import { loadStateFromContent } from '../previewdef/worldmap/loader/states';
import { loadStrategicRegionFromContent } from '../previewdef/worldmap/loader/strategicregion';
import { setProvinces, moveProvince } from '../previewdef/worldmap/editor/moveprovince';
import * as fileloader from '../util/fileloader';

// The world map editor's province-rewrite logic (setProvinces in editor/moveprovince.ts) turns a
// HOI4 state/strategic region file plus a new province list into a set of precise WorkspaceEdit
// operations. These tests stub a TextDocument + WorkspaceEdit recorder and assert on the recorded
// insert/delete/replace operations (offsets converted to positions by the stub's positionAt).
describe('previewdef/worldmap/editor setProvinces', () => {
    // Minimal document stub: getText returns the given source, positionAt maps a character offset
    // to a { line, character } Position by scanning line breaks.
    function makeDocument(source: string) {
        return {
            uri: { toString: () => 'file:///test.txt' },
            getText: () => source,
            positionAt: (offset: number) => {
                const prefix = source.substring(0, offset);
                const line = prefix.split('\n').length - 1;
                const character = prefix.length - prefix.lastIndexOf('\n') - 1;
                return {
                    line,
                    character,
                    with: (change: { line?: number; character?: number }) => ({
                        line: change.line ?? line,
                        character: change.character ?? character,
                    }),
                };
            },
        };
    }

    function makeEditRecorder() {
        const ops: { kind: string; text?: string; range?: unknown; pos?: unknown }[] = [];
        return {
            ops,
            insert: (_uri: unknown, pos: unknown, text: string) => ops.push({ kind: 'insert', pos, text }),
            delete: (_uri: unknown, range: unknown) => ops.push({ kind: 'delete', range }),
            replace: (_uri: unknown, range: unknown, text: string) => ops.push({ kind: 'replace', range, text }),
        };
    }

    it('replaces a single provinces block with the sorted list', async () => {
        const source = 'state = {\n\tid = 1\n\tprovinces = {\n\t\t30 10 20\n\t}\n}\n';
        const edit = makeEditRecorder();
        const ok = await setProvinces(edit as any, 'state', 1, 'history/states/1.txt', makeDocument(source) as any, [20, 30, 10], undefined, null);
        assert.strictEqual(ok, true);
        const replace = edit.ops.find(op => op.kind === 'replace');
        assert.ok(replace, 'expected a replace on the provinces block');
        assert.ok(replace!.text!.includes('10 20 30'), 'provinces must be rewritten sorted');
    });

    it('inserts a provinces block when the state has none', async () => {
        const source = 'state = {\n\tid = 2\n}\n';
        const edit = makeEditRecorder();
        const ok = await setProvinces(edit as any, 'state', 2, 'history/states/2.txt', makeDocument(source) as any, [5, 6], undefined, null);
        assert.strictEqual(ok, true);
        const insert = edit.ops.find(op => op.kind === 'insert');
        assert.ok(insert, 'expected an insert for the missing provinces block');
        assert.ok(insert!.text!.includes('provinces = {'), 'inserted text must open a provinces block');
        assert.ok(insert!.text!.includes('5 6'), 'inserted text must contain the provinces');
    });

    it('deletes extra province blocks and rewrites the first one', async () => {
        const source = 'state = {\n\tid = 3\n\tprovinces = {\n\t\t1\n\t}\n\tprovinces = {\n\t\t2\n\t}\n}\n';
        const edit = makeEditRecorder();
        const ok = await setProvinces(edit as any, 'state', 3, 'history/states/3.txt', makeDocument(source) as any, [1, 2], undefined, null);
        assert.strictEqual(ok, true);
        const deletes = edit.ops.filter(op => op.kind === 'delete');
        assert.strictEqual(deletes.length, 1, 'the extra province block must be deleted');
        const replace = edit.ops.find(op => op.kind === 'replace');
        assert.ok(replace!.text!.includes('1 2'), 'first block must carry the merged sorted list');
    });

    it('works for strategic regions using the strategic_region root', async () => {
        const source = 'strategic_region = {\n\tid = 10\n\tprovinces = {\n\t\t100 200\n\t}\n}\n';
        const edit = makeEditRecorder();
        const ok = await setProvinces(edit as any, 'strategicregion', 10, 'map/strategicregions/10.txt', makeDocument(source) as any, [200, 100], undefined, null);
        assert.strictEqual(ok, true);
        const replace = edit.ops.find(op => op.kind === 'replace');
        assert.ok(replace!.text!.includes('100 200'), 'strategic region provinces must be rewritten sorted');
    });

    it('removes the victory point entry when the moving province carries one', async () => {
        const source = 'state = {\n\tid = 4\n\tprovinces = {\n\t\t7 8\n\t}\n\thistory = {\n\t\tvictory_points = { 7 10 }\n\t}\n}\n';
        const edit = makeEditRecorder();
        const ok = await setProvinces(edit as any, 'state', 4, 'history/states/4.txt', makeDocument(source) as any, [8], { province: 7, remove: true }, null);
        assert.strictEqual(ok, true);
        const vpDelete = edit.ops.find(op => op.kind === 'delete');
        assert.ok(vpDelete, 'removing the province must delete its victory_points entry');
    });

    it('adds a victory_points entry when the province keeps one in the target state', async () => {
        const source = 'state = {\n\tid = 5\n\tprovinces = {\n\t\t9\n\t}\n}\n';
        const edit = makeEditRecorder();
        const ok = await setProvinces(edit as any, 'state', 5, 'history/states/5.txt', makeDocument(source) as any, [9], { province: 9, remove: false, text: 'victory_points = { 9 10 }' }, null);
        assert.strictEqual(ok, true);
        const vpInsert = edit.ops.find(op => op.kind === 'insert' && op.text!.includes('victory_points'));
        assert.ok(vpInsert, 'adding the province with a VP must insert a history block');
        assert.ok(vpInsert!.text!.includes('victory_points = { 9 10 }'), 'inserted VP entry must carry the block text');
    });

    it('keeps the victory point when the target state has no provinces block yet', async () => {
        // Regression for the empty-provinces branch: inserting the provinces block must not skip
        // the VP handling, so a moved province carrying a VP keeps it in the target state.
        const source = 'state = {\n\tid = 5\n}\n';
        const edit = makeEditRecorder();
        const ok = await setProvinces(edit as any, 'state', 5, 'history/states/5.txt', makeDocument(source) as any, [9], { province: 9, remove: false, text: 'victory_points = { 9 10 }' }, null);
        assert.strictEqual(ok, true);
        const provinceInsert = edit.ops.find(op => op.kind === 'insert' && op.text!.includes('provinces = {'));
        assert.ok(provinceInsert, 'a provinces block must be inserted');
        const vpInsert = edit.ops.find(op => op.kind === 'insert' && op.text!.includes('victory_points'));
        assert.ok(vpInsert, 'the VP must still be written into a history block');
    });

    it('inserts a provinces block into a compact single-line state without corrupting it', async () => {
        const source = 'state = { id = 6 }\n';
        const edit = makeEditRecorder();
        const ok = await setProvinces(edit as any, 'state', 6, 'history/states/6.txt', makeDocument(source) as any, [1, 2], undefined, null);
        assert.strictEqual(ok, true);
        const insert = edit.ops.find(op => op.kind === 'insert');
        assert.ok(insert, 'expected an insert for the missing provinces block');
        assert.ok(insert!.text!.startsWith('\n'), 'compact single-line format must lead the block with a newline');
        assert.ok(insert!.text!.includes('provinces = {'), 'inserted text must open a provinces block');
        assert.ok(insert!.text!.includes('1 2'), 'inserted text must contain the provinces');
    });

    it('fails gracefully when the state id is missing', async () => {
        const source = 'state = {\n\tid = 99\n}\n';
        const edit = makeEditRecorder();
        const ok = await setProvinces(edit as any, 'state', 404, 'history/states/404.txt', makeDocument(source) as any, [1], undefined, null);
        assert.strictEqual(ok, false);
        assert.strictEqual(edit.ops.length, 0, 'no edits must be recorded on failure');
    });
});

describe('previewdef/worldmap/loader loadStateFromContent', () => {
    it('parses the add-state template into an empty province list', () => {
        const content = 'state = {\n\tid = 42\n\tname="STATE_42"\n\tmanpower = 0\n\tstate_category = wasteland\n\thistory = {\n\t}\n\tprovinces = {\n\t}\n\tlocal_supplies = 0\n}\n';
        const states = loadStateFromContent(content, 'history/states/42.txt', []);
        assert.strictEqual(states.length, 1);
        assert.strictEqual(states[0].id, 42);
        assert.deepStrictEqual(states[0].provinces, []);
        assert.strictEqual(states[0].file, 'history/states/42.txt');
    });

    it('extracts provinces and victory points from real content', () => {
        const content = 'state = {\n\tid = 7\n\tprovinces = { 10 20 }\n\thistory = {\n\t\tvictory_points = { 10 5 }\n\t}\n}\n';
        const states = loadStateFromContent(content, 'history/states/7.txt', []);
        assert.strictEqual(states[0].id, 7);
        assert.deepStrictEqual(states[0].provinces, [10, 20]);
        assert.strictEqual(states[0].victoryPoints[10], 5);
    });

    it('parses buildings with named keys (current HOI4 format)', () => {
        const content = 'state = {\n\tid = 42\n\tprovinces = { 1 }\n\thistory = {\n\t\tbuildings = {\n\t\t\tindustrial_complex = 2\n\t\t\tarms_factory = 3\n\t\t}\n\t}\n}\n';
        const states = loadStateFromContent(content, 'history/states/42.txt', []);
        assert.strictEqual(states.length, 1);
        assert.strictEqual(states[0].buildings['industrial_complex'], 2);
        assert.strictEqual(states[0].buildings['arms_factory'], 3);
    });

    it('parses buildings with numeric keys (legacy mod format)', () => {
        const content = 'state = {\n\tid = 42\n\tprovinces = { 1 }\n\thistory = {\n\t\tbuildings = {\n\t\t\t1 = 5\n\t\t\t4 = 4\n\t\t}\n\t}\n}\n';
        const states = loadStateFromContent(content, 'history/states/42.txt', []);
        assert.strictEqual(states.length, 1);
        assert.strictEqual(states[0].buildings['1'], 5);
        assert.strictEqual(states[0].buildings['4'], 4);
    });

    it('ignores provincial building objects without crashing', () => {
        const content = 'state = {\n\tid = 42\n\tprovinces = { 1 }\n\thistory = {\n\t\tbuildings = {\n\t\t\tindustrial_complex = 2\n\t\t\t3838 = {\n\t\t\t\tnaval_base = 3\n\t\t\t}\n\t\t}\n\t}\n}\n';
        const states = loadStateFromContent(content, 'history/states/42.txt', []);
        assert.strictEqual(states.length, 1);
        assert.strictEqual(states[0].buildings['industrial_complex'], 2);
        // Provincial building objects produce undefined values — they are ignored by the renderer.
        assert.strictEqual(states[0].buildings['3838'], undefined);
    });

    it('parses buildings from a vanilla-shaped state with owner, victory points and dockyard', () => {
        const content = 'state = {\n\tid = 171\n\tname = "STATE_171"\n\tmanpower = 2295085\n\tstate_category = city\n\thistory = {\n\t\towner = SPR\n\t\tvictory_points = {\n\t\t\t758 5\n\t\t}\n\t\tbuildings = {\n\t\t\tinfrastructure = 3\n\t\t\tdockyard = 2\n\t\t\tarms_factory = 1\n\t\t\tair_base = 2\n\t\t\t758 = {\n\t\t\t\tnaval_base = 6\n\t\t\t}\n\t\t}\n\t}\n\tprovinces = { 729 758 }\n}\n';
        const states = loadStateFromContent(content, 'history/states/171.txt', []);
        assert.strictEqual(states.length, 1);
        assert.strictEqual(states[0].owner, 'SPR');
        assert.strictEqual(states[0].victoryPoints[758], 5);
        assert.strictEqual(states[0].buildings['arms_factory'], 1);
        assert.strictEqual(states[0].buildings['dockyard'], 2);
        assert.strictEqual(states[0].buildings['758'], undefined);
    });

    it('produces empty buildings when the history block has none', () => {
        const content = 'state = {\n\tid = 42\n\tprovinces = { 1 }\n\thistory = {\n\t\towner = SPR\n\t}\n}\n';
        const states = loadStateFromContent(content, 'history/states/42.txt', []);
        assert.strictEqual(states.length, 1);
        assert.strictEqual(states[0].buildings['industrial_complex'], undefined);
        assert.strictEqual(states[0].buildings['1'], undefined);
    });
});

describe('previewdef/worldmap/loader loadStrategicRegionFromContent', () => {
    it('parses the add-strategic-region template', () => {
        const content = 'strategic_region = {\n\tid = 8\n\tname = "STRATEGICREGION_8"\n\tprovinces={\n\t}\n\tweather={\n\t}\n}\n';
        const regions = loadStrategicRegionFromContent(content, 'map/strategicregions/8.txt', []);
        assert.strictEqual(regions.length, 1);
        assert.strictEqual(regions[0].id, 8);
        assert.deepStrictEqual(regions[0].provinces, []);
        assert.strictEqual(regions[0].file, 'map/strategicregions/8.txt');
    });
});

// Transactional orchestration of moveProvince: the move is built on both sides before anything is
// committed, so a failed apply or a missing target must leave the cached arrays and the webview
// messages untouched. getFilePathFromMod is stubbed so the target file resolves into the "mod".
describe('previewdef/worldmap/editor moveProvince orchestration', () => {
    const realGetFilePathFromMod = fileloader.getFilePathFromMod;
    const realOpenTextDocument = (vscode.workspace as any).openTextDocument;
    const realApplyEdit = (vscode.workspace as any).applyEdit;
    const realShowErrorMessage = (vscode.window as any).showErrorMessage;
    let errorMessages: string[] = [];

    function makeDocument(source: string) {
        return {
            uri: { toString: () => 'file:///t.txt' },
            getText: () => source,
            positionAt: (offset: number) => {
                const prefix = source.substring(0, offset);
                const line = prefix.split('\n').length - 1;
                const character = prefix.length - prefix.lastIndexOf('\n') - 1;
                return {
                    line,
                    character,
                    with: (change: { line?: number; character?: number }) => ({
                        line: change.line ?? line,
                        character: change.character ?? character,
                    }),
                };
            },
        };
    }

    function makeWorldMap(states: unknown[]) {
        return {
            width: 0,
            height: 0,
            provinces: [],
            states,
            countries: [],
            strategicRegions: [],
            supplyAreas: [],
            railways: [],
            supplyNodes: [],
            provincesCount: 0,
            statesCount: states.length,
            countriesCount: 0,
            strategicRegionsCount: 0,
            supplyAreasCount: 0,
            railwaysCount: 0,
            supplyNodesCount: 0,
            badProvincesCount: 0,
            badStatesCount: 0,
            badStrategicRegionsCount: 0,
            badSupplyAreasCount: 0,
            continents: [],
            terrains: [],
            resources: [],
            rivers: [],
            warnings: [],
        };
    }

        beforeEach(() => {
        errorMessages = [];
        (vscode.window as any).showErrorMessage = async (msg: string) => { errorMessages.push(msg); };
        // The stub uri must satisfy getHoiOpenedFileOriginalUri, which calls uri.with({fragment:''}),
        // and differ per file so openTextDocument can route source vs target documents.
        (fileloader as any).getFilePathFromMod = async (f: string) => ({
            toString: () => 'file:///mod/' + f,
            with: () => ({ toString: () => 'file:///mod/' + f }),
        });
        // vscode.WorkspaceEdit comes from the stub (see _vscode_stub.ts); import * as vscode copies
        // the stub's own properties, so assignments there would not reach the source modules.
    });

    afterEach(() => {
        (fileloader as any).getFilePathFromMod = realGetFilePathFromMod;
        (vscode.workspace as any).openTextDocument = realOpenTextDocument;
        (vscode.workspace as any).applyEdit = realApplyEdit;
        (vscode.window as any).showErrorMessage = realShowErrorMessage;
    });

    it('rejects a move whose target region is missing from the cache', async () => {
        const states = [{ id: 1, provinces: [10], victoryPoints: {}, file: 'history/states/1.txt', token: null }];
        const worldMap = makeWorldMap(states);
        const msgs = await moveProvince(
            { command: 'moveprovince', type: 'state', province: 10, to: 99, from: 1, toFile: 'history/states/1.txt', fromFile: 'history/states/1.txt' },
            worldMap as any);
        assert.strictEqual(msgs.length, 0);
        assert.deepStrictEqual(states[0].provinces, [10], 'cache must stay unchanged');
        assert.ok(errorMessages.length > 0, 'a target-missing error must be surfaced');
    });

    it('keeps the cache and messages untouched when applyEdit reports failure', async () => {
        // The cached states array is indexed by state id (index 0 is unused).
        const states = [
            undefined,
            { id: 1, provinces: [10], victoryPoints: {}, file: 'history/states/1.txt', token: null },
            { id: 2, provinces: [20], victoryPoints: {}, file: 'history/states/2.txt', token: null },
        ];
        const worldMap = makeWorldMap(states);
        const source = 'state = {\n\tid = 1\n\tprovinces = {\n\t\t10\n\t}\n}\n';
        (vscode.workspace as any).openTextDocument = async () => makeDocument(source);
        (vscode.workspace as any).applyEdit = async () => false;
        const msgs = await moveProvince(
            { command: 'moveprovince', type: 'state', province: 10, to: 1, from: 1, toFile: 'history/states/1.txt', fromFile: 'history/states/1.txt' },
            worldMap as any);
        assert.strictEqual(msgs.length, 0, 'no webview messages on a failed apply');
        assert.deepStrictEqual(states[1]!.provinces, [10], 'cached provinces must stay unchanged');
        assert.ok(errorMessages.length > 0, 'an apply failure must be surfaced');
    });

    it('builds edits for both sides of a move and commits them together', async () => {
        // The cached states array is indexed by state id (index 0 is unused).
        const states = [
            undefined,
            { id: 1, provinces: [10], victoryPoints: {}, file: 'history/states/1.txt', token: null },
            { id: 2, provinces: [20], victoryPoints: {}, file: 'history/states/2.txt', token: null },
        ];
        const worldMap = makeWorldMap(states);
        const source1 = 'state = {\n\tid = 1\n\tprovinces = {\n\t\t10\n\t}\n}\n';
        const source2 = 'state = {\n\tid = 2\n\tprovinces = {\n\t\t20\n\t}\n}\n';
        (vscode.workspace as any).openTextDocument = async (uri: any) =>
            String(uri).includes('2.txt') ? makeDocument(source2) : makeDocument(source1);
        (vscode.workspace as any).applyEdit = async () => true;
        const msgs = await moveProvince(
            { command: 'moveprovince', type: 'state', province: 10, to: 2, from: 1, toFile: 'history/states/2.txt', fromFile: 'history/states/1.txt' },
            worldMap as any);
        assert.strictEqual(msgs.length, 2, 'both sides must produce webview messages');
        assert.deepStrictEqual(states[1]!.provinces, [], 'source region must lose the province');
        assert.deepStrictEqual(states[2]!.provinces, [10, 20], 'target region must gain the province (sorted by id)');
    });
});