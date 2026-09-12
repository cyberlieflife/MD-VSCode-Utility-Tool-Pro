import * as vscode from 'vscode';
import { readFileSync } from 'fs';
import worldmapview from './worldmapview.html';
import worldmapviewstyles from './worldmapview.css';
import { localize, localizeText, i18nTableAsScript } from '../../util/i18n';
import { html } from '../../util/html';
import { error, debug } from '../../util/debug';
import { WorldMapMessage, ProgressReporter, WorldMapData, MapItemMessage, RequestMapItemMessage, MoveProvinceMessage, AddMapItemMessage, EditStateMessage } from './definitions';
import { matchPathEnd } from '../../util/nodecommon';
import { writeFile, getConfiguration } from '../../util/vsccommon';
import { slice, debounceByInput, forceError } from '../../util/common';
import { openOrCopyHoiFile } from '../../util/previewfileopener';
import { WorldMapLoader } from './loader/worldmaploader';
import { isEqual } from 'lodash';
import { LoaderSession } from '../../util/loader/loader';
import { TelemetryMessage, sendByMessage } from '../../util/telemetry';
import { itemFingerprints, collectChangeRanges } from './itemfingerprint';
import { contextContainer } from '../../context';
import { moveProvince } from './editor/moveprovince';
import { addMapItem } from './editor/addmapitem';
import { editState } from './editor/editstate';

interface WorldMapWebviewAssets {
    commonJs: string;
    worldmapJs: string;
    commonCss: string;
    codiconCss: string;
}

// The world map webview accumulates 100-300 MB of map data, which can crash its renderer
// process. VS Code then rebuilds the page from panel.webview.html, but that rebuild's requests
// for the external webview resources (the bundled scripts and stylesheets) can fail (known VS
// Code service-worker issues), leaving an unstyled page whose bootstrap script never ran and
// which therefore never re-requests the map data. Inlining every script, stylesheet and the
// icon font into the html removes those external requests entirely: a rebuilt page re-runs the
// bundled loader by itself and reloads the map data on its own.
let worldMapWebviewAssets: WorldMapWebviewAssets | undefined = undefined;

function readWorldMapWebviewAssets(): WorldMapWebviewAssets {
    if (worldMapWebviewAssets) {
        return worldMapWebviewAssets;
    }

    const extensionUri = contextContainer.current?.extensionUri;
    if (!extensionUri) {
        throw new Error('Cannot read world map webview assets: extension context is not registered.');
    }

    const read = (name: string) => readFileSync(vscode.Uri.joinPath(extensionUri, 'static/' + name).fsPath, 'utf8');
    // The icon font is embedded as a data URI (CSP: font-src data:) so a rebuilt page keeps its
    // toolbar icons without any external request.
    const codiconTtf = readFileSync(vscode.Uri.joinPath(extensionUri, 'static/codicon.ttf').fsPath);
    const codiconCss = read('codicon.css').replace(
        /url\("\.\/codicon\.ttf[^"]*"\)/,
        'url("data:font/ttf;base64,' + codiconTtf.toString('base64') + '")');

    worldMapWebviewAssets = {
        commonJs: read('common.js'),
        worldmapJs: read('worldmap.js'),
        commonCss: read('common.css'),
        codiconCss,
    };
    return worldMapWebviewAssets;
}

export class WorldMap {
    public panel: vscode.WebviewPanel | undefined;

    private worldMapLoader: WorldMapLoader;
    private worldMapDependencies: string[] | undefined;
    private cachedWorldMap: WorldMapData | undefined;

    private lastRequestedExportUri: vscode.Uri | undefined;

    constructor(panel: vscode.WebviewPanel) {
        this.panel = panel;
        this.worldMapLoader = new WorldMapLoader();
        this.worldMapLoader.onProgress(this.progressReporter);
    }

    public initialize(): void {
        if (!this.panel) {
            return;
        }

        const webview = this.panel.webview;
        webview.html = this.renderWorldMap(webview);
        webview.onDidReceiveMessage((msg) => this.onMessage(msg));
        this.panel.onDidChangeViewState(() => this.onViewStateChanged());
    }

    // The full world map (provinces, states, countries, ...) is 100-300 MB. When the panel is
    // hidden, release the extension-host copy so it doesn't linger for the whole session. The
    // webview keeps its own rendered copy (when retainContextWhenHidden is on), so the map is
    // still shown immediately on return; any further data request reloads from disk on demand.
    private onViewStateChanged(): void {
        if (this.panel && !this.panel.visible) {
            this.releaseMemory();
        }
    }

