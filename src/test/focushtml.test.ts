import * as assert from 'assert';
import { assembleFocusHtml, FocusHtmlClasses } from '../previewdef/focustree/contentbuilder';
import { Focus } from '../previewdef/focustree/schema';

function makeFocus(overrides: Partial<Focus> = {}): Focus {
    return {
        id: 'focus_a',
        x: 0,
        y: 0,
        icon: [],
        textIcon: undefined,
        overlay: undefined,
        prerequisite: [],
        exclusive: [],
        inAllowBranch: [],
        allowBranch: undefined,
        relativePositionId: undefined,
        offset: [],
        token: { value: 'focus_a', start: 10, end: 20, type: 'word' },
        xToken: undefined,
        yToken: undefined,
        file: 'common/national_focus/ger.txt',
        warnings: [],
        ...overrides,
    } as Focus;
}

function makeClasses(overrides: Partial<FocusHtmlClasses> = {}): FocusHtmlClasses {
    return {
        titlebarClass: 'st-focus-titlebar-test',
        overlayClass: 'st-focus-overlay-test',
        hasCustomTitlebar: true,
        hasFocusOverlay: false,
        focusCommonClass: 'st-focus-common-1',
        focusIconLayerClass: 'st-focus-icon-layer-2',
        focusTitlebarLayerClass: 'st-focus-titlebar-layer-3',
        focusOverlayLayerClass: 'st-focus-overlay-layer-4',
        focusCheckboxClass: 'st-focus-checkbox-5',
        focusSpanClass: 'st-focus-span-6',
        ...overrides,
    };
}

describe('previewdef/focustree/assembleFocusHtml', function () {
    it('is deterministic for the same focus and classes', function () {
        const focus = makeFocus();
        const classes = makeClasses();
        assert.strictEqual(assembleFocusHtml(focus, 'common/national_focus/ger.txt', classes), assembleFocusHtml(focus, 'common/national_focus/ger.txt', classes));
    });

    it('embeds the focus id, tokens and injected classes', function () {
        const focus = makeFocus();
        const html = assembleFocusHtml(focus, 'common/national_focus/ger.txt', makeClasses());
        assert.ok(html.includes('data-focus-id="focus_a"'));
        assert.ok(html.includes('start="10"'));
        assert.ok(html.includes('end="20"'));
        assert.ok(html.includes('st-focus-titlebar-test'));
        assert.ok(html.includes('st-focus-overlay-test'));
        assert.ok(html.includes('st-focus-common-1'));
        assert.ok(html.includes('st-focus-icon-layer-2'));
        assert.ok(html.includes('id="checkbox-focus_a"'));
        assert.ok(html.includes('{{iconClass}}'), 'icon class stays a placeholder for the webview');
        assert.ok(html.includes('{{position}}'), 'position stays a placeholder for the webview');
        assert.ok(html.includes('>focus_a<'), 'label is the raw focus id');
    });

    it('omits the file attribute when the focus lives in the previewed file', function () {
        const focus = makeFocus();
        const html = assembleFocusHtml(focus, 'common/national_focus/ger.txt', makeClasses());
        assert.ok(!html.includes('file="'), 'same-file focus must not carry a file attribute');
        const jointHtml = assembleFocusHtml(focus, 'other_file.txt', makeClasses());
        assert.ok(jointHtml.includes('file="common/national_focus/ger.txt"'));
    });

    it('flips the titlebar/overlay data flags from the class flags', function () {
        const focus = makeFocus();
        const withBoth = makeClasses({ hasCustomTitlebar: true, hasFocusOverlay: true });
        const html = assembleFocusHtml(focus, 'f.txt', withBoth);
        assert.ok(html.includes('data-has-custom-titlebar="true"'));
        assert.ok(html.includes('data-has-focus-overlay="true"'));
        const without = makeClasses({ hasCustomTitlebar: false, hasFocusOverlay: false });
        const html2 = assembleFocusHtml(focus, 'f.txt', without);
        assert.ok(html2.includes('data-has-custom-titlebar="false"'));
        assert.ok(html2.includes('data-has-focus-overlay="false"'));
    });

    it('renders different output for different focus ids', function () {
        const a = assembleFocusHtml(makeFocus(), 'f.txt', makeClasses());
        const b = assembleFocusHtml(makeFocus({ id: 'focus_b' }), 'f.txt', makeClasses());
        assert.notStrictEqual(a, b);
    });
});
