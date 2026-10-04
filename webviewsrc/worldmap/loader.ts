import { WorldMapMessage, Province, WorldMapData, RequestMapItemMessage, State, Country, Point, Region, Bookmark, ConditionItem } from "./definitions";
import { applyCondition } from "../../src/hoiformat/condition";
import { copyArray } from "../util/common";
import { inBBox } from "./graphutils";
import { Subscriber } from "../util/event";
import { WorldMapWarning, Terrain, StrategicRegion, SupplyArea, Railway, SupplyNode, Resource, River, FactoryImages } from "../../src/previewdef/worldmap/definitions";
import { vscode } from "../util/vscode";
import { BehaviorSubject, fromEvent, Observable, ObservedValueOf, Subject } from 'rxjs';
import { buildProvinceSpatialIndex, defaultCellSize, ProvinceSpatialIndex, queryPointCandidates } from "./spatialindex";
import { buildWarningIndex, WarningIndex, queryProvinceWarnings, queryStateWarnings, queryStrategicRegionWarnings, querySupplyAreaWarnings, queryRiverWarnings } from "./warningindex";

interface ExtraMapData {
    provincesCount: number;
    statesCount: number;
    countriesCount: number;
    railwaysCount: number;
    supplyNodesCount: number;
}

interface FEWorldMapClassExtra {
    getProvinceById(provinceId: number | undefined): Province | undefined;
    getStateById(stateId: number | undefined): State | undefined;
    getStrategicRegionById(strategicRegionId: number | undefined): StrategicRegion | undefined;
    getSupplyAreaById(supplyAreaId: number | undefined): SupplyArea | undefined;

    getStateByProvinceId(provinceId: number): State | undefined;
    getProvinceToStateMap(): Record<number, number | undefined>;
    
    getStrategicRegionByProvinceId(provinceId: number): StrategicRegion | undefined;
    getProvinceToStrategicRegionMap(): Record<number, number | undefined>;

    getSupplyAreaByStateId(stateId: number): SupplyArea | undefined;
    getStateToSupplyAreaMap(): Record<number, number | undefined>;

    getRailwayLevelByProvinceId(provinceId: number): number | undefined;

    getSupplyNodeByProvinceId(provinceId: number): SupplyNode | undefined;

    getProvinceByPosition(x: number, y: number): Province | undefined;

    getCountryColorByTag(): Record<string, number>;
    getCountryByTag(tag: string | undefined): Country | undefined;
    getCountryRegionByTag(tag: string): { provinces: number[] } & Region | undefined;

    // Selected conditions (bookmark dates) are applied when resolving a state's history values.
    setSelectedConditions(conditions: ConditionItem[]): void;
    getSelectedConditions(): ConditionItem[];
    getStateOwner(state: State | undefined): string | undefined;

    getProvinceWarnings(province?: Province, state?: State, strategicRegion?: StrategicRegion, supplyArea?: SupplyArea): string[];
    getStateWarnings(state: State, supplyArea?: SupplyArea): string[];
    getStrategicRegionWarnings(strategicRegion: StrategicRegion): string[];
    getSupplyAreaWarnings(supplyArea: SupplyArea): string[];
    getRiverWarnings(riverIndex: number): string[];

    forEachProvince(callback: (province: Province) => boolean | void): void;
    forEachState(callback: (state: State) => boolean | void): void;
    forEachStrategicRegion(callback: (strategicRegion: StrategicRegion) => boolean | void): void;
    forEachSupplyArea(callback: (supplyArea: SupplyArea) => boolean | void): void;
    forEachRailway(callback: (railway: Railway) => boolean | void): void;
    forEachSupplyNode(callback: (supplyNode: SupplyNode) => boolean | void): void;
}

export type FEWorldMap = Omit<WorldMapData, 'states' | 'provinces' | 'strategicRegions' | 'supplyAreas' | 'railways' | 'supplyNodes'>
    & ExtraMapData & FEWorldMapClassExtra;

