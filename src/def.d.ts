declare module 'vscode' {
    namespace workspace {
        export function getConfiguration(section: 'mdHoi4Utilities'): WorkspaceConfiguration & {
            readonly installPath: string;
            readonly loadDlcContents: boolean;
            readonly modFile: string;
            readonly useConditionInFocus: boolean;
            readonly eventTreePreview: boolean;
            readonly sharedFocusIndex: boolean;
            readonly gfxIndex: boolean;
            readonly localisationIndex: boolean;
            readonly enableSupplyArea: boolean;
            readonly previewLocalisation: 'Brazilian Portuguese' | 'English' | 'French' | 'German' | 'Japanese' | 'Polish' | 'Russian' | 'Simplified Chinese' | 'Spanish';
            readonly inlayWindowGfxRoots: string[];
            readonly technologyGfxRoots: string[];
            readonly worldMapRetainContextWhenHidden: boolean;
            readonly ideaPreview: boolean;
            readonly decisionPreview: boolean;
            readonly characterPreview: boolean;
            readonly bopPreview: boolean;
            readonly ideaPlaceholderIcon: string;
            readonly modifierFormatFiles: string[];
            readonly characterTraitStructuralKeys: string[];
            readonly decisionGfxFiles: string[];
            readonly ideaSwapIndex: boolean;
            readonly focusTreeLayout: 'standard' | 'gui';
            readonly focusTreePrerequisiteLines: 'available' | 'completed';
            readonly focusOverlayGfxFiles: string[];
        };
    }
}

declare module '*.html' {
    const _default: string;
    export default _default;
}

declare module '*.css' {
    const _default: string;
    export default _default;
}

declare module '*.txt' {
    const _default: string;
    export default _default;
}

declare const VERSION: string;
declare const EXTENSION_ID: string;
declare const IS_WEB_EXT: boolean;
