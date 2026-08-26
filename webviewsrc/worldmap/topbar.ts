import { Subscriber, toBehaviorSubject } from "../util/event";
import { Loader, FEWorldMap } from "./loader";
import { ViewPoint } from "./viewpoint";
import { vscode } from "../util/vscode";
import { setState } from "../util/common";
import { WorldMapMessage, WorldMapWarning } from "../../src/previewdef/worldmap/definitions";
import { feLocalize } from "../util/i18n";
import { DivDropdown } from "../util/dropdown";
import { BehaviorSubject, combineLatest, fromEvent } from 'rxjs';
import { Renderer } from './renderer';
import { sendEvent } from '../util/telemetry';

export type ViewMode = 'province' | 'state' | 'strategicregion' | 'supplyarea' | 'warnings';
export type ColorSet = 'provinceid' | 'provincetype' | 'terrain' | 'country' | 'stateid' | 'manpower' |
    'victorypoint' | 'continent' | 'warnings' | 'strategicregionid' | 'supplyareaid' | 'supplyvalue' | 'resources';

// Display options added after the initial release. They are merged into a previously saved display
// selection exactly once (before the migration flag is persisted) so existing users get them
// enabled by default while later changes to the selection are respected.
export function mergeDisplayMigration(display: readonly string[], migrated: boolean): readonly string[] {
    if (migrated) {
        return display;
    }
    return [...new Set([...display, 'resource', 'factory'])];
}

export const topBarHeight = 40;

export class TopBar extends Subscriber {
    public viewMode$: BehaviorSubject<ViewMode>;
    public colorSet$: BehaviorSubject<ColorSet>;
    public hoverProvinceId$: BehaviorSubject<number | undefined>;
    public selectedProvinceId$: BehaviorSubject<number | undefined>;
    public hoverStateId$: BehaviorSubject<number | undefined>;
    public selectedStateId$: BehaviorSubject<number | undefined>;
    public hoverStrategicRegionId$: BehaviorSubject<number | undefined>;
    public selectedStrategicRegionId$: BehaviorSubject<number | undefined>;
    public hoverSupplyAreaId$: BehaviorSubject<number | undefined>;
    public selectedSupplyAreaId$: BehaviorSubject<number | undefined>;
    public warningFilter: DivDropdown;
    public display: DivDropdown;

    public warningsVisible: boolean = false;

    // Edit mode: when active (state/strategicregion views), clicking a province moves it into the
    // currently selected region instead of changing the selection. editModeHoverProvinceId$ carries
    // the province under the cursor so the renderer can highlight the move target.
    public editMode$ = new BehaviorSubject<boolean>(false);
    public editModeHoverProvinceId$ = new BehaviorSubject<number | undefined>(undefined);

    public get editMode(): boolean {
        return this.editMode$.value;
    }

    private searchBox: HTMLInputElement;

    constructor(private canvas: HTMLCanvasElement, private viewPoint: ViewPoint, private loader: Loader, state: any) {
        super();

        this.addSubscription(this.warningFilter = new DivDropdown(document.getElementById('warningfilter') as HTMLDivElement, true));
        this.addSubscription(this.display = new DivDropdown(document.getElementById('display') as HTMLDivElement, true));

        this.viewMode$ = toBehaviorSubject<ViewMode>(document.getElementById('viewmode') as HTMLSelectElement, state.viewMode ?? 'province');
        this.colorSet$ = toBehaviorSubject<ColorSet>(document.getElementById('colorset') as HTMLSelectElement, state.colorSet ?? 'provinceid');
        this.hoverProvinceId$ = new BehaviorSubject<number | undefined>(undefined);
        this.selectedProvinceId$ = new BehaviorSubject<number | undefined>(state.selectedProvinceId ?? undefined);
        this.hoverStateId$ = new BehaviorSubject<number | undefined>(undefined);
        this.selectedStateId$ = new BehaviorSubject<number | undefined>(state.selectedStateId ?? undefined);
        this.hoverStrategicRegionId$ = new BehaviorSubject<number | undefined>(undefined);
        this.selectedStrategicRegionId$ = new BehaviorSubject<number | undefined>(state.selectedStrategicRegionId ?? undefined);
        this.hoverSupplyAreaId$ = new BehaviorSubject<number | undefined>(undefined);
        this.selectedSupplyAreaId$ = new BehaviorSubject<number | undefined>(state.selectedSupplyAreaId ?? undefined);
        if (state.warningFilter) {
            this.warningFilter.selectedValues$.next(state.warningFilter);
        } else {
            this.warningFilter.selectAll();
        }
        if (state.display) {
            // The merge is one-time: once displayMigrated is persisted, the saved selection is
            // used verbatim so disabling the new options sticks across panel reloads.
            this.display.selectedValues$.next(mergeDisplayMigration(state.display, state.displayMigrated));
            if (!state.displayMigrated) {
                setState({ displayMigrated: true });
            }
        } else {
            this.display.selectAll();
        }

        this.searchBox = document.getElementById("searchbox") as HTMLInputElement;

        this.loadControls();
        this.registerEventListeners(canvas);
    }

