import * as assert from 'assert';
import * as vscode from 'vscode';
import { defaultTitlebarStyle, getFocusTitlebarImage, loadFocusTitlebarStyles, resolveTitlebarGfxName } from '../previewdef/focustree/titlebar';
import { clearDlcZipCache } from '../util/fileloader';

// Covers the focus-frame titlebar fallback: a focus without text_icon renders through the
// default_style entry of 00_titlebar_styles.txt instead of having no titlebar at all.
describe('previewdef/focustree/titlebar', () => {
    it('defaults to the "default_style" style name', () => {
        assert.strictEqual(defaultTitlebarStyle, 'default_style');
    });

    it('resolves an explicit text_icon from the style table', () => {
        const styles = { text_icon_a: 'GFX_focus_titlebar_a', default_style: 'GFX_focus_titlebar_default' };
        assert.strictEqual(resolveTitlebarGfxName('text_icon_a', styles), 'GFX_focus_titlebar_a');
    });

    it('falls back to default_style when the focus has no text_icon', () => {
        const styles = { default_style: 'GFX_focus_titlebar_default' };
        assert.strictEqual(resolveTitlebarGfxName(undefined, styles), 'GFX_focus_titlebar_default');
    });

    it('returns undefined when the explicit text_icon is missing from the style table', () => {
        const styles = { default_style: 'GFX_focus_titlebar_default' };
        assert.strictEqual(resolveTitlebarGfxName('text_icon_a', styles), undefined);
    });

    it('returns undefined when no text_icon and no default_style entry exists', () => {
        const styles = { other_style: 'GFX_other' };
        assert.strictEqual(resolveTitlebarGfxName(undefined, styles), undefined);
        assert.strictEqual(resolveTitlebarGfxName(undefined, {}), undefined);
    });
});

// End-to-end repro of the default_style fallback against the real-world file formats:
// a style file with `default = yes` and the four state keys (unavailable/completed/available/
// current), and a nationalfocusview.gfx carrying the GFX_focus_can_start sprite.
describe('previewdef/focustree/titlebar default_style integration', function () {
    const File = vscode.FileType.File;
    const realGetConfig = (vscode.workspace as any).getConfiguration;
    const realStat = (vscode.workspace.fs as any).stat;
    const realReadFile = (vscode.workspace.fs as any).readFile;
    const realReadDirectory = (vscode.workspace.fs as any).readDirectory;
    const realWorkspaceFolders = (vscode.workspace as any).workspaceFolders;

    // Mirrors vanilla/MD common/national_focus/00_titlebar_styles.txt: extra keys must not
    // disturb the name -> available map.
    const titlebarStylesContent = `style = {
	name = default_style
	default = yes
	unavailable = GFX_focus_unavailable
	completed = GFX_focus_completed
	available = GFX_focus_can_start
	current = GFX_focus_current
}
style = {
	name = JOINT_focus_style
	unavailable = GFX_focus_unavailable_joint
	completed = GFX_focus_completed_joint
	available = GFX_focus_can_start_joint
	current = GFX_focus_current_joint
}`;

    const gfxContent = `spriteTypes = {
	spriteType = {
		name = "GFX_focus_can_start"
		textureFile = "gfx/interface/focusview/titlebar/focus_can_start_bg.png"
	}
}`;

    // 1x1 PNG so imageCache can pass it through without a real DDS on disk.
    const png1x1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

    beforeEach(function () {
        (vscode.workspace as any).workspaceFolders = [{ uri: vscode.Uri.parse('file:///mod'), name: 'mod', index: 0 }];
        (vscode.workspace as any).getConfiguration = () => ({
            get: () => undefined, update: () => Promise.resolve(), inspect: () => undefined,
            modFile: '', loadDlcContents: false, inlayWindowGfxRoots: [],
        });
        (vscode.workspace.fs as any).stat = async () => ({ type: File, mtime: 1, ctime: 0, size: 0 });
        (vscode.workspace.fs as any).readDirectory = async () => [];
        (vscode.workspace.fs as any).readFile = async (uri: any) => {
            const p = String(uri.fsPath ?? uri.path ?? '').replace(/\\/g, '/');
            if (p.endsWith('common/national_focus/00_titlebar_styles.txt')) { return Buffer.from(titlebarStylesContent); }
            if (p.endsWith('interface/nationalfocusview.gfx')) { return Buffer.from(gfxContent); }
            if (p.endsWith('gfx/interface/focusview/titlebar/focus_can_start_bg.png')) { return png1x1; }
            throw new Error('unexpected read: ' + p);
        };
    });

    afterEach(async function () {
        (vscode.workspace as any).workspaceFolders = realWorkspaceFolders;
        (vscode.workspace as any).getConfiguration = realGetConfig;
        (vscode.workspace.fs as any).stat = realStat;
        (vscode.workspace.fs as any).readDirectory = realReadDirectory;
        (vscode.workspace.fs as any).readFile = realReadFile;
        await clearDlcZipCache();
    });

    it('parses the real-world style file format into a name -> available map', async function () {
        const styles = await loadFocusTitlebarStyles();
        assert.strictEqual(styles['default_style'], 'GFX_focus_can_start');
        assert.strictEqual(styles['JOINT_focus_style'], 'GFX_focus_can_start_joint');
    });

    it('resolves the default_style titlebar image for a focus without text_icon', async function () {
        const styles = await loadFocusTitlebarStyles();
        const image = await getFocusTitlebarImage(undefined, styles);
        assert.ok(image, 'expected a resolved image for the default_style fallback');
        assert.strictEqual(image!.width, 1);
        assert.strictEqual(image!.height, 1);
    });

    it('returns undefined when the fallback style is missing from the style file', async function () {
        const styles = await loadFocusTitlebarStyles();
        const image = await getFocusTitlebarImage('no_such_style', styles);
        assert.strictEqual(image, undefined);
    });
});