    private releaseMemory(): void {
        if (this.cachedWorldMap === undefined) {
            return;
        }
        this.cachedWorldMap = undefined;
        // Dropping the loader lets its cached WorldMapData be garbage collected. A fresh loader
        // rebuilds from disk on the next request.
        this.worldMapLoader = new WorldMapLoader();
        this.worldMapLoader.onProgress(this.progressReporter);
    }

    public onDocumentChange = debounceByInput(
        (uri: vscode.Uri) => {
            if (!this.worldMapDependencies || !this.panel?.visible) {
                return;
            }

            if (this.worldMapDependencies.some(d => matchPathEnd(uri.toString(), d.split('/')))) {
                void this.sendProvinceMapSummaryToWebview(false);
            }
        },
        uri => uri.toString(),
        1000,
        { trailing: true });

    public dispose() {
        this.panel = undefined;
    }

    private renderWorldMap(webview: vscode.Webview): string {
        const assets = readWorldMapWebviewAssets();
        return html(
            webview,
            localizeText(worldmapview),
            [
                { content: i18nTableAsScript() },
                { content: 'window.__enableSupplyArea = ' + getConfiguration().enableSupplyArea + ';' },
                { content: contextContainer.current ?
                    'window.__pencilUri = "' + webview.asWebviewUri(vscode.Uri.joinPath(contextContainer.current.extensionUri, 'static/pencil.svg')).toString() + '";' :
                    '' },
                { content: assets.commonJs },
                { content: assets.worldmapJs },
            ],
            [
                { content: assets.commonCss },
                { content: assets.codiconCss },
                { content: worldmapviewstyles },
            ]
        );
    }

    private async onMessage(msg: WorldMapMessage | TelemetryMessage): Promise<void> {
        try {
            debug('worldmap message ' + JSON.stringify(msg));
            switch (msg.command) {
                case 'loaded':
                    await this.sendProvinceMapSummaryToWebview(msg.force);
                    break;
                case 'requestprovinces':
                    await this.sendMapData('provinces', msg, (await this.worldMapLoader.getWorldMap()).provinces);
                    break;
                case 'requeststates':
                    await this.sendMapData('states', msg, (await this.worldMapLoader.getWorldMap()).states);
                    break;
                case 'requestcountries':
                    await this.sendMapData('countries', msg, (await this.worldMapLoader.getWorldMap()).countries);
                    break;
                case 'requeststrategicregions':
                    await this.sendMapData('strategicregions', msg, (await this.worldMapLoader.getWorldMap()).strategicRegions);
                    break;
                case 'requestsupplyareas':
                    await this.sendMapData('supplyareas', msg, (await this.worldMapLoader.getWorldMap()).supplyAreas);
                    break;
                case 'requestrailways':
                    await this.sendMapData('railways', msg, (await this.worldMapLoader.getWorldMap()).railways);
                    break;
                case 'requestsupplynodes':
                    await this.sendMapData('supplynodes', msg, (await this.worldMapLoader.getWorldMap()).supplyNodes);
                    break;
                case 'openfile':
                    await this.openFile(msg.file, msg.type, msg.start, msg.end);
                    break;
                case 'telemetry':
                    await sendByMessage(msg);
                    break;
                case 'requestexportmap':
                    await this.requestExportMap();
                    break;
                case 'exportmap':
                    await this.exportMap(msg.dataUrl);
                    break;
                case 'moveprovince':
                    await this.moveProvince(msg);
                    break;
                case 'addmapitem':
                    await this.addMapItem(msg);
                    break;
                case 'editstate':
                    await this.editState(msg);
                    break;
            }
        } catch (e) {
            error(e);
        }
    }

    private sendMapData(command: MapItemMessage['command'], msg: RequestMapItemMessage, value: unknown[]) {
        return this.postMessageToWebview({
            command: command,
            data: JSON.stringify(slice(value, msg.start, msg.end)),
            start: msg.start,
            end: msg.end,
        } as WorldMapMessage);
    }

    private progressReporter: ProgressReporter = async (progress: string) => {
        debug('Progress:', progress);
        await this.postMessageToWebview({
            command: 'progress',
            data: progress,
        } as WorldMapMessage);
    };