export class Loader extends Subscriber {
    public worldMap: FEWorldMapClass;
    public loading$ = new BehaviorSubject<boolean>(false);
    public progress: number = 0;
    public progressText: string = '';

    private writableWorldMap$ = new Subject<FEWorldMap>();
    public worldMap$: Observable<FEWorldMap> = this.writableWorldMap$;

    private writableProgress$ = new BehaviorSubject({ progress: 0, progressText: '' });
    public progress$: Observable<ObservedValueOf<Loader['writableProgress$']>> = this.writableProgress$;

    private loadingProvinceMap: WorldMapData & { provincesCount: number; statesCount: number; countriesCount: number; } | undefined;
    private loadingQueue: WorldMapMessage[] = [];
    private loadingQueueStartLength = 0;

    constructor() {
        super();
        this.worldMap = new FEWorldMapClass();
        this.load();
        this.worldMap$.subscribe(wm => (window as any)['worldMap'] = wm);
    }

    public refresh() {
        this.worldMap = new FEWorldMapClass();
        this.writableWorldMap$.next(this.worldMap);
        vscode.postMessage({ command: 'loaded', force: true } as WorldMapMessage);
        this.loading$.next(true);
    }

    private load() {
        this.addSubscription(fromEvent<MessageEvent>(window, 'message').subscribe(event => {
            const message = event.data as WorldMapMessage;
            switch (message.command) {
                case 'provincemapsummary':
                    this.loadingProvinceMap = { ...message.data };
                    this.loadingProvinceMap.provinces = new Array(this.loadingProvinceMap.provincesCount);
                    this.loadingProvinceMap.states = new Array(this.loadingProvinceMap.statesCount);
                    this.loadingProvinceMap.countries = new Array(this.loadingProvinceMap.countriesCount);
                    this.loadingProvinceMap.strategicRegions = new Array(this.loadingProvinceMap.strategicRegionsCount);
                    console.log(message.data);
                    this.startLoading();
                    break;
                case 'provinces':
                    this.receiveData(this.loadingProvinceMap?.provinces, message.start, message.end, message.data);
                    if (this.loadingProvinceMap) {
                        this.loadingProvinceMap.provincesCount = message.count ?? this.loadingProvinceMap.provincesCount;
                        this.loadingProvinceMap.badProvincesCount = message.badCount ?? this.loadingProvinceMap.badProvincesCount;
                    }
                    this.loadNext();
                    break;
                case 'states':
                    this.receiveData(this.loadingProvinceMap?.states, message.start, message.end, message.data);
                    if (this.loadingProvinceMap) {
                        this.loadingProvinceMap.statesCount = message.count ?? this.loadingProvinceMap.statesCount;
                        this.loadingProvinceMap.badStatesCount = message.badCount ?? this.loadingProvinceMap.badStatesCount;
                    }
                    this.loadNext();
                    break;
                case 'countries':
                    this.receiveData(this.loadingProvinceMap?.countries, message.start, message.end, message.data);
                    if (this.loadingProvinceMap) {
                        this.loadingProvinceMap.countriesCount = message.count ?? this.loadingProvinceMap.countriesCount;
                    }
                    this.loadNext();
                    break;
                case 'strategicregions':
                    this.receiveData(this.loadingProvinceMap?.strategicRegions, message.start, message.end, message.data);
                    if (this.loadingProvinceMap) {
                        this.loadingProvinceMap.strategicRegionsCount = message.count ?? this.loadingProvinceMap.strategicRegionsCount;
                        this.loadingProvinceMap.badStrategicRegionsCount = message.badCount ?? this.loadingProvinceMap.badStrategicRegionsCount;
                    }
                    this.loadNext();
                    break;
                case 'supplyareas':
                    this.receiveData(this.loadingProvinceMap?.supplyAreas, message.start, message.end, message.data);
                    if (this.loadingProvinceMap) {
                        this.loadingProvinceMap.supplyAreasCount = message.count ?? this.loadingProvinceMap.supplyAreasCount;
                        this.loadingProvinceMap.badSupplyAreasCount = message.badCount ?? this.loadingProvinceMap.badSupplyAreasCount;
                    }
                    this.loadNext();
                    break;
                case 'railways':
                    this.receiveData(this.loadingProvinceMap?.railways, message.start, message.end, message.data);
                    if (this.loadingProvinceMap) {
                        this.loadingProvinceMap.railwaysCount = message.count ?? this.loadingProvinceMap.railwaysCount;
                    }
                    this.loadNext();
                    break;
                case 'supplynodes':
                    this.receiveData(this.loadingProvinceMap?.supplyNodes, message.start, message.end, message.data);
                    if (this.loadingProvinceMap) {
                        this.loadingProvinceMap.supplyNodesCount = message.count ?? this.loadingProvinceMap.supplyNodesCount;
                    }
                    this.loadNext();
                    break;
                case 'warnings':
                    if (this.loadingProvinceMap) {
                        this.loadingProvinceMap.warnings = JSON.parse(message.data);
                        this.loadNext();
                    }
                    break;
                case 'continents':
                    if (this.loadingProvinceMap) {
                        this.loadingProvinceMap.continents = JSON.parse(message.data);
                        this.loadNext();
                    }
                    break;
                case 'terrains':
                    if (this.loadingProvinceMap) {
                        this.loadingProvinceMap.terrains = JSON.parse(message.data);
                        this.loadNext();
                    }
                    break;
                case 'resources':
                    if (this.loadingProvinceMap) {
                        this.loadingProvinceMap.resources = JSON.parse(message.data);
                        this.loadNext();
                    }
                    break;
                case 'progress':
                    this.progressText = message.data;
                    this.writableProgress$.next({ progressText: this.progressText, progress: this.progress });
                    break;
                case 'error':
                    this.progressText = message.data;
                    this.writableProgress$.next({ progressText: this.progressText, progress: this.progress });
                    this.loading$.next(false);
                    break;
            }
        }));

        vscode.postMessage({ command: 'loaded', force: false } as WorldMapMessage);
        this.loading$.next(true);
    }

