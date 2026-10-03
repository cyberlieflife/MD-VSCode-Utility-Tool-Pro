import * as assert from 'assert';
import { buildTechnologyTagMap, technologyTagsByFolder } from '../previewdef/technology/countryicons';
import { TechnologyTree } from '../previewdef/technology/schema';

// 科技树国家图标清单的纯函数部分：从 gfx 索引的 sprite 名里按游戏声明的 tag 切出
// 「技术 id -> 有自己图标的国家」，再按每个技术文件夹筛出值得列出的国家。

describe('previewdef/technology/countryicons', () => {
    describe('buildTechnologyTagMap', () => {
        const tags = new Set(['AAA', 'BBB']);

        it('splits GFX_<tag>_<id> names on the declared tags, in both the _medium and bare forms', () => {
            const map = buildTechnologyTagMap(tags, [
                'GFX_AAA_tank_medium',
                'GFX_AAA_tank',
                'GFX_BBB_tank',
            ]);
            assert.deepStrictEqual(map, {
                tank: ['AAA', 'BBB'],
                tank_medium: ['AAA'],
            });
        });

        it('ignores names whose prefix is not a declared tag', () => {
            const map = buildTechnologyTagMap(tags, ['GFX_APC_1_medium', 'GFX_CCC_tank']);
            assert.deepStrictEqual(map, {});
        });

        it('ignores names without the GFX_ prefix or without an id', () => {
            const map = buildTechnologyTagMap(tags, ['AAA_tank', 'GFX_AAA_', 'GFX_AAA', 'plain']);
            assert.deepStrictEqual(map, {});
        });

        it('sorts each id\'s tag list and returns nothing for empty input', () => {
            assert.deepStrictEqual(buildTechnologyTagMap(new Set(), ['GFX_AAA_tank']), {});
            assert.deepStrictEqual(buildTechnologyTagMap(tags, []), {});
            assert.deepStrictEqual(
                buildTechnologyTagMap(new Set(['ZZZ', 'AAA']), ['GFX_ZZZ_gun', 'GFX_AAA_gun']),
                { gun: ['AAA', 'ZZZ'] },
            );
        });
    });

    describe('technologyTagsByFolder', () => {
        const tree = (folder: string, technologies: [string, string[]][]): TechnologyTree => ({
            startTechnology: `${folder}_start`,
            folder,
            technologies: technologies.map(([id, folders]) => ({
                id,
                folders: Object.fromEntries(folders.map(f => [f, { name: f, x: 0, y: 0 }])),
            })),
        } as TechnologyTree);

        it('lists, per folder, the tags of technologies drawn in it', () => {
            const trees = [
                tree('infantry_folder', [['tank', ['infantry_folder']], ['gun', ['infantry_folder', 'artillery_folder']]]),
                tree('artillery_folder', [['gun', ['infantry_folder', 'artillery_folder']]]),
            ];
            const tagMap = { tank: ['AAA'], gun: ['BBB', 'AAA'] };

            const byFolder = technologyTagsByFolder(trees, ['infantry_folder', 'artillery_folder', 'empty_folder'], tagMap);
            assert.deepStrictEqual(byFolder, {
                infantry_folder: ['AAA', 'BBB'],
                artillery_folder: ['AAA', 'BBB'],
                empty_folder: [],
            });
        });

        it('keeps a folder with no country art as an empty list instead of dropping it', () => {
            const trees = [tree('infantry_folder', [['tank', ['infantry_folder']]])];
            assert.deepStrictEqual(technologyTagsByFolder(trees, ['infantry_folder'], {}), { infantry_folder: [] });
        });
    });
});
