import './setup';
import * as assert from 'assert';
import { DivDropdown, numDropDownOpened$ } from '../../../webviewsrc/util/dropdown';

describe('webview/util/dropdown', function () {
    beforeEach(function () {
        document.body.innerHTML = '';
        numDropDownOpened$.next(0);
    });

    function buildDivDropdown(values: string[], multi = false, initial?: string[]) {
        const div = document.createElement('div');
        div.classList.add('select-container');

        const valueSpan = document.createElement('span');
        valueSpan.classList.add('value');
        div.appendChild(valueSpan);

        values.forEach(v => {
            const opt = document.createElement('div');
            opt.classList.add('option');
            opt.setAttribute('value', v);
            opt.textContent = v;
            div.appendChild(opt);
        });

        document.body.appendChild(div);

        const dd = new DivDropdown(div, multi);
        if (initial) {
            dd.selectedValues$.next(initial);
        }
        return dd;
    }

    it('initializes with the first option selected (single)', function () {
        const dd = buildDivDropdown(['a', 'b', 'c']);
        assert.deepStrictEqual(dd.selectedValues$.value, ['a']);
    });

    it('selectAll selects every option', function () {
        const dd = buildDivDropdown(['x', 'y', 'z'], true);
        dd.selectAll();
        assert.deepStrictEqual(dd.selectedValues$.value, ['x', 'y', 'z']);
    });

    it('updates displayed text on selection change', function () {
        const dd = buildDivDropdown(['first', 'second']);
        const span = dd.select.querySelector('span.value') as HTMLSpanElement;
        assert.ok(span.textContent?.includes('first'));

        dd.selectedValues$.next(['second']);
        assert.ok(span.textContent?.includes('second'));
    });

    it('does not throw on mousedown', function () {
        const dd = buildDivDropdown(['a', 'b']);
        dd.select.dispatchEvent(new Event('mousedown'));
        // Just verifies no exception
        dd.dispose();
    });

    it('closes an open menu when the dropdown is disposed', function () {
        const dd = buildDivDropdown(['a', 'b']);
        dd.select.dispatchEvent(new Event('mousedown'));
        assert.strictEqual(numDropDownOpened$.value, 1);
        assert.ok(dd.select.classList.contains('dropdown-opened'));
        assert.strictEqual(document.querySelectorAll('.select-dropdown').length, 1);

        dd.dispose();

        assert.strictEqual(numDropDownOpened$.value, 0);
        assert.strictEqual(dd.select.classList.contains('dropdown-opened'), false);
        assert.strictEqual(document.querySelectorAll('.select-dropdown').length, 0);
    });

    it('increments open counter when dropdown opens', function (done) {
        const dd = buildDivDropdown(['a', 'b']);
        const sub = numDropDownOpened$.subscribe(n => {
            if (n === 1) {
                sub.unsubscribe();
                dd.dispose();
                done();
            }
        });
        dd.select.dispatchEvent(new Event('mousedown'));
    });
});
