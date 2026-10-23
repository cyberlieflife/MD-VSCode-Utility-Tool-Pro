import './setup';
import * as assert from 'assert';
import { warningBoxClass, warningFlashClass } from '../../../src/util/hoi4gui/warningstyles';
import {
    applyWarningMarkers,
    clearWarningMarkers,
    renderWarningList,
    setWarningMarkersVisible,
} from '../../../webviewsrc/util/warnings';

// 共享的网格树警告层：焦点树与 MIO 特质树都靠它给节点加标记、列面板、点条目跳到节点。
// 这里用 trait_ 前缀，证明前缀是参数而不是写死的。

function gridItem(id: string, x: number, y: number) {
    return { id, gridX: x, gridY: y } as never;
}

describe('webview/util/warnings', () => {
    beforeEach(() => {
        document.body.innerHTML = [
            '<div id="trait_a"><div class="navigator" title="a (0, 0)"></div></div>',
            '<div id="trait_b"><div class="navigator" title="b (0, 0)"></div></div>',
            '<div id="warnings-container"><div id="warnings"></div></div>',
            '<button id="show-warnings"></button>',
            '<button id="toggle-warning-markers"></button>',
        ].join('');
    });

    afterEach(() => {
        clearWarningMarkers();
    });

    it('marks every node a warning names, under the given id prefix', () => {
        applyWarningMarkers(
            { warnings: [{ source: 'a', text: 'boom', relatedSources: ['b'] }] },
            [gridItem('a', 0, 0), gridItem('b', 0, 0)],
            'trait_',
            true,
        );

        assert.ok(document.querySelector(`#trait_a .${warningBoxClass}`), 'the source is marked');
        assert.ok(document.querySelector(`#trait_b .${warningBoxClass}`), 'the related node is marked');
        const title = (document.querySelector('#trait_a .navigator') as HTMLElement).title;
        assert.ok(title.includes('⚠ boom'), title);
        // 两个被警告的节点叠在同一格：角标要说明还藏着另一个。
        assert.strictEqual(document.querySelector(`#trait_a .${warningBoxClass} span`)!.textContent, '⚠×2');
    });

    it('restores the navigator title when the markers are cleared', () => {
        applyWarningMarkers(
            { warnings: [{ source: 'a', text: 'boom' }] },
            [gridItem('a', 0, 0)],
            'trait_',
            true,
        );
        clearWarningMarkers();

        assert.strictEqual(document.querySelector(`#trait_a .${warningBoxClass}`), null);
        assert.strictEqual((document.querySelector('#trait_a .navigator') as HTMLElement).title, 'a (0, 0)');
    });

    it('hides and shows the existing markers without rebuilding them', () => {
        applyWarningMarkers(
            { warnings: [{ source: 'a', text: 'boom' }] },
            [gridItem('a', 0, 0)],
            'trait_',
            true,
        );

        setWarningMarkersVisible(false);
        assert.strictEqual((document.querySelector(`#trait_a .${warningBoxClass}`) as HTMLElement).style.display, 'none');

        setWarningMarkersVisible(true);
        assert.strictEqual((document.querySelector(`#trait_a .${warningBoxClass}`) as HTMLElement).style.display, 'block');
    });

    it('lists every warning and reveals the node it names', () => {
        renderWarningList(
            { warnings: [{ source: 'a', text: 'boom' }] },
            'trait_',
        );

        const entries = document.querySelectorAll('#warnings [role="button"]');
        assert.strictEqual(entries.length, 1);
        assert.ok((entries[0] as HTMLElement).textContent!.includes('[a] boom'));

        (entries[0] as HTMLElement).dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

        assert.strictEqual((document.getElementById('warnings-container') as HTMLElement).style.display, 'none');
        assert.ok(document.getElementById('trait_a')!.classList.contains(warningFlashClass));
    });

    it('says so when the tree has no warnings', () => {
        renderWarningList({ warnings: [] }, 'trait_');
        assert.ok(document.getElementById('warnings')!.textContent!.includes('No warnings'));
    });
});
