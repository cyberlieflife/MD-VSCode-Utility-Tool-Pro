import * as vscode from 'vscode';
import { localize } from '../../../util/i18n';
import { copyFilesIntoWorkspace } from '../../../util/previewfileopener';
import { MoveProvinceMessage, WorldMapData, WorldMapMessage } from '../definitions';
import { parseHoi4File, Token } from '../../../hoiformat/hoiparser';
import { convertNodeToJson, Enum, SchemaDef } from '../../../hoiformat/schema';

export async function moveProvince(msg: MoveProvinceMessage, cachedWorldMap: WorldMapData): Promise<WorldMapMessage[]> {
    const result: WorldMapMessage[] = [];
    const { type, province, to, from, toFile, fromFile } = msg;
    const typeName = localize('worldmap.openfiletype.' + type as any, type);
    const regionArray = type === 'state' ? cachedWorldMap.states : cachedWorldMap.strategicRegions;
    const toRegion = regionArray[to];
    const fromRegion = from !== undefined ? regionArray[from] : undefined;
    if (!toRegion) {
        // No target region in the cached data: move would silently drop the province otherwise.
        await vscode.window.showErrorMessage(localize('worldmap.edit.failed.notarget', 'The target {0} does not exist in the world map data. Please reload the world map and try again.', typeName));
        return result;
    }
    if (from === to && fromRegion && 'victoryPoints' in fromRegion && province in fromRegion.victoryPoints) {
        await vscode.window.showErrorMessage(localize('worldmap.edit.failed.cannotremovevp', 'You cannot remove a province with victory point.'));
        return result;
    }

    const files = [toFile];
    if (fromFile && fromFile !== toFile) {
        files.push(fromFile);
    }

    const filePathsInMod = await copyFilesIntoWorkspace(files, {
        mustOpenFolderMessage: localize('worldmap.mustopenafolder.edit', 'Must open a folder before editing {0} file.', typeName),
        selectFolderMessage: localize('worldmap.selectafolder', 'Select a folder to copy {0} file', typeName),
        failedToOpenMessage: (errorMessage) => localize('worldmap.failedtoopenstate', 'Failed to open {0} file: {1}.', typeName, errorMessage),
    });
    if (filePathsInMod.some(v => v === undefined)) {
        return result;
    }

    const toDocumentUri = filePathsInMod[0]!;
    const toDocument = await vscode.workspace.openTextDocument(toDocumentUri);
    const workspaceEdit = new vscode.WorkspaceEdit();
    const vp = fromRegion && 'victoryPoints' in fromRegion ? fromRegion.victoryPoints[province] : undefined;
    // Fallback VP text carries the victory point across the move even when the source file's
    // victory_points block cannot be located; the exact block text replaces it when found.
    // The text is the body of a victory_points entry: `victory_points = { province value }`.
    const vpText = vp !== undefined ? `victory_points = { ${province} ${vp} }` : undefined;
    const vpObject = vp !== undefined ? { province, remove: true, text: vpText } : undefined;

    // The move is transactional: both the source and the target edits are built first, then the
    // cache is updated and the edits are applied together. If either side cannot be edited the
    // whole move is aborted, so the province is never deleted without being inserted (or vice
    // versa) and the on-disk file, the cached arrays and the webview messages stay consistent.
    let fromProvincesUpdated: number[] | undefined = undefined;
    let fromApplied = false;
    let toProvincesUpdated: number[] | undefined = undefined;
    let toApplied = false;

    if (to !== from) {
        // Move province from one to another
        const fromDocumentUri = fromFile === toFile ? toDocumentUri : filePathsInMod[1];
        const fromDocument = fromDocumentUri ? await vscode.workspace.openTextDocument(fromDocumentUri) : undefined;
        if (from !== undefined && fromFile !== undefined && fromDocument && fromRegion) {
            const provinceIndex = fromRegion.provinces.indexOf(province);
            if (provinceIndex >= 0) {
                const fromProvinces = [...fromRegion.provinces];
                fromProvinces.splice(provinceIndex, 1);
                if (await setProvinces(workspaceEdit, type, from, fromFile, fromDocument, fromProvinces, vpObject, fromRegion.token)) {
                    fromProvincesUpdated = fromProvinces;
                    fromApplied = true;
                } else {
                    return result;
                }
            }
        }

        const nextToProvinces = [...toRegion.provinces];
        if (toRegion && !nextToProvinces.includes(province)) {
            nextToProvinces.push(province);
        }
        if (toRegion) {
            // Independent VP object for the target side: never mutates the shared one used by the
            // source call (its `remove` flag and extracted text stay as the source left them).
            const toVp = vpObject ? { ...vpObject, remove: false } : undefined;
            if (await setProvinces(workspaceEdit, type, to, toFile, toDocument, nextToProvinces, toVp, toRegion.token)) {
                toProvincesUpdated = nextToProvinces;
                toApplied = true;
            } else {
                return result;
            }
        }
    } else if (toRegion) {
        // Remove province
        const nextToProvinces = [...toRegion.provinces];
        const provinceIndex = nextToProvinces.indexOf(province);
        if (provinceIndex >= 0) {
            nextToProvinces.splice(provinceIndex, 1);
        }
        if (await setProvinces(workspaceEdit, type, to, toFile, toDocument, nextToProvinces, vpObject, toRegion.token)) {
            toProvincesUpdated = nextToProvinces;
            toApplied = true;
        } else {
            return result;
        }
    }

    // Apply first, then commit the cached arrays and webview messages: if the edit cannot be applied
    // (conflicting file state), the disk is untouched and the in-memory data must stay untouched too.
    const applied = await vscode.workspace.applyEdit(workspaceEdit);
    if (applied === false) {
        await vscode.window.showErrorMessage(localize('worldmap.edit.failed.apply', 'The change could not be applied. The file may have changed on disk. Please try again.'));
        return result;
    }

    if (fromApplied && fromProvincesUpdated !== undefined && fromRegion && from !== undefined) {
        fromRegion.provinces = fromProvincesUpdated;
        if (vp !== undefined && 'victoryPoints' in fromRegion) {
            delete fromRegion.victoryPoints[province];
        }
        result.push({ command: type === 'state' ? 'states' : 'strategicregions', data: JSON.stringify([fromRegion]), start: from, end: from + 1 });
    }
    if (toApplied && toProvincesUpdated !== undefined && toRegion) {
        toRegion.provinces = toProvincesUpdated;
        if (vp !== undefined && 'victoryPoints' in toRegion) {
            toRegion.victoryPoints[province] = vp;
        }
        result.push({ command: type === 'state' ? 'states' : 'strategicregions', data: JSON.stringify([toRegion]), start: to, end: to + 1 });
    }

    return result;
}