    private onViewModeChange() {
        document.querySelectorAll('#colorset > option[viewmode]').forEach(v => {
            (v as HTMLOptionElement).hidden = true;
        });
    
        let colorSetHidden = true;
        document.querySelectorAll('#colorset > option[viewmode~="' + this.viewMode$.value + '"]').forEach(v => {
            (v as HTMLOptionElement).hidden = false;
            if ((v as HTMLOptionElement).value === this.colorSet$.value) {
                colorSetHidden = false;
            }
        });
        
        document.querySelectorAll('#colorset > option:not([viewmode])').forEach(v => {
            if ((v as HTMLOptionElement).value === this.colorSet$.value) {
                colorSetHidden = false;
            }
        });

        document.querySelectorAll('button[viewmode]').forEach(v => {
            (v as HTMLButtonElement).style.display = 'none';
        });

        document.querySelectorAll('button[viewmode~="' + this.viewMode$.value + '"]').forEach(v => {
            (v as HTMLButtonElement).style.display = 'inline-block';
        });

        document.querySelectorAll('.group[viewmode]').forEach(v => {
            (v as HTMLDivElement).style.display = 'none';
        });

        document.querySelectorAll('.group[viewmode~="' + this.viewMode$.value + '"]').forEach(v => {
            (v as HTMLDivElement).style.display = 'inline-block';
        });
    
        if (colorSetHidden) {
            const newColorset = (document.querySelector('#colorset > option:not(*[hidden])') as HTMLOptionElement)?.value;
            this.colorSet$.next(newColorset as any);
        }

        this.setSearchBoxPlaceHolder();
    }
    
    private loadControls() {
        this.loadWarningButton();
        this.loadSearchBox();
        this.loadRefreshButton();
        this.loadOpenButton();
        this.loadExportButton();
        this.loadEditButton();
        this.loadSelectedRegionButton();
    }

    private loadWarningButton() {
        const warningsContainer = document.getElementById('warnings-container')!;
        const showWarnings = document.getElementById('show-warnings')!;
        this.addSubscription(fromEvent(showWarnings, 'click').subscribe(() => {
            this.warningsVisible = !this.warningsVisible;
            if (this.warningsVisible) {
                sendEvent('worldmap.openwarnings');
                warningsContainer.style.display = 'block';
            } else {
                warningsContainer.style.display = 'none';
            }
        }));
    }

    private loadSearchBox() {
        const searchBox = this.searchBox;
        const search = document.getElementById("search")!;
        this.addSubscription(fromEvent<KeyboardEvent>(searchBox, 'keypress').subscribe((e) => {
            if (e.code === 'Enter') {
                sendEvent('worldmap.search', { keypress: 'true' });
                this.search(searchBox.value);
            }
        }));
        this.addSubscription(fromEvent(search, 'click').subscribe(() => {
            sendEvent('worldmap.search', { keypress: 'false' });
            this.search(searchBox.value);
        }));
    }

    private loadRefreshButton() {
        const refresh = document.getElementById("refresh") as HTMLButtonElement;
        this.addSubscription(fromEvent(refresh, 'click').subscribe(() => {
            if (!refresh.disabled) {
                sendEvent('worldmap.refresh');
                this.loader.refresh();
            }
        }));
        this.addSubscription(this.loader.loading$.subscribe(v => {
            refresh.disabled = v;
        }));
    }

