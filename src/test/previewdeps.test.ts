import * as assert from 'assert';
import * as vscode from 'vscode';
import * as fileloader from '../util/fileloader';
import * as gfxindex from '../util/gfxindex';
import * as modifiers from '../util/modifiers';
import * as ideaSwapIndex from '../util/ideaSwapIndex';
import * as characterTraits from '../util/characterTraits';
import * as configuredgfxfiles from '../util/configuredgfxfiles';
import * as guiwindowindex from '../util/guiwindowindex';
import * as eventIndex from '../util/eventIndex';
import { LoaderSession } from '../util/loader/loader';
import { IdeasLoader } from '../previewdef/idea/loader';
import { EventsLoader } from '../previewdef/event/loader';
import { CharactersLoader } from '../previewdef/character/loader';
import { DecisionsLoader } from '../previewdef/decision/loader';
import { DecisionCategoriesLoader } from '../previewdef/decision/categories';
import { ScriptedGuisLoader } from '../previewdef/decision/scriptedgui';
import { MioLoader } from '../previewdef/mio/loader';
import { renderGuiFile } from '../previewdef/gui/contentbuilder';
import { renderMioFile } from '../previewdef/mio/contentbuilder';
import { renderTechnologyFile } from '../previewdef/technology/contentbuilder';

// 预览只有在把 .gfx 文件登记为依赖后才会在它变化时重绘。加载器原先只把图集文件名放进结果，
// 没有放进依赖表；这里用最小 stub 断言它们确实进了 dependencies。

const webview = { asWebviewUri: (u: unknown) => u, cspSource: '' } as unknown as vscode.Webview;
const uri = vscode.Uri.file('/tmp/common/ideas/test.txt');
const spriteGfx = 'gfx/interface/test_sprites.gfx';

let restores: (() => void)[] = [];

function replace(target: object, key: string, value: unknown): void {
    const holder = target as Record<string, unknown>;
    const original = holder[key];
    holder[key] = value;
    restores.push(() => {
        holder[key] = original;
    });
}

afterEach(() => {
    for (const restore of restores.reverse()) {
        restore();
    }
    restores = [];
});

function stubSharedDependencies(): void {
    // 空内容时没有图片可查，但加载器仍会用这个容器文件构成 gfxFiles。
    replace(gfxindex, 'getGfxContainerFiles', async () => [spriteGfx]);
    replace(modifiers, 'loadModifierDefinitions', async () => ({}));
    replace(modifiers, 'listModifierDefinitionFiles', async () => []);
}

describe('preview dependencies: a sprite .gfx change reaches the preview', () => {
    it('subscribes the idea preview to the .gfx files it read', async () => {
        stubSharedDependencies();
        replace(ideaSwapIndex, 'getIdeaSwaps', async () => []);
        replace(fileloader, 'getDescriptorIdeaPlaceholderIcon', async () => []);
        replace(fileloader, 'getFilePathFromModOrHOI4', async () => undefined);

        const loader = new IdeasLoader('common/ideas/test.txt', async () => '');
        const { dependencies } = await loader.load(new LoaderSession(false));

        assert.ok(dependencies.includes(spriteGfx));
        assert.ok(dependencies.includes('interface/ideas.gfx'));
    });

    it('subscribes the event preview to the .gfx files it read', async () => {
        stubSharedDependencies();
        replace(eventIndex, 'ensureEventIndex', async () => undefined);
        replace(eventIndex, 'findFileByEventId', () => undefined);

        const loader = new EventsLoader('events/test.txt', async () => '');
        const { dependencies } = await loader.load(new LoaderSession(false));

        assert.ok(dependencies.includes(spriteGfx));
        assert.ok(dependencies.includes('interface/eventpictures.gfx'));
    });

    it('subscribes the character preview to the .gfx files it read', async () => {
        stubSharedDependencies();
        replace(characterTraits, 'loadCharacterTraits', async () => ({ traits: {}, files: [] }));

        const loader = new CharactersLoader('common/characters/test.txt', async () => '');
        const { dependencies } = await loader.load(new LoaderSession(false));

        assert.ok(dependencies.includes(spriteGfx));
    });

    it('subscribes the decision preview to every .gfx file, not only the configured ones', async () => {
        stubSharedDependencies();
        replace(fileloader, 'getDescriptorDecisionGfx', async () => []);
        replace(configuredgfxfiles, 'resolveConfiguredGfxFiles', async () => ['gfx/interface/decisions.gfx']);
        replace(guiwindowindex, 'findContainerWindows', async () => ({}));
        replace(DecisionCategoriesLoader.prototype, 'load', async () => ({ result: [], dependencies: [] }));
        replace(ScriptedGuisLoader.prototype, 'load', async () => ({ result: [], dependencies: [] }));

        const loader = new DecisionsLoader('common/decisions/test.txt', async () => '');
        const { dependencies } = await loader.load(new LoaderSession(false));

        assert.ok(dependencies.includes(spriteGfx));
        assert.ok(dependencies.includes('gfx/interface/decisions.gfx'));
    });

    it('subscribes the MIO preview to the organisations folder, so an added file refreshes it', async () => {
        replace(fileloader, 'listFilesFromModOrHOI4', async () => []);
        replace(fileloader, 'readFileFromModOrHOI4', async (path: string) => [
            Buffer.from(''),
            vscode.Uri.file(`/tmp/${path}`),
        ]);
        replace(fileloader, 'hoiFileExpiryToken', async () => '');
        replace(gfxindex, 'getGfxContainerFiles', async () => [spriteGfx]);

        const loader = new MioLoader(
            'common/military_industrial_organization/organizations/test.txt',
            async () => '',
        );
        const { dependencies } = await loader.load(new LoaderSession(false));

        assert.ok(dependencies.includes('common/military_industrial_organization/organizations/*'));
        assert.ok(dependencies.includes(spriteGfx));
    });
});

describe('preview renders force the loader session when a dependency changed', () => {
    function recordingLoader(result: unknown): { loader: object, forces: boolean[] } {
        const forces: boolean[] = [];
        return {
            forces,
            loader: {
                load: async (session: LoaderSession) => {
                    forces.push(session.force);
                    return { result, dependencies: [] };
                },
            },
        };
    }

    async function forcesFor(
        recorder: { loader: object, forces: boolean[] },
        render: (loader: never, uri: vscode.Uri, webview: vscode.Webview, options: { partial: boolean, dependencyChanged: boolean }) => Promise<unknown>,
    ): Promise<void> {
        await render(recorder.loader as never, uri, webview, { partial: true, dependencyChanged: true });
        await render(recorder.loader as never, uri, webview, { partial: true, dependencyChanged: false });
    }

    it('forces the gui preview session', async () => {
        const recorder = recordingLoader({ guiFiles: [] });

        await forcesFor(recorder, renderGuiFile);

        assert.deepStrictEqual(recorder.forces, [true, false]);
    });

    it('forces the MIO preview session', async () => {
        const recorder = recordingLoader({ mios: [], gfxFiles: [] });

        await forcesFor(recorder, renderMioFile);

        assert.deepStrictEqual(recorder.forces, [true, false]);
    });

    it('forces the technology preview session', async () => {
        const recorder = recordingLoader({ technologyTrees: [] });

        await forcesFor(recorder, renderTechnologyFile);

        assert.deepStrictEqual(recorder.forces, [true, false]);
    });
});
