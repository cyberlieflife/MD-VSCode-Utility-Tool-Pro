// Unit-test setup: stub out the `vscode` module so pure-function tests can
// load source files that import it.
//
// Source files under src/util and src/previewdef routinely do
// `import * as vscode from 'vscode';` at the top, which compiles to
// `const vscode = require('vscode')` under commonjs. The real vscode module
// only exists inside the extension host, so mocha + plain Node would throw
// MODULE_NOT_FOUND the moment any test transitively requires such a source
// file.
//
// This setup file is wired into the mocha invocation through the `--require`
// flag in the npm test script. It runs before any test file is loaded.

const Module = require('module');
const path = require('path');

function buildStub() {
    function noop() { return undefined; }
    function disposable() { return { dispose: noop }; }

    const FileType = { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 };

    const Uri = {
        file(p: string) {
            const fsPath = String(p);
            return { fsPath, path: '/' + fsPath.replace(/\\/g, '/'), scheme: 'file', toString: () => 'file://' + fsPath };
        },        parse(v: string) {
            // 与真实 API 一致：'file://' 前缀不属于 fsPath。解析往返（toString → parse）是生产代码
            // 常见的做法（缓存键就是 URI 字符串），旧的最小实现会让 fsPath 带上前缀。
            let fsPath = String(v);
            let path = fsPath;
            if (fsPath.startsWith('file://')) {
                fsPath = fsPath.slice('file://'.length);
                path = '/' + fsPath;
            }
            return { fsPath, path, scheme: 'file', toString: () => v };
        },
        joinPath(base: any, ...pathSegments: string[]) {
            const basePath = (base && base.fsPath) || '';
            const fsPath = [basePath, ...pathSegments].join('/').replace(/\\/g, '/');
            return { fsPath, path: '/' + fsPath, scheme: 'file', toString: () => 'file://' + fsPath };
        },
    };

    const workspace = {
        getConfiguration: () => ({
            get: (_k: any) => undefined,
            update: () => Promise.resolve(),
            inspect: () => undefined,
        }),
        workspaceFolders: undefined,
        getWorkspaceFolder: () => undefined,
        onDidChangeConfiguration: disposable,
        onDidChangeTextDocument: disposable,
        onDidCloseTextDocument: disposable,
        onDidChangeWorkspaceFolders: disposable,
        onDidCreateFiles: disposable,
        onDidDeleteFiles: disposable,
        onDidRenameFiles: disposable,
        createFileSystemWatcher: () => ({
            onDidCreate: disposable,
            onDidDelete: disposable,
            onDidChange: disposable,
            dispose: () => undefined,
        }),
        textDocuments: [],
        fs: {
            stat: async () => ({ type: FileType.File, mtime: 0, ctime: 0, size: 0 }),
            readDirectory: async () => [],
            // Reads real files when the path exists (so tests of code that loads bundled assets
            // see their content); missing paths keep returning an empty buffer, matching the
            // original stub behaviour.
            readFile: async (uri: any) => {
                try {
                    return require('fs').readFileSync(uri.fsPath);
                } catch (e) {
                    return new Uint8Array();
                }
            },
            writeFile: async () => undefined,
            createDirectory: async () => undefined,
        },
    };

    const window = {
        showErrorMessage: async () => undefined,
        showInformationMessage: async () => undefined,
        showWarningMessage: async () => undefined,
        showQuickPick: async () => undefined,
        showOpenDialog: async () => undefined,
        setStatusBarMessage: () => disposable(),
        // The shared index-progress session opens a notification with this. The stub runs the task
        // to completion with a reporting handle, which is all the index builds need from it.
        withProgress: async (_options: any, task: (report: any, token: any) => Promise<unknown>) => {
            return await task(
                { report: () => undefined },
                { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: noop }) },
            );
        },
        createOutputChannel: () => ({
            appendLine: noop, append: noop, show: noop, hide: noop, dispose: noop, name: '',
        }),
        createStatusBarItem: () => ({
            text: '', tooltip: '', command: undefined,
            show: noop, hide: noop, dispose: noop,
        }),
        activeTextEditor: undefined,
        onDidChangeActiveTextEditor: disposable,
        registerWebviewPanelSerializer: () => disposable(),
    };

    const commands = {
        registerCommand: () => disposable(),
        executeCommand: async () => undefined,
        getCommands: async () => [],
    };

    // Provider-layer tests replace this handler on the shared object to capture the provider
    // that registerModifierInlayHint passes to the extension host.
    const languages = {
        registerInlayHintsProvider: () => disposable(),
    };

    const ConfigurationTarget = { Global: 1, Workspace: 2 };
    const StatusBarAlignment = { Left: 1, Right: 2 };
    const ViewColumn = { Active: -1, Beside: -2, One: 1, Two: 2, Three: 3 };

    function Position(this: any, line: number, character: number) { this.line = line; this.character = character; }
    function Range(this: any, s: any, e: any) { this.start = s; this.end = e; }

    // Real VS Code's Disposable only wraps a cleanup function; code that builds one directly (the
    // parent-mods listener set does) needs the constructor here.
    class Disposable {
        constructor(private readonly callOnDispose?: () => unknown) {}
        dispose(): void {
            this.callOnDispose?.();
        }
        static from(...items: { dispose(): unknown }[]): Disposable {
            return new Disposable(() => items.forEach(item => item.dispose()));
        }
    }

    class InlayHint {
        position: any;
        label: any;
        paddingLeft = false;
        constructor(position: any, label: any) {
            this.position = position;
            this.label = label;
        }
    }

    return {
        Uri,
        workspace,
        window,
        commands,
        languages,
        env: {},
        FileType,
        ConfigurationTarget,
        StatusBarAlignment,
        ViewColumn,
        Position,
        Range,
        InlayHint,
        InlayHintKind: { Type: 1, Parameter: 2 },
        ProgressLocation: { SourceControl: 1, Window: 10, Notification: 15 },
        WorkspaceEdit: class {
            public ops: { kind: string; pos?: any; range?: any; text?: string }[] = [];
            public insert(_uri: any, pos: any, text: string) { this.ops.push({ kind: 'insert', pos, text }); }
            public delete(_uri: any, range: any) { this.ops.push({ kind: 'delete', range }); }
            public replace(_uri: any, range: any, text: string) { this.ops.push({ kind: 'replace', range, text }); }
        },
        Disposable,
        // Event semantics match the real vscode API: `event(cb)` registers the listener and
        // returns a disposable, `fire` invokes the registered listeners. The previous stub
        // dropped listeners, which made event-firing code paths (e.g. gfxindex build
        // notifications) untestable; the existing tests inject their own event mocks and are
        // unaffected.
        EventEmitter: class {
            private listeners: ((value: any) => void)[] = [];
            event = (listener: (value: any) => void) => {
                this.listeners.push(listener);
                return { dispose: () => { this.listeners = this.listeners.filter(l => l !== listener); } };
            };
            fire = (value: any) => { for (const listener of [...this.listeners]) { listener(value); } };
            dispose = () => { this.listeners = []; };
        },
        TreeItem: class { label: any; constructor(label: any) { this.label = label; } },
        TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
        ThemeIcon: class { id: any; constructor(id: any) { this.id = id; } },
    };
}

