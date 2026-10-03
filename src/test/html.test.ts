import * as assert from 'assert';
import * as vscode from 'vscode';
import { htmlEscape, html } from '../util/html';
import * as featureflags from '../util/featureflags';

describe('util/html', () => {
    describe('htmlEscape', () => {
        it('escapes ampersands', () => {
            // Note: every space is also replaced with &nbsp; -- the function
            // is space-aggressive, so we test without surrounding spaces.
            assert.strictEqual(htmlEscape('foo&bar'), 'foo&amp;bar');
        });

        it('escapes angle brackets', () => {
            assert.strictEqual(htmlEscape('<div>'), '&lt;div&gt;');
        });

        it('escapes double and single quotes', () => {
            assert.strictEqual(htmlEscape('"hi"\'there\''), '&quot;hi&quot;&#039;there&#039;');
        });

        it('escapes newlines and spaces', () => {
            // The function encodes every space and newline, which is unusual for HTML, but is
            // the project's actual contract: callers feed it pre-trimmed text.
            assert.strictEqual(htmlEscape('a\nb'), 'a&#10;b');
            assert.strictEqual(htmlEscape('a b'), 'a&nbsp;b');
        });

        it('escapes the ampersand before other characters so & does not double-encode', () => {
            // The function does & first, so an input `&lt;` becomes `&amp;lt;` -- the & is
            // escaped but the existing `lt;` is left alone. Document the behaviour.
            assert.strictEqual(htmlEscape('&lt;'), '&amp;lt;');
        });

        it('returns an empty string unchanged', () => {
            assert.strictEqual(htmlEscape(''), '');
        });
    });

    // 每个预览的页面都从 html() 出去，所以滚轮设置在这里注入一次，网页端的缩放就能读到它。
    describe('previewWheel injection', () => {
        const webview = { asWebviewUri: (u: unknown) => u, cspSource: '' } as unknown as vscode.Webview;

        it('renders the configured wheel mode into the page as window.previewWheel', () => {
            const before = featureflags.previewWheel;
            try {
                (featureflags as any).previewWheel = 'zoom';
                assert.ok(html(webview, '<div></div>', []).includes('window.previewWheel = "zoom"'));

                (featureflags as any).previewWheel = 'scroll';
                assert.ok(html(webview, '<div></div>', []).includes('window.previewWheel = "scroll"'));
            } finally {
                (featureflags as any).previewWheel = before;
            }
        });
    });
});