    private openMapItem(useHoverValue = false) {
        sendEvent('worldmap.open.' + this.viewMode$.value + (useHoverValue ? '.dblclick' : ''));
        if (this.viewMode$.value === 'state') {
            const selected = useHoverValue ? this.hoverStateId$.value : this.selectedStateId$.value;
            if (selected) {
                const state = this.loader.worldMap.getStateById(selected);
                if (state) {
                    vscode.postMessage<WorldMapMessage>({ command: 'openfile', type: 'state', file: state.file, start: state.token?.start, end: state.token?.end });
                }
            }
        } else if (this.viewMode$.value === 'strategicregion') {
            const selected = useHoverValue ? this.hoverStrategicRegionId$.value : this.selectedStrategicRegionId$.value;
            if (selected) {
                const strategicRegion = this.loader.worldMap.getStrategicRegionById(selected);
                if (strategicRegion) {
                    vscode.postMessage<WorldMapMessage>({ command: 'openfile', type: 'strategicregion', file: strategicRegion.file,
                        start: strategicRegion.token?.start, end: strategicRegion.token?.end });
                }
            }
        } else if (this.viewMode$.value === 'supplyarea') {
            const selected = useHoverValue ? this.hoverSupplyAreaId$.value : this.selectedSupplyAreaId$.value;
            if (selected) {
                const supplyArea = this.loader.worldMap.getSupplyAreaById(selected);
                if (supplyArea) {
                    vscode.postMessage<WorldMapMessage>({ command: 'openfile', type: 'supplyarea', file: supplyArea.file,
                        start: supplyArea.token?.start, end: supplyArea.token?.end });
                }
            }
        }
    }

    private loadOpenButton() {
        const open = document.getElementById("open") as HTMLButtonElement;
        this.addSubscription(fromEvent(open, 'click').subscribe((e) => {
            e.stopPropagation();
            this.openMapItem();
        }));

        this.addSubscription(combineLatest([this.viewMode$, this.selectedStateId$, this.selectedStrategicRegionId$, this.selectedSupplyAreaId$]).subscribe(
            ([viewMode, selectedStateId, selectedStrategicRegionId, selectedSupplyAreaId]) => {
                open.disabled = !((viewMode === 'state' && selectedStateId !== undefined) ||
                    (viewMode === 'strategicregion' && selectedStrategicRegionId !== undefined) ||
                    (viewMode === 'supplyarea' && selectedSupplyAreaId !== undefined));
            }
        ));
    }

    private loadExportButton() {
        const exportButton = document.getElementById("export") as HTMLButtonElement;
        exportButton.disabled = true;
        this.addSubscription(this.loader.worldMap$.subscribe(wm => {
            exportButton.disabled = !wm;
        }));
        this.addSubscription(fromEvent(exportButton, 'click').subscribe(e => {
            e.stopPropagation();
            vscode.postMessage({ command: 'requestexportmap' });
        }));
        this.addSubscription(fromEvent<MessageEvent>(window, 'message').subscribe(event => {
            const message = event.data as WorldMapMessage;
            if (message.command !== 'requestexportmap') {
                return;
            }

            const worldMap = this.loader.worldMap;
            if (!worldMap) {
                return;
            }

            sendEvent('worldmap.export');
            const canvas = document.createElement("canvas");
            canvas.width = Math.max(1, worldMap.width);
            canvas.height = Math.max(1, worldMap.height);
            const viewPoint = new ViewPoint(canvas, this.loader, 0, { x: 0, y: 0, scale: 1 });
            Renderer.renderMapImpl(canvas, this, viewPoint, worldMap, { preciseEdge: true, overwriteRenderPrecision: 1 });
            vscode.postMessage({ command: 'exportmap', dataUrl: canvas.toDataURL() });
        }));
    }
    