const origResolve = (Module as any)._resolveFilename;
(Module as any)._resolveFilename = function (request: string, parent: any, ...rest: any[]) {
    if (request === 'vscode') {
        return path.join(__dirname, '__vscode_stub__');
    }
    // Preview sources import their view html/css and file templates through webpack's
    // raw-loader, which a tsc-only test run does not have. Serve those imports the way
    // raw-loader would: resolve them to the source files (the compiled module lives under
    // out-test/, the raw asset still under src/) and export their contents as the module's
    // default string.
    if (/\.(html|css|txt)$/.test(request) && parent && parent.filename) {
        // Compiled layout is out-test/src/..., the raw asset lives at src/...: drop the
        // out-test segment to map back to the source tree.
        const resolved = path.resolve(path.dirname(parent.filename), request);
        return resolved.replace(/([\\/])out-test(?=[\\/])/, '$1');
    }
    return origResolve.call(this, request, parent, ...rest);
};

for (const rawExtension of ['.html', '.css', '.txt']) {
    (require.extensions as any)[rawExtension] = (module: any, filename: string) => {
        module.exports = require('fs').readFileSync(filename, 'utf8');
    };
}

// `def.d.ts` declares a handful of compile-time globals (IS_WEB_EXT, VERSION,
// EXTENSION_ID). The webpack build wires these up via DefinePlugin; under
// Node + tsc they are undefined. Tests that load modules referencing them
// (e.g. fileloader.ts) need them set on globalThis.
(globalThis as any).IS_WEB_EXT = false;
(globalThis as any).VERSION = 'test';
(globalThis as any).EXTENSION_ID = 'test.test';

const stub = buildStub();
(require.cache as any)[path.join(__dirname, '__vscode_stub__')] = {
    id: 'vscode',
    filename: 'vscode',
    loaded: true,
    exports: stub,
    children: [],
    paths: [],
};
