import * as assert from 'assert';
import * as vscode from 'vscode';
import { loadStateFromContent } from '../previewdef/worldmap/loader/states';
import { editState } from '../previewdef/worldmap/editor/editstate';
import * as fileloader from '../util/fileloader';
import { EditStateMessage } from '../previewdef/worldmap/definitions';

// editState turns an EditStateMessage into WorkspaceEdit operations on the state's history file.
// These tests stub the document + WorkspaceEdit (same pattern as worldmapeditor.test.ts). Every
// fixture replays the recorded ops back onto the source text (replayText below) and asserts on
// the resulting file content, so duplicate-block or misplaced-insert regressions surface as
// structural failures instead of passing string-includes checks.
describe('previewdef/worldmap/editor editState', () => {
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

    function positionToOffset(source: string, pos: { line: number; character: number }): number {
        const lines = source.split('\n');
        let offset = 0;
        for (let i = 0; i < pos.line; i++) {
            offset += lines[i].length + 1;
        }
        return offset + pos.character;
    }

    // Applies recorded ops to the source text from the back so earlier offsets stay valid.
    function replayText(source: string, ops: { kind: string; text?: string; range?: any; pos?: any }[]): string {
        let text = source;
        const sorted = [...ops].sort((a, b) => {
            const offsetOf = (op: any) => op.kind === 'insert' ? positionToOffset(text, op.pos) : positionToOffset(text, op.range.start);
            return offsetOf(b) - offsetOf(a);
        });
        for (const op of sorted) {
            if (op.kind === 'insert') {
                const offset = positionToOffset(text, op.pos);
                text = text.substring(0, offset) + op.text + text.substring(offset);
            } else if (op.kind === 'delete') {
                const start = positionToOffset(text, op.range.start);
                const end = positionToOffset(text, op.range.end);
                text = text.substring(0, start) + text.substring(end);
            } else {
                const start = positionToOffset(text, op.range.start);
                const end = positionToOffset(text, op.range.end);
                text = text.substring(0, start) + op.text + text.substring(end);
            }
        }
        return text;
    }

    // WorkspaceEdit ops recorded through the stub class prototype patch in beforeEach.
    let ops: { kind: string; text?: string; range?: any; pos?: unknown }[] = [];

    const realGetFilePathFromMod = fileloader.getFilePathFromMod;
    const realOpenTextDocument = (vscode.workspace as any).openTextDocument;
    const realApplyEdit = (vscode.workspace as any).applyEdit;
    const realShowErrorMessage = (vscode.window as any).showErrorMessage;
    let errorMessages: string[] = [];

    beforeEach(() => {
        ops = [];
        // Route every WorkspaceEdit instance's mutations into the shared ops list.
        const WorkspaceEditStub = (vscode as any).WorkspaceEdit;
        if (WorkspaceEditStub) {
            WorkspaceEditStub.prototype.insert = function (_uri: unknown, pos: unknown, text: string) { ops.push({ kind: 'insert', pos, text }); };
            WorkspaceEditStub.prototype.delete = function (_uri: unknown, range: unknown) { ops.push({ kind: 'delete', range }); };
            WorkspaceEditStub.prototype.replace = function (_uri: unknown, range: unknown, text: string) { ops.push({ kind: 'replace', range, text }); };
        }
        errorMessages = [];
        (vscode.window as any).showErrorMessage = async (msg: string) => { errorMessages.push(msg); };
        // The stub uri must satisfy getHoiOpenedFileOriginalUri, which calls uri.with({fragment:''}).
        (fileloader as any).getFilePathFromMod = async (f: string) => ({
            toString: () => 'file:///mod/' + f,
            with: () => ({ toString: () => 'file:///mod/' + f }),
        });
    });

    afterEach(() => {
        (fileloader as any).getFilePathFromMod = realGetFilePathFromMod;
        (vscode.workspace as any).openTextDocument = realOpenTextDocument;
        (vscode.workspace as any).applyEdit = realApplyEdit;
        (vscode.window as any).showErrorMessage = realShowErrorMessage;
    });

    function stubOpenDocument(source: string) {
        (vscode.workspace as any).openTextDocument = async () => makeDocument(source);
    }

    function stubApplyEdit(ok: boolean) {
        (vscode.workspace as any).applyEdit = async () => ok;
    }

    function makeCache(source: string) {
        const states = loadStateFromContent(source, 'history/states/42.txt', []);
        assert.strictEqual(states.length, 1);
        return { states: [undefined, states[0]] } as any;
    }

    function makeMessage(overrides: Partial<EditStateMessage>): EditStateMessage {
        return {
            command: 'editstate',
            id: 1,
            file: 'history/states/42.txt',
            owner: 'GER',
            cores: ['GER'],
            claims: [],
            category: 'city',
            manpower: 1358394,
            infrastructure: undefined,
            civilianFactories: 3,
            militaryFactories: 1,
            resources: {},
            ...overrides,
        };
    }

    async function editAndReplay(source: string, overrides: Partial<EditStateMessage>) {
        stubOpenDocument(source);
        stubApplyEdit(true);
        const cache = makeCache(source);
        const messages = await editState(makeMessage(overrides), cache);
        assert.strictEqual(messages.length, 1, 'the edit must succeed');
        return { result: replayText(source, ops), cache };
    }

    const vanillaish = 'state = {\n\tid = 42\n\tname = "STATE_42"\n\tmanpower = 100\n\tstate_category = city\n\thistory = {\n\t\towner = GER\n\t\tadd_core_of = GER\n\t\tbuildings = {\n\t\t\tinfrastructure = 2\n\t\t\tindustrial_complex = 3\n\t\t\tarms_factory = 1\n\t\t}\n\t}\n\tresources = {\n\t\tsteel = 5\n\t}\n\tprovinces = { 1 2 }\n}\n';

    it('replaces owner, cores and category in place without structural changes', async () => {
        const { result } = await editAndReplay(vanillaish, { owner: 'SOV', cores: ['GER', 'SOV'], category: 'town' });
        assert.strictEqual((result.match(/history = \{/g) ?? []).length, 1, 'exactly one history block');
        assert.strictEqual((result.match(/buildings = \{/g) ?? []).length, 1, 'exactly one buildings block');
        assert.ok(result.includes('owner = SOV'));
        assert.ok(result.includes('add_core_of = GER\n\t\tadd_core_of = SOV'));
        assert.ok(result.includes('state_category = town'));
        assert.ok(result.includes('industrial_complex = 3'), 'untouched lines survive');
        assert.ok(result.includes('infrastructure = 2'), 'other building lines survive');
    });

    it('removes all core lines when the list is empty', async () => {
        const { result } = await editAndReplay(vanillaish, { cores: [] });
        assert.ok(!result.includes('add_core_of'), 'no core line may remain');
        assert.strictEqual((result.match(/history = \{/g) ?? []).length, 1);
        assert.ok(result.includes('owner = GER'), 'owner survives');
    });

    it('changes factory counts by replacing only the numbers, keeping comments and siblings', async () => {
        const source = 'state = {\n\tid = 42\n\thistory = {\n\t\towner = GER\n\t\tbuildings = {\n\t\t\tinfrastructure = 2 #keep\n\t\t\tindustrial_complex = 3 #was: 6\n\t\t\tarms_factory = 1\n\t\t}\n\t}\n\tprovinces = { 1 }\n}\n';
        const { result } = await editAndReplay(source, { civilianFactories: 9, militaryFactories: 4 });
        assert.strictEqual((result.match(/buildings = \{/g) ?? []).length, 1);
        assert.ok(result.includes('industrial_complex = 9 #was: 6'), 'value replaced, trailing comment kept');
        assert.ok(result.includes('arms_factory = 4'));
        assert.ok(result.includes('infrastructure = 2 #keep'));
    });

    it('replaces the infrastructure level in place without touching other buildings', async () => {
        const { result } = await editAndReplay(vanillaish, { infrastructure: 5, civilianFactories: undefined, militaryFactories: undefined });
        assert.strictEqual((result.match(/buildings = \{/g) ?? []).length, 1, 'exactly one buildings block');
        assert.ok(result.includes('infrastructure = 5'), 'infrastructure replaced in place');
        assert.strictEqual((result.match(/infrastructure/g) ?? []).length, 1);
        assert.ok(result.includes('industrial_complex = 3'), 'factory lines survive');
    });

    it('removes the infrastructure line when the level is 0 and clears the cached value', async () => {
        const { result, cache } = await editAndReplay(vanillaish, { infrastructure: 0, civilianFactories: undefined, militaryFactories: undefined });
        assert.strictEqual((result.match(/buildings = \{/g) ?? []).length, 1, 'exactly one buildings block');
        assert.ok(!result.includes('infrastructure'), 'the infrastructure line must be removed');
        assert.ok(result.includes('industrial_complex = 3'), 'factory lines survive');
        assert.strictEqual(cache.states[1].buildings['infrastructure'], undefined, 'the cached infrastructure must clear');
    });

    it('inserts an infrastructure line into an existing buildings block missing it', async () => {
        const source = 'state = {\n\tid = 42\n\thistory = {\n\t\towner = GER\n\t\tbuildings = {\n\t\t\tarms_factory = 2\n\t\t}\n\t}\n\tprovinces = { 1 }\n}\n';
        const { result } = await editAndReplay(source, { infrastructure: 3, civilianFactories: undefined, militaryFactories: undefined });
        assert.strictEqual((result.match(/buildings = \{/g) ?? []).length, 1, 'no duplicate buildings blocks');
        assert.ok(result.includes('infrastructure = 3'), 'the missing line must be inserted');
        assert.ok(result.includes('arms_factory = 2'), 'existing buildings survive');
    });

    it('creates one history and one buildings block when only the infrastructure level is set', async () => {
        const sparse = 'state = {\n\tid = 42\n\tprovinces = { 1 }\n}\n';
        const { result } = await editAndReplay(sparse, { owner: undefined, cores: [], claims: [], category: '', infrastructure: 1, civilianFactories: undefined, militaryFactories: undefined, resources: {} });
        assert.strictEqual((result.match(/history = \{/g) ?? []).length, 1, 'exactly one history block');
        assert.strictEqual((result.match(/buildings = \{/g) ?? []).length, 1, 'exactly one buildings block');
        assert.ok(result.includes('infrastructure = 1'));
    });

    it('keeps CRLF endings when adding factory lines to an existing buildings block', async () => {
        const source = 'state = {\r\n\tid = 42\r\n\thistory = {\r\n\t\towner = GER\r\n\t\tbuildings = {\r\n\t\t\tinfrastructure = 2\r\n\t\t}\r\n\t}\r\n\tprovinces = { 1 }\r\n}\r\n';
        const { result } = await editAndReplay(source, { civilianFactories: 3, militaryFactories: 1 });
        assert.strictEqual((result.match(/buildings = \{/g) ?? []).length, 1);
        // Inserted factory lines must use the document's CRLF ending: no bare \n may appear.
        const bareLf = (result.match(/(?<!\r)\n/g) ?? []).length;
        assert.strictEqual(bareLf, 0, 'no mixed line endings');
        assert.ok(result.includes('industrial_complex = 3'));
        assert.ok(result.includes('arms_factory = 1'));
    });

    it('creates exactly one history and one buildings block in a sparse state', async () => {
        const sparse = 'state = {\n\tid = 42\n\tprovinces = { 1 }\n}\n';
        const { result } = await editAndReplay(sparse, { owner: 'SOV', cores: ['SOV'], claims: ['POL'], category: 'wasteland', civilianFactories: 1, militaryFactories: 2, resources: { steel: 3 } });
        assert.strictEqual((result.match(/history = \{/g) ?? []).length, 1, 'no duplicate history blocks');
        assert.strictEqual((result.match(/buildings = \{/g) ?? []).length, 1, 'no duplicate buildings blocks');
        assert.strictEqual((result.match(/resources = \{/g) ?? []).length, 1, 'no duplicate resources blocks');
        assert.ok(result.includes('owner = SOV'));
        assert.ok(result.includes('add_core_of = SOV'));
        assert.ok(result.includes('add_claim_by = POL'));
        assert.ok(result.includes('industrial_complex = 1'));
        assert.ok(result.includes('arms_factory = 2'));
        assert.ok(result.includes('steel = 3'));
        assert.ok(result.includes('state_category = wasteland'));
    });

    it('adds one buildings block inside an existing history block without factories', async () => {
        const source = 'state = {\n\tid = 42\n\thistory = {\n\t\towner = GER\n\t\tadd_core_of = GER\n\t}\n\tprovinces = { 1 }\n}\n';
        const { result } = await editAndReplay(source, { civilianFactories: 2, militaryFactories: 5 });
        assert.strictEqual((result.match(/history = \{/g) ?? []).length, 1, 'no second history block');
        assert.strictEqual((result.match(/buildings = \{/g) ?? []).length, 1, 'no duplicate buildings blocks');
        assert.ok(result.includes('industrial_complex = 2'));
        assert.ok(result.includes('arms_factory = 5'));
        assert.ok(result.includes('owner = GER'), 'existing history lines survive');
    });

    // Regression for the duplicate-history-block report: history exists but has no owner line, so
    // the owner must land inside that block instead of a newly appended second history block.
    it('puts owner into an existing ownerless history block', async () => {
        const source = 'state = {\n\tid = 42\n\thistory = {\n\t\tadd_core_of = CUS\n\t}\n\tprovinces = { 1 }\n}\n';
        const { result } = await editAndReplay(source, { owner: 'CUS', cores: ['CUS'], claims: [], category: '', civilianFactories: undefined, militaryFactories: undefined, resources: {} });
        assert.strictEqual((result.match(/history = \{/g) ?? []).length, 1, 'exactly one history block');
        assert.ok(result.includes('owner = CUS'));
        assert.ok(result.includes('add_core_of = CUS'));
    });

    // Regression matching the screenshot: ownerless history + missing factories in one edit must
    // not emit duplicate blocks (old bug wrote buildings into the old block and again into a new one).
    it('creates no duplicate blocks when adding owner and factories to an ownerless history', async () => {
        const source = 'state = {\n\tid = 1217\n\tname = "STATE_1217"\n\tmanpower = 0\n\tstate_category = town\n\thistory = {\n\t\tadd_core_of = CUS\n\t}\n\tprovinces = { 689 691 }\n\tlocal_supplies = 0\n}\n';
        const { result } = await editAndReplay(source, { owner: 'CUS', cores: ['CUS'], claims: [], category: '', civilianFactories: 1, militaryFactories: 1, resources: {} });
        assert.strictEqual((result.match(/history = \{/g) ?? []).length, 1, 'exactly one history block, got:\n' + result);
        assert.strictEqual((result.match(/buildings = \{/g) ?? []).length, 1, 'exactly one buildings block');
        assert.ok(result.includes('owner = CUS'));
        assert.ok(result.includes('industrial_complex = 1'));
        assert.ok(result.includes('arms_factory = 1'));
        assert.ok(result.includes('add_core_of = CUS'));
    });

    it('leaves no stray blank line when a new buildings block is the only change (anchor-only edit)', async () => {
        const source = 'state={id=42 history={ owner=GER } provinces={ 1 } }\n';
        const { result } = await editAndReplay(source, { cores: [], claims: [], civilianFactories: 1, militaryFactories: undefined, resources: {}, category: '' });
        assert.strictEqual((result.match(/buildings = \{/g) ?? []).length, 1);
        assert.ok(!/\n[ \t]*\n[ \t]*\}/.test(result), 'no blank line before the state closing brace');
        assert.ok(result.includes('owner=GER') || result.includes('owner = GER'), 'existing content survives');
    });

    it('writes CRLF line endings into a CRLF document when creating blocks', async () => {
        const sparse = 'state = {\r\n\tid = 42\r\n\tprovinces = { 1 }\r\n}\r\n';
        const { result } = await editAndReplay(sparse, { owner: 'SOV', cores: ['SOV'], claims: [], category: 'city', civilianFactories: 1, militaryFactories: undefined, resources: { steel: 3 } });
        assert.strictEqual((result.match(/history = \{/g) ?? []).length, 1);
        // Every line ending in the result must be CRLF: no bare \n may appear.
        const bareLf = (result.match(/(?<!\r)\n/g) ?? []).length;
        assert.strictEqual(bareLf, 0, 'inserted lines must use the document CRLF ending');
        assert.ok(result.includes('owner = SOV'));
        assert.ok(result.includes('steel = 3'));
    });

    it('rewrites claims in a compact single-line file without breaking the line', async () => {
        const source = 'state={id=42 history={ owner=GER add_claim_by=POL } provinces={ 1 } }\n';
        const { result } = await editAndReplay(source, { cores: [], claims: ['GRE', 'ITA'], civilianFactories: undefined, militaryFactories: undefined, resources: {}, category: '' });
        assert.strictEqual((result.match(/add_claim_by/g) ?? []).length, 2, 'two claim lines after rewrite');
        assert.ok(result.includes('add_claim_by=GRE') || result.includes('add_claim_by = GRE'));
        assert.ok(result.includes('add_claim_by=ITA') || result.includes('add_claim_by = ITA'));
        assert.ok(!/\r/.test(result), 'no stray carriage returns in an LF file');
    });

    it('follows legacy numeric building keys when the file uses them', async () => {
        const source = 'state = {\n\tid = 42\n\thistory = {\n\t\towner = GER\n\t\tbuildings = {\n\t\t\t1 = 3\n\t\t}\n\t}\n\tprovinces = { 1 }\n}\n';
        const { result } = await editAndReplay(source, { civilianFactories: 8 });
        assert.strictEqual((result.match(/buildings = \{/g) ?? []).length, 1);
        assert.ok(result.includes('1 = 8'), 'the numeric key line is replaced in place');
        assert.ok(!result.includes('industrial_complex'), 'no named key is introduced');
    });

    it('handles single-line compact format blocks', async () => {
        const source = 'state={id=42 history={ owner=GER buildings={ industrial_complex=3 arms_factory=1 } } resources={ steel=5 } provinces={ 1 } }\n';
        stubOpenDocument(source);
        stubApplyEdit(true);
        const cache = makeCache(source);
        const messages = await editState(makeMessage({ owner: 'SOV', cores: [], claims: [], civilianFactories: 7, militaryFactories: undefined, resources: { steel: 0, oil: 2 }, category: 'city' }), cache);
        assert.strictEqual(messages.length, 1);
        const result = replayText(source, ops);
        assert.ok(result.includes('owner = SOV') || result.includes('owner=SOV'), 'owner updated');
        assert.ok(result.includes('industrial_complex = 7') || result.includes('industrial_complex=7'), 'civilian updated');
        assert.ok(result.includes('oil') && /[oO][iI][lL]\s*=\s*2|oil=2/.test(result), 'oil inserted');
        assert.ok(!/\bsteel\b\s*=\s*5/.test(result), 'steel line removed');
    });

    it('handles CRLF line endings when deleting lines', async () => {
        const source = 'state = {\r\n\tid = 42\r\n\thistory = {\r\n\t\towner = GER\r\n\t\tadd_core_of = GER\r\n\t}\r\n\tresources = {\r\n\t\tsteel = 5\r\n\t}\r\n\tprovinces = { 1 }\r\n}\r\n';
        const { result } = await editAndReplay(source, { cores: [], resources: { steel: 0 } });
        assert.ok(!result.includes('add_core_of'), 'core line removed');
        assert.ok(!result.includes('steel'), 'steel line removed');
        assert.ok(result.includes('owner = GER'), 'owner survives');
        assert.strictEqual((result.match(/history = \{/g) ?? []).length, 1);
        // No orphan \r left behind on the edited lines.
        assert.ok(!result.includes('\r\r'), 'no stray carriage returns');
    });

    it('replaces manpower value in place and keeps the rest of the line intact', async () => {
        const source = 'state = {\n\tid = 42\n\tmanpower = 1358394\n\tstate_category = city\n\thistory = {\n\t\towner = GER\n\t}\n\tprovinces = { 1 }\n}\n';
        const { result } = await editAndReplay(source, { manpower: 100 });
        assert.ok(result.includes('manpower = 100'), 'manpower must be replaced in place');
        assert.strictEqual((result.match(/manpower/g) ?? []).length, 1);
        assert.ok(result.includes('state_category = city'));
    });

    it('inserts a manpower line when the state has none and ignores negative targets', async () => {
        const sparse = 'state = {\n\tid = 42\n\tprovinces = { 1 }\n}\n';
        const { result } = await editAndReplay(sparse, { manpower: 5000 });
        assert.ok(result.includes('manpower = 5000'), 'missing manpower line must be inserted');

        stubOpenDocument(sparse);
        stubApplyEdit(true);
        ops = [];
        const cache = makeCache(sparse);
        const messages = await editState(makeMessage({ manpower: -5 }), cache);
        assert.strictEqual(messages.length, 1, 'the edit itself succeeds');
        assert.strictEqual(ops.filter(op => op.kind === 'insert' && op.text!.includes('manpower')).length, 0, 'negative manpower must be ignored');
    });

    it('replaces state_category value in place', async () => {
        const { result } = await editAndReplay(vanillaish, { category: 'town' });
        assert.ok(result.includes('state_category = town'));
        assert.strictEqual((result.match(/state_category/g) ?? []).length, 1);
    });

    it('returns no messages when the state id is unknown', async () => {
        const cache = { states: [undefined, undefined] } as any;
        const messages = await editState(makeMessage({ id: 5 }), cache);
        assert.strictEqual(messages.length, 0);
        assert.ok(errorMessages.length > 0, 'a missing state must surface an error');
    });

    it('applies nothing when applyEdit fails, leaving the cached state untouched', async () => {
        stubOpenDocument(vanillaish);
        stubApplyEdit(false);
        const cache = makeCache(vanillaish);
        const before = JSON.stringify(cache.states[1]);
        const messages = await editState(makeMessage({ owner: 'SOV' }), cache);
        assert.strictEqual(messages.length, 0);
        assert.strictEqual(JSON.stringify(cache.states[1]), before, 'cache must stay untouched on a failed apply');
        assert.ok(errorMessages.length > 0, 'an apply failure must be surfaced');
    });

    it('emits an incremental states message carrying the updated values', async () => {
        stubOpenDocument(vanillaish);
        stubApplyEdit(true);
        const cache = makeCache(vanillaish);
        const messages = await editState(makeMessage({ owner: 'SOV', cores: ['GER', 'SOV'], claims: ['POL'], category: 'town', manpower: 42, infrastructure: 4, civilianFactories: 9, militaryFactories: 0, resources: { steel: 0, oil: 2 } }), cache);
        assert.strictEqual(messages.length, 1);
        const msg = messages[0] as any;
        assert.strictEqual(msg.command, 'states');
        assert.strictEqual(msg.start, 1);
        assert.strictEqual(msg.end, 2);
        const state = JSON.parse(msg.data)[0];
        // The cached state keeps history values as value+condition entries, so the incremental
        // message carries the same shape the loader produces.
        assert.deepStrictEqual(state.owner, [{ value: 'SOV', condition: true }]);
        assert.deepStrictEqual(state.cores, [{ value: 'GER', condition: true }, { value: 'SOV', condition: true }]);
        assert.deepStrictEqual(state.claimBy, [{ value: 'POL', condition: true }]);
        assert.strictEqual(state.category, 'town');
        assert.strictEqual(state.manpower, 42);
        assert.strictEqual(state.buildings['infrastructure'], 4);
        assert.strictEqual(state.buildings['industrial_complex'], 9);
        assert.strictEqual(state.buildings['arms_factory'], undefined);
        assert.strictEqual(state.resources['steel'], undefined);
        assert.strictEqual(state.resources['oil'], 2);
    });
});