    private loadEditButton() {
        const editButton = document.getElementById('edit') as HTMLButtonElement;
        const addButton = document.getElementById('add') as HTMLButtonElement;
        editButton.disabled = true;
        addButton.disabled = true;
        const pencilUri: string | undefined = (window as any).__pencilUri;

        const that = this;

        function enterEditMode() {
            that.editMode$.next(true);
            editButton.classList.add('active');
            that.canvas.style.cursor = pencilUri ? "url('" + pencilUri + "') 3.5 27.5, pointer" : 'crosshair';
        }

        function exitEditMode() {
            that.editMode$.next(false);
            editButton.classList.remove('active');
            that.canvas.style.cursor = 'crosshair';
        }

        this.addSubscription(this.viewMode$.subscribe(() => {
            exitEditMode();
        }));

        this.addSubscription(combineLatest([
            this.viewMode$,
            this.selectedStateId$,
            this.selectedStrategicRegionId$,
        ]).subscribe(() => {
            editButton.disabled = !this.canEditCurrentView();
            addButton.disabled = !(this.viewMode$.value === 'state' || this.viewMode$.value === 'strategicregion');
        }));

        this.addSubscription(fromEvent(editButton, 'click').subscribe(e => {
            e.stopPropagation();
            if (!this.editMode$.value) {
                sendEvent('worldmap.entereditmode.' + this.viewMode$.value);
                enterEditMode();
            } else {
                exitEditMode();
            }
        }));

        this.addSubscription(fromEvent(addButton, 'click').subscribe(e => {
            e.stopPropagation();
            if (this.loader.worldMap) {
                sendEvent('worldmap.add.' + this.viewMode$.value);
                vscode.postMessage<WorldMapMessage>({ command: 'addmapitem', type: this.viewMode$.value as 'state' | 'strategicregion' });
            }
        }));

        this.addSubscription(fromEvent<MessageEvent>(window, 'message').subscribe(event => {
            const message = event.data as WorldMapMessage;
            if (message.command !== 'selectmapitem') {
                return;
            }

            if (message.type === this.viewMode$.value) {
                if (message.type === 'state') {
                    this.selectedStateId$.next(message.id);
                } else if (message.type === 'strategicregion') {
                    this.selectedStrategicRegionId$.next(message.id);
                }
                if (message.enterEditMode && this.canEditCurrentView()) {
                    enterEditMode();
                }
            }
        }));
    }

    private canEditCurrentView(): boolean {
        const viewMode = this.viewMode$.value;
        return (viewMode === 'state' && this.selectedStateId$.value !== undefined) ||
            (viewMode === 'strategicregion' && this.selectedStrategicRegionId$.value !== undefined);
    }

    private loadSelectedRegionButton() {
        const selectedRegionButton = document.getElementById('selectedregion') as HTMLButtonElement;
        const selectedRegionText = document.getElementById('selectedregion-text') as HTMLSpanElement;

        this.addSubscription(combineLatest([
            this.viewMode$,
            this.selectedProvinceId$,
            this.selectedStateId$,
            this.selectedStrategicRegionId$,
            this.selectedSupplyAreaId$,
        ]).subscribe(() => {
            selectedRegionButton.disabled = !this.canViewSelected();
            const selected = this.getSelectedItemId();
            selectedRegionText.textContent = selected === undefined ?
                feLocalize('worldmap.topbar.selectedregion.none', 'None') :
                selected.toString();
        }));

        this.addSubscription(fromEvent(selectedRegionButton, 'click').subscribe(e => {
            e.stopPropagation();
            this.viewSelected();
        }));
    }

    private getSelectedItemId(): number | undefined {
        switch (this.viewMode$.value) {
            case 'province':
                return this.selectedProvinceId$.value;
            case 'state':
                return this.selectedStateId$.value;
            case 'strategicregion':
                return this.selectedStrategicRegionId$.value;
            case 'supplyarea':
                return this.selectedSupplyAreaId$.value;
            default:
                return undefined;
        }
    }

    private canViewSelected(): boolean {
        const worldMap = this.loader.worldMap;
        const id = this.getSelectedItemId();
        if (id === undefined) {
            return false;
        }
        switch (this.viewMode$.value) {
            case 'province':
                return worldMap.getProvinceById(id) !== undefined;
            case 'state':
                return worldMap.getStateById(id) !== undefined;
            case 'strategicregion':
                return worldMap.getStrategicRegionById(id) !== undefined;
            case 'supplyarea':
                return worldMap.getSupplyAreaById(id) !== undefined;
            default:
                return false;
        }
    }

    private viewSelected(): void {
        const worldMap = this.loader.worldMap;
        const id = this.getSelectedItemId();
        if (id === undefined) {
            return;
        }
        const region = this.viewMode$.value === 'province' ? worldMap.getProvinceById(id) :
            this.viewMode$.value === 'state' ? worldMap.getStateById(id) :
            this.viewMode$.value === 'strategicregion' ? worldMap.getStrategicRegionById(id) :
            worldMap.getSupplyAreaById(id);
        if (region && region.boundingBox.h > 0 && region.boundingBox.w > 0) {
            this.viewPoint.centerZone(region.boundingBox);
        }
    }

