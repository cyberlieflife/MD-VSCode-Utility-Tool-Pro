import * as assert from 'assert';
import * as vscode from 'vscode';
import { getTechnologyIconNames, renderTechnologyFile } from '../previewdef/technology/contentbuilder';
import { serializeUpdate, renderedHtml, LoaderRenderResult } from '../previewdef/loaderpreview';

// renderTechnologyFile returns the in-place update parts { html, update } on success and a plain html
// string on the no-tree / error branches. These drive it against a stub loader (a countrytechtreeview
// with no folder children, so every folder takes the deterministic "can't find folder" fallback) to
// assert the return shape and that serializeUpdate is stable for identical input -- the property the
// LoaderPreview skip relies on -- and differs when the input changed.

const webview = { asWebviewUri: (u: unknown) => u, cspSource: '' } as unknown as vscode.Webview;
const uri = vscode.Uri.file('/tmp/common/technologies/test.txt');

function loaderFor(folders: string[], countryTagsByFolder: Record<string, string[]> = {}): any {
    return {
        load: async () => ({
            result: {
                technologyTrees: folders.map(folder => ({ startTechnology: `${folder}_start`, folder, technologies: [] })),
                guiFiles: [{
                    file: 'countrytechtreeview.gui',
                    data: { guitypes: [{ containerwindowtype: [{ name: 'countrytechtreeview', containerwindowtype: [] }] }] },
                }],
                gfxFiles: [],
                equipmentArchetypes: {},
                countryTagsByFolder,
            },
        }),
    };
}

// The class list on an element carrying id="<id>", read out of the rendered html.
function classOf(html: string, id: string): string {
    const m = new RegExp(`id="${id}"[^>]*?class="([^"]*)"`).exec(html);
    assert.ok(m, `expected an element with id="${id}"`);
    return m![1].trim();
}

describe('previewdef/technology renderTechnologyFile in-place update', () => {
    it('returns { html, update } carrying contentHtml, folderOptionsHtml and folders', async () => {
        const rendered = await renderTechnologyFile(loaderFor(['artillery', 'infantry']), uri, webview) as LoaderRenderResult;
        assert.strictEqual(typeof rendered, 'object');
        assert.strictEqual(typeof renderedHtml(rendered), 'string');
        assert.ok(rendered.update);
        assert.strictEqual(typeof rendered.update.styleCss, 'string');
        const data = rendered.update.data as { contentHtml: string; folderOptionsHtml: string; folders: string[] };
        assert.strictEqual(typeof data.contentHtml, 'string');
        assert.strictEqual(typeof data.folderOptionsHtml, 'string');
        assert.deepStrictEqual(data.folders, ['artillery', 'infantry']);
    });

    it('serializeUpdate is stable for identical input, even though the full html nonces differ', async () => {
        const a = await renderTechnologyFile(loaderFor(['artillery', 'infantry']), uri, webview) as LoaderRenderResult;
        const b = await renderTechnologyFile(loaderFor(['artillery', 'infantry']), uri, webview) as LoaderRenderResult;
        // The full html carries fresh CSP nonces per render so it never hashes equal; the update parts
        // must be byte-identical so a no-op edit skips.
        assert.notStrictEqual(renderedHtml(a), renderedHtml(b));
        assert.strictEqual(serializeUpdate(a.update!), serializeUpdate(b.update!));
    });

    it('serializeUpdate differs when the input changed', async () => {
        const a = await renderTechnologyFile(loaderFor(['artillery', 'infantry']), uri, webview) as LoaderRenderResult;
        const c = await renderTechnologyFile(loaderFor(['artillery', 'armor']), uri, webview) as LoaderRenderResult;
        assert.notStrictEqual(serializeUpdate(a.update!), serializeUpdate(c.update!));
    });

    it('gives the shell elements suffix-free stable class names carried by the pushed styleCss', async () => {
        // The shell (folder toolbar, #dragger, #techtreecontent wrapper) lives outside the swapped
        // content, so its classes must be suffix-free style() names, not per-render oneTimeStyle ids,
        // or an in-place update's styleCss would have no rule for the class still on the live element.
        const a = await renderTechnologyFile(loaderFor(['artillery', 'infantry']), uri, webview) as LoaderRenderResult;
        const b = await renderTechnologyFile(loaderFor(['artillery', 'armor']), uri, webview) as LoaderRenderResult;

        for (const rendered of [a, b]) {
            const styleCss = rendered.update!.styleCss!;
            assert.strictEqual(classOf(renderedHtml(rendered), 'dragger'), 'st-dragger');
            assert.ok(classOf(renderedHtml(rendered), 'techtreecontent').split(' ').includes('st-mainContent'));
            assert.ok(styleCss.includes('.st-dragger {'));
            assert.ok(styleCss.includes('.st-mainContent {'));
            assert.ok(styleCss.includes('.st-folderSelectorBar {'));
        }
    });

    it('returns a plain string (no update parts) for the no-technology-tree page', async () => {
        const rendered = await renderTechnologyFile(loaderFor([]), uri, webview);
        assert.strictEqual(typeof rendered, 'string');
    });

    it('returns a plain string for the error page when the loader throws', async () => {
        const throwing: any = { load: async () => { throw new Error('boom'); } };
        const rendered = await renderTechnologyFile(throwing, uri, webview);
        assert.strictEqual(typeof rendered, 'string');
    });
});

// 国家图标的解析顺序与载荷：图标按「所选国家的专属图 → 通用图 → .gui 里的占位名」依次回退，
// 国家清单随 update 一起下发，供网页端按文件夹重列下拉。
describe('previewdef/technology country icons', () => {
    it('resolves a technology icon through the country art first, then the generic name, then the placeholder', () => {
        assert.deepStrictEqual(
            getTechnologyIconNames('tank', 'AAA', 'GFX_technology_medium'),
            ['GFX_AAA_tank_medium', 'GFX_AAA_tank', 'GFX_tank_medium', 'GFX_tank', 'GFX_technology_medium'],
        );
        assert.deepStrictEqual(
            getTechnologyIconNames('tank', undefined, 'GFX_technology_medium'),
            ['GFX_tank_medium', 'GFX_tank', 'GFX_technology_medium'],
        );
    });

    it('carries the country lists and the chosen country in the update payload', async () => {
        const rendered = await renderTechnologyFile(
            loaderFor(['artillery'], { artillery: ['AAA'] }),
            uri,
            webview,
        ) as LoaderRenderResult;

        const data = rendered.update!.data as { countries: unknown; country: unknown };
        // 没有本地化索引时标签退化为裸 tag；没有存过选择时 country 是空串（通用树）。
        assert.deepStrictEqual(data.countries, { artillery: [{ tag: 'AAA', label: 'AAA' }] });
        assert.strictEqual(data.country, '');
    });
});