    private startLoading() {
        if (!this.loadingProvinceMap) {
            return;
        }
    
        this.loadingQueue.length = 0;
    
        this.queueLoadingRequest('requestcountries', this.loadingProvinceMap.countriesCount, 750);
        this.queueLoadingRequest('requeststrategicregions', this.loadingProvinceMap.strategicRegionsCount, 750);
        this.queueLoadingRequest('requeststrategicregions', -this.loadingProvinceMap.badStrategicRegionsCount, 750, this.loadingProvinceMap.badStrategicRegionsCount);
        this.queueLoadingRequest('requestsupplyareas', this.loadingProvinceMap.supplyAreasCount, 750);
        this.queueLoadingRequest('requestsupplyareas', -this.loadingProvinceMap.badSupplyAreasCount, 750, this.loadingProvinceMap.badSupplyAreasCount);
        this.queueLoadingRequest('requeststates', this.loadingProvinceMap.statesCount, 750);
        this.queueLoadingRequest('requeststates', -this.loadingProvinceMap.badStatesCount, 750, this.loadingProvinceMap.badStatesCount);
        this.queueLoadingRequest('requestprovinces', this.loadingProvinceMap.provincesCount, 750);
        this.queueLoadingRequest('requestprovinces', -this.loadingProvinceMap.badProvincesCount, 750, this.loadingProvinceMap.badProvincesCount);
        this.queueLoadingRequest('requestrailways', this.loadingProvinceMap.railwaysCount, 2500);
        this.queueLoadingRequest('requestsupplynodes', this.loadingProvinceMap.supplyNodesCount, 5000);

        this.loadingQueueStartLength = this.loadingQueue.length;
        this.progressText = '';
        this.loadNext();
    }

