import * as assert from 'assert';
import * as fileloader from '../util/fileloader';
import { parseHoi4File } from '../hoiformat/hoiparser';
import { convertNodeToJson } from '../hoiformat/schema';
import { countryTagsExpiryToken, countryTagsFolder, loadCountryTags, loadCountryTagsFile } from '../util/countrytags';

// common/country_tags 的共享读取器：文件解析、整目录归集、以及派生缓存用的过期令牌。
// fileloader 的入口按 gfxindex.test.ts 的手法打桩（commonjs 导出属性访问会被 TS 导入读到），
// 解析仍走真实的 hoi 解析器。

describe('util/countrytags', () => {
    const originalListFiles = (fileloader as any).listFilesFromModOrHOI4;
    const originalReadFileJson = (fileloader as any).readFileFromModOrHOI4AsJson;
    const originalFilesExpiryToken = (fileloader as any).hoiFilesExpiryToken;

    let files: Record<string, string>;
    let mtimes: Record<string, number>;
    // 每次用例递增，让过期令牌每次都不同：缓存（3 秒 TTL）不会把上一个用例的结果带过来。
    let mtimeSeq = 1;

    beforeEach(() => {
        files = {
            [`${countryTagsFolder}/a.txt`]: 'AAA = "countries/AAA.txt"\nBBB = "countries/BBB.txt"\ndynamic_tags = { D1 = x D2 = y }',
            [`${countryTagsFolder}/b.txt`]: 'CCC = "countries/CCC.txt"',
        };
        mtimes = {
            [`${countryTagsFolder}/a.txt`]: ++mtimeSeq,
            [`${countryTagsFolder}/b.txt`]: ++mtimeSeq,
        };
        (fileloader as any).listFilesFromModOrHOI4 = async (relativePath: string) => {
            assert.strictEqual(relativePath, countryTagsFolder);
            return Object.keys(files).map(f => f.slice(countryTagsFolder.length + 1));
        };
        (fileloader as any).readFileFromModOrHOI4AsJson = async (relativePath: string, schema: unknown) => {
            const content = files[relativePath];
            if (content === undefined) {
                throw new Error('no such file: ' + relativePath);
            }
            return convertNodeToJson(parseHoi4File(content), schema as any, {});
        };
        // 每个文件一个可变的 mtime，用来驱动过期令牌。打桩的是多文件版本：countrytags 导入的
        // 就是它（同模块内的调用不走导出对象，单文件版本打不到）。
        (fileloader as any).hoiFilesExpiryToken = async (relativePaths: string[]) =>
            relativePaths.map(p => `${p}@${mtimes[p] ?? 1}`).join('|');
    });

    afterEach(() => {
        (fileloader as any).listFilesFromModOrHOI4 = originalListFiles;
        (fileloader as any).readFileFromModOrHOI4AsJson = originalReadFileJson;
        (fileloader as any).hoiFilesExpiryToken = originalFilesExpiryToken;
    });

    it('parses the tag -> country file map, skipping dynamic_tags and empty values', async () => {
        const tags = await loadCountryTagsFile(`${countryTagsFolder}/a.txt`);
        assert.deepStrictEqual(tags, [
            { tag: 'AAA', file: 'countries/AAA.txt' },
            { tag: 'BBB', file: 'countries/BBB.txt' },
        ]);
    });

    it('returns an empty list for a file it cannot read', async () => {
        assert.deepStrictEqual(await loadCountryTagsFile(`${countryTagsFolder}/missing.txt`), []);
    });

    it('collects the declared tags and the files they came from', async () => {
        const { tags, files: read } = await loadCountryTags();
        assert.deepStrictEqual([...tags].sort(), ['AAA', 'BBB', 'CCC']);
        assert.deepStrictEqual(read, [`${countryTagsFolder}/a.txt`, `${countryTagsFolder}/b.txt`]);
    });

    it('moves the expiry token when a tag file changes', async () => {
        const before = await countryTagsExpiryToken();
        mtimes[`${countryTagsFolder}/a.txt`] = ++mtimeSeq;
        assert.notStrictEqual(await countryTagsExpiryToken(), before);
    });
});
