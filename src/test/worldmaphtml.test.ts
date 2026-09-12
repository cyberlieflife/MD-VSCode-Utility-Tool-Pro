import * as assert from 'assert';
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { html } from '../util/html';
import { WorldMap } from '../previewdef/worldmap/worldmap';
import { contextContainer } from '../context';

// Extension root the tests run from (out-test/src/test -> project root); its static/ folder
// holds the bundled webview assets the world map html must inline.
const extensionRoot = path.resolve(__dirname, '..', '..', '..');

function makePanel() {
    let lastAssignedHtml = '';
    const webview = {
        postMessage: () => Promise.resolve(true),
        asWebviewUri: (u: unknown) => u,
        cspSource: 'https://testcontainers.vscode-cdn.net',
        get html() {
            return lastAssignedHtml;
        },
        set html(v: string) {
            lastAssignedHtml = v;
        },
        onDidReceiveMessage: () => ({ dispose() { /* no-op */ } }),
    };
    const panel = {
        webview,
        visible: true,
        onDidChangeViewState: () => ({ dispose() { /* no-op */ } }),
        onDidDispose: () => ({ dispose() { /* no-op */ } }),
    };
    return {
        panel: panel as any,
        get html() {
            return lastAssignedHtml;
        },
    };
}

describe('previewdef/worldmap html inlining', () => {
    before(function () {
        // static/ is gitignored: the bundled assets only exist after a webpack build. CI runs
        // its test step before packaging, so there the suite has nothing real to assert against;
        // the packaging step itself still fails the release if the build breaks.
        const assets = ['common.js', 'worldmap.js', 'common.css', 'codicon.css', 'codicon.ttf']
            .every(name => fs.existsSync(path.join(extensionRoot, 'static', name)));
        if (!assets) {
            this.skip();
        }

        contextContainer.current = { extensionUri: vscode.Uri.file(extensionRoot) } as any;
    });

    after(() => {
        contextContainer.current = null;
    });

    async function initializeWorldMap() {
        const panel = makePanel();
        await new WorldMap(panel.panel).initialize();
        return panel.html;
    }

    it('inlines every script and stylesheet so the page makes no external resource requests', async () => {
        const result = await initializeWorldMap();
        assert.ok(!result.includes('<script src='), 'scripts must be inlined, not linked');
        assert.ok(!result.includes('<link rel="stylesheet"'), 'stylesheets must be inlined, not linked');
    });

    it('embeds the bundled scripts and the shared stylesheet verbatim', async () => {
        const result = await initializeWorldMap();
        for (const asset of ['common.js', 'worldmap.js', 'common.css']) {
            const content = fs.readFileSync(path.join(extensionRoot, 'static', asset), 'utf8');
            assert.ok(result.includes(content), asset + ' must be embedded in the html');
        }
    });

    it('embeds the codicon font as a data URI instead of an external font request', async () => {
        const result = await initializeWorldMap();
        assert.ok(result.includes('data:font/ttf;base64,'), 'the icon font must be a data URI');
        assert.ok(!result.includes('./codicon.ttf'), 'no external codicon.ttf reference may remain');
    });

    it('keeps the bootstrap inline scripts for the localisation table and settings', async () => {
        const result = await initializeWorldMap();
        assert.ok(result.includes('window.__i18ntable'));
        assert.ok(result.includes('window.__enableSupplyArea'));
    });

    it('allows data: font sources in the CSP for the embedded icon font', async () => {
        const result = await initializeWorldMap();
        assert.ok(/font-src[^;]*data:/.test(result));
    });
});

describe('util/html inline tag escaping', () => {
    const webview = { asWebviewUri: (u: unknown) => u, cspSource: 'https://csp.test' } as any;

    it('escapes an inline </script> inside script content so the tag is not closed early', () => {
        const result = html(webview, '', [{ content: 'var x = "</script>";' }]);
        assert.ok(result.includes('var x = "<\\/script>";'));
        assert.ok(!result.includes('var x = "</script>"'));
    });

    it('escapes an inline </style> inside style content so the tag is not closed early', () => {
        const result = html(webview, '', [], [{ content: 'a::after { content: "</style"; }' }]);
        assert.ok(result.includes('a::after { content: "<\\/style"; }'));
        assert.ok(!result.includes('content: "</style"'));
    });
});