    private async sendProvinceMapSummaryToWebview(force: boolean) {
        try {
            this.worldMapLoader.shallowForceReload();
            const oldCachedWorldMap = this.cachedWorldMap;
            const loaderSession = new LoaderSession(force, () => this.panel === undefined);
            const { result: worldMap, dependencies } = await this.worldMapLoader.load(loaderSession);
            this.worldMapDependencies = dependencies;
            this.cachedWorldMap = worldMap;

            if (!force && oldCachedWorldMap && await this.sendDifferences(oldCachedWorldMap, worldMap)) {
                return;
            }

            const summary: WorldMapData = {
                ...worldMap,
                provinces: [],
                states: [],
                countries: [],
                strategicRegions: [],
                supplyAreas: [],
                railways: [],
                supplyNodes: [],
            };

            await this.postMessageToWebview({
                command: 'provincemapsummary',
                data: summary,
            } as WorldMapMessage);
        } catch (e) {
            error(e);

            await this.postMessageToWebview({
                command: 'error',
                data: localize('worldmap.failedtoload', 'Failed to load world map: {0}.', forceError(e).toString()),
            } as WorldMapMessage);
        }
    }

    private async openFile(file: string, type: 'state' | 'strategicregion' | 'supplyarea', start: number | undefined, end: number | undefined): Promise<void> {
        const typeName = localize('worldmap.openfiletype.' + type as any, type);
        await openOrCopyHoiFile(file, start, end, {
            mustOpenFolderMessage: localize('worldmap.mustopenafolder', 'Must open a folder before opening {0} file.', typeName),
            selectFolderMessage: localize('worldmap.selectafolder', 'Select a folder to copy {0} file', typeName),
            failedToOpenMessage: (errorMessage) => localize('worldmap.failedtoopenstate', 'Failed to open {0} file: {1}.', typeName, errorMessage),
        });
    }

    private async sendDifferences(cachedWorldMap: WorldMapData, worldMap: WorldMapData): Promise<boolean> {
        await this.progressReporter(localize('worldmap.progress.comparing', 'Comparing changes...'));
        const changeMessages: WorldMapMessage[] = [];

        if ((['width', 'height', 'provincesCount', 'statesCount', 'countriesCount', 'strategicRegionsCount', 'supplyAreasCount',
            'railwaysCount', 'supplyNodesCount',
            'badProvincesCount', 'badStatesCount', 'badStrategicRegionsCount', 'badSupplyAreasCount'] as (keyof WorldMapData)[])
            .some(k => !isEqual(cachedWorldMap[k], worldMap[k]))) {
            return false;
        }

        if (!isEqual(cachedWorldMap.warnings, worldMap.warnings)) {
            changeMessages.push({ command: 'warnings', data: JSON.stringify(worldMap.warnings), start: 0, end: 0 });
        }

        if (!isEqual(cachedWorldMap.continents, worldMap.continents)) {
            changeMessages.push({ command: 'continents', data: JSON.stringify(worldMap.continents), start: 0, end: 0 });
        }

        if (!isEqual(cachedWorldMap.terrains, worldMap.terrains)) {
            changeMessages.push({ command: 'terrains', data: JSON.stringify(worldMap.terrains), start: 0, end: 0 });
        }

        if (!isEqual(cachedWorldMap.resources, worldMap.resources)) {
            changeMessages.push({ command: 'resources', data: JSON.stringify(worldMap.resources), start: 0, end: 0 });
        }

        if (!this.fillMessageForItem(changeMessages, worldMap.provinces, cachedWorldMap.provinces, 'provinces', worldMap.badProvincesCount, worldMap.provincesCount)) {
            return false;
        }

        if (!this.fillMessageForItem(changeMessages, worldMap.states, cachedWorldMap.states, 'states', worldMap.badStatesCount, worldMap.statesCount)) {
            return false;
        }

        if (!this.fillMessageForItem(changeMessages, worldMap.countries, cachedWorldMap.countries, 'countries', 0, worldMap.countriesCount)) {
            return false;
        }

        if (!this.fillMessageForItem(changeMessages, worldMap.strategicRegions, cachedWorldMap.strategicRegions, 'strategicregions', worldMap.badStrategicRegionsCount, worldMap.strategicRegionsCount)) {
            return false;
        }

        if (!this.fillMessageForItem(changeMessages, worldMap.supplyAreas, cachedWorldMap.supplyAreas, 'supplyareas', worldMap.badSupplyAreasCount, worldMap.supplyAreasCount)) {
            return false;
        }

        if (!this.fillMessageForItem(changeMessages, worldMap.railways, cachedWorldMap.railways, 'railways', 0, worldMap.railwaysCount)) {
            return false;
        }

        if (!this.fillMessageForItem(changeMessages, worldMap.supplyNodes, cachedWorldMap.supplyNodes, 'supplynodes', 0, worldMap.supplyNodesCount)) {
            return false;
        }

        await this.progressReporter(localize('worldmap.progress.applying', 'Applying changes...'));

        for (const message of changeMessages) {
            await this.postMessageToWebview(message);
        }

        await this.progressReporter('');
        return true;
    }

