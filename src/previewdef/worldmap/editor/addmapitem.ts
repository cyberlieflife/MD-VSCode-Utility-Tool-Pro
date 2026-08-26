import * as vscode from 'vscode';
import stateTemplate from './statetemplate.txt';
import strategicRegionTemplate from './strategicregiontemplate.txt';
import { AddMapItemMessage, State, StrategicRegion, WorldMapData, WorldMapMessage } from '../definitions';
import { loadStateFromContent } from '../loader/states';
import { localize } from '../../../util/i18n';
import { dirUri, getPreferedIndent, mkdirs, writeFile } from '../../../util/vsccommon';
import { loadStrategicRegionFromContent } from '../loader/strategicregion';
import { forceError } from '../../../util/common';

export async function addMapItem(msg: AddMapItemMessage, cachedWorldMap: WorldMapData): Promise<WorldMapMessage[]> {
    const type = msg.type;
    const typeName = localize('worldmap.openfiletype.' + type as any, type);

    if (!vscode.workspace.workspaceFolders?.length) {
        await vscode.window.showErrorMessage(localize('worldmap.mustopenafolder.add', 'Must open a folder before adding {0} file.', typeName));
        return [];
    }

    let targetFolderUri = vscode.workspace.workspaceFolders[0].uri;
    if (vscode.workspace.workspaceFolders.length > 1) {
        const folder = await vscode.window.showWorkspaceFolderPick({ placeHolder: localize('worldmap.selectafolder.create', 'Select a folder to create {0} file', typeName) });
        if (!folder) {
            return [];
        }

        targetFolderUri = folder.uri;
    }

    if (type === 'state') {
        return addState(targetFolderUri, cachedWorldMap);
    } else if (type === 'strategicregion') {
        return addStrategicRegion(targetFolderUri, cachedWorldMap);
    }

    return [];
}

async function addState(targetFolderUri: vscode.Uri, cachedWorldMap: WorldMapData): Promise<WorldMapMessage[]> {
    const result: WorldMapMessage[] = [];
    const newStateId = cachedWorldMap.statesCount;

    const indent = getPreferedIndent();
    const content = stateTemplate.replace(/\{id\}/g, newStateId.toString()).replace(/\t/g, indent);
    const file = 'history/states/' + newStateId.toString() + '.txt';
    const targetUri = vscode.Uri.joinPath(targetFolderUri, file);
    
    try {
        await mkdirs(dirUri(targetUri));
        await writeFile(targetUri, Buffer.from(content));
    } catch (e) {
        await vscode.window.showErrorMessage(localize('worldmap.add.failed.write', 'Failed to create {0} file: {1}.', localize('worldmap.openfiletype.state', 'state'), forceError(e).toString()));
        return result;
    }
    // The counter is bumped only after the file is on disk, so a failed write never desyncs the
    // next id from the cached arrays.
    cachedWorldMap.statesCount++;

    const parsedStates = loadStateFromContent(content, file, []);
    if (parsedStates.length === 0) {
        // Template parse failure: roll back the just-written file so id and cache stay consistent.
        try {
            await vscode.workspace.fs.delete(targetUri, { recursive: false });
        } catch {
            // Rollback failure leaves a stray file; the error message below still tells the user.
        }
        await vscode.window.showErrorMessage(localize('worldmap.add.failed.parse', 'Failed to parse the new {0} file.', localize('worldmap.openfiletype.state', 'state')));
        return result;
    }

    const newState: State = {
        ...parsedStates[0],
        boundingBox: { x: 0, y: 0, w: 0, h: 0 },
        centerOfMass: { x: 0, y: 0 },
        mass: 0,
    };
    // Keep the extension-host cache in sync so a province can be moved into the new state
    // immediately, without waiting for a document-change reload to pick up the new file.
    cachedWorldMap.states[newStateId] = newState;

    result.push({
        command: 'states',
        data: JSON.stringify([newState]),
        start: newStateId,
        end: newStateId + 1,
        count: cachedWorldMap.statesCount,
    });

    result.push({
        command: 'selectmapitem',
        type: 'state',
        id: newStateId,
        enterEditMode: true,
    });

    // mark dirty
    const workspaceEdit = new vscode.WorkspaceEdit();
    workspaceEdit.replace(targetUri, new vscode.Range(0, 0, 0, 5), 'state');
    await vscode.workspace.applyEdit(workspaceEdit);
    return result;
}

async function addStrategicRegion(targetFolderUri: vscode.Uri, cachedWorldMap: WorldMapData): Promise<WorldMapMessage[]> {
    const result: WorldMapMessage[] = [];
    const newStrategicRegionId = cachedWorldMap.strategicRegionsCount;

    const indent = getPreferedIndent();
    const content = strategicRegionTemplate.replace(/\{id\}/g, newStrategicRegionId.toString()).replace(/\t/g, indent);
    const file = 'map/strategicregions/' + newStrategicRegionId.toString() + '.txt';
    const targetUri = vscode.Uri.joinPath(targetFolderUri, file);
    
    try {
        await mkdirs(dirUri(targetUri));
        await writeFile(targetUri, Buffer.from(content));
    } catch (e) {
        await vscode.window.showErrorMessage(localize('worldmap.add.failed.write', 'Failed to create {0} file: {1}.', localize('worldmap.openfiletype.strategicregion', 'strategic region'), forceError(e).toString()));
        return result;
    }
    // Bump the counter only after the file is on disk (see addState).
    cachedWorldMap.strategicRegionsCount++;

    const parsedRegions = loadStrategicRegionFromContent(content, file, []);
    if (parsedRegions.length === 0) {
        try {
            await vscode.workspace.fs.delete(targetUri, { recursive: false });
        } catch {
            // Rollback failure leaves a stray file; the error message below still tells the user.
        }
        await vscode.window.showErrorMessage(localize('worldmap.add.failed.parse', 'Failed to parse the new {0} file.', localize('worldmap.openfiletype.strategicregion', 'strategic region')));
        return result;
    }

    const newStrategicRegion: StrategicRegion = {
        ...parsedRegions[0],
        boundingBox: { x: 0, y: 0, w: 0, h: 0 },
        centerOfMass: { x: 0, y: 0 },
        mass: 0,
    };
    // Keep the extension-host cache in sync so a province can be moved into the new strategic
    // region immediately, without waiting for a document-change reload.
    cachedWorldMap.strategicRegions[newStrategicRegionId] = newStrategicRegion;

    result.push({
        command: 'strategicregions',
        data: JSON.stringify([newStrategicRegion]),
        start: newStrategicRegionId,
        end: newStrategicRegionId + 1,
        count: cachedWorldMap.strategicRegionsCount,
    });

    result.push({
        command: 'selectmapitem',
        type: 'strategicregion',
        id: newStrategicRegionId,
        enterEditMode: true,
    });

    // mark dirty
    const workspaceEdit = new vscode.WorkspaceEdit();
    workspaceEdit.replace(targetUri, new vscode.Range(0, 0, 0, 16), 'strategic_region');
    await vscode.workspace.applyEdit(workspaceEdit);
    return result;
}