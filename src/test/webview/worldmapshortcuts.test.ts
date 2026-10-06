import './setup';
import * as assert from 'assert';
import { editShortcutFor } from '../../../webviewsrc/worldmap/topbar';

// The world map's edit shortcuts (E edits, A adds, S links the state and strategic-region borders)
// are decided by editShortcutFor, which the keydown handler delegates to. The guards matter: a
// letter typed into the search box, or a chord such as Ctrl+E, must not fire a toolbar action.

function key(code: string, overrides: Partial<KeyboardEvent> = {}): Pick<KeyboardEvent, 'code' | 'ctrlKey' | 'metaKey' | 'altKey' | 'target'> {
    return { code, ctrlKey: false, metaKey: false, altKey: false, target: null, ...overrides };
}

function field(tagName: string): HTMLElement {
    return { tagName, isContentEditable: false } as unknown as HTMLElement;
}

describe('webview/worldmap edit shortcuts', () => {
    it('maps E, A and S to their actions', () => {
        assert.strictEqual(editShortcutFor(key('KeyE')), 'edit');
        assert.strictEqual(editShortcutFor(key('KeyA')), 'add');
        assert.strictEqual(editShortcutFor(key('KeyS')), 'link');
    });

    it('ignores keys that are not shortcuts', () => {
        assert.strictEqual(editShortcutFor(key('KeyQ')), undefined);
        assert.strictEqual(editShortcutFor(key('Escape')), undefined);
        assert.strictEqual(editShortcutFor(key('Enter')), undefined);
    });

    it('ignores a shortcut held with a modifier, so a browser chord is left alone', () => {
        assert.strictEqual(editShortcutFor(key('KeyE', { ctrlKey: true })), undefined);
        assert.strictEqual(editShortcutFor(key('KeyA', { metaKey: true })), undefined);
        assert.strictEqual(editShortcutFor(key('KeyS', { altKey: true })), undefined);
    });

    it('ignores a shortcut aimed at a field, so typing a letter does not fire it', () => {
        assert.strictEqual(editShortcutFor(key('KeyE', { target: field('INPUT') })), undefined);
        assert.strictEqual(editShortcutFor(key('KeyA', { target: field('SELECT') })), undefined);
        assert.strictEqual(editShortcutFor(key('KeyS', { target: field('TEXTAREA') })), undefined);
        assert.strictEqual(editShortcutFor(key('KeyE', { target: { tagName: 'DIV', isContentEditable: true } as unknown as HTMLElement })), undefined);
    });

    it('still fires a shortcut aimed at an ordinary element', () => {
        assert.strictEqual(editShortcutFor(key('KeyE', { target: field('DIV') })), 'edit');
    });
});
