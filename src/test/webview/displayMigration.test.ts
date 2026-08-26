import './setup';
import * as assert from 'assert';
import { mergeDisplayMigration } from '../../../webviewsrc/worldmap/topbar';

describe('webview/worldmap/topbar mergeDisplayMigration', () => {
    it('merges the new display options on the first load after an upgrade', () => {
        const result = mergeDisplayMigration(['edge', 'label'], false);
        assert.deepStrictEqual([...result].sort(), ['edge', 'factory', 'label', 'resource']);
    });

    it('keeps the saved selection verbatim after the migration has run', () => {
        const result = mergeDisplayMigration(['edge', 'label'], true);
        assert.deepStrictEqual(result, ['edge', 'label']);
    });

    it('adds only the missing new options when the user already enabled one of them', () => {
        const result = mergeDisplayMigration(['edge', 'resource'], false);
        assert.deepStrictEqual([...result].sort(), ['edge', 'factory', 'resource']);
    });

    it('does not duplicate options', () => {
        const result = mergeDisplayMigration(['resource', 'factory'], false);
        assert.deepStrictEqual(result, ['resource', 'factory']);
    });
});
