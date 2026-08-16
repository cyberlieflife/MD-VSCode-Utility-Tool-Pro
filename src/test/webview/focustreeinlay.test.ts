import './setup';
import * as assert from 'assert';
import { substituteInlaySlots } from '../../../webviewsrc/inlayslots';

// Reference implementation replicating the original per-slot split/join reduction.
function referenceSubstitute(template: string, slotClasses: Record<string, string>): string {
    let content = template;
    for (const id in slotClasses) {
        content = content.split(`{{inlay_slot_class:${id}}}`).join(slotClasses[id]);
    }
    return content;
}

describe('webview/focustree/substituteInlaySlots', function () {
    it('replaces each known placeholder with its resolved class', function () {
        const template = 'a{{inlay_slot_class:iconA}}b{{inlay_slot_class:iconB}}c';
        assert.strictEqual(
            substituteInlaySlots(template, { iconA: 'st-inlay-gfx-a', iconB: 'st-inlay-gfx-b' }),
            'ast-inlay-gfx-abst-inlay-gfx-bc',
        );
    });

    it('replaces repeated occurrences of the same slot', function () {
        const template = '{{inlay_slot_class:x}}/{{inlay_slot_class:x}}';
        assert.strictEqual(substituteInlaySlots(template, { x: 'cls' }), 'cls/cls');
    });

    it('substitutes an empty class for a slot with no active option', function () {
        const template = '{{inlay_slot_class:x}}';
        assert.strictEqual(substituteInlaySlots(template, { x: '' }), '');
    });

    it('leaves placeholders without a known slot verbatim', function () {
        const template = '{{inlay_slot_class:unknown}}';
        assert.strictEqual(substituteInlaySlots(template, { x: 'cls' }), '{{inlay_slot_class:unknown}}');
    });

    it('leaves a template without placeholders untouched', function () {
        const template = 'plain text';
        assert.strictEqual(substituteInlaySlots(template, { x: 'cls' }), 'plain text');
    });

    it('matches the per-slot split/join reference across random templates and slots', function () {
        const rand = (() => {
            let s = 0xF01A55E >>> 0;
            return () => {
                s = (s * 1664525 + 1013904223) >>> 0;
                return s / 0x100000000;
            };
        })();
        const slotNames = ['a', 'b', 'cc', 'long-id'];
        for (let trial = 0; trial < 60; trial++) {
            const slotClasses: Record<string, string> = {};
            for (const name of slotNames) {
                if (rand() > 0.3) {
                    slotClasses[name] = rand() > 0.5 ? 'st-inlay-gfx-' + name : '';
                }
            }
            let template = '';
            const parts = 1 + Math.floor(rand() * 8);
            for (let i = 0; i < parts; i++) {
                if (rand() > 0.4) {
                    template += `{{inlay_slot_class:${slotNames[Math.floor(rand() * slotNames.length)]}}}`;
                } else {
                    template += 'text' + i;
                }
            }
            const expected = referenceSubstitute(template, slotClasses);
            const got = substituteInlaySlots(template, slotClasses);
            assert.strictEqual(got, expected, `trial ${trial}: template ${template}`);
        }
    });
});