    private queueLoadingRequest<C extends RequestMapItemMessage['command']>(command: C, count: number, step: number, offset: number = 0) {
        for (let i = offset, j = 0; j < count; i += step, j += step) {
            this.loadingQueue.push({
                command,
                start: i,
                end: Math.min(i + step, offset + count),
            });
        }
    }

    private loadNext(updateMap: boolean = true) {
        this.progress = 1 - this.loadingQueue.length / this.loadingQueueStartLength;

        if (this.loadingQueue.length === 0) {
            // Final emit is synchronous against the now-complete arrays: guarantees the last frame is
            // never a partial one and covers hidden panels, where the rAF path never fires.
            if (updateMap) {
                this.emitWorldMap();
            }
            this.loading$.next(false);
        } else {
            // Keep the request pump immediate; only the map emit is rAF-coalesced.
            vscode.postMessage(this.loadingQueue.shift());
            if (updateMap) {
                this.scheduleWorldMapEmit();
            }
        }

        this.writableProgress$.next({ progressText: this.progressText, progress: this.progress });
    }

    private pendingEmit = false;
    private scheduleWorldMapEmit(): void {
        if (this.pendingEmit) {
            return;
        }
        this.pendingEmit = true;
        requestAnimationFrame(() => {
            if (this.pendingEmit) {
                this.emitWorldMap();
            }
        });
    }

    private emitWorldMap(): void {
        this.pendingEmit = false;
        this.worldMap = new FEWorldMapClass(this.loadingProvinceMap!);
        this.writableWorldMap$.next(this.worldMap);
    }
    
    private receiveData<T>(arr: T[] | undefined, start: number, end: number, data: string): void {
        if (arr) {
            copyArray(JSON.parse(data), arr, 0, start, end - start);
        }
    }
}

export class FEWorldMapClass implements FEWorldMap {
    width!: number;
    height!: number;
    countries!: Country[];
    warnings!: WorldMapWarning[];
    provincesCount!: number;
    statesCount!: number;
    countriesCount!: number;
    strategicRegionsCount!: number;
    supplyAreasCount!: number;
    railwaysCount!: number;
    supplyNodesCount!: number;
    badProvincesCount!: number;
    badStatesCount!: number;
    badStrategicRegionsCount!: number;
    badSupplyAreasCount!: number;
    continents!: string[];
    terrains!: Terrain[];
    resources!: Resource[];
    factoryImages!: FactoryImages;
    stateCategories!: string[];
    provinceDefinitionsFile!: string;
    stateCategoryNames!: Record<string, string>;
    stateCategorySlots!: Record<string, number>;
    rivers!: River[];
    conditionExprs!: ConditionItem[];
    bookmarks!: Bookmark[];

    private provinces!: (Province | null | undefined)[];
    private states!: (State | null | undefined)[];
    private strategicRegions!: (StrategicRegion | null | undefined)[];
    private supplyAreas!: (SupplyArea | null | undefined)[];
    private railways!: (Railway | null | undefined)[];
    private supplyNodes!: (SupplyNode | null | undefined)[];