    // Edit-mode click on a province: ask the extension host to move it into the selected region.
    // The target files are resolved (and copied into the workspace if needed) on the host side.
    private moveProvinceToSelected(): void {
        const worldMap = this.loader.worldMap;
        const hoverProvince = worldMap.getProvinceById(this.editModeHoverProvinceId$.value);
        if (!hoverProvince) {
            return;
        }

        const viewMode = this.viewMode$.value;
        if (viewMode === 'state') {
            const selectedState = worldMap.getStateById(this.selectedStateId$.value);
            if (!selectedState) {
                return;
            }
            const hoverState = worldMap.getStateByProvinceId(hoverProvince.id);
            vscode.postMessage<WorldMapMessage>({
                command: 'moveprovince',
                type: 'state',
                province: hoverProvince.id,
                to: selectedState.id,
                from: hoverState?.id,
                toFile: selectedState.file,
                fromFile: hoverState?.file,
            });
        } else if (viewMode === 'strategicregion') {
            const selectedStrategicRegion = worldMap.getStrategicRegionById(this.selectedStrategicRegionId$.value);
            if (!selectedStrategicRegion) {
                return;
            }
            const hoverStrategicRegion = worldMap.getStrategicRegionByProvinceId(hoverProvince.id);
            vscode.postMessage<WorldMapMessage>({
                command: 'moveprovince',
                type: 'strategicregion',
                province: hoverProvince.id,
                to: selectedStrategicRegion.id,
                from: hoverStrategicRegion?.id,
                toFile: selectedStrategicRegion.file,
                fromFile: hoverStrategicRegion?.file,
            });
        }
    }

    // Middle-button click: select the item under the cursor without toggling the previous selection.
    private selectHoveredItem(): void {
        switch (this.viewMode$.value) {
            case 'province':
                this.selectedProvinceId$.next(this.hoverProvinceId$.value);
                break;
            case 'state':
                this.selectedStateId$.next(this.hoverStateId$.value);
                break;
            case 'strategicregion':
                this.selectedStrategicRegionId$.next(this.hoverStrategicRegionId$.value);
                break;
            case 'supplyarea':
                this.selectedSupplyAreaId$.next(this.hoverSupplyAreaId$.value);
                break;
        }
    }
    
    private registerEventListeners(canvas: HTMLCanvasElement) {
        let midButtonDown = false;

        this.addSubscription(fromEvent<MouseEvent>(canvas, 'mousemove').subscribe((e) => {
            if (!this.loader.worldMap) {
                this.hoverProvinceId$.next(undefined);
                this.hoverStateId$.next(undefined);
                this.hoverStrategicRegionId$.next(undefined);
                this.hoverSupplyAreaId$.next(undefined);
                this.editModeHoverProvinceId$.next(undefined);
                return;
            }
    
            const worldMap = this.loader.worldMap;
            let x = this.viewPoint.convertBackX(e.pageX);
            let y = this.viewPoint.convertBackY(e.pageY);
            if (x < 0) {
                x += worldMap.width;
            }
            while (x >= worldMap.width && worldMap.width > 0) {
                x -= worldMap.width;
            }

            this.hoverProvinceId$.next(worldMap.getProvinceByPosition(x, y)?.id);
            this.editModeHoverProvinceId$.next(this.hoverProvinceId$.value);
            this.hoverStateId$.next(this.hoverProvinceId$.value === undefined ? undefined : worldMap.getStateByProvinceId(this.hoverProvinceId$.value)?.id);
            this.hoverStrategicRegionId$.next(this.hoverProvinceId$.value === undefined ? undefined : worldMap.getStrategicRegionByProvinceId(this.hoverProvinceId$.value)?.id);
            this.hoverSupplyAreaId$.next(this.hoverStateId$.value === undefined ? undefined : worldMap.getSupplyAreaByStateId(this.hoverStateId$.value)?.id);
        }));
    
        this.addSubscription(fromEvent(canvas, 'mouseleave').subscribe(() => {
            this.hoverProvinceId$.next(undefined);
            this.hoverStateId$.next(undefined);
            this.hoverStrategicRegionId$.next(undefined);
            this.hoverSupplyAreaId$.next(undefined);
            this.editModeHoverProvinceId$.next(undefined);
            midButtonDown = false;
        }));
    
        this.addSubscription(fromEvent(canvas, 'click').subscribe(() => {
            if (this.editMode$.value && (this.viewMode$.value === 'state' || this.viewMode$.value === 'strategicregion')) {
                this.moveProvinceToSelected();
                return;
            }
            switch (this.viewMode$.value) {
                case 'province':
                    this.selectedProvinceId$.next(this.selectedProvinceId$.value === this.hoverProvinceId$.value ? undefined : this.hoverProvinceId$.value);
                    break;
                case 'state':
                    this.selectedStateId$.next(this.selectedStateId$.value === this.hoverStateId$.value ? undefined : this.hoverStateId$.value);
                    break;
                case 'strategicregion':
                    this.selectedStrategicRegionId$.next(this.selectedStrategicRegionId$.value === this.hoverStrategicRegionId$.value ? undefined : this.hoverStrategicRegionId$.value);
                    break;
                case 'supplyarea':
                    this.selectedSupplyAreaId$.next(this.selectedSupplyAreaId$.value === this.hoverSupplyAreaId$.value ? undefined : this.hoverSupplyAreaId$.value);
                    break;
            }
        }));

        this.addSubscription(fromEvent(canvas, 'dblclick').subscribe(e => {
            e.stopPropagation();
            if (!this.editMode$.value) {
                this.openMapItem(true);
            }
        }));

        this.addSubscription(fromEvent<MouseEvent>(canvas, 'mousedown').subscribe(e => {
            if (e.button === 1) {
                midButtonDown = true;
            }
        }));

        this.addSubscription(fromEvent<MouseEvent>(canvas, 'mouseup').subscribe(e => {
            if (e.button === 1) {
                if (midButtonDown) {
                    e.preventDefault();
                    this.selectHoveredItem();
                }
                midButtonDown = false;
            }
        }));

        this.addSubscription(this.viewMode$.subscribe(() => this.onViewModeChange()));

        this.addSubscription(this.loader.worldMap$.subscribe(wm => {
            const warnings = document.getElementById('warnings') as HTMLTextAreaElement;
            if (wm.warnings.length === 0) {
                warnings.value = feLocalize('worldmap.warnings.nowarnings', 'No warnings.');
            } else {
                warnings.value = feLocalize('worldmap.warnings', 'World map warnings: \n\n{0}', wm.warnings.map(warningToString).join('\n'));
            }

            this.setSearchBoxPlaceHolder(wm);
        }));
    }

