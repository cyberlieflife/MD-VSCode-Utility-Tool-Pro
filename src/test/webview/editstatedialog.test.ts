import './setup';
import * as assert from 'assert';
import { openEditStateDialog } from '../../../webviewsrc/worldmap/editstatedialog';

// The Edit state dialog: right-click menu entry opens openEditStateDialog(worldMap, state);
// Confirm must post a complete editstate message. The posted messages are captured by replacing
// the vscode module's postMessage (the dialog module reads it at call time through the imported
// binding, so the module-level export object is patched).
describe('webview/worldmap editstatedialog', () => {
    let posted: any[] = [];

    const worldMap = {
        stateCategories: ['city', 'town', 'wasteland'],
        stateCategoryNames: { city: '城镇地区', town: '发达乡村地区', wasteland: '荒漠' },
        stateCategorySlots: { city: 6, town: 4, wasteland: 0 },
        resources: [
            { name: 'steel', displayName: '钢材', file: '', },
            { name: 'oil', displayName: '石油', file: '', },
        ],
    } as any;

    const state = {
        id: 42,
        file: 'history/states/42.txt',
        owner: 'GER',
        cores: ['GER'],
        claims: ['POL'],
        category: 'city',
        manpower: 1358394,
        buildings: { infrastructure: 2, industrial_complex: 3, arms_factory: 1 },
        resources: { steel: 5 },
    } as any;

    const realVscode = require('../../../webviewsrc/util/vscode');

    beforeEach(() => {
        posted = [];
        (realVscode as any).vscode.postMessage = (msg: any) => { posted.push(msg); };
        document.body.innerHTML = '';
    });

    afterEach(() => {
        document.body.innerHTML = '';
    });

    function query(selector: string): HTMLElement {
        const el = document.querySelector(selector);
        assert.ok(el, 'expected element ' + selector);
        return el as HTMLElement;
    }

    function queryInput(labelText: string): HTMLInputElement {
        for (const lab of Array.from(document.querySelectorAll('label'))) {
            if (lab.textContent === labelText) {
                const input = lab.nextElementSibling as HTMLInputElement;
                assert.ok(input && input.tagName === 'INPUT', 'expected an input after the label ' + labelText);
                return input;
            }
        }
        // Resource rows use a span for the resource name instead of a label.
        for (const span of Array.from(document.querySelectorAll('span'))) {
            if (span.textContent === labelText) {
                const input = span.nextElementSibling as HTMLInputElement;
                assert.ok(input && input.tagName === 'INPUT', 'expected an input after the span ' + labelText);
                return input;
            }
        }
        throw new Error('label not found: ' + labelText);
    }

    it('builds the dialog with prefilled fields and posts the editstate message on confirm', () => {
        openEditStateDialog(worldMap, state);

        const overlay = query('.wm-editstate');
        assert.ok(overlay.textContent!.includes('42'), 'title must carry the state id');

        const owner = queryInput('Owner (tag)');
        assert.strictEqual(owner.value, 'GER');
        const cores = queryInput('Cores (space-separated tags)');
        assert.strictEqual(cores.value, 'GER');
        const claims = queryInput('Claimed by (space-separated tags)');
        assert.strictEqual(claims.value, 'POL');
        const manpower = queryInput('Manpower');
        assert.strictEqual(manpower.value, '1358394');
        const infrastructure = queryInput('Infrastructure');
        assert.strictEqual(infrastructure.value, '2');
        const civilian = queryInput('Civilian factories');
        assert.strictEqual(civilian.value, '3');
        const military = queryInput('Military factories');
        assert.strictEqual(military.value, '1');
        const steel = queryInput('钢材 (steel)');
        assert.strictEqual(steel.value, '5');
        const oil = queryInput('石油 (oil)');
        assert.strictEqual(oil.value, '0');

        owner.value = 'SOV';
        cores.value = 'GER SOV';
        claims.value = 'POL ITA';
        manpower.value = '999999';
        infrastructure.value = '4';
        civilian.value = '9';
        military.value = '0';
        steel.value = '0';
        oil.value = '2';

        const buttons = Array.from(overlay.querySelectorAll('button'));
        const confirm = buttons.find(b => b.textContent === 'Confirm');
        assert.ok(confirm, 'a Confirm button must exist');
        confirm!.click();

        assert.strictEqual(posted.length, 1);
        const msg = posted[0];
        assert.strictEqual(msg.command, 'editstate');
        assert.strictEqual(msg.id, 42);
        assert.strictEqual(msg.file, 'history/states/42.txt');
        assert.strictEqual(msg.owner, 'SOV');
        assert.deepStrictEqual(msg.cores, ['GER', 'SOV']);
        assert.deepStrictEqual(msg.claims, ['POL', 'ITA']);
        assert.strictEqual(msg.category, 'city');
        assert.strictEqual(msg.infrastructure, 4);
        assert.strictEqual(msg.civilianFactories, 9);
        assert.strictEqual(msg.manpower, 999999);
        assert.strictEqual(msg.militaryFactories, 0);
        assert.deepStrictEqual(msg.resources, { steel: 0, oil: 2 });

        // The dialog closes on confirm.
        assert.strictEqual(document.querySelector('.wm-editstate'), null);
    });

    it('selects the current category and sends the newly chosen one', () => {
        openEditStateDialog(worldMap, state);
        const overlay = query('.wm-editstate');
        const select = overlay.querySelector('select') as HTMLSelectElement;
        assert.ok(select, 'a category select must exist');
        assert.strictEqual(select.value, 'city');
        const options = Array.from(select.options).map(o => o.value);
        assert.deepStrictEqual(options, ['city', 'town', 'wasteland']);
        // Option labels show the localised name followed by the key written to the file,
        // plus the category's base building slots when the definition carries one.
        assert.strictEqual(select.options[0].textContent, '城镇地区 (city) — 6');
        assert.strictEqual(select.options[1].textContent, '发达乡村地区 (town) — 4');
        assert.strictEqual(select.options[2].textContent, '荒漠 (wasteland) — 0');
        select.value = 'town';

        const buttons = Array.from(overlay.querySelectorAll('button'));
        buttons.find(b => b.textContent === 'Confirm')!.click();
        assert.strictEqual(posted[0].category, 'town');
    });

    it('shows localised resource display names while sending the resource keys', () => {
        openEditStateDialog(worldMap, state);
        const steel = queryInput('钢材 (steel)');
        assert.strictEqual(steel.value, '5');
        const oil = queryInput('石油 (oil)');
        assert.strictEqual(oil.value, '0');
        oil.value = '2';

        const overlay = query('.wm-editstate');
        const buttons = Array.from(overlay.querySelectorAll('button'));
        buttons.find(b => b.textContent === 'Confirm')!.click();
        assert.deepStrictEqual(posted[0].resources, { steel: 5, oil: 2 }, 'the message must carry the resource keys, not the display names');
    });

    it('clamps the infrastructure level into the 0-5 range on confirm', () => {
        openEditStateDialog(worldMap, state);
        const infrastructure = queryInput('Infrastructure');
        infrastructure.value = '9';
        const overlay = query('.wm-editstate');
        const buttons = Array.from(overlay.querySelectorAll('button'));
        buttons.find(b => b.textContent === 'Confirm')!.click();
        assert.strictEqual(posted[0].infrastructure, 5, 'values above 5 must clamp down to 5');

        openEditStateDialog(worldMap, state);
        const infrastructureAgain = queryInput('Infrastructure');
        infrastructureAgain.value = '-3';
        const overlayAgain = query('.wm-editstate');
        const buttonsAgain = Array.from(overlayAgain.querySelectorAll('button'));
        buttonsAgain.find(b => b.textContent === 'Confirm')!.click();
        assert.strictEqual(posted[1].infrastructure, 0, 'negative values must clamp up to 0');
    });

    it('removes the owner when the field is blank', () => {
        openEditStateDialog(worldMap, state);
        const owner = queryInput('Owner (tag)');
        owner.value = '   ';
        const overlay = query('.wm-editstate');
        const buttons = Array.from(overlay.querySelectorAll('button'));
        buttons.find(b => b.textContent === 'Confirm')!.click();
        assert.strictEqual(posted[0].owner, undefined);
    });

    it('closes on cancel without posting', () => {
        openEditStateDialog(worldMap, state);
        const overlay = query('.wm-editstate');
        const buttons = Array.from(overlay.querySelectorAll('button'));
        buttons.find(b => b.textContent === 'Cancel')!.click();
        assert.strictEqual(document.querySelector('.wm-editstate'), null);
        assert.strictEqual(posted.length, 0);
    });
});