    // Reverse-lookup maps, memoized per instance. Lifetime is strictly this instance: the loader
    // builds a fresh FEWorldMapClass per emit, so a memo built mid-load is discarded next emit and
    // the final post-load instance memoizes against complete arrays.
    private provinceToStateMemo: Record<number, number | undefined> | undefined = undefined;
    private provinceToStrategicRegionMemo: Record<number, number | undefined> | undefined = undefined;
    private stateToSupplyAreaMemo: Record<number, number | undefined> | undefined = undefined;
    private provinceToRailwayLevelMemo: Record<number, number | undefined> | undefined = undefined;
    private provinceToSupplyNodeMemo: Record<number, SupplyNode | undefined> | undefined = undefined;
    // Spatial index over province bounding boxes, built lazily for point lookups (hover and
    // region-label background queries). Memoized per instance like the reverse maps above, so a
    // mid-load emit discards a half-built index and the final instance builds against complete data.
    private provinceSpatialIndexMemo: ProvinceSpatialIndex | undefined = undefined;
    // Reverse warning index and country tag -> color map, built lazily for the render hot path
    // (per-province coloring / tooltips). Same per-instance lifetime as the other memos.
    private warningIndexMemo: WarningIndex | undefined = undefined;
    private countryColorByTagMemo: Record<string, number> | undefined = undefined;
    // Bookmark-date conditions the user toggled; empty means "no date selected".
    private selectedConditions: ConditionItem[] = [];

    constructor(worldMap?: WorldMapData & ExtraMapData) {
        Object.assign(this, worldMap ?? ({
            width: 0, height: 0,
            provinces: [], states: [], countries: [], warnings: [], continents: [], strategicRegions: [], supplyAreas: [], terrains: [],
            railways: [], supplyNodes: [], resources: [], factoryImages: { civilian: '', military: '' }, stateCategories: [], stateCategoryNames: {}, stateCategorySlots: {}, rivers: [],
            provinceDefinitionsFile: '',
            conditionExprs: [], bookmarks: [],
            provincesCount: 0, statesCount: 0, countriesCount: 0, strategicRegionsCount: 0, supplyAreasCount: 0,
            badProvincesCount: 0, badStatesCount: 0, badStrategicRegionsCount: 0, badSupplyAreasCount: 0,
            railwaysCount: 0, supplyNodesCount: 0,
        } as WorldMapData & ExtraMapData));
    }

    public getProvinceById = (provinceId: number | undefined): Province | undefined => {
        return provinceId ? this.provinces[provinceId] ?? undefined : undefined;
    };

    public getStateById = (stateId: number | undefined): State | undefined => {
        return stateId ? this.states[stateId] ?? undefined : undefined;
    };

    public getStrategicRegionById = (strategicRegionId: number | undefined): StrategicRegion | undefined => {
        return strategicRegionId ? this.strategicRegions[strategicRegionId] ?? undefined : undefined;
    };

    public getSupplyAreaById = (supplyAreaId: number | undefined): SupplyArea | undefined => {
        return supplyAreaId ? this.supplyAreas[supplyAreaId] ?? undefined : undefined;
    };

    public getStateByProvinceId(provinceId: number): State | undefined {
        return this.getStateById(this.getProvinceToStateMap()[provinceId]);
    }

    public getStrategicRegionByProvinceId(provinceId: number): StrategicRegion | undefined {
        return this.getStrategicRegionById(this.getProvinceToStrategicRegionMap()[provinceId]);
    }

    public getSupplyAreaByStateId(stateId: number): SupplyArea | undefined {
        return this.getSupplyAreaById(this.getStateToSupplyAreaMap()[stateId]);
    }

    public getRailwayLevelByProvinceId(provinceId: number): number | undefined {
        if (this.provinceToRailwayLevelMemo === undefined) {
            const result: Record<number, number | undefined> = {};
            this.forEachRailway(railway =>
                railway.provinces.forEach(p => {
                    const existing = result[p];
                    result[p] = existing === undefined ? railway.level : Math.max(existing, railway.level);
                })
            );
            this.provinceToRailwayLevelMemo = result;
        }
        return this.provinceToRailwayLevelMemo[provinceId];
    }

    public getSupplyNodeByProvinceId(provinceId: number): SupplyNode | undefined {
        if (this.provinceToSupplyNodeMemo === undefined) {
            const result: Record<number, SupplyNode | undefined> = {};
            this.forEachSupplyNode(supplyNode => {
                if (result[supplyNode.province] === undefined) {
                    result[supplyNode.province] = supplyNode;
                }
            });
            this.provinceToSupplyNodeMemo = result;
        }
        return this.provinceToSupplyNodeMemo[provinceId];
    }
    
