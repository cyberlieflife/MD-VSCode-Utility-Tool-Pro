import * as assert from 'assert';
import { getDependenciesFromText } from '../util/dependency';

describe('util/dependency', () => {
    describe('getDependenciesFromText', () => {
        it('returns an empty list for text with no dependency markers', () => {
            assert.deepStrictEqual(getDependenciesFromText(''), []);
            assert.deepStrictEqual(getDependenciesFromText('name = 1\nother = 2\n'), []);
        });

        it('parses a single dependency marker', () => {
            const result = getDependenciesFromText('#!event:events/foo.txt\n');
            assert.deepStrictEqual(result, [{ type: 'event', path: 'events/foo.txt' }]);
        });

        it('parses txt and yml markers, and includes type===ext markers', () => {
            // The filter is `type === ext || ext === 'txt' || ext === 'yml'`.
            // For a marker like `#!sprite:gfx/sprite.gfx`, type=`sprite` and ext=`gfx`,
            // so it is filtered out. The only way a type can match its extension is
            // when the extension literally equals the type (e.g. `#!sprite:foo.sprite`).
            const text = [
                '#!event:events/foo.txt',
                '#!localisation:localisation/replace/english.yml',
                '#!sprite:data/foo.sprite',
                '#!sprite:gfx/sprite.gfx',
                '#!other:foo.bar',
            ].join('\n') + '\n';

            const result = getDependenciesFromText(text);
            assert.deepStrictEqual(result, [
                { type: 'event', path: 'events/foo.txt' },
                { type: 'localisation', path: 'localisation/replace/english.yml' },
                { type: 'sprite', path: 'data/foo.sprite' },
            ]);
        });

        it('ignores lines where the extension is unsupported', () => {
            const text = [
                '#!event:events/foo.png',
                '#!note:docs/readme.md',
                '#!event:events/bar.txt',
            ].join('\n') + '\n';

            const result = getDependenciesFromText(text);
            assert.deepStrictEqual(result, [{ type: 'event', path: 'events/bar.txt' }]);
        });

        it('accepts leading whitespace before the marker', () => {
            const result = getDependenciesFromText('   #!event:events/foo.txt\n');
            assert.deepStrictEqual(result, [{ type: 'event', path: 'events/foo.txt' }]);
        });

        it('finds a marker after a large file without backtracing over it', function () {
            this.timeout(5000);
            // 每行行首的 \s* 曾把空行逐个吞掉再回溯，20 万空行就是几十亿步。
            const padding = ':'.repeat(300_000) + '\r\n\r\n'.repeat(200_000);
            const result = getDependenciesFromText(padding + '#!event:events/foo.txt\r\n');
            assert.deepStrictEqual(result, [{ type: 'event', path: 'events/foo.txt' }]);
        });

        it('does not match markers that are not at the start of a line', () => {
            const result = getDependenciesFromText('desc = "#!event:events/foo.txt"\n');
            assert.deepStrictEqual(result, []);
        });

        it('preserves multiple dependencies in declaration order', () => {
            const text = [
                '#!event:events/a.txt',
                '#!event:events/b.txt',
                '#!localisation:localisation/a.yml',
                '#!event:events/c.txt',
            ].join('\n') + '\n';

            const result = getDependenciesFromText(text);
            assert.deepStrictEqual(result, [
                { type: 'event', path: 'events/a.txt' },
                { type: 'event', path: 'events/b.txt' },
                { type: 'localisation', path: 'localisation/a.yml' },
                { type: 'event', path: 'events/c.txt' },
            ]);
        });

        it('normalizes multiple slashes and backslashes in the path to a single forward slash', () => {
            const result = getDependenciesFromText([
                '#!event:events\\\\sub\\\\foo.txt',
                '#!event:events//sub//bar.txt',
            ].join('\n') + '\n');

            assert.deepStrictEqual(result, [
                { type: 'event', path: 'events/sub/foo.txt' },
                { type: 'event', path: 'events/sub/bar.txt' },
            ]);
        });

        it('trims whitespace around the path', () => {
            // 路径现在按行尾之前的整段读取再 trim，因此冒号后的空格与行尾空格都不再影响扩展名判断。
            const result = getDependenciesFromText('#!event:  events/foo.txt  \n');
            assert.deepStrictEqual(result, [{ type: 'event', path: 'events/foo.txt' }]);
        });

        it('ignores comment-like text that is not a marker', () => {
            const result = getDependenciesFromText('# this is a regular comment\n#!event:events/foo.txt\n');
            assert.deepStrictEqual(result, [{ type: 'event', path: 'events/foo.txt' }]);
        });
    });
});
