import * as vscode from 'vscode';
import * as path from 'path';
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
 * Refuses a copy target that leaves the workspace folder. `..` is refused by the file resolver
 * too, but the target is joined from a path a preview supplied, so the check belongs here, before
 * anything is read from the game install.
 */
async function ensureCopyTargetIsInsideWorkspace(targetPath: vscode.Uri, workspaceRoot: vscode.Uri): Promise<void> {
    if (targetPath.scheme !== 'file' || workspaceRoot.scheme !== 'file') {
        return;
    }

    const relative = path.relative(workspaceRoot.fsPath, targetPath.fsPath);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error('Copy target resolves outside the workspace');
    }
    if (hasDotPrefixedSegment(relative)) {
        throw new Error('Copy target is inside a dot-prefixed path');
    }
}

// `.` and `..` are not names: the file resolver refuses `..`, and joinPath drops `.`.
function hasDotPrefixedSegment(file: string): boolean {
    return file
        .split(/[\\/]/)
        .some((segment) => segment.startsWith('.') && segment !== '.' && segment !== '..');
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
            // Both checks run before the read: a refused target must not cost a file read, and a
            // dot-prefixed folder is not a place to drop a copy of a game file.
            const targetPath = vscode.Uri.joinPath(targetFolderUri, file);
            if (hasDotPrefixedSegment(file)) {
                throw new Error('Copy target is inside a dot-prefixed path');
            }
            await ensureCopyTargetIsInsideWorkspace(targetPath, targetFolderUri);
            const [buffer] = await readFileFromModOrHOI4(file);
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
