import * as vscode from 'vscode';
import { renderTechnologyFile } from './contentbuilder';
import { matchPathEnd } from '../../util/nodecommon';
import { PreviewProviderDef } from '../previewmanager';
import { LoaderPreview } from '../loaderpreview';
import { TechnologyTreeLoader } from './loader';
import { localize } from '../../util/i18n';

function canPreviewTechnology(document: vscode.TextDocument) {
    const uri = document.uri;
    if (matchPathEnd(uri.toString().toLowerCase(), ['common', 'technologies', '*']) && uri.path.toLowerCase().endsWith('.txt')) {
        return 0;
    }

    const text = document.getText();
    return /(technologies)\s*=\s*{/.exec(text)?.index;
}

class TechnologyTreePreview extends LoaderPreview<TechnologyTreeLoader> {
    constructor(uri: vscode.Uri, panel: vscode.WebviewPanel) {
        super(uri, panel, (file, contentProvider) => new TechnologyTreeLoader(file, contentProvider), renderTechnologyFile);
    }
}

export const technologyPreviewDef: PreviewProviderDef = {
    type: 'technology',
    displayName: () => localize('preview.type.technology', 'Technology tree (common/technologies/*.txt)'),
    canPreview: canPreviewTechnology,
    previewConstructor: TechnologyTreePreview,
};
