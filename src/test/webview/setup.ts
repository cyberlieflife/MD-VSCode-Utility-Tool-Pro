import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
    url: 'https://localhost',
    pretendToBeVisual: true,
});

// global window (no ts-expect-error)
(global as any).window = dom.window;
(global as any).document = dom.window.document;

// Mock acquireVsCodeApi for webview tests
const state: Record<string, any> = {};
(global as any).acquireVsCodeApi = () => ({
    postMessage: () => {},
    getState: () => state,
    setState: (s: Record<string, any>) => {
        Object.assign(state, s);
    },
    // end of acquireVsCodeApi mock (no ts-expect-error)
});

// Provide browser globals that jsdom exposes on its window so that
// `new Event(...)`, `new MouseEvent(...)`, `new KeyboardEvent(...)` etc.
// work in test code the same way they do in a real browser.
for (const name of [
    'Event', 'MessageEvent', 'MouseEvent', 'KeyboardEvent', 'FocusEvent',
    'PointerEvent', 'WheelEvent',
]) {
    (global as any)[name] = (dom.window as any)[name];
}

// Mock i18n table for feLocalize tests
(dom.window as any).__i18ntable = {
    'test.key': 'Translated value',
    'combobox.noselection': '(No selection)',
    'combobox.all': '(All)',
    'combobox.multiple': '{0} (+{1})',
};

// The listeners a webview entrypoint adds to `window` while it loads, held back from the window so
// that one preview never handles another preview's `load` or `message`: every spec file shares this
// one window. A suite that drives the preview through window events attaches them for its duration.
export interface EntrypointListeners {
    attach(): void;
    detach(): void;
}

type RecordedListener = [string, EventListenerOrEventListenerObject, boolean | AddEventListenerOptions | undefined];

export function loadEntrypoint<T>(load: () => T): { module: T; listeners: EntrypointListeners } {
    const recorded: RecordedListener[] = [];
    const originalAddEventListener = window.addEventListener;
    (window as any).addEventListener = (...args: RecordedListener) => {
        recorded.push(args);
    };
    let module: T;
    try {
        module = load();
    } finally {
        (window as any).addEventListener = originalAddEventListener;
    }

    // What the module added while attached -- a listener its load handler registers, say -- is
    // removed with the rest, so nothing it did outlives the suite.
    let attached: RecordedListener[] | undefined;
    const listeners: EntrypointListeners = {
        attach() {
            if (attached) {
                return;
            }
            const added: RecordedListener[] = [];
            attached = added;
            for (const args of recorded) {
                originalAddEventListener.apply(window, args);
                added.push(args);
            }
            (window as any).addEventListener = (...args: RecordedListener) => {
                originalAddEventListener.apply(window, args);
                added.push(args);
            };
        },
        detach() {
            if (!attached) {
                return;
            }
            (window as any).addEventListener = originalAddEventListener;
            for (const [type, listener, options] of attached) {
                window.removeEventListener(type, listener, options);
            }
            attached = undefined;
        },
    };
    return { module: module!, listeners };
}

// Attaches the entrypoint's listeners for the enclosing `describe`.
export function useEntrypoint(listeners: EntrypointListeners): void {
    before(() => listeners.attach());
    after(() => listeners.detach());
}