interface ProvincesContainer {
    id?: number;
    provinces: Enum[];
    history?: {
        victory_points: Enum[];
        _valueEndToken?: Token;
    };
    _token?: Token | null;
    _valueStartToken?: Token;
    _valueEndToken?: Token;
}

interface ProvincesContainerFile {
    state: ProvincesContainer[];
    strategic_region: ProvincesContainer[];
}

const provincesContainerSchema: SchemaDef<ProvincesContainer> = {
    id: 'number',
    provinces: { _innerType: 'enum', _type: 'array' },
    history: { victory_points: { _innerType: 'enum', _type: 'array' } },
};

const provincesContainerFileSchema: SchemaDef<ProvincesContainerFile> = {
    state: { _innerType: provincesContainerSchema, _type: 'array' },
    strategic_region: { _innerType: provincesContainerSchema, _type: 'array' },
};

export async function setProvinces(
    workspaceEdit: vscode.WorkspaceEdit,
    type: 'state' | 'strategicregion',
    id: number,
    relativePath: string,
    document: vscode.TextDocument,
    provinces: number[],
    vp: { province: number; remove?: boolean; text?: string; } | undefined,
    token: Token | null
): Promise<boolean> {
    const nodes = parseHoi4File(document.getText(), localize('infile', 'In file {0}:\n', relativePath));
    const file = convertNodeToJson<ProvincesContainerFile>(nodes, provincesContainerFileSchema);
    const list = type === 'state' ? file.state : file.strategic_region;
    const item = (list.find(i => i.id === id) ?? list.find(i => i._token && i._token?.start === token?.start && i._token?.end === token?.end)) as ProvincesContainer | undefined;
    if (!item) {
        return false;
    }

    return applyProvincesEdit(workspaceEdit, document, item, provinces, vp, type);
}

function renderProvincesBlock(indent: string, provinces: number[]): string {
    return indent + 'provinces = {' + '\n' + indent + indent + provinces.join(' ') + '\n' + indent + '}' + '\n';
}

function renderProvincesList(indent: string, provinces: number[]): string {
    return '{' + '\n' + indent + indent + provinces.join(' ') + '\n' + indent + '}';
}

function renderHistoryBlock(indent: string, vpText: string): string {
    return indent + 'history = {' + '\n' + indent + indent + vpText + '\n' + indent + '}' + '\n';
}

function sliceText(text: string, startOffset: number, endOffset: number): string {
    return text.substring(startOffset, endOffset);
}

