import * as vscode from 'vscode';
import { ConfigurationKey } from '../constants';
import { getConfiguration } from "./vsccommon";

// Live feature flags. These are `let` (not `const`) so they can be refreshed when the user changes
// settings. Importers using ES `import { ... }` syntax read the property dynamically at access time
// (TypeScript compiles to `const mod = require(...); mod.flag`), so they always see the current value. Index-backed
// flags (sharedFocusIndex/gfxIndex/localisationIndex) still need a reload to (re)build their index;
// refreshing here keeps the flag consistent in the meantime.
export let useConditionInFocus = getConfiguration().useConditionInFocus;
export let eventTreePreview = getConfiguration().eventTreePreview;
export let sharedFocusIndex = getConfiguration().sharedFocusIndex;
export let gfxIndex = getConfiguration().gfxIndex;
export let localisationIndex = getConfiguration().localisationIndex;
// The four preview switches gate the idea, character, decision and balance-of-power previews.
export let ideaPreview = getConfiguration().ideaPreview;
export let decisionPreview = getConfiguration().decisionPreview;
export let characterPreview = getConfiguration().characterPreview;
export let bopPreview = getConfiguration().bopPreview;
// Gates the idea swap chain index the idea preview reads.
export let ideaSwapIndex = getConfiguration().ideaSwapIndex;
// 科技树预览是否提供国家下拉、并按国家解析科技图标；同时决定 loader 是否构建国家清单。
export let technologyCountryIcons = getConfiguration().technologyCountryIcons;
// 焦点树的布局模式：standard 用预览内置的网格，gui 读游戏 nationalfocusview.gui 的几何。
export let focusTreeLayout = getConfiguration().focusTreeLayout ?? 'standard';
// 前置连线按哪种状态取色：available（蓝）或 completed（绿）。
export let focusTreePrerequisiteLines = getConfiguration().focusTreePrerequisiteLines ?? 'available';

export function refreshFeatureFlags(): void {
    const config = getConfiguration();
    useConditionInFocus = config.useConditionInFocus;
    eventTreePreview = config.eventTreePreview;
    sharedFocusIndex = config.sharedFocusIndex;
    gfxIndex = config.gfxIndex;
    localisationIndex = config.localisationIndex;
    ideaPreview = config.ideaPreview;
    decisionPreview = config.decisionPreview;
    characterPreview = config.characterPreview;
    bopPreview = config.bopPreview;
    ideaSwapIndex = config.ideaSwapIndex;
    technologyCountryIcons = config.technologyCountryIcons;
    focusTreeLayout = config.focusTreeLayout ?? 'standard';
    focusTreePrerequisiteLines = config.focusTreePrerequisiteLines ?? 'available';
}

export function registerFeatureFlags(): vscode.Disposable {
    return vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration(ConfigurationKey)) {
            refreshFeatureFlags();
        }
    });
}