    private fillMessageForItem(
        changeMessages: WorldMapMessage[],
        list: unknown[],
        cachedList: unknown[],
        command: MapItemMessage['command'],
        listStart: number,
        listEnd: number,
    ): boolean {
        const changeMessagesCountLimit = 30;
        const messageCountLimit = 300;

        // Fast path: the sub-loader did not reload, so its result array is the same object as the
        // cached one and nothing in this list changed.
        if (list === cachedList) {
            return true;
        }

        // Fingerprint comparison replaces the per-item isEqual deep walk. Ranges come back relative
        // to the compared slice and map to absolute indices (listStart + relative) for the messages.
        const newFps = itemFingerprints(list, listStart, listEnd);
        const oldFps = itemFingerprints(cachedList, listStart, listEnd);
        const ranges = collectChangeRanges(i => newFps[i] === oldFps[i], listEnd - listStart, messageCountLimit);
        for (const range of ranges) {
            changeMessages.push({
                command,
                data: JSON.stringify(slice(list, listStart + range.start, listStart + range.end)),
                start: listStart + range.start,
                end: listStart + range.end,
            });
            if (changeMessages.length > changeMessagesCountLimit) {
                return false;
            }
        }

        return true;
    }

    private async postMessageToWebview(message: WorldMapMessage) {
        if (!this.panel) {
            return false;
        }

        return await this.panel.webview.postMessage(message);
    }

    private async requestExportMap() {
        const uri = await vscode.window.showSaveDialog({ filters: { [localize('pngfile', 'PNG file')]: ['png'] } });
        this.lastRequestedExportUri = uri;
        if (!uri) {
            return;
        }

        await this.postMessageToWebview({ command: 'requestexportmap' });
    }

    private async exportMap(dataUrl?: string) {
        const uri = this.lastRequestedExportUri;
        if (!uri) {
            return;
        }

        const prefix = 'data:image/png;base64,';
        if (!dataUrl || !dataUrl.startsWith(prefix)) {
            vscode.window.showErrorMessage(localize('worldmap.export.error.imgformat', 'Can\'t export world map: Image is not in correct format.'));
            return;
        }

        try {
            const base64 = dataUrl.substring(prefix.length);
            const buffer = Buffer.from(base64, 'base64');

            await writeFile(uri, buffer);

            vscode.window.showInformationMessage(localize('worldmap.export.success', 'Successfully exported world map.'));

        } catch (e) {
            error(e);
            vscode.window.showErrorMessage(localize('worldmap.export.error', 'Can\'t export world map: {0}.', e));
        }
    }

    private async moveProvince(msg: MoveProvinceMessage) {
        if (!this.cachedWorldMap) {
            await vscode.window.showErrorMessage(localize('worldmap.edit.failed.nocache', 'Editing failed. No cached world map data. Please reload the world map and try again.'));
            return;
        }

        const messages = await moveProvince(msg, this.cachedWorldMap);
        for (const message of messages) {
            await this.postMessageToWebview(message);
        }
    }

    private async addMapItem(msg: AddMapItemMessage) {
        if (!this.cachedWorldMap) {
            await vscode.window.showErrorMessage(localize('worldmap.add.failed.nocache', 'Adding failed. No cached world map data. Please reload the world map and try again.'));
            return;
        }

        const messages = await addMapItem(msg, this.cachedWorldMap);
        for (const message of messages) {
            await this.postMessageToWebview(message);
        }
    }

    private async editState(msg: EditStateMessage) {
        if (!this.cachedWorldMap) {
            await vscode.window.showErrorMessage(localize('worldmap.edit.failed.nocache', 'Editing failed. No cached world map data. Please reload the world map and try again.'));
            return;
        }

        const messages = await editState(msg, this.cachedWorldMap);
        for (const message of messages) {
            await this.postMessageToWebview(message);
        }
    }
}
