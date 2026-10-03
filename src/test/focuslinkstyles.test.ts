import * as assert from 'assert';
import { StyleTable } from '../util/styletable';
import { focusLinkClass, focusLinkFrames, focusLinkShapes, FocusLinkImages, registerFocusLinkStyles } from '../util/hoi4gui/focuslink';
import { exclusiveLinkClass, exclusiveLinkVerticalClass, registerExclusiveLinkStyles } from '../util/hoi4gui/exclusivelink';

// 从生成的 CSS 里取出某选择器规则的属性名（排序后比较，不依赖声明顺序）。
function propertiesOf(css: string, selector: string): string[] {
    const start = css.indexOf(selector + ' {');
    if (start < 0) {
        return [];
    }
    const open = css.indexOf('{', start);
    const close = css.indexOf('}', open);
    return css.slice(open + 1, close)
        .split(';')
        .map(p => p.split(':')[0].trim())
        .filter(p => p !== '')
        .sort();
}

// uri 里不能带分号：属性解析按分号切分声明，data URI 的分号会把背景值切成两段。
function fakeImage(width = 16, height = 16): any {
    return { uri: 'about:blank#image', width, height };
}

function texturedFocusLinkImages(): FocusLinkImages {
    const solid: any = {};
    const dashed: any = {};
    for (const shape of focusLinkShapes) {
        solid[shape] = fakeImage();
        dashed[shape] = fakeImage();
    }
    return { solid, dashed };
}

// 焦点树分两遍渲染，各有一张 StyleTable，两份规则会同时出现在页面里按属性级联：无图与有图
// 两个分支必须声明同一组属性，只在一侧声明的属性会在另一侧下面残留。
describe('hoi4gui link styles', () => {
    describe('registerFocusLinkStyles', () => {
        it('registers the CSS under the selector its class names, tiles and pseudo elements alike', () => {
            const st = new StyleTable();
            registerFocusLinkStyles(st, undefined);
            const css = st.toRawCss();
            for (const shape of focusLinkShapes) {
                for (const dashed of [false, true]) {
                    assert.ok(css.includes('.' + focusLinkClass(shape, dashed) + ' {'), focusLinkClass(shape, dashed));
                    assert.ok(css.includes('.' + focusLinkClass(shape, dashed) + '::before {'), focusLinkClass(shape, dashed));
                    assert.ok(css.includes('.' + focusLinkClass(shape, dashed) + '::after {'), focusLinkClass(shape, dashed));
                }
            }
        });

        it('declares the same properties with and without textures', () => {
            const plain = new StyleTable();
            registerFocusLinkStyles(plain, undefined);
            const textured = new StyleTable();
            registerFocusLinkStyles(textured, texturedFocusLinkImages());
            const cssPlain = plain.toRawCss();
            const cssTextured = textured.toRawCss();
            for (const shape of focusLinkShapes) {
                for (const dashed of [false, true]) {
                    for (const pseudo of ['', '::before', '::after']) {
                        const selector = '.' + focusLinkClass(shape, dashed) + pseudo;
                        assert.ok(propertiesOf(cssPlain, selector).length > 0, selector);
                        assert.deepStrictEqual(propertiesOf(cssPlain, selector), propertiesOf(cssTextured, selector), selector);
                    }
                }
            }
        });

        it('picks the solid and dashed frame by state', () => {
            assert.deepStrictEqual(focusLinkFrames('available'), { solid: 2, dashed: 3 });
            assert.deepStrictEqual(focusLinkFrames('completed'), { solid: 0, dashed: 1 });
        });
    });

    describe('registerExclusiveLinkStyles', () => {
        it('registers the CSS under the selector its class names', () => {
            const st = new StyleTable();
            registerExclusiveLinkStyles(st, undefined, 96);
            const css = st.toRawCss();
            for (const pseudo of ['::before', '::after']) {
                assert.ok(css.includes('.' + exclusiveLinkClass + pseudo + ' {'), pseudo);
                assert.ok(css.includes('.' + exclusiveLinkVerticalClass + pseudo + ' {'), pseudo);
            }
        });

        it('declares the same properties with and without textures', () => {
            const plain = new StyleTable();
            registerExclusiveLinkStyles(plain, undefined, 96);
            const images = {
                line: fakeImage(16, 4),
                left: fakeImage(32, 32),
                mid: fakeImage(32, 32),
                right: fakeImage(32, 32),
            };
            const textured = new StyleTable();
            registerExclusiveLinkStyles(textured, images as any, 96);
            const cssPlain = plain.toRawCss();
            const cssTextured = textured.toRawCss();
            for (const cls of [exclusiveLinkClass, exclusiveLinkVerticalClass]) {
                for (const pseudo of ['::before', '::after']) {
                    const selector = '.' + cls + pseudo;
                    assert.ok(propertiesOf(cssPlain, selector).length > 0, selector);
                    assert.deepStrictEqual(propertiesOf(cssPlain, selector), propertiesOf(cssTextured, selector), selector);
                }
            }
        });
    });
});