    public getProvinceSpatialIndex(): ProvinceSpatialIndex {
        if (this.provinceSpatialIndexMemo === undefined) {
            this.provinceSpatialIndexMemo = buildProvinceSpatialIndex(this.provinces, this.width, defaultCellSize(this.width));
        }
        return this.provinceSpatialIndexMemo;
    }

    public getProvinceByPosition(x: number, y: number): Province | undefined {
        const point: Point = { x, y };
        // Spatial index narrows the scan to the single grid cell the point falls into; the exact
        // bounding-box + coverZones test is unchanged, so the result is identical to a full scan.
        const candidates = queryPointCandidates(this.getProvinceSpatialIndex(), x, y);
        for (const id of candidates) {
            const province = this.provinces[id];
            if (province && inBBox(point, province.boundingBox) && province.coverZones.some(z => inBBox(point, z))) {
                return province;
            }
        }
        return undefined;
    }

    public getProvinceToStateMap(): Record<number, number | undefined> {
        if (this.provinceToStateMemo === undefined) {
            const result: Record<number, number | undefined> = {};
            this.forEachState(state =>
                state.provinces.forEach(p => {
                    result[p] = state.id;
                })
            );
            this.provinceToStateMemo = result;
        }
        return this.provinceToStateMemo;
    }

    public getProvinceToStrategicRegionMap(): Record<number, number | undefined> {
        if (this.provinceToStrategicRegionMemo === undefined) {
            const result: Record<number, number | undefined> = {};
            this.forEachStrategicRegion(strategicRegion =>
                strategicRegion.provinces.forEach(p => {
                    result[p] = strategicRegion.id;
                })
            );
            this.provinceToStrategicRegionMemo = result;
        }
        return this.provinceToStrategicRegionMemo;
    }

    public getStateToSupplyAreaMap(): Record<number, number | undefined> {
        if (this.stateToSupplyAreaMemo === undefined) {
            const result: Record<number, number | undefined> = {};
            this.forEachSupplyArea(supplyArea =>
                supplyArea.states.forEach(s => {
                    result[s] = supplyArea.id;
                })
            );
            this.stateToSupplyAreaMemo = result;
        }
        return this.stateToSupplyAreaMemo;
    }

    public forEachProvince(callback: (province: Province) => boolean | void) {
        const count = this.provincesCount;
        for (let i = this.badProvincesCount; i < count; i++) {
            const province = this.provinces[i];
            if (province && callback(province)) {
                break;
            }
        }
    }

    public forEachState(callback: (state: State) => boolean | void) {
        const count = this.statesCount;
        for (let i = this.badStatesCount; i < count; i++) {
            const state = this.states[i];
            if (state && callback(state)) {
                break;
            }
        }
    }

    public forEachStrategicRegion(callback: (strategicRegion: StrategicRegion) => boolean | void): void {
        const count = this.strategicRegionsCount;
        for (let i = this.badStrategicRegionsCount; i < count; i++) {
            const strategicRegion = this.strategicRegions[i];
            if (strategicRegion && callback(strategicRegion)) {
                break;
            }
        }
    }
    
    public forEachSupplyArea(callback: (supplyArea: SupplyArea) => boolean | void): void {
        const count = this.supplyAreasCount;
        for (let i = this.badSupplyAreasCount; i < count; i++) {
            const supplyArea = this.supplyAreas[i];
            if (supplyArea && callback(supplyArea)) {
                break;
            }
        }
    }
    
    public forEachRailway(callback: (railway: Railway) => boolean | void): void {
        const count = this.railwaysCount;
        for (let i = 0; i < count; i++) {
            const railway = this.railways[i];
            if (railway && callback(railway)) {
                break;
            }
        }
    }
    
