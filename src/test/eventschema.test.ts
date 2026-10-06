import * as assert from 'assert';
import { parseHoi4File } from '../hoiformat/hoiparser';
import { getEvents, HOIEvent } from '../previewdef/event/schema';

// `desc` is written three ways in real mods: a bare localisation key (a symbol), a quoted string,
// and a block that carries `text`. All three must land as a string, and an unrecognised shape must
// drop out rather than add an empty line to the card. `ai_chance` is kept as raw script text.

function firstEvent(content: string): HOIEvent {
    const events = getEvents(parseHoi4File(content), 'test.txt');
    const namespace = Object.values(events.eventItemsByNamespace)[0];
    assert.ok(namespace && namespace.length > 0, 'expected an event');
    return namespace[0];
}

describe('previewdef/event schema descriptions and AI chance', () => {
    it('reads a bare symbol, a quoted string and a text block as descriptions', () => {
        const event = firstEvent(`
            add_namespace = test
            country_event = {
                id = test.1
                desc = test.1.desc
                desc = "A plain description."
                desc = { text = test.1.desc_alt }
            }
        `);
        assert.deepStrictEqual(event.descriptions, ['test.1.desc', 'A plain description.', 'test.1.desc_alt']);
    });

    it('drops a description shape it cannot read instead of adding an empty line', () => {
        const event = firstEvent(`
            add_namespace = test
            country_event = {
                id = test.1
                desc = { unrelated = 1 }
            }
        `);
        assert.deepStrictEqual(event.descriptions, []);
    });

    it('keeps the option ai_chance block as raw script text', () => {
        const event = firstEvent(`
            add_namespace = test
            country_event = {
                id = test.1
                option = {
                    name = test.1.a
                    ai_chance = { base = 10 modifier = { factor = 2 has_war = yes } }
                }
            }
        `);
        assert.strictEqual(event.options.length, 1);
        assert.ok(event.options[0].aiChance, 'expected the ai_chance block');
        assert.ok(event.options[0].aiChance!.includes('base = 10'), 'the raw block text is kept');
    });

    it('leaves aiChance undefined when the option declares none', () => {
        const event = firstEvent(`
            add_namespace = test
            country_event = {
                id = test.1
                option = { name = test.1.a }
            }
        `);
        assert.strictEqual(event.options[0].aiChance, undefined);
    });
});
