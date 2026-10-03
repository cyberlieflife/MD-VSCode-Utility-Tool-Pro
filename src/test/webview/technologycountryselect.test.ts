import './setup';
import * as assert from 'assert';

// 科技树网页端的国家下拉：宿主每次 updateBody 都带来整张「文件夹 -> 国家」表与它实际画的国家，
// 网页端按屏幕上的文件夹重列选项，选中的国家即使该文件夹没有专属美术也留在列表里。

describe('webview/techtree country select', function () {
    this.timeout(10000);

    const messages: any[] = [];
    const setState: Record<string, any> = {};

    before(async function () {
        // 与 focustreeinteractions 同样的手法：让 util/vscode 与 util/common 重新绑定到本测试的
        // acquireVsCodeApi（其它 webview 测试可能已缓存了 no-op 版本），再动态 import 入口。
        delete require.cache[require.resolve('../../../webviewsrc/util/vscode')];
        delete require.cache[require.resolve('../../../webviewsrc/util/common')];
        (global as any).acquireVsCodeApi = () => ({
            postMessage: (m: any) => { messages.push(m); },
            getState: () => setState,
            setState: (s: Record<string, any>) => { Object.assign(setState, s); },
        });

        document.body.innerHTML = `
        <select id="folderSelector"><option value="techfolder_infantry">infantry</option></select>
        <div id="techtreecontent"><div id="techfolder_infantry" class="techfolder"></div></div>
        <select id="tech-country"><option value="">Generic</option></select>
    `;

        await import('../../../webviewsrc/techtree');
    });

    after(function () {
        document.body.innerHTML = '';
    });

    const countrySelect = () => document.getElementById('tech-country') as HTMLSelectElement;

    function update(data: Record<string, unknown>): void {
        window.dispatchEvent(new MessageEvent('message', {
            data: { type: 'updateBody', styleCss: '', data },
        }));
    }

    const infantryHtml = '<div id="techfolder_infantry" class="techfolder"></div>';

    it('re-lists the country options for the folder on screen and selects the host\'s country', function () {
        update({
            folders: ['infantry'],
            folderOptionsHtml: '<option value="techfolder_infantry">infantry</option>',
            contentHtml: infantryHtml,
            countries: {
                infantry: [{ tag: 'AAA', label: 'Aaa (AAA)' }, { tag: 'BBB', label: 'Bbb (BBB)' }],
            },
            country: 'AAA',
        });

        const select = countrySelect();
        assert.deepStrictEqual(
            [...select.options].map(o => o.value),
            ['', 'AAA', 'BBB'],
        );
        assert.deepStrictEqual(
            [...select.options].map(o => o.textContent),
            ['Generic', 'Aaa (AAA)', 'Bbb (BBB)'],
        );
        assert.strictEqual(select.value, 'AAA');
    });

    it('keeps a selected country this folder does not list, labelled by its bare tag', function () {
        update({
            folders: ['infantry'],
            folderOptionsHtml: '<option value="techfolder_infantry">infantry</option>',
            contentHtml: infantryHtml,
            countries: { infantry: [] },
            country: 'ZZZ',
        });

        const select = countrySelect();
        assert.deepStrictEqual([...select.options].map(o => o.value), ['', 'ZZZ']);
        assert.strictEqual(select.options[1]!.textContent, 'ZZZ');
        assert.strictEqual(select.value, 'ZZZ');
    });

    it('follows a host that dropped the stored country back to Generic', function () {
        update({
            folders: ['infantry'],
            folderOptionsHtml: '<option value="techfolder_infantry">infantry</option>',
            contentHtml: infantryHtml,
            countries: { infantry: [{ tag: 'BBB', label: 'Bbb (BBB)' }] },
            country: '',
        });

        const select = countrySelect();
        assert.deepStrictEqual([...select.options].map(o => o.value), ['', 'BBB']);
        assert.strictEqual(select.value, '');
    });

    it('posts the picked country as a preview option', function () {
        // load 处理器绑定下拉的 change 监听；jsdom 不会自己派发 load，手工补一次。
        window.dispatchEvent(new Event('load'));
        messages.length = 0;

        const select = countrySelect();
        select.value = 'BBB';
        select.dispatchEvent(new Event('change'));

        assert.ok(
            messages.some(m => m.command === 'setPreviewOption' && m.key === 'technology.country' && m.value === 'BBB'),
            JSON.stringify(messages),
        );
    });
});
