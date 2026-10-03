import './setup';
import * as assert from 'assert';
import { currentScale, enableZoom, setZoomEnabled } from '../../../webviewsrc/util/common';
import { vscode } from '../../../webviewsrc/util/vscode';

// 缩放体系：滚轮行为由 window.previewWheel 决定（scroll/auto/zoom），Ctrl+滚轮与 +/- 始终缩放，
// 右下角的 +/- 控件与读数跟随缩放值。

describe('webview/util/common zoom wheel modes', function () {
    this.timeout(10000);

    let element: HTMLDivElement;

    beforeEach(function () {
        document.body.innerHTML = '<div id="zoom-content"></div>';
        element = document.getElementById('zoom-content') as HTMLDivElement;
        (window as any).previewWheel = 'scroll';
        // 直接改缓存下来的 webview API：其它 spec 会替换 acquireVsCodeApi，只有这份和 common.ts 用的是同一个。
        vscode.setState({ scale: 1 });
        setZoomEnabled(true);
        enableZoom(element, 0, 0);
    });

    function wheel(deltaY: number, options: { ctrlKey?: boolean; deltaMode?: number } = {}): void {
        const event = new WheelEvent('wheel', {
            deltaY,
            deltaMode: options.deltaMode ?? 0,
            ctrlKey: options.ctrlKey ?? false,
            bubbles: true,
            cancelable: true,
        });
        window.dispatchEvent(event);
    }

    it('leaves a bare wheel scrolling under the default "scroll" mode', function () {
        wheel(120);
        assert.strictEqual(currentScale(), 1);
    });

    it('zooms on ctrl+wheel whatever the mode is', function () {
        wheel(120, { ctrlKey: true });
        assert.strictEqual(currentScale(), 0.8);
        wheel(-120, { ctrlKey: true });
        assert.strictEqual(currentScale(), 1);
    });

    it('always zooms on a bare wheel under "zoom"', function () {
        (window as any).previewWheel = 'zoom';
        wheel(120);
        assert.strictEqual(currentScale(), 0.8);
        wheel(-120);
        assert.strictEqual(currentScale(), 1);
    });

    it('reads the gesture under "auto": a line-delta wheel zooms, a trackpad-like delta does not', function () {
        (window as any).previewWheel = 'auto';

        // A trackpad swipe: small, ramping deltas with no wheelDeltaY evidence.
        wheel(30);
        assert.strictEqual(currentScale(), 1);

        // A wheel reports line/page deltas rather than pixels; that alone settles it as a mouse.
        wheel(3, { deltaMode: 1 });
        assert.strictEqual(currentScale(), 0.8);
    });

    it('builds the zoom controls once and keeps the readout and button states in step', function () {
        const controls = document.getElementById('zoom-controls');
        assert.ok(controls, 'the overlay must be appended to the body');
        assert.strictEqual(document.getElementById('zoom-level')!.textContent, '100%');
        assert.strictEqual((document.getElementById('zoom-in') as HTMLButtonElement).disabled, true, 'already at max zoom');
        assert.strictEqual((document.getElementById('zoom-out') as HTMLButtonElement).disabled, false);

        (document.getElementById('zoom-out') as HTMLButtonElement).click();
        assert.strictEqual(currentScale(), 0.8);
        assert.strictEqual(document.getElementById('zoom-level')!.textContent, '80%');
        assert.strictEqual((document.getElementById('zoom-in') as HTMLButtonElement).disabled, false);

        // enableZoom 再次调用（同一文档里的第二次渲染）复用它已经建好的控件。
        enableZoom(element, 0, 0);
        assert.strictEqual(document.querySelectorAll('#zoom-controls').length, 1);
    });

    it('zooms with the +/- keys and ignores keys aimed at a text field', function () {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: '-', bubbles: true, cancelable: true }));
        assert.strictEqual(currentScale(), 0.8);

        const input = document.createElement('input');
        document.body.appendChild(input);
        input.dispatchEvent(new KeyboardEvent('keydown', { key: '+', bubbles: true, cancelable: true }));
        assert.strictEqual(currentScale(), 0.8, 'a key typed into an input must not zoom');

        window.dispatchEvent(new KeyboardEvent('keydown', { key: '+', bubbles: true, cancelable: true }));
        assert.strictEqual(currentScale(), 1);
    });
});