function detectIndent(text: string): string {
    // Counts leading-space and leading-tab prefixes line by line and picks the most common one.
    const counts: Record<string, number> = {};
    for (const line of text.split('\n')) {
        let spaces = 0;
        while (line.charAt(spaces) === ' ') {
            spaces++;
        }
        let tabs = 0;
        while (line.charAt(tabs) === '\t') {
            tabs++;
        }
        const indent = spaces > 0 ? ' '.repeat(spaces) : '\t'.repeat(tabs);
        if (indent.length > 0) {
            counts[indent] = (counts[indent] ?? 0) + 1;
        }
    }

    let best = '\t';
    let bestCount = 0;
    for (const indent of Object.keys(counts)) {
        if (counts[indent] > bestCount) {
            best = indent;
            bestCount = counts[indent];
        }
    }

    return best;
}

async function applyProvincesEdit(
    workspaceEdit: vscode.WorkspaceEdit,
    document: vscode.TextDocument,
    item: ProvincesContainer,
    provinces: number[],
    vp: { province: number; remove?: boolean; text?: string; } | undefined,
    type: 'state' | 'strategicregion',
): Promise<boolean> {
    const text = document.getText();
    const indent = detectIndent(text);
    const valueEndOffset = item._valueEndToken?.start ?? text.length;
    // Insertion point before the closing brace: at the start of its line when the brace sits on its
    // own line (standard formatting), right before the brace otherwise (single-line compact format).
    // Compact format needs a leading newline so the inserted block does not merge into that line.
    const braceLineStart = document.positionAt(valueEndOffset).with({ character: 0 });
    const lineBeforeBrace = text.substring(text.lastIndexOf('\n', valueEndOffset - 1) + 1, valueEndOffset);
    const compactFormat = lineBeforeBrace.trim() !== '';
    const endTokenStartPosition = compactFormat ? document.positionAt(valueEndOffset) : braceLineStart;

    provinces.sort((a, b) => a - b);
    if (item.provinces.length === 0) {
        // The state has no provinces block yet: insert one. VP handling below still runs, so a
        // province moved here with a victory point is not silently dropped.
        const provincesBlock = renderProvincesBlock(indent, provinces);
        workspaceEdit.insert(document.uri, endTokenStartPosition, compactFormat ? '\n' + provincesBlock : provincesBlock);
    } else {
        const firstProvince = item.provinces[0];
        if (firstProvince._valueStartToken?.start === undefined || firstProvince._valueEndToken?.end === undefined) {
            return false;
        }

        if (item.provinces.length > 1) {
            for (let i = 1; i < item.provinces.length; i++) {
                const province = item.provinces[i];
                if (province._token?.start === undefined || province._valueEndToken?.end === undefined) {
                    return false;
                }
            }

            for (let i = 1; i < item.provinces.length; i++) {
                const province = item.provinces[i];
                const start = document.positionAt(province._token!.start);
                const end = document.positionAt(province._valueEndToken!.end);
                const range = new vscode.Range(start, end);
                workspaceEdit.delete(document.uri, range);
            }
        }

        const start = document.positionAt(firstProvince._valueStartToken.start);
        const end = document.positionAt(firstProvince._valueEndToken.end);
        const range = new vscode.Range(start, end);
        workspaceEdit.replace(document.uri, range, renderProvincesList(indent, provinces));
    }

    if (type === 'state' && vp) {
        const { province, remove, text: vpText = '' } = vp;
        if (remove) {
            if (item.history) {
                const vpList = item.history.victory_points;
                const vpIndex = vpList.findIndex(vp => vp._values.length >= 1 && vp._values[0] === province.toString());
                if (vpIndex !== -1) {
                    const vpItem = vpList[vpIndex];
                    const vpStart = vpItem._token?.start;
                    const vpEnd = vpItem._valueEndToken?.end;
                    if (vpStart !== undefined && vpEnd !== undefined) {
                        vp.text = sliceText(text, vpStart, vpEnd);
                        const newlineOffset = text.charAt(vpEnd) === '\n' ? 1 : 0;
                        workspaceEdit.delete(document.uri, new vscode.Range(document.positionAt(vpStart), document.positionAt(vpEnd + newlineOffset)));
                    }
                }
            }
        } else {
            if (!item.history) {
                const historyBlock = renderHistoryBlock(indent, vpText);
                workspaceEdit.insert(document.uri, endTokenStartPosition, compactFormat ? '\n' + historyBlock : historyBlock);
            } else {
                const history = item.history;
                const lastVp = history.victory_points.length > 0 ? history.victory_points[history.victory_points.length - 1] : undefined;
                const insertPosition = lastVp?._valueEndToken?.end;
                if (insertPosition !== undefined) {
                    workspaceEdit.insert(document.uri, document.positionAt(insertPosition), '\n' + indent + indent + vpText);
                } else {
                    const historyEndPosition = history._valueEndToken?.start !== undefined ? document.positionAt(history._valueEndToken.start).with({ character: 0 }) : undefined;
                    const insertPosition = historyEndPosition ?? endTokenStartPosition;
                    workspaceEdit.insert(document.uri, insertPosition, indent + indent + vpText + '\n');
                }
            }
        }
    }

    return true;
}