    private search(text: string) {
        const number = parseInt(text);
        if (isNaN(number)) {
            return;
        }

        const viewMode = this.viewMode$.value;
        const [getRegionById, selectedId] =
            viewMode === 'province' ? [this.loader.worldMap.getProvinceById, this.selectedProvinceId$] :
            viewMode === 'state' ? [this.loader.worldMap.getStateById, this.selectedStateId$] :
            viewMode === 'strategicregion' ? [this.loader.worldMap.getStrategicRegionById, this.selectedStrategicRegionId$] :
            viewMode === 'supplyarea' ? [this.loader.worldMap.getSupplyAreaById, this.selectedSupplyAreaId$] :
            [() => undefined, undefined];
            
        const region = getRegionById(number);
        if (region) {
            selectedId?.next(number);
            this.viewPoint.centerZone(region.boundingBox);
        }
    }

    private setSearchBoxPlaceHolder(worldMap?: FEWorldMap) {
        if (!worldMap) {
            worldMap = this.loader.worldMap;
        }

        let placeholder = '';
        switch (this.viewMode$.value) {
            case 'province':
                placeholder = worldMap.provincesCount > 1 ? `1-${worldMap.provincesCount - 1}` : '';
                break;
            case 'state':
                placeholder = worldMap.statesCount > 1 ? `1-${worldMap.statesCount - 1}` : '';
                break;
            case 'strategicregion':
                placeholder = worldMap.strategicRegionsCount > 1 ? `1-${worldMap.strategicRegionsCount - 1}` : '';
                break;
            case 'supplyarea':
                placeholder = worldMap.supplyAreasCount > 1 ? `1-${worldMap.supplyAreasCount - 1}` : '';
                break;
            default:
                break;
        }

        if (placeholder) {
            this.searchBox.placeholder = feLocalize('worldmap.topbar.search.placeholder', 'Range: {0}', placeholder);
        } else {
            this.searchBox.placeholder = '';
        }
    }
}

function warningToString(warning: WorldMapWarning): string {
    return `[${warning.source.map(s => `${s.type[0].toUpperCase()}${s.type.substr(1)} ${'id' in s ? s.id : s.name}`).join(', ')}] ${warning.text}`;
}