    public forEachSupplyNode(callback: (supplyNode: SupplyNode) => boolean | void): void {
        const count = this.supplyNodesCount;
        for (let i = 0; i < count; i++) {
            const supplyNode = this.supplyNodes[i];
            if (supplyNode && callback(supplyNode)) {
                break;
            }
        }
    }

    public getWarningIndex(): WarningIndex {
        if (this.warningIndexMemo === undefined) {
            this.warningIndexMemo = buildWarningIndex(this.warnings);
        }
        return this.warningIndexMemo;
    }

    public getCountryColorByTag(): Record<string, number> {
        if (this.countryColorByTagMemo === undefined) {
            const result: Record<string, number> = {};
            for (const country of this.countries) {
                // Keep the FIRST country of a duplicated tag, mirroring countries.find().
                if (country && result[country.tag] === undefined) {
                    result[country.tag] = country.color;
                }
            }
            this.countryColorByTagMemo = result;
        }
        return this.countryColorByTagMemo;
    }

    public getCountryByTag(tag: string | undefined): Country | undefined {
        return tag === undefined ? undefined : this.countries.find(c => c.tag === tag);
    }

    public setSelectedConditions(conditions: ConditionItem[]): void {
        this.selectedConditions = conditions;
    }

    public getSelectedConditions(): ConditionItem[] {
        return this.selectedConditions;
    }

    // The first history entry whose condition holds under the selected conditions.
    public getStateOwner(state: State | undefined): string | undefined {
        return state?.owner.find(o => applyCondition(o.condition, this.selectedConditions))?.value;
    }

    // The union of the country's owned states, for centering the view and highlighting on hover.
    // The bounding box spans the owned provinces; a wrap-around country (spanning the map seam) is
    // centered on its widest run rather than the full span, which would otherwise cover the map.
    public getCountryRegionByTag(tag: string): { provinces: number[] } & Region | undefined {
        const provinces: number[] = [];
        this.forEachState(state => {
            if (this.getStateOwner(state) === tag) {
                provinces.push(...state.provinces);
            }
        });

        if (provinces.length === 0) {
            return undefined;
        }

        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const id of provinces) {
            const province = this.getProvinceById(id);
            if (!province) {
                continue;
            }
            minX = Math.min(minX, province.boundingBox.x);
            minY = Math.min(minY, province.boundingBox.y);
            maxX = Math.max(maxX, province.boundingBox.x + province.boundingBox.w);
            maxY = Math.max(maxY, province.boundingBox.y + province.boundingBox.h);
        }

        if (minX === Infinity) {
            return undefined;
        }

        return {
            provinces,
            boundingBox: { x: minX, y: minY, w: maxX - minX, h: maxY - minY },
            centerOfMass: { x: (minX + maxX) / 2, y: (minY + maxY) / 2 },
            mass: maxX - minX,
        };
    }

    public getProvinceWarnings(province?: Province, state?: State, strategicRegion?: StrategicRegion, supplyArea?: SupplyArea): string[] {
        return queryProvinceWarnings(this.getWarningIndex(), this.warnings, province, state, strategicRegion, supplyArea);
    }

    public getStateWarnings(state: State, supplyArea?: SupplyArea): string[] {
        return queryStateWarnings(this.getWarningIndex(), this.warnings, state, supplyArea);
    }

    public getStrategicRegionWarnings(strategicRegion: StrategicRegion): string[] {
        return queryStrategicRegionWarnings(this.getWarningIndex(), this.warnings, strategicRegion);
    }
    
    public getSupplyAreaWarnings(supplyArea: SupplyArea): string[] {
        return querySupplyAreaWarnings(this.getWarningIndex(), this.warnings, supplyArea);
    }

    public getRiverWarnings(riverIndex: number): string[] {
        return queryRiverWarnings(this.getWarningIndex(), this.warnings, riverIndex);
    }
}
