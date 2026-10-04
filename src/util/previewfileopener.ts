import * as vscode from 'vscode';
import { dirUri, mkdirs, writeFile } from './vsccommon';
import { getFilePathFromMod, getHoiOpenedFileOriginalUri, readFileFromModOrHOI4 } from './fileloader';
import { forceError } from './common';

export interface OpenOrCopyHoiFileOptions {
    viewColumn?: vscode.ViewColumn;
    mustOpenFolderMessage: string;
    selectFolderMessage: string;
    failedToOpenMessage: (errorMessage: string) => string;
}

export interface CopyFilesIntoWorkspaceOptions {
    mustOpenFolderMessage: string;
    selectFolderMessage: string;
    failedToOpenMessage: (errorMessage: string) => string;
}

/**
 * Returns, for each HOI4-relative path, the workspace uri to edit: the file's own uri when it
 * lives in an opened mod, or a workspace copy created from the HOI4 install when it does not.
 * The folder picker runs once for the whole batch. A `undefined` entry means the caller must
 * stop (no workspace folder, folder pick cancelled, or the copy failed).
 */
export async function copyFilesIntoWorkspace(files: string[], options: CopyFilesIntoWorkspaceOptions): Promise<(vscode.Uri | undefined)[]> {
    const filePathsInMod = await Promise.all(files.map(async (f) => {
        const path = await getFilePathFromMod(f);
        return path ? getHoiOpenedFileOriginalUri(path) : undefined;
    }));
    const filePathsNotInMod = filePathsInMod.map((v, i) => !v ? files[i] : undefined);

    if (filePathsNotInMod.every(v => v === undefined)) {
        return filePathsInMod;
    }

    if (!vscode.workspace.workspaceFolders?.length) {
        await vscode.window.showErrorMessage(options.mustOpenFolderMessage);
        return files.map(() => undefined);
    }

    let targetFolderUri = vscode.workspace.workspaceFolders[0].uri;
    if (vscode.workspace.workspaceFolders.length > 1) {
        const folder = await vscode.window.showWorkspaceFolderPick({ placeHolder: options.selectFolderMessage });
        if (!folder) {
            return files.map(() => undefined);
        }

        targetFolderUri = folder.uri;
    }

    const copied = await Promise.all(filePathsNotInMod.map(async (v, i) => {
        const file = v;
        if (file === undefined) {
            return filePathsInMod[i];
        }

        try {
            const [buffer] = await readFileFromModOrHOI4(file);
            const targetPath = vscode.Uri.joinPath(targetFolderUri, file);
            await mkdirs(dirUri(targetPath));
            await writeFile(targetPath, buffer);
            return targetPath;
        } catch (e) {
            await vscode.window.showErrorMessage(options.failedToOpenMessage(forceError(e).toString()));
            return undefined;
        }
    }));

    return copied;
}

export async function openOrCopyHoiFile(file: string, start: number | undefined, end: number | undefined, options: OpenOrCopyHoiFileOptions, lineNumber?: number): Promise<void> {
    const [uri] = await copyFilesIntoWorkspace([file], options);
    if (!uri) {
        return;
    }

    try {
        const document = await vscode.workspace.openTextDocument(uri);
        const line = lineNumber === undefined ? undefined : Math.max(0, Math.min(lineNumber, document.lineCount - 1));
        await vscode.window.showTextDocument(document, {
            selection: start !== undefined && end !== undefined ? new vscode.Range(document.positionAt(start), document.positionAt(end)) :
                (line !== undefined ? document.lineAt(line).range : undefined),
            viewColumn: options.viewColumn,
        });
    } catch (e) {
        await vscode.window.showErrorMessage(options.failedToOpenMessage(forceError(e).toString()));
    }
}
