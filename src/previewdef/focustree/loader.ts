import { ContentLoader, LoadResultOD, Dependency, LoaderSession, mergeInLoadResult } from "../../util/loader/loader";
import { convertFocusFileNodeToJson, FocusTree, getFocusTreeWithFocusFile, getGfxNameForSearchFilter, extractOrListIds } from "./schema";
import { parseHoi4File } from "../../hoiformat/hoiparser";
import { localize } from "../../util/i18n";
import { Logger } from "../../util/logger";
import { uniq, flatten, chain } from "lodash";
import { getGfxContainerFiles } from "../../util/gfxindex";
import { sharedFocusIndex, focusTreeLayout } from "../../util/featureflags";
import { findFileByFocusKey, ensureFocusIndex } from "../../util/sharedFocusIndex";
import { focusTitlebarStylesFile, nationalFocusViewGfxFile, getFocusOverlayGfxFiles } from "./titlebar";
import { GuiFileLoader } from "../gui/loader";
import { buildFocusTreeLayout, FocusTreeLayout, FocusTreeLayoutMode, nationalFocusViewGuiFile } from "./layout";
import { addInlayGfxWarnings, listGuiGfxFiles, loadFocusInlayWindows, resolveInlayGfxFiles, resolveInlayGuiWindows, resolveInlaysForTree } from "./inlay";

export interface FocusTreeLoaderResult {
    focusTrees: FocusTree[];
    gfxFiles: string[];
    // 焦点覆盖层查图的 .gfx 文件（游戏 goals.gfx，再是设置与 descriptor 命名的）。
    overlayGfxFiles: string[];
    // 仅在 focusTreeLayout 设置为 gui 时存在；否则预览使用标准布局。
    layout?: FocusTreeLayout;
}

export type ProgressCallback = (message: string, current?: number, total?: number) => void;

const focusesGFX = 'interface/goals.gfx';

export class FocusTreeLoader extends ContentLoader<FocusTreeLoaderResult> {
    private progressListener: ProgressCallback | undefined;
    // 上一次加载使用的布局设置。设置不属于文档内容，不记录的话，翻转布局设置会命中"文本未变"
    // 的加载缓存而得不到新布局。
    private loadedLayoutMode: FocusTreeLayoutMode | undefined;

    public override async shouldReloadImpl(session: LoaderSession): Promise<boolean> {
        if (this.loadedLayoutMode !== undefined && this.loadedLayoutMode !== focusTreeLayout) {
            return true;
        }
        return super.shouldReloadImpl(session);
    }

    public setProgressListener(cb: ProgressCallback | undefined): void {
        this.progressListener = cb;
    }

    private emitProgress(message: string, current?: number, total?: number): void {
        this.progressListener?.(message, current, total);
    }

