import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
    url: 'https://localhost',
    pretendToBeVisual: true,
});

// global window (no ts-expect-error)
(global as any).window = dom.window;
(global as any).document = dom.window.document;

// Every message the page posted, so a test can assert on what the webview told the host.
const postedMessages: any[] = [];

// What the page has posted since the test started, without clearing it.
export function recordedPosts(): any[] {
    return postedMessages.slice();
}

export function takePostedMessages(): any[] {
    return postedMessages.splice(0, postedMessages.length);
}

// The runtime errors raised since the last call, for a test that triggers one on purpose and asserts
// on it. Taking them is what keeps the root hooks from failing the test over them.
const runtimeErrors: unknown[] = [];

export function takeRuntimeErrors(): unknown[] {
    return runtimeErrors.splice(0, runtimeErrors.length);
}

function describeRuntimeError(error: unknown): string {
    if (error instanceof Error || (error && typeof error === 'object' && 'stack' in error)) {
        return String((error as Error).stack ?? (error as Error).message);
    }
    return typeof error === 'string' ? error : JSON.stringify(error);
}

function failOnRuntimeErrors(where: string): void {
    const errors = takeRuntimeErrors();
    if (errors.length > 0) {
        throw new Error(`Unexpected webview runtime error(s) ${where}:\n${errors.map(describeRuntimeError).join('\n')}`);
    }
}

// A root hook: this module is imported from spec files, so mocha's globals exist while it loads.
// The page reports its own uncaught errors as `telemetry` messages (tryRun funnels them there), and
// a suite that let one pass would be asserting on a page that threw its way through the test.
beforeEach(function () {
    postedMessages.length = 0;
});

afterEach(function () {
    failOnRuntimeErrors(`by "${this.currentTest?.fullTitle() ?? 'unknown test'}", its hooks, or anything that ran since the previous test (spec files loading, for the first)`);
});

// Mock acquireVsCodeApi for webview tests. The real `setState` replaces the persisted state
// wholesale, so this one does too. The object lives for the whole mocha run, so a test that needs
// a clean slate calls `resetWebviewState()` rather than relying on an earlier file to clear it.
const state: Record<string, any> = {};

export function resetWebviewState(): void {
    for (const key of Object.keys(state)) {
        delete state[key];
    }
}

(global as any).acquireVsCodeApi = () => ({
    postMessage: (message: any) => {
        postedMessages.push(message);
        // tryRun reports an uncaught listener error as a telemetry exception; the afterEach hook
        // above fails the test over one instead of letting it pass silently.
        if (message?.command === 'telemetry' && message.telemetryType === 'exception') {
            runtimeErrors.push(message.args?.[0] ?? message);
        }
    },
    getState: () => state,
    setState: (s: Record<string, any>) => {
        // Copied first: the webview's own setState hands back the object getState returned.
        const next = { ...s };
        resetWebviewState();
        Object.assign(state, next);
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
