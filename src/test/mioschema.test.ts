import * as assert from 'assert';
import { parseHoi4File } from '../hoiformat/hoiparser';
import { getMiosFromFile } from '../previewdef/mio/schema';

describe('previewdef/mio/schema trait link warnings', () => {
    function warningsOf(content: string) {
        const mios = getMiosFromFile(parseHoi4File(content), [], 'test.txt');
        return mios[0].warnings;
    }

    it('reports a parent that does not exist', () => {
        const warnings = warningsOf(`
            test_org = {
                trait = { token = b all_parents = { missing } }
            }
        `);
        assert.ok(warnings.some(w => w.text.includes('missing') && w.text.includes('does not exist')), warnings.map(w => w.text).join(' | '));
    });

    it('reports a parent block that asks for more parents than it lists', () => {
        const warnings = warningsOf(`
            test_org = {
                trait = { token = a }
                trait = { token = b parent = { traits = { a } num_parents_needed = 3 } }
            }
        `);
        assert.ok(warnings.some(w => w.text.includes('needs 3 parents') && w.text.includes('only 1')), warnings.map(w => w.text).join(' | '));
    });

    it('reports a parent that is not positioned above its dependent', () => {
        const warnings = warningsOf(`
            test_org = {
                trait = { token = a position = { x = 0 y = 2 } }
                trait = { token = b position = { x = 0 y = 0 } all_parents = { a } }
            }
        `);
        const warning = warnings.find(w => w.text.includes('is not positioned above'));
        assert.ok(warning, warnings.map(w => w.text).join(' | '));
        // 配对的两端都会被预览标出来。
        assert.deepStrictEqual(warning!.relatedSources, ['a']);
    });

    it('reports a mutually exclusive trait that does not exist', () => {
        const warnings = warningsOf(`
            test_org = {
                trait = { token = a mutually_exclusive = { missing } }
            }
        `);
        assert.ok(warnings.some(w => w.text.includes('Mutually exclusive trait missing')), warnings.map(w => w.text).join(' | '));
    });

    it('reports mutually exclusive traits on different rows', () => {
        const warnings = warningsOf(`
            test_org = {
                trait = { token = a position = { x = 0 y = 0 } mutually_exclusive = { b } }
                trait = { token = b position = { x = 2 y = 1 } }
            }
        `);
        assert.ok(warnings.some(w => w.text.includes('not on the same row')), warnings.map(w => w.text).join(' | '));
    });

    it('reports nothing for a well-placed parent and an exclusive pair', () => {
        const warnings = warningsOf(`
            test_org = {
                trait = { token = a position = { x = 0 y = 0 } mutually_exclusive = { b } }
                trait = { token = b position = { x = 2 y = 0 } }
                trait = { token = c position = { x = 0 y = 1 } all_parents = { a } }
            }
        `);
        assert.deepStrictEqual(warnings, []);
    });
});

describe('previewdef/mio/schema tree_header_text', () => {
    it('parses multiple tree_header_text blocks into textHeaders', () => {
        const input = `
            test_org = {
                name = test_org
                tree_header_text = {
                    text = test_org_first_header
                    x = 2
                }
                tree_header_text = {
                    text = test_org_second_header
                    x = 6
                }
                trait = {
                    token = test_org_trait
                    position = { x = 2 y = 0 }
                }
            }
        `;
        const mios = getMiosFromFile(parseHoi4File(input), [], 'test.txt');
        assert.strictEqual(mios.length, 1);
        assert.deepStrictEqual(mios[0].textHeaders, [
            { text: 'test_org_first_header', x: 2 },
            { text: 'test_org_second_header', x: 6 },
        ]);
    });

    it('yields an empty textHeaders array when the field is absent', () => {
        const input = `
            test_org = {
                name = test_org
                trait = {
                    token = test_org_trait
                    position = { x = 0 y = 0 }
                }
            }
        `;
        const mios = getMiosFromFile(parseHoi4File(input), [], 'test.txt');
        assert.strictEqual(mios.length, 1);
        assert.deepStrictEqual(mios[0].textHeaders, []);
    });

    it('defaults a missing x to 0 and skips a header with no text', () => {
        const input = `
            test_org = {
                name = test_org
                tree_header_text = {
                    text = test_org_header_no_x
                }
                tree_header_text = {
                    x = 4
                }
            }
        `;
        const mios = getMiosFromFile(parseHoi4File(input), [], 'test.txt');
        assert.deepStrictEqual(mios[0].textHeaders, [
            { text: 'test_org_header_no_x', x: 0 },
        ]);
    });
});