    protected async postLoad(content: string | undefined, dependencies: Dependency[], error: any, session: LoaderSession): Promise<LoadResultOD<FocusTreeLoaderResult>> {
        if (error || (content === undefined)) {
            throw error;
        }

        const constants = {};

        this.emitProgress(localize('focustree.loading.parsing', 'Parsing focus file'));
        const file = convertFocusFileNodeToJson(parseHoi4File(content, localize('infile', 'In file {0}:\n', this.file)), constants);

        if (sharedFocusIndex) {
            // The index builds asynchronously at extension activation; a preview restored right
            // after VS Code startup must wait so shared_focus resolution does not silently miss.
            await ensureFocusIndex();
            const depPaths = new Set(dependencies.map(d => d.path));
            for (const focusTree of file.focus_tree) {
                for (const sharedFocus of extractOrListIds(focusTree.shared_focus)) {
                    if (!sharedFocus) {
                        continue;
                    }
                    const filePath = findFileByFocusKey(sharedFocus);
                    if (filePath && !depPaths.has(filePath)) {
                        depPaths.add(filePath);
                        dependencies.push({type: 'focus', path: filePath});
                    }
                }
            }
        }

        const focusTreeDependencies = dependencies.filter(d => d.type === 'focus').map(d => d.path);
        if (focusTreeDependencies.length > 0) {
            this.emitProgress(localize('focustree.loading.shared', 'Loading shared focus dependencies'));
        }
        const focusTreeDepFiles = await this.loaderDependencies.loadMultiple(focusTreeDependencies, session, FocusTreeLoader);

        const importedFocusTrees = chain(focusTreeDepFiles)
            .flatMap(f => f.result.focusTrees)
            .value();

        const focusTrees = getFocusTreeWithFocusFile(file, importedFocusTrees, this.file, constants);

        // Include synthetic trees from dependent files (e.g., joint focus trees)
        focusTrees.push(...importedFocusTrees.filter(tree => tree.isSharedFocues));

        // guiResolution.gfxFiles is exactly listGuiGfxFiles() and inlayGfxResolution.resolvedFiles is
        // [] when no tree has inlays, so the short-circuit still lists the interface gfx to keep the
        // icon-resolution gfx set (result.gfxFiles) byte-identical while skipping the inlay parse work.
        let inlayGuiGfxFiles: string[] = [];
        let inlayResolvedGfxFiles: string[] = [];
        let inlayGuiFiles: string[] = [];

        if (focusTrees.every(ft => ft.inlayWindowRefs.length === 0)) {
            for (const focusTree of focusTrees) {
                focusTree.inlayWindows = [];
                focusTree.inlayConditionExprs = [];
            }
            inlayGuiGfxFiles = await listGuiGfxFiles();
        } else {
            this.emitProgress(localize('focustree.loading.inlays', 'Loading inlay windows'));
            const loadedInlays = await loadFocusInlayWindows();
            for (const focusTree of focusTrees) {
                const resolved = resolveInlaysForTree(focusTree.inlayWindowRefs, loadedInlays.inlays);
                focusTree.inlayWindows = resolved.inlayWindows;
                focusTree.inlayConditionExprs = resolved.inlayConditionExprs;
                if (focusTree.inlayWindowRefs.length > 0) {
                    focusTree.warnings.push(...loadedInlays.warnings);
                }
                focusTree.warnings.push(...resolved.warnings);
            }

            this.emitProgress(localize('focustree.loading.inlay_gui', 'Resolving inlay GUI files'));
            const guiResolution = await resolveInlayGuiWindows(chain(focusTrees).flatMap(ft => ft.inlayWindows).value());
            for (const focusTree of focusTrees) {
                focusTree.warnings.push(...guiResolution.warnings.filter(w => focusTree.inlayWindows.some(inlay => inlay.id === w.source)));
            }

            this.emitProgress(localize('focustree.loading.inlay_gfx', 'Resolving inlay sprites'));
            const inlayGfxResolution = await resolveInlayGfxFiles(chain(focusTrees).flatMap(ft => ft.inlayWindows).value());
            for (const focusTree of focusTrees) {
                addInlayGfxWarnings(focusTree.inlayWindows, focusTree.warnings);
            }

            inlayGuiGfxFiles = guiResolution.gfxFiles;
            inlayResolvedGfxFiles = inlayGfxResolution.resolvedFiles;
            inlayGuiFiles = guiResolution.guiFiles;
        }

        const gfxDependencies = [
            ...dependencies.filter(d => d.type === 'gfx').map(d => d.path),
            ...flatten(focusTreeDepFiles.map(f => f.result.gfxFiles)),
            ...await getGfxContainerFiles(chain(focusTrees).flatMap(ft => Object.values(ft.focuses)).flatMap(f => [...f.icon.map(i => i.icon), f.overlay, ...f.searchFilters.map(getGfxNameForSearchFilter)]).value()),
            ...inlayGuiGfxFiles,
            ...inlayResolvedGfxFiles,
        ];

        this.loadedLayoutMode = focusTreeLayout;
        let layout: FocusTreeLayout | undefined = undefined;
        let layoutDependencies: string[] = [];
        if (focusTreeLayout === 'gui') {
            // 通过依赖加载器加载，nationalfocusview.gui 被编辑时会重载这棵树。gui 文件缺失或
            // 读不动时按标准布局继续，而不是让整个预览报错消失。
            try {
                const layoutGui = await this.loaderDependencies.loadMultiple([nationalFocusViewGuiFile], session, GuiFileLoader);
                const guiFiles = layoutGui.flatMap(r => r.result.guiFiles).map(g => g.data);
                layout = buildFocusTreeLayout(guiFiles);
                layoutDependencies = [nationalFocusViewGuiFile, ...mergeInLoadResult(layoutGui, 'dependencies')];
            } catch (e) {
                Logger.error(`Cannot read ${nationalFocusViewGuiFile} for the focus tree layout; using the standard layout: ${e}`);
            }
        }

        const overlayGfxFiles = await getFocusOverlayGfxFiles();

        return {
            result: {
                focusTrees,
                gfxFiles: uniq([...gfxDependencies, focusesGFX]),
                overlayGfxFiles,
                layout,
            },
            dependencies: uniq([
                this.file,
                focusesGFX,
                focusTitlebarStylesFile,
                nationalFocusViewGfxFile,
                ...overlayGfxFiles,
                ...gfxDependencies,
                ...chain(focusTrees).flatMap(ft => ft.inlayWindows).map(inlay => inlay.file).uniq().value(),
                ...inlayGuiFiles,
                ...focusTreeDependencies,
                ...mergeInLoadResult(focusTreeDepFiles, 'dependencies'),
                ...layoutDependencies,
            ]),
        };
    }

    public toString() {
        return `[FocusTreeLoader ${this.file}]`;
    }
}
