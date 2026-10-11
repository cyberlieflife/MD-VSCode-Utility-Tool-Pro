import './setup';
import * as assert from 'assert';
import {
	handleIdeaEditorMessage,
	openCreateIdeaDialog,
	openIdeaEditDialog,
} from '../../../webviewsrc/ideaeditdialog';

// The idea edit dialog: the picture row, the modifier list, and the two commands Confirm posts. The
// posted messages are captured by patching the vscode module's postMessage (the dialog reads it at
// call time through the imported binding).
describe('webview/idea edit dialog', () => {
	let posted: any[] = [];
	const realVscode = require('../../../webviewsrc/util/vscode');

	function card(overrides: any = {}): any {
		return {
			id: 'idea_one',
			category: 'country',
			name: { key: 'idea_one', text: 'Idea One' },
			desc: { key: 'idea_one_desc', text: 'idea_one_desc' },
			borrowsName: false,
			isDefault: false,
			isLaw: false,
			badges: [],
			modifiers: [],
			research: [],
			targeted: [],
			equipment: [],
			allowed: true,
			available: true,
			hasEffects: false,
			edit: { picture: 'GFX_idea_one', modifiers: [{ key: 'stability_factor', value: '0.1' }] },
			...overrides,
		};
	}

	beforeEach(() => {
		posted = [];
		(realVscode as any).vscode.postMessage = (msg: any) => { posted.push(msg); };
		document.body.innerHTML = '';
	});

	afterEach(() => {
		document.body.innerHTML = '';
	});

	function buttonIn(root: ParentNode, text: string): HTMLButtonElement {
		const button = [...root.querySelectorAll('button')].find((b) => b.textContent === text);
		assert.ok(button, `expected a "${text}" button, got: ` +
			JSON.stringify([...root.querySelectorAll('button')].map((b) => b.textContent)));
		return button as HTMLButtonElement;
	}

	function inputAfterLabel(text: string): HTMLInputElement {
		for (const label of Array.from(document.querySelectorAll('label'))) {
			if (label.textContent === text) {
				const input = label.nextElementSibling as HTMLInputElement;
				assert.ok(input && input.tagName === 'INPUT', 'expected an input after ' + text);
				return input;
			}
		}
		throw new Error('no input labelled ' + text);
	}

	const modifierRows = () => [...document.querySelectorAll('.idea-edit-modifier')] as HTMLElement[];

	it('shows the localised modifier name and posts the changed value', () => {
		openIdeaEditDialog(card());
		handleIdeaEditorMessage({
			type: 'ideaEditorData',
			modifiers: [{ key: 'stability_factor', name: 'Stability' }],
		});

		const rows = modifierRows();
		assert.strictEqual(rows.length, 1);
		assert.strictEqual(rows[0].querySelector('span')!.textContent, 'Stability');

		const value = rows[0].querySelector('input') as HTMLInputElement;
		value.value = '0.3';
		value.dispatchEvent(new Event('change', { bubbles: true }));

		buttonIn(document.body, 'Confirm').dispatchEvent(new MouseEvent('click', { bubbles: true }));

		assert.deepStrictEqual(
			posted.filter((m) => m.command === 'editIdeaModifiers'),
			[{ command: 'editIdeaModifiers', id: 'idea_one', modifiers: [{ key: 'stability_factor', value: '0.3' }] }],
		);
		// The picture was not touched, so no picture message goes out.
		assert.strictEqual(posted.filter((m) => m.command === 'editIdeaPicture').length, 0);
	});

	it('sends nothing when the dialog changed nothing', () => {
		openIdeaEditDialog(card());
		buttonIn(document.body, 'Confirm').dispatchEvent(new MouseEvent('click', { bubbles: true }));
		assert.strictEqual(
			posted.filter((m) => m.command === 'editIdeaModifiers' || m.command === 'editIdeaPicture').length,
			0,
		);
	});

	it('posts an empty modifier list when every row was removed', () => {
		openIdeaEditDialog(card());
		const remove = buttonIn(modifierRows()[0], 'Remove');
		remove.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		buttonIn(document.body, 'Confirm').dispatchEvent(new MouseEvent('click', { bubbles: true }));

		const message = posted.find((m) => m.command === 'editIdeaModifiers');
		assert.ok(message, 'a modifier message should be posted');
		assert.deepStrictEqual(message.modifiers, []);
	});

	it('adds a row chosen from the modifier picker', () => {
		handleIdeaEditorMessage({
			type: 'ideaEditorData',
			modifiers: [{ key: 'war_support_factor', name: 'War Support' }],
		});
		openIdeaEditDialog(card({ edit: { picture: undefined, modifiers: [] } }));
		assert.strictEqual(modifierRows().length, 0);

		buttonIn(document.body, 'Add modifier').dispatchEvent(new MouseEvent('click', { bubbles: true }));
		const option = document.querySelector('.idea-edit-modifier-option') as HTMLElement;
		assert.ok(option, 'the picker should list the known modifiers');
		option.dispatchEvent(new MouseEvent('click', { bubbles: true }));

		assert.strictEqual(modifierRows().length, 1);
		assert.strictEqual(modifierRows()[0].querySelector('span')!.textContent, 'War Support');
	});

	it('creates an idea with the picked category and key', () => {
		openCreateIdeaDialog(['country', 'laws']);
		inputAfterLabel('Key').value = 'my_idea';
		buttonIn(document.body, 'Confirm').dispatchEvent(new MouseEvent('click', { bubbles: true }));

		assert.deepStrictEqual(posted.find((m) => m.command === 'createIdea'), {
			command: 'createIdea',
			category: 'country',
			id: 'my_idea',
			sprite: undefined,
			modifiers: [],
		});
	});

	it('refuses to create an idea without a key', () => {
		openCreateIdeaDialog(['country']);
		buttonIn(document.body, 'Confirm').dispatchEvent(new MouseEvent('click', { bubbles: true }));
		assert.strictEqual(posted.filter((m) => m.command === 'createIdea').length, 0);
	});
});
