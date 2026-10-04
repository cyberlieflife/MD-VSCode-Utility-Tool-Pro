import { Province, Point, State, Zone, Terrain, StrategicRegion, SupplyArea, WithCondition } from "../../src/previewdef/worldmap/definitions";
import { FEWorldMap, Loader } from "./loader";
import { ViewPoint } from "./viewpoint";
import { bboxCenter, distanceSqr, distanceHamming, mergeRiverRuns, RiverPixel } from "./graphutils";
import { TopBar, topBarHeight, ColorSet, ViewMode } from "./topbar";
import { Subscriber } from "../util/event";
import { arrayToMap } from "../util/common";
import { applyCondition } from "../../src/hoiformat/condition";
import { feLocalize } from "../util/i18n";
import { chain, max } from "lodash";
import { combineLatest, fromEvent } from 'rxjs';
import { distinctUntilChanged } from 'rxjs/operators';

const landWarning = 0xE02020;
const landNoWarning = 0x7FFF7F;
const waterWarning = 0xC00000;
const waterNoWarning = 0x20E020;

const renderScaleByViewMode: Record<ViewMode, { edge: number, labels: number }> = {
    province: { edge: 2, labels: 3 },
    state: { edge: 1, labels: 1 },
    country: { edge: 0.25, labels: 0.25 },
    strategicregion: { edge: 0.25, labels: 0.25 },
    supplyarea: { edge: 0.5, labels: 1 },
    warnings: { edge: 2, labels: 3 },
};

interface RenderContext {
    topBar: TopBar;
    viewPoint: ViewPoint;
    mapCanvasContext: CanvasRenderingContext2D;
    provinceToState: Record<number, number | undefined>;
    provinceToStrategicRegion: Record<number, number | undefined>;
    stateToSupplyArea: Record<number, number | undefined>;
    renderedProvincesByOffset: Record<number, Province[]>;
    renderedProvincesById: Record<number, Province>;
    renderedProvinces?: Province[];
    overwriteRenderPrecision?: number;
    preciseEdge?: boolean;
    extraState: any;
}

export class Renderer extends Subscriber {
    private canvasWidth: number = 0;
    private canvasHeight: number = 0;
    
    private backCanvas: HTMLCanvasElement;
    private mapCanvas: HTMLCanvasElement;
    private mainCanvasContext: CanvasRenderingContext2D;
    private backCanvasContext: CanvasRenderingContext2D;
    
    private cursorX = 0;
    private cursorY = 0;

    private static resourceImages: Record<string, HTMLImageElement | undefined> = {};
    private static factoryImages: { civilian?: HTMLImageElement, military?: HTMLImageElement } = {};

    // Vertical gap between the factory row and the resource row when both are present.
    private static readonly ICON_ROW_GAP = 5;
    // Shared icon scale and number-slot width for factory/resource rows drawn over the map.
    private static readonly ICON_ROW_SCALE = 0.7;
    private static readonly ICON_ROW_LABEL_WIDTH = 16;
    // Tooltip rows keep the pre-icon-row defaults (full-size icons, wider number slots).
    private static readonly TOOLTIP_ICON_ROW_SCALE = 1;
    private static readonly TOOLTIP_ICON_ROW_LABEL_WIDTH = 30;

    // Single source of truth for laying out the factory and resource rows under a state label or
    // inside its tooltip: row sizes, the gap between them, and whether each row exists. Callers
    // pass the same layout object back to drawFactoryResourceRows so the frame and its content
    // can never disagree about the geometry.
    private static getFactoryResourceRowsLayout(state: State, scale: number, labelWidth: number) {
        const factories = Renderer.getFactoriesSize(state, scale, labelWidth);
        const resources = Renderer.getResourcesSize(state, scale, labelWidth);
        const gap = factories.height > 0 && resources.height > 0 ? Renderer.ICON_ROW_GAP : 0;
        return {
            factories,
            resources,
            gap,
            totalWidth: Math.max(factories.width, resources.width),
            totalHeight: factories.height + gap + resources.height,
        };
    }

    // Draws the factory row (civilian then military) and the resource row laid out by
    // getFactoryResourceRowsLayout, left-aligned at (x, y).
    private static drawFactoryResourceRows(context: CanvasRenderingContext2D, state: State, layout: ReturnType<typeof Renderer.getFactoryResourceRowsLayout>, x: number, y: number, scale: number, labelWidth: number) {
        let iconY = y;
        if (layout.factories.height > 0) {
            Renderer.renderFactories(context, state, x, iconY, scale, labelWidth);
            iconY += layout.factories.height + layout.gap;
        }
        if (layout.resources.height > 0) {
            Renderer.renderResources(context, state, x, iconY, scale, labelWidth);
        }
    }

    constructor(private mainCanvas: HTMLCanvasElement, private viewPoint: ViewPoint, private loader: Loader, private topBar: TopBar) {
        super();

        this.addSubscription(fromEvent(window, 'resize').subscribe(this.resizeCanvas));

        this.mainCanvasContext = this.mainCanvas.getContext('2d')!;
        this.backCanvas = document.createElement('canvas');
        this.backCanvasContext = this.backCanvas.getContext('2d')!;
        this.mapCanvas = document.createElement('canvas');

        this.registerCanvasEventHandlers();
        this.resizeCanvas();

        this.addSubscription(loader.worldMap$.subscribe(this.reloadImages));
        // Direct (not rAF-coalesced) so the load-completion emit always renders, even on a hidden panel.
        this.addSubscription(loader.worldMap$.subscribe(this.renderCanvas));
        this.addSubscription(
            combineLatest([
                loader.progress$,
                viewPoint.observable$,
                topBar.viewMode$,
                topBar.colorSet$,
                topBar.hoverProvinceId$,
                topBar.selectedProvinceId$,
                topBar.hoverStateId$,
                topBar.selectedStateId$,
                topBar.hoverStrategicRegionId$,
                topBar.selectedStrategicRegionId$,
                topBar.hoverSupplyAreaId$,
                topBar.selectedSupplyAreaId$,
                topBar.editMode$,
                topBar.editModeHoverProvinceId$,
                topBar.warningFilter.selectedValues$,
                topBar.display.selectedValues$,
            ]).pipe(
                distinctUntilChanged((x, y) => x.every((v, i) => v === y[i]))
            ).subscribe(this.scheduleRender)
        );
    }

    private renderScheduled = false;
    // Coalesces bursts of triggers into one render per frame; renderCanvas reads current state at
    // rAF time, so a coalesced render never paints stale data.
    private scheduleRender = () => {
        if (this.renderScheduled) {
            return;
        }
        this.renderScheduled = true;
        requestAnimationFrame(() => {
            this.renderScheduled = false;
            this.renderCanvas();
        });
    };

    private reloadImages = () => {
        for (const resource of this.loader.worldMap.resources) {
            const image = new Image();
            image.onload = () => {
                Renderer.resourceImages[resource.name] = image;
            };
            image.src = resource.imageUri;
        }

        const { civilian, military } = this.loader.worldMap.factoryImages;
        const loadFactoryImage = (uri: string, set: (image: HTMLImageElement) => void) => {
            if (!uri) {
                return;
            }
            const image = new Image();
            image.onload = () => {
                set(image);
                this.scheduleRender();
            };
            image.src = uri;
        };
        loadFactoryImage(civilian, image => Renderer.factoryImages.civilian = image);
        loadFactoryImage(military, image => Renderer.factoryImages.military = image);
    };

    public renderCanvas = () => {
        if (this.canvasWidth <= 0 && this.canvasHeight <= 0) {
            return;
        }

        const backCanvasContext = this.backCanvasContext;
    
        backCanvasContext.fillStyle = 'black';
        backCanvasContext.fillRect(0, 0, this.canvasWidth, this.canvasHeight);
        backCanvasContext.fillStyle = 'white';
        backCanvasContext.font = '12px sans-serif';

        this.renderMap();
        backCanvasContext.drawImage(this.mapCanvas, 0, 0);

        const viewMode = this.topBar.viewMode$.value;
        switch (viewMode) {
            case 'province':
            case 'warnings':
                this.renderProvinceHoverSelection(this.loader.worldMap);
                break;
            case 'state':
                if (this.topBar.editMode$.value) {
                    this.renderStateEditModeSelection(this.loader.worldMap);
                } else {
                    this.renderStateHoverSelection(this.loader.worldMap);
                }
                break;
            case 'country':
                this.renderCountryHoverSelection(this.loader.worldMap);
                break;
            case 'strategicregion':
                if (this.topBar.editMode$.value) {
                    this.renderStrategicRegionEditModeSelection(this.loader.worldMap);
                } else {
                    this.renderStrategicRegionHoverSelection(this.loader.worldMap);
                }
                break;
            case 'supplyarea':
                this.renderSupplyAreaHoverSelection(this.loader.worldMap);
                break;
        }

        if (this.loader.progressText !== '') {
            this.renderLoadingText(this.loader.progressText);
        } else if (this.loader.loading$.value) {
            this.renderLoadingText(feLocalize('worldmap.progress.visualizing', 'Visualizing map data: {0}', Math.round(this.loader.progress * 100) + '%'));
        }
    
        this.mainCanvasContext.drawImage(this.backCanvas, 0, 0);
    };
    
    private resizeCanvas = () => {
        this.canvasWidth = this.mainCanvas.width = this.mapCanvas.width = this.backCanvas.width = window.innerWidth;
        this.canvasHeight = this.mainCanvas.height = this.mapCanvas.height = this.backCanvas.height = window.innerHeight;
        // Coalesce the repaint into the rAF render like every other trigger; a resize storm (window
        // drag) otherwise renders once per resize event.
        this.scheduleRender();
    };

    private oldMapState: any = undefined;
    private renderMap() {
        const worldMap = this.loader.worldMap;
        const displayOptions = this.topBar.display.selectedValues$.value;
        const newMapState = {
            worldMap,
            canvasWidth: this.canvasWidth,
            canvasHeight: this.canvasHeight,
            viewMode: this.topBar.viewMode$.value,
            colorSet: this.topBar.colorSet$.value,
            warningFilter: this.topBar.warningFilter.selectedValues$.value,
            edgeVisible: displayOptions.includes('edge'),
            labelVisible: displayOptions.includes('label'),
            adaptZooming: displayOptions.includes('adaptzooming'),
            fastRendering: displayOptions.includes('fastrending'),
            supplyVisible: displayOptions.includes('supply'),
            riverVisible: displayOptions.includes('river'),
            resourceVisible: displayOptions.includes('resource'),
            factoryVisible: displayOptions.includes('factory'),
            ...this.viewPoint.toJson(),
        };

        // State not changed
        if (this.oldMapState !== undefined && Object.keys(newMapState).every(k => this.oldMapState[k] === (newMapState as any)[k])) {
            return;
        }
        this.oldMapState = newMapState;
        Renderer.renderMapImpl(this.mapCanvas, this.topBar, this.viewPoint, worldMap,
            newMapState.fastRendering ? {} : { preciseEdge: true, overwriteRenderPrecision: 1 });
    }

    public static renderMapImpl(canvas: HTMLCanvasElement, topBar: TopBar, viewPoint: ViewPoint, worldMap: FEWorldMap, otherRenderContext?: Partial<RenderContext>) {
        const mapCanvasContext = canvas.getContext('2d')!;
        mapCanvasContext.fillStyle = 'black';
        mapCanvasContext.fillRect(0, 0, canvas.width, canvas.height);

        const renderContext: RenderContext = {
            topBar,
            viewPoint,
            mapCanvasContext,
            provinceToState: worldMap.getProvinceToStateMap(),
            provinceToStrategicRegion: worldMap.getProvinceToStrategicRegionMap(),
            stateToSupplyArea: worldMap.getStateToSupplyAreaMap(),
            renderedProvincesByOffset: {},
            renderedProvincesById: {},
            extraState: undefined,
            ...otherRenderContext,
        };

        const mapZone: Zone = { x: 0, y: 0, w: worldMap.width, h: worldMap.height };
        Renderer.renderAllOffsets(viewPoint, mapZone, worldMap.width, xOffset => Renderer.renderMapBackground(worldMap, xOffset, renderContext));

        renderContext.renderedProvinces = Object.values(renderContext.renderedProvincesById);
        Renderer.renderAllOffsets(viewPoint, mapZone, worldMap.width, xOffset => Renderer.renderMapForeground(worldMap, xOffset, renderContext));
    }

    private static renderMapBackground(worldMap: FEWorldMap, xOffset: number, renderContext: RenderContext) {
        const { mapCanvasContext: context, topBar, viewPoint, overwriteRenderPrecision } = renderContext;
        const scale = viewPoint.scale;
        const renderedProvinces = renderContext.renderedProvincesByOffset[xOffset] ?? [];
        const { renderedProvincesById } = renderContext;
        renderContext.renderedProvincesByOffset[xOffset] = renderedProvinces;
        const edgeVisible = Renderer.isEdgeVisible(topBar, viewPoint);

        worldMap.forEachProvince(province => {
            if (renderContext.viewPoint.bboxInView(province.boundingBox, xOffset)) {
                const color = getColorByColorSet(topBar.colorSet$.value, province, worldMap, renderContext);
                context.fillStyle = toColor(color);
                Renderer.renderProvince(viewPoint, context, province, scale, xOffset, overwriteRenderPrecision);
                renderedProvinces.push(province);
                renderedProvincesById[province.id] = province;
            }

            if (edgeVisible) {
                for (const edge of province.edges) {
                    if (edge.path.length > 0) {
                        continue;
                    }

                    const toProvince = worldMap.getProvinceById(edge.to);
                    if (!toProvince) {
                        continue;
                    }

                    const [startPoint, endPoint] = findNearestPoints(edge.start, edge.stop, province, toProvince);
                    if (renderContext.viewPoint.lineInView(startPoint, endPoint, xOffset)) {
                        if (!(province.id in renderedProvincesById)) {
                            renderedProvinces.push(province);
                            renderedProvincesById[province.id] = province;
                        }
                        if (!(edge.to in renderedProvincesById)) {
                            renderedProvinces.push(toProvince);
                            renderedProvincesById[edge.to] = toProvince;
                        }
                    }
                }
            }
        });
    }

    private static renderMapForeground(worldMap: FEWorldMap, xOffset: number, renderContext: RenderContext) {
        const { mapCanvasContext: context, topBar, viewPoint } = renderContext;

        if (Renderer.isRiverVisible(topBar, viewPoint)) {
            Renderer.renderRivers(renderContext, worldMap, context, xOffset);
        }

        if (Renderer.isEdgeVisible(topBar, viewPoint)) {
            Renderer.renderAllEdges(renderContext, worldMap, context, xOffset);
        }

        if (Renderer.isSupplyVisible(topBar)) {
            Renderer.renderSupplyRelated(renderContext, worldMap, context, xOffset);
        }

        if (Renderer.isLabelVisible(topBar, viewPoint)) {
            Renderer.renderMapLabels(renderContext, worldMap, context, xOffset);
        }
    }

    private static isEdgeVisible(topBar: TopBar, viewPoint: ViewPoint) {
        if (topBar.display.selectedValues$.value.includes('adaptzooming')) {
            const viewMode = topBar.viewMode$.value;
            const renderScale = renderScaleByViewMode[viewMode];
            const scale = viewPoint.scale;
            return renderScale.edge <= scale && topBar.display.selectedValues$.value.includes('edge');
        }

        return topBar.display.selectedValues$.value.includes('edge');
    }

    private static isLabelVisible(topBar: TopBar, viewPoint: ViewPoint) {
        if (topBar.display.selectedValues$.value.includes('adaptzooming')) {
            const viewMode = topBar.viewMode$.value;
            const renderScale = renderScaleByViewMode[viewMode];
            const scale = viewPoint.scale;
            return renderScale.labels <= scale && topBar.display.selectedValues$.value.includes('label');
        }

        return topBar.display.selectedValues$.value.includes('label');
    }

    private isMouseHighlightVisible() {
        return this.topBar.display.selectedValues$.value.includes('mousehighlight');
    }

    private isTooltipVisible() {
        return this.topBar.display.selectedValues$.value.includes('tooltip');
    }

    private static isSupplyVisible(topBar: TopBar) {
        return topBar.display.selectedValues$.value.includes('supply');
    }

    private static isResourceVisible(topBar: TopBar) {
        return topBar.display.selectedValues$.value.includes('resource');
    }

    private static isFactoryVisible(topBar: TopBar) {
        return topBar.display.selectedValues$.value.includes('factory');
    }

    private static isRiverVisible(topBar: TopBar, viewPoint: ViewPoint) {
        if (topBar.display.selectedValues$.value.includes('adaptzooming')) {
            return 1 <= viewPoint.scale && topBar.display.selectedValues$.value.includes('river');
        }

        return topBar.display.selectedValues$.value.includes('river');
    }

    private static renderAllEdges(renderContext: RenderContext, worldMap: FEWorldMap, context: CanvasRenderingContext2D, xOffset: number) {
        const renderedProvinces = renderContext.renderedProvincesByOffset[xOffset] ?? [];
        const preciseEdge = renderContext.preciseEdge;

        context.strokeStyle = 'black';
        context.beginPath();
        for (const province of renderedProvinces) {
            Renderer.renderEdges(renderContext, province, worldMap, context, xOffset, false, preciseEdge);
        }
        context.stroke();

        context.strokeStyle = 'red';
        context.beginPath();
        for (const province of renderedProvinces) {
            Renderer.renderEdges(renderContext, province, worldMap, context, xOffset, true, preciseEdge);
        }
        context.stroke();
    }

    private static renderMapLabels(renderContext: RenderContext, worldMap: FEWorldMap, context: CanvasRenderingContext2D, xOffset: number) {
        const { provinceToState, provinceToStrategicRegion, stateToSupplyArea, topBar, viewPoint } = renderContext;
        const renderedProvinces = renderContext.renderedProvincesByOffset[xOffset] ?? [];
        const viewMode = topBar.viewMode$.value;
        const colorSet = topBar.colorSet$.value;
        const showSupply = Renderer.isSupplyVisible(topBar);

        context.font = '10px sans-serif';
        context.textAlign = 'center';
        context.textBaseline = 'middle';
        if (viewMode === 'province' || viewMode === 'warnings') {
            for (const province of renderedProvinces) {
                const provinceColor = showSupply && worldMap.getSupplyNodeByProvinceId(province.id) ? 0xFF0000 :
                    getColorByColorSet(colorSet, province, worldMap, renderContext);
                context.fillStyle = toColor(getHighConstrastColor(provinceColor));
                const labelPosition = province.centerOfMass;
                context.fillText(province.id.toString(), viewPoint.convertX(labelPosition.x + xOffset), viewPoint.convertY(labelPosition.y));
            }
        } else if (viewMode === 'country') {
            const renderedCountries: Record<string, boolean> = {};
            const showLocalised = topBar.display.selectedValues$.value.includes('localisedlabel');
            for (const province of renderedProvinces) {
                const state = worldMap.getStateById(provinceToState[province.id]);
                const owner = worldMap.getStateOwner(state);
                if (owner !== undefined && !renderedCountries[owner]) {
                    renderedCountries[owner] = true;
                    const region = worldMap.getCountryRegionByTag(owner);
                    if (region) {
                        const labelPosition = region.centerOfMass;
                        const provinceAtLabel = worldMap.getProvinceByPosition(labelPosition.x, labelPosition.y);
                        const provinceColor = getColorByColorSet(colorSet, provinceAtLabel ?? province, worldMap, renderContext);
                        context.fillStyle = toColor(getHighConstrastColor(provinceColor));
                        const country = worldMap.getCountryByTag(owner);
                        if (country?.localisedName && showLocalised) {
                            const fontSize = 10;
                            context.fillText(country.localisedName, viewPoint.convertX(labelPosition.x + xOffset), viewPoint.convertY(labelPosition.y) - fontSize / 2);
                            context.fillText(owner, viewPoint.convertX(labelPosition.x + xOffset), viewPoint.convertY(labelPosition.y) + fontSize / 2);
                        } else {
                            context.fillText(owner, viewPoint.convertX(labelPosition.x + xOffset), viewPoint.convertY(labelPosition.y));
                        }
                    }
                }
            }
        } else {
            const renderedRegions: Record<number, boolean> = {};
            const regionMap = viewMode === 'state' ? provinceToState : provinceToStrategicRegion;
            const getRegionById = viewMode === 'state' ? worldMap.getStateById : viewMode === 'supplyarea' ? worldMap.getSupplyAreaById : worldMap.getStrategicRegionById;

            for (const province of renderedProvinces) {
                const stateId = viewMode === 'supplyarea' ? provinceToState[province.id] : undefined;
                const regionId = viewMode === 'supplyarea' ? (stateId !== undefined ? stateToSupplyArea[stateId] : undefined) : regionMap[province.id];
                if (regionId !== undefined && !renderedRegions[regionId]) {
                    renderedRegions[regionId] = true;
                    const region = getRegionById(regionId);
                    if (region) {
                        const labelPosition = region.centerOfMass;
                        const provinceAtLabel = worldMap.getProvinceByPosition(labelPosition.x, labelPosition.y);
                        const provinceColor = getColorByColorSet(colorSet, provinceAtLabel ?? province, worldMap, renderContext);
                        context.fillStyle = toColor(getHighConstrastColor(provinceColor));
                        context.fillText(region.id.toString(), viewPoint.convertX(labelPosition.x + xOffset), viewPoint.convertY(labelPosition.y));
                        if (viewMode === 'state') {
                            const state = region as State;
                            const showFactories = Renderer.isFactoryVisible(topBar);
                            const showResources = Renderer.isResourceVisible(topBar);
                            if (showFactories || showResources) {
                                const layout = Renderer.getFactoryResourceRowsLayout(state, Renderer.ICON_ROW_SCALE, Renderer.ICON_ROW_LABEL_WIDTH);
                                const centerX = viewPoint.convertX(labelPosition.x + xOffset);
                                let y = viewPoint.convertY(labelPosition.y) + 5;
                                if (showFactories && layout.factories.width > 0) {
                                    Renderer.renderFactories(context, state, centerX - layout.factories.width / 2, y, Renderer.ICON_ROW_SCALE, Renderer.ICON_ROW_LABEL_WIDTH);
                                    y += layout.factories.height + Renderer.ICON_ROW_GAP;
                                }
                                if (showResources && layout.resources.width > 0) {
                                    Renderer.renderResources(context, state, centerX - layout.resources.width / 2, y, Renderer.ICON_ROW_SCALE, Renderer.ICON_ROW_LABEL_WIDTH);
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    private static renderEdges(
        renderContext: RenderContext,
        province: Province,
        worldMap: FEWorldMap,
        context: CanvasRenderingContext2D,
        xOffset: number,
        isRed: boolean,
        preciseEdge?: boolean,
    ) {
        const { provinceToState, provinceToStrategicRegion, stateToSupplyArea, renderedProvinces, topBar, viewPoint } = renderContext;
        const scale = viewPoint.scale;
        const viewMode = topBar.viewMode$.value;

        context.lineWidth = 2;
        for (const provinceEdge of province.edges) {
            if (!('path' in provinceEdge)) {
                continue;
            }

            if (provinceEdge.to > province.id) {
                continue;
            }

            const stateFromId = provinceToState[province.id];
            const stateToId = provinceToState[provinceEdge.to];

            const stateFromImpassable = worldMap.getStateById(stateFromId)?.impassable ?? false;
            const stateToImpassable = worldMap.getStateById(stateToId)?.impassable ?? false;

            const impassable = provinceEdge.type === 'impassable' || stateFromImpassable !== stateToImpassable;
            const paths = provinceEdge.path;
            
            if ((impassable || (paths.length === 0 && provinceEdge.type !== 'impassable')) !== isRed) {
                continue;
            }

            const strategicRegionFromId = provinceToStrategicRegion[province.id];
            const strategicRegionToId = provinceToStrategicRegion[provinceEdge.to];

            if (!impassable && paths.length > 0) {
                if (viewMode === 'state') {
                    if (stateFromId === stateToId && (stateFromId !== undefined || strategicRegionFromId === strategicRegionToId)) {
                        continue;
                    }
                } else if (viewMode === 'strategicregion') {
                    if (strategicRegionFromId === strategicRegionToId) {
                        continue;
                    }
                } else if (viewMode === 'supplyarea') {
                    if ((stateFromId === stateToId && (stateFromId !== undefined || strategicRegionFromId === strategicRegionToId)) ||
                        (stateFromId !== undefined && stateToId !== undefined && stateToSupplyArea[stateFromId] === stateToSupplyArea[stateToId])
                        ) {
                        continue;
                    }
                }
            }

            for (const path of paths) {
                if (path.length === 0) {
                    continue;
                }

                context.moveTo(viewPoint.convertX(path[0].x + xOffset), viewPoint.convertY(path[0].y));
                for (let j = 0; j < path.length; j++) {
                    if (!preciseEdge && scale <= 4 && j % (scale < 1 ? Math.floor(10 / scale) : 6 - scale) !== 0 && !isCriticalPoint(path, j)) {
                        continue;
                    }
                    const pos = path[j];
                    context.lineTo(viewPoint.convertX(pos.x + xOffset), viewPoint.convertY(pos.y));
                }
            }

            if (paths.length === 0 && provinceEdge.type !== 'impassable') {
                const toProvince = renderedProvinces?.find(p => p.id === provinceEdge.to);
                const [startPoint, endPoint] = findNearestPoints(provinceEdge.start, provinceEdge.stop, province, toProvince);

                context.moveTo(viewPoint.convertX(startPoint.x + xOffset), viewPoint.convertY(startPoint.y));
                context.lineTo(viewPoint.convertX(endPoint.x + xOffset), viewPoint.convertY(endPoint.y));
            }
        }
    }

    private static renderSupplyRelated(
        renderContext: RenderContext,
        worldMap: FEWorldMap,
        context: CanvasRenderingContext2D,
        xOffset: number
    ): void {
        const { renderedProvincesById, viewPoint } = renderContext;
        
        context.strokeStyle = 'rgb(200, 0, 0)';
        worldMap.forEachRailway(railway => {
            // Short-circuit: skip a railway only when NO province of it is on screen (the previous
            // every() scanned the whole list; some() stops at the first hit).
            if (!railway.provinces.some(id => renderedProvincesById[id])) {
                return;
            }

            context.beginPath();
            context.lineWidth = Math.min(10, 2 * railway.level);
            let hasProvince = false;
            for (let i = 0; i < railway.provinces.length; i++) {
                const province = worldMap.getProvinceById(railway.provinces[i]);
                if (province) {
                    if (!hasProvince) {
                        context.moveTo(viewPoint.convertX(province.centerOfMass.x + xOffset), viewPoint.convertY(province.centerOfMass.y));
                    } else {
                        context.lineTo(viewPoint.convertX(province.centerOfMass.x + xOffset), viewPoint.convertY(province.centerOfMass.y));
                    }
                    hasProvince = true;
                } else {
                    context.stroke();
                    hasProvince = false;
                }
            }
            if (hasProvince) {
                context.stroke();
            }
        });

        context.fillStyle = 'rgb(200, 0, 0)';
        const size = Math.min(30, viewPoint.scale * 10);
        // Iterate the rendered provinces and probe the O(1) supply-node memo instead of scanning
        // every supply node per frame (nodes are sparse; rendered provinces are the visible set).
        for (const province of Object.values(renderedProvincesById)) {
            const supplyNode = worldMap.getSupplyNodeByProvinceId(province.id);
            if (supplyNode) {
                const x = viewPoint.convertX(province.centerOfMass.x + xOffset);
                const y = viewPoint.convertY(province.centerOfMass.y);
                context.fillRect(x - size / 2, y - size / 2, size, size);
            }
        }
    }

    private static renderRivers(
        renderContext: RenderContext,
        worldMap: FEWorldMap,
        context: CanvasRenderingContext2D,
        xOffset: number
    ): void {
        const { viewPoint, topBar } = renderContext;
        const showRiverWarning = topBar.colorSet$.value === 'warnings' && topBar.warningFilter.selectedValues$.value.includes('river');

        const riverColors: string[] = [
            'rgb(0, 255, 0)',
            'rgb(255, 0, 0)',
            'rgb(255, 252, 0)',
            'rgb(0, 225, 255)',
            'rgb(0, 200, 255)',
            'rgb(0, 150, 255)',
            'rgb(0, 100, 255)',
            'rgb(0, 0, 255)',
            'rgb(0, 0, 255)',
            'rgb(0, 0, 200)',
            'rgb(0, 0, 150)',
            'rgb(0, 0, 100)',
        ];

        const warningColor = toColor(waterWarning);

        for (let i = 0; i < worldMap.rivers.length; i++) {
            const river = worldMap.rivers[i];
            if (!viewPoint.bboxInView(river.boundingBox, xOffset)) {
                continue;
            }

            const hasWarning = showRiverWarning && worldMap.getRiverWarnings(i).length > 0;
            // Batch per-pixel fills into horizontal same-color runs (mergeRiverRuns). The canvas
            // scale is an integer >= 1 here (isRiverVisible gates on scale >= 1), so a run's
            // fillRect covers exactly the pixels it merged, with the same snap as per-pixel fills.
            const pixels: RiverPixel[] = [];
            for (const key in river.colors) {
                const index = parseInt(key, 10);
                pixels.push({
                    x: index % river.boundingBox.w + river.boundingBox.x,
                    y: Math.floor(index / river.boundingBox.w) + river.boundingBox.y,
                    color: river.colors[key],
                });
            }
            for (const run of mergeRiverRuns(pixels)) {
                context.fillStyle = hasWarning && run.color >= 3 ? warningColor : riverColors[run.color];
                context.fillRect(viewPoint.convertX(run.x + xOffset), viewPoint.convertY(run.y), run.w * viewPoint.scale, viewPoint.scale);
            }
        }
    }

    private static renderProvince(
        viewPoint: ViewPoint,
        context: CanvasRenderingContext2D,
        province: Province,
        scale?: number,
        xOffset: number = 0,
        overwriteRenderPrecision?: number
    ): void {
        scale = scale ?? viewPoint.scale;
        const renderPrecisionBase = 2;
        const renderPrecision = 
            scale < 1 ? Math.pow(2, Math.floor(Math.log2((1 / scale))) + (overwriteRenderPrecision !== undefined ? 0 : renderPrecisionBase)) :
            overwriteRenderPrecision ?? (scale <= renderPrecisionBase ? Math.pow(2, renderPrecisionBase + 1 - Math.round(scale)) : 1);
        const renderPrecisionMask = renderPrecision - 1;
        const renderPrecisionOffset = (renderPrecision - 1) / 2;
        for (const zone of province.coverZones) {
            if (zone.w < renderPrecision) {
                if ((zone.x & renderPrecisionMask) === 0 && (zone.y & renderPrecisionMask) === 0) {
                    context.fillRect(
                        viewPoint.convertX(zone.x + xOffset - renderPrecisionOffset),
                        viewPoint.convertY(zone.y - renderPrecisionOffset),
                        renderPrecision * scale,
                        renderPrecision * scale);
                }
            } else {
                context.fillRect(
                    viewPoint.convertX(zone.x + xOffset - renderPrecisionOffset),
                    viewPoint.convertY(zone.y - renderPrecisionOffset),
                    zone.w * scale,
                    zone.h * scale);
            }
        }
    }

    private renderProvince(context: CanvasRenderingContext2D, province: Province, scale?: number, xOffset: number = 0): void {
        Renderer.renderProvince(this.viewPoint, context, province, scale, xOffset);
    }

    private registerCanvasEventHandlers() {
        this.addSubscription(fromEvent<MouseEvent>(this.mainCanvas, 'mousemove').subscribe((e) => {
            this.cursorX = e.pageX;
            this.cursorY = e.pageY;
            this.scheduleRender();
        }));
    }

    private renderHoverProvince(province: Province, worldMap: FEWorldMap, renderAdjacent: boolean = true) {
        const backCanvasContext = this.backCanvasContext;
        const viewPoint = this.viewPoint;
        backCanvasContext.fillStyle = 'rgba(255, 255, 255, 0.7)';
        this.renderAllOffsets(province.boundingBox, worldMap.width, xOffset =>
            this.renderProvince(backCanvasContext, province, viewPoint.scale, xOffset));

        if (!renderAdjacent) {
            return;
        }

        for (const adjecent of province.edges) {
            const adjecentNumber = adjecent.to;
            if (adjecentNumber === -1 || adjecent.type === 'impassable') {
                continue;
            }
            const adjecentProvince = worldMap.getProvinceById(adjecentNumber);
            if (adjecentProvince) {
                backCanvasContext.fillStyle = 'rgba(255, 255, 255, 0.3)';
                this.renderAllOffsets(adjecentProvince.boundingBox, worldMap.width, xOffset =>
                    this.renderProvince(backCanvasContext, adjecentProvince, viewPoint.scale, xOffset));
            }
        }
    }

    private renderSelectedProvince(province: Province, worldMap: FEWorldMap) {
        this.backCanvasContext.fillStyle = 'rgba(128, 255, 128, 0.7)';
        this.renderAllOffsets(province.boundingBox, worldMap.width, xOffset =>
            this.renderProvince(this.backCanvasContext, province, this.viewPoint.scale, xOffset));
    }

    private renderProvinceTooltip(province: Province, worldMap: FEWorldMap) {
        const stateObject = worldMap.getStateByProvinceId(province.id);
        const strategicRegion = worldMap.getStrategicRegionByProvinceId(province.id);
        const supplyArea = stateObject ? worldMap.getSupplyAreaByStateId(stateObject.id) : undefined;
        const railwayLevel = worldMap.getRailwayLevelByProvinceId(province.id);
        const supplyNode = worldMap.getSupplyNodeByProvinceId(province.id);
        const vp = stateObject?.victoryPoints[province.id];

        this.renderTooltip(`
${stateObject?.impassable ? '|r|' + feLocalize('worldmap.tooltip.impassable', 'Impassable') : ''}
${feLocalize('worldmap.tooltip.province', 'Province')}=${province.id}
${vp ? `${feLocalize('worldmap.tooltip.victorypoint', 'Victory point')}=${vp}` : ''}
${stateObject ? `
${feLocalize('worldmap.tooltip.state', 'State')}=${stateObject.id}`: ''
}
${supplyArea ? `
${feLocalize('worldmap.tooltip.supplyarea', 'Supply area')}=${supplyArea.id}
` : ''}
${railwayLevel ? `
${feLocalize('worldmap.tooltip.railwaylevel', 'Railway level')}=${railwayLevel}
` : ''}
${supplyNode ? `
${feLocalize('worldmap.tooltip.supplynode', 'Supply node')}=true
` : ''}
${strategicRegion ? `
${feLocalize('worldmap.tooltip.strategicregion', 'Strategic region')}=${strategicRegion.id}
`: ''
}
${stateObject ? `
${feLocalize('worldmap.tooltip.owner', 'Owner')}=${worldMap.getStateOwner(stateObject) ?? ''}
${feLocalize('worldmap.tooltip.coreof', 'Core of')}=${solveWithConditionAsSet(stateObject.cores, worldMap.getSelectedConditions()).join(',')}
${feLocalize('worldmap.tooltip.manpower', 'Manpower')}=${toCommaDivideNumber(stateObject.manpower)}` : ''
}
${supplyArea ? `
${feLocalize('worldmap.tooltip.supplyvalue', 'Supply value')}=${supplyArea.value}
` : ''}
${feLocalize('worldmap.tooltip.type', 'Type')}=${province.type}
${feLocalize('worldmap.tooltip.terrain', 'Terrain')}=${province.terrain}
${strategicRegion && strategicRegion.navalTerrain ? `
${feLocalize('worldmap.tooltip.navalterrain', 'Naval terrain')}=${strategicRegion.navalTerrain}
`: ''
}
${feLocalize('worldmap.tooltip.coastal', 'Coastal')}=${province.coastal}
${feLocalize('worldmap.tooltip.continent', 'Continent')}=${province.continent !== 0 ? `${worldMap.continents[province.continent]}(${province.continent})` : '0'}
${feLocalize('worldmap.tooltip.adjacencies', 'Adjecencies')}=${province.edges.filter(e => e.type !== 'impassable' && e.to !== -1).map(e => e.to).join(',')}
${worldMap.getProvinceWarnings(province, stateObject, strategicRegion, supplyArea).map(v => '|r|' + v).join('\n')}`
        );
    }

    private renderLoadingText(text: string) {
        const backCanvasContext = this.backCanvasContext;
        backCanvasContext.font = '12px sans-serif';
        const mesurement = backCanvasContext.measureText(text);
        backCanvasContext.fillStyle = 'black';
        backCanvasContext.fillRect(0, topBarHeight, 20 + mesurement.width, 32);
        backCanvasContext.fillStyle = 'white';
        backCanvasContext.textAlign = 'start';
        backCanvasContext.textBaseline = 'top';
        backCanvasContext.fillText(text, 10, 10 + topBarHeight);
    }

    private renderStateEditModeSelection(worldMap: FEWorldMap) {
        const hoverProvince = worldMap.getProvinceById(this.topBar.editModeHoverProvinceId$.value);
        this.renderHoverSelectionInEditMode(worldMap, hoverProvince, worldMap.getStateById(this.topBar.selectedStateId$.value));
    }

    private renderStrategicRegionEditModeSelection(worldMap: FEWorldMap) {
        const hoverProvince = worldMap.getProvinceById(this.topBar.editModeHoverProvinceId$.value);
        this.renderHoverSelectionInEditMode(worldMap, hoverProvince, worldMap.getStrategicRegionById(this.topBar.selectedStrategicRegionId$.value));
    }

    // Edit mode highlights the whole selected region in green, the hovered province in red when it
    // is part of that region (the move would remove it), and in green otherwise (the move target).
    private renderHoverSelectionInEditMode(worldMap: FEWorldMap, hover: Province | undefined, selected: { provinces: number[] } | undefined) {
        let hoverRendered = false;
        if (selected) {
            for (const provinceId of selected.provinces) {
                const province = worldMap.getProvinceById(provinceId);
                if (province) {
                    if (province !== hover) {
                        this.renderSelectedProvince(province, worldMap);
                    } else {
                        hoverRendered = true;
                        this.renderStyledProvince(province, worldMap, 'rgba(255, 128, 128, 0.7)');
                    }
                }
            }
        }

        if (hover && !hoverRendered) {
            this.renderSelectedProvince(hover, worldMap);
        }
    }

    private renderStyledProvince(province: Province, worldMap: FEWorldMap, fillStyle: string) {
        this.backCanvasContext.fillStyle = fillStyle;
        this.renderAllOffsets(province.boundingBox, worldMap.width, xOffset =>
            this.renderProvince(this.backCanvasContext, province, this.viewPoint.scale, xOffset));
    }

    private renderProvinceHoverSelection(worldMap: FEWorldMap) {
        let province = worldMap.getProvinceById(this.topBar.selectedProvinceId$.value);
        if (province) {
            this.renderSelectedProvince(province, worldMap);
        }
        province = worldMap.getProvinceById(this.topBar.hoverProvinceId$.value);
        if (province) {
            if (this.topBar.selectedProvinceId$ !== this.topBar.hoverProvinceId$ && this.isMouseHighlightVisible()) {
                this.renderHoverProvince(province, worldMap);
            }
            if (this.isTooltipVisible()) {
                this.renderProvinceTooltip(province, worldMap);
            }
        }
    }

    private renderStateHoverSelection(worldMap: FEWorldMap) {
        const hover = worldMap.getStateById(this.topBar.hoverStateId$.value);
        this.renderHoverSelection(worldMap, hover, worldMap.getStateById(this.topBar.selectedStateId$.value));
        hover && this.isTooltipVisible() && this.renderStateTooltip(hover, worldMap);
    }

    private renderCountryHoverSelection(worldMap: FEWorldMap) {
        const hoverTag = this.topBar.hoverCountryTag$.value;
        const selectedTag = this.topBar.selectedCountryTag$.value;
        const hover = hoverTag === undefined ? undefined : worldMap.getCountryRegionByTag(hoverTag);
        const selected = selectedTag === undefined ? undefined : worldMap.getCountryRegionByTag(selectedTag);
        this.renderHoverSelection(worldMap, hover, selected);
        hover && hoverTag !== undefined && this.isTooltipVisible() && this.renderCountryTooltip(hoverTag, worldMap);
    }

    private renderStrategicRegionHoverSelection(worldMap: FEWorldMap) {
        const hover = worldMap.getStrategicRegionById(this.topBar.hoverStrategicRegionId$.value);
        this.renderHoverSelection(worldMap, hover, worldMap.getStrategicRegionById(this.topBar.selectedStrategicRegionId$.value));
        hover && this.isTooltipVisible() && this.renderStrategicRegionTooltip(hover, worldMap);
    }

    private renderSupplyAreaHoverSelection(worldMap: FEWorldMap) {
        const hover = worldMap.getSupplyAreaById(this.topBar.hoverSupplyAreaId$.value);
        const selected = worldMap.getSupplyAreaById(this.topBar.selectedSupplyAreaId$.value);
        const toProvinces = (supplyArea: SupplyArea | undefined) => {
            return supplyArea ?
                {
                    provinces: chain(supplyArea.states)
                        .map(stateId => worldMap.getStateById(stateId)?.provinces)
                        .filter((v): v is number[] => !!v)
                        .flatten()
                        .value()
                } :
                undefined;
        };

        this.renderHoverSelection(worldMap, toProvinces(hover), toProvinces(selected));
        hover && this.isTooltipVisible() && this.renderSupplyAreaTooltip(hover, worldMap);
    }

    private renderHoverSelection(worldMap: FEWorldMap, hover: { provinces: number[] } | undefined, selected: { provinces: number[] } | undefined) {
        if (selected) {
            for (const provinceId of selected.provinces) {
                const province = worldMap.getProvinceById(provinceId);
                if (province) {
                    this.renderSelectedProvince(province, worldMap);
                }
            }
        }

        if (hover && this.isMouseHighlightVisible() && hover !== selected) {
            for (const provinceId of hover.provinces) {
                const province = worldMap.getProvinceById(provinceId);
                if (province) {
                    this.renderHoverProvince(province, worldMap, false);
                }
            }
        }
    }

    private renderStateTooltip(state: State, worldMap: FEWorldMap) {
        const supplyArea = worldMap.getSupplyAreaByStateId(state.id);
        this.renderTooltip(`
${state.impassable ? '|r|' + feLocalize('worldmap.tooltip.impassable', 'Impassable') : ''}
${state.impassableIgnoredLinks.length > 0 ? feLocalize('worldmap.tooltip.impassableignoredlinks', 'Impassable ignored links') + '=' + state.impassableIgnoredLinks.join(',') : ''}
${feLocalize('worldmap.tooltip.state', 'State')}=${state.id}
${supplyArea ? `
${feLocalize('worldmap.tooltip.supplyarea', 'Supply area')}=${supplyArea.id}
` : ''}
${feLocalize('worldmap.tooltip.owner', 'Owner')}=${worldMap.getStateOwner(state) ?? ''}
${feLocalize('worldmap.tooltip.coreof', 'Core of')}=${solveWithConditionAsSet(state.cores, worldMap.getSelectedConditions()).join(',')}
${feLocalize('worldmap.tooltip.manpower', 'Manpower')}=${toCommaDivideNumber(state.manpower)}
${feLocalize('worldmap.tooltip.category', 'Category')}=${state.category}
${supplyArea ? `
${feLocalize('worldmap.tooltip.supplyvalue', 'Supply value')}=${supplyArea.value}
` : ''}
${feLocalize('worldmap.tooltip.provinces', 'Provinces')}=${state.provinces.join(',')}
${worldMap.getStateWarnings(state, supplyArea).map(v => '|r|' + v).join('\n')}`,
            (width, height) => {
                const layout = Renderer.getFactoryResourceRowsLayout(state, Renderer.TOOLTIP_ICON_ROW_SCALE, Renderer.TOOLTIP_ICON_ROW_LABEL_WIDTH);
                return { width: Math.max(width, layout.totalWidth), height: height + layout.totalHeight };
            },
            (x, y) => {
                Renderer.drawFactoryResourceRows(this.backCanvasContext, state, Renderer.getFactoryResourceRowsLayout(state, Renderer.TOOLTIP_ICON_ROW_SCALE, Renderer.TOOLTIP_ICON_ROW_LABEL_WIDTH), x, y, Renderer.TOOLTIP_ICON_ROW_SCALE, Renderer.TOOLTIP_ICON_ROW_LABEL_WIDTH);
            });
    }

    private renderCountryTooltip(tag: string, worldMap: FEWorldMap) {
        const states: number[] = [];
        worldMap.forEachState(state => {
            if (worldMap.getStateOwner(state) === tag) {
                states.push(state.id);
            }
        });

        const country = worldMap.getCountryByTag(tag);
        this.renderTooltip(`
${feLocalize('worldmap.tooltip.country', 'Country')}=${tag}${country?.localisedName ? ` (${country.localisedName})` : ''}
${feLocalize('worldmap.tooltip.states', 'States')}=${states.join(',')}`);
    }

    private renderStrategicRegionTooltip(strategicRegion: StrategicRegion, worldMap: FEWorldMap) {
        this.renderTooltip(`
${feLocalize('worldmap.tooltip.strategicregion', 'Strategic region')}=${strategicRegion.id}
${strategicRegion.navalTerrain ? `
${feLocalize('worldmap.tooltip.navalterrain', 'Naval terrain')}=${strategicRegion.navalTerrain}
`: ''
}
${feLocalize('worldmap.tooltip.provinces', 'Provinces')}=${strategicRegion.provinces.join(',')}
${worldMap.getStrategicRegionWarnings(strategicRegion).map(v => '|r|' + v).join('\n')}`);
    }

    private renderSupplyAreaTooltip(supplyArea: SupplyArea, worldMap: FEWorldMap) {
        this.renderTooltip(`
${feLocalize('worldmap.tooltip.supplyarea', 'Supply area')}=${supplyArea.id}
${feLocalize('worldmap.tooltip.supplyvalue', 'Supply value')}=${supplyArea.value}
${feLocalize('worldmap.tooltip.states', 'States')}=${supplyArea.states.join(',')}
${worldMap.getSupplyAreaWarnings(supplyArea).map(v => '|r|' + v).join('\n')}`);
    }

    private renderTooltip(tooltip: string, sizeCallback?: (width: number, height: number) => {width: number, height: number}, renderCallback?: (x: number, y: number) => void) {
        const backCanvasContext = this.backCanvasContext;
        const cursorX = this.cursorX;
        const cursorY = this.cursorY;

        let mapX = this.viewPoint.convertBackX(cursorX);
        if (this.loader.worldMap.width > 0 && mapX >= this.loader.worldMap.width) {
            mapX -= this.loader.worldMap.width;
        }
        const mapY = this.viewPoint.convertBackY(cursorY);

        tooltip = `(${mapX}, ${mapY})\nX=${mapX}, Z=${this.loader.worldMap.height - 1 - mapY}\n` + tooltip;

        const colorPrefix = /^\|r\|/;
        const regex = /(\n)|((?:\|r\|)?(?:.{40,59}[, ]|.{60}))/g;
        const text = tooltip.trim()
            .split(regex)
            .map((v, i, a) => {
                if (!v?.trim() || colorPrefix.test(v)) {
                    return v;
                }
                for (let j = i - 1; j >= 0; j--) {
                    if (!a[j] || a[j] === '\n') {
                        return v;
                    }
                    const match = colorPrefix.exec(a[j]);
                    if (match) {
                        return match[0] + v;
                    }
                }
                return v;
            })
            .filter(v => v?.trim());

        const fontSize = 14;
        let toolTipOffsetX = 10;
        let toolTipOffsetY = 10;
        const marginX = 10;
        const marginY = 10;
        const linePadding = 3;

        backCanvasContext.font = `${fontSize}px sans-serif`;
        backCanvasContext.textAlign = 'start';
        let width = max(text.map(t => backCanvasContext.measureText(t).width)) ?? 0;
        let height = fontSize * text.length + linePadding * (text.length - 1);

        if (cursorX + toolTipOffsetX + width + 2 * marginX > this.canvasWidth) {
            toolTipOffsetX = -10 - (width + 2 * marginX);
        }
        
        if (cursorY + toolTipOffsetY + height + 2 * marginY > this.canvasHeight) {
            toolTipOffsetY = -10 - (height + 2 * marginY);
        }
        backCanvasContext.strokeStyle = '#7F7F7F';
        backCanvasContext.fillStyle = 'white';
        backCanvasContext.textBaseline = 'top';

        if (sizeCallback) {
            const result = sizeCallback(width, height);
            width = result.width;
            height = result.height;
        }

        backCanvasContext.fillRect(cursorX + toolTipOffsetX, cursorY + toolTipOffsetY, width + 2 * marginX, height + 2 * marginY);
        backCanvasContext.strokeRect(cursorX + toolTipOffsetX, cursorY + toolTipOffsetY, width + 2 * marginX, height + 2 * marginY);

        text.forEach((t, i) => {
            backCanvasContext.fillStyle = 'black';
            if (t.startsWith('|r|')) {
                backCanvasContext.fillStyle = 'red';
                t = t.substring(3);
            }
            t = t.trim();
            backCanvasContext.fillText(t, cursorX + toolTipOffsetX + marginX, cursorY + toolTipOffsetY + marginY + i * (fontSize + linePadding));
        });

        backCanvasContext.fillStyle = 'black';
        if (renderCallback) {
            renderCallback(cursorX + toolTipOffsetX + marginX, cursorY + toolTipOffsetY + marginY + text.length * (fontSize + linePadding));
        }
    }

    private static renderAllOffsets(viewPoint: ViewPoint, boundingBox: Zone, step: number, callback: (xOffset: number) => void, minimalRenderCount: number = 1) {
        let xOffset = 0;
        let i = 0;
        let inView = viewPoint.bboxInView(boundingBox, xOffset);
        while (inView || i < minimalRenderCount) {
            if (inView) {
                callback(xOffset);
            }
            if (step <= 0) {
                return;
            }
            xOffset += step;
            i++;
            inView = viewPoint.bboxInView(boundingBox, xOffset);
        }
    }

    private renderAllOffsets(boundingBox: Zone, step: number, callback: (xOffset: number) => void, minimalRenderCount: number = 1) {
        Renderer.renderAllOffsets(this.viewPoint, boundingBox, step, callback, minimalRenderCount);
    }

    private static getFactoriesSize(state: State, scale: number = 1, labelWidth: number = 30): { width: number, height: number } {
        let fullWidth = 0;
        let maxHeight = 0;
        if (Renderer.getCivilianFactories(state) > 0) {
            const width = (Renderer.factoryImages.civilian?.naturalWidth ?? 24) * scale;
            const height = (Renderer.factoryImages.civilian?.naturalHeight ?? 24) * scale;
            maxHeight = Math.max(maxHeight, height);
            fullWidth += width + labelWidth;
        }
        if (Renderer.getMilitaryFactories(state) > 0) {
            const width = (Renderer.factoryImages.military?.naturalWidth ?? 24) * scale;
            const height = (Renderer.factoryImages.military?.naturalHeight ?? 24) * scale;
            maxHeight = Math.max(maxHeight, height);
            fullWidth += width + labelWidth;
        }
        return { width: fullWidth, height: maxHeight };
    }

    private static renderFactories(context: CanvasRenderingContext2D, state: State, x: number, y: number, scale: number = 1, labelWidth: number = 30) {
        // Reuse the region label's high-contrast color for the numbers next to each icon, and
        // restore the alignment state afterwards so callers keep their own text layout intact.
        const numberColor = context.fillStyle;
        const previousTextAlign = context.textAlign;
        const previousTextBaseline = context.textBaseline;
        context.textAlign = 'center';
        context.textBaseline = 'middle';
        const civilian = Renderer.getCivilianFactories(state);
        const military = Renderer.getMilitaryFactories(state);
        const civilianImage = Renderer.factoryImages.civilian;
        const militaryImage = Renderer.factoryImages.military;
        if (civilian > 0) {
            const width = (civilianImage?.naturalWidth ?? 24) * scale;
            const height = (civilianImage?.naturalHeight ?? 24) * scale;
            if (civilianImage) {
                context.drawImage(civilianImage, x, y, width, height);
            } else {
                context.fillStyle = 'rgb(52, 152, 219)';
                context.fillRect(x, y, width, height);
            }
            context.fillStyle = numberColor;
            context.fillText(civilian.toString(), x + width + labelWidth / 2, y + height / 2);
            x += width + labelWidth;
        }
        if (military > 0) {
            const width = (militaryImage?.naturalWidth ?? 24) * scale;
            const height = (militaryImage?.naturalHeight ?? 24) * scale;
            if (militaryImage) {
                context.drawImage(militaryImage, x, y, width, height);
            } else {
                context.fillStyle = 'rgb(231, 76, 60)';
                context.fillRect(x, y, width, height);
            }
            context.fillStyle = numberColor;
            context.fillText(military.toString(), x + width + labelWidth / 2, y + height / 2);
            x += width + labelWidth;
        }
        context.textAlign = previousTextAlign;
        context.textBaseline = previousTextBaseline;
    }

    private static getCivilianFactories(state: State): number {
        // Current HOI4 names the buildings; older mods use numeric ids (1 = civilian, 4 = military).
        const buildings = state.buildings ?? {};
        return buildings['industrial_complex'] ?? buildings['1'] ?? 0;
    }

    private static getMilitaryFactories(state: State): number {
        const buildings = state.buildings ?? {};
        return buildings['arms_factory'] ?? buildings['4'] ?? 0;
    }

    private static getResourcesSize(state: State, scale: number = 1, labelWidth: number = 30): { width: number, height: number } {
        let fullWidth = 0;
        let maxHeight = 0;
        for (const resource in state.resources) {
            if (!state.resources[resource]) {
                continue;
            }
            const image = Renderer.resourceImages[resource];
            if (image) {
                maxHeight = Math.max(maxHeight, image.naturalHeight * scale);
                fullWidth += image.naturalWidth * scale;
            } else {
                maxHeight = Math.max(maxHeight, 24 * scale);
                fullWidth += 24 * scale;
            }
            fullWidth += labelWidth;
        }
        return { width: fullWidth, height: maxHeight };
    }

    private static renderResources(context: CanvasRenderingContext2D, state: State, x: number, y: number, scale: number = 1, labelWidth: number = 30) {
        // Keep the caller's fill style for the quantity text; the gray fallback box must not leak it.
        const numberColor = context.fillStyle;
        context.textAlign = 'center';
        context.textBaseline = 'middle';
        for (const resource in state.resources) {
            const resourceNumber = state.resources[resource];
            if (!resourceNumber) {
                continue;
            }

            const image = Renderer.resourceImages[resource];
            if (image) {
                context.drawImage(image, x, y, image.naturalWidth * scale, image.naturalHeight * scale);
                context.fillStyle = numberColor;
                context.fillText(resourceNumber.toString(), x + (image?.naturalWidth ?? 0) * scale + labelWidth / 2, y + Math.max(0, image?.naturalHeight ?? 0) * scale / 2);
                x += (image?.naturalWidth ?? 0) * scale + labelWidth;
            } else {
                context.fillStyle = 'gray';
                context.fillRect(x, y, 24 * scale, 24 * scale);
                context.fillStyle = numberColor;
                context.fillText(resourceNumber.toString(), x + 24 * scale + labelWidth / 2, y + 24 * scale / 2);
                x += 24 * scale + labelWidth;
            }
        }
    }
}

function toColor(colorNum: number) {
    return '#' + colorNum.toString(16).padStart(6, '0');
}

// --- L2: provincial boundary point spatial hash index ---
// Boundary points are collected from province.edges once per province object and memoized in a
// WeakMap; incremental data updates replace province objects, so stale indexes are dropped
// automatically. Cell size is a map-pixel heuristic: large enough to keep buckets few, small
// enough that the expansion visits only nearby cells.
const SPATIAL_GRID_CELL_SIZE = 64;

interface SpatialGrid {
    cellSize: number;
    cells: Map<string, Point[]>;
    // Occupied cell coordinates as a flat [x0, y0, x1, y1, ...] array. Kept as numbers so the
    // per-query nearest search builds its min-heap without parsing string keys back into
    // coordinates.
    cellCoords: number[];
}

interface ProvinceSpatialIndex {
    grid: SpatialGrid;
    points: Point[]; // flattened boundary points, used by the two-set nearest pair search
}

const provinceSpatialIndexCache = new WeakMap<Province, ProvinceSpatialIndex>();
// --- L1: nearest-pair result cache ---
// Keyed by province object pairs (then by the start/end coordinates) *after* the start/end
// normalization inside findNearestPoints, so the "end-only" and "start-only" call shapes share one
// entry. Rendering frames repeatedly call findNearestPoints with the same arguments; the result is
// stable within one loaded map, so the first frame pays the search and all later frames hit this
// cache. Province object replacement (incremental updates) invalidates the WeakMap keys
// automatically.
const nearestPairResultCache = new WeakMap<Province, WeakMap<Province, Map<string, [Point, Point]>>>();

function spatialCellKey(cx: number, cy: number): string {
    return cx + ',' + cy;
}

function collectBoundaryPoints(province: Province): Point[] {
    const points: Point[] = [];
    for (const edge of province.edges) {
        for (const path of edge.path) {
            for (const p of path) {
                points.push(p);
            }
        }
    }
    return points;
}

function buildSpatialIndex(province: Province): ProvinceSpatialIndex {
    const points = collectBoundaryPoints(province);
    const cells = new Map<string, Point[]>();
    const cellCoords: number[] = [];
    for (const p of points) {
        const cellX = Math.floor(p.x / SPATIAL_GRID_CELL_SIZE);
        const cellY = Math.floor(p.y / SPATIAL_GRID_CELL_SIZE);
        const key = spatialCellKey(cellX, cellY);
        let bucket = cells.get(key);
        if (bucket === undefined) {
            cells.set(key, bucket = []);
            cellCoords.push(cellX, cellY);
        }
        bucket.push(p);
    }
    return {
        grid: { cellSize: SPATIAL_GRID_CELL_SIZE, cells, cellCoords },
        points,
    };
}

function getSpatialIndex(province: Province): ProvinceSpatialIndex {
    let index = provinceSpatialIndexCache.get(province);
    if (index === undefined) {
        index = buildSpatialIndex(province);
        provinceSpatialIndexCache.set(province, index);
    }
    return index;
}

// Lower bound on the squared distance from p to any point inside the given cell. The upper bound is
// exclusive (xMax = (cellX+1)*cellSize, not -1) and the "p.x >= xMax" branch takes p.x - xMax, so
// the bound stays valid for fractional coordinates too, not only integer pixels.
function cellMinDistanceSqr(p: Point, cellSize: number, cellX: number, cellY: number): number {
    const xMin = cellX * cellSize;
    const xMax = (cellX + 1) * cellSize;
    const yMin = cellY * cellSize;
    const yMax = (cellY + 1) * cellSize;
    const dx = p.x < xMin ? xMin - p.x : p.x >= xMax ? p.x - xMax : 0;
    const dy = p.y < yMin ? yMin - p.y : p.y >= yMax ? p.y - yMax : 0;
    return dx * dx + dy * dy;
}

// --- Nearest neighbour via a min-heap over cells ---
// All occupied cells are heapified by their distance lower bound to p (O(C) build), then popped
// smallest-first. The first popped cell already yields a concrete bestD (any bucket is non-empty),
// and since every later cell has a lower bound >= the heap top, the scan stops as soon as the heap
// top's bound cannot beat bestD. Exact (equivalent to a full scan, verified by property tests), and
// in sparse/separated layouts only a handful of cells are popped - no full sort, no string parsing.
interface CellEntry {
    cellX: number;
    cellY: number;
    minD: number;
}

function heapifyMin(heap: CellEntry[]): void {
    for (let i = (heap.length >> 1) - 1; i >= 0; i--) {
        siftDown(heap, i);
    }
}

function siftDown(heap: CellEntry[], i: number): void {
    const length = heap.length;
    while (true) {
        let smallest = i;
        const left = 2 * i + 1;
        const right = 2 * i + 2;
        if (left < length && heap[left].minD < heap[smallest].minD) {
            smallest = left;
        }
        if (right < length && heap[right].minD < heap[smallest].minD) {
            smallest = right;
        }
        if (smallest === i) {
            return;
        }
        const tmp = heap[i];
        heap[i] = heap[smallest];
        heap[smallest] = tmp;
        i = smallest;
    }
}

function heapPopMin(heap: CellEntry[]): CellEntry | undefined {
    if (heap.length === 0) {
        return undefined;
    }
    const top = heap[0];
    const last = heap.pop()!;
    if (heap.length > 0) {
        heap[0] = last;
        siftDown(heap, 0);
    }
    return top;
}

// Exact nearest neighbor in a spatial grid (see the min-heap note above). The heap is rebuilt per
// query because each lower bound depends on the query point p; C is the occupied-cell count, which
// is small (boundary points of one province cluster into few cells) and the loop usually exits
// after one pop.
function findNearestInGrid(grid: SpatialGrid, p: Point): Point | undefined {
    const cells = grid.cells;
    if (cells.size === 0) {
        return undefined;
    }
    const cs = grid.cellSize;
    const coords = grid.cellCoords;
    const heap: CellEntry[] = new Array(coords.length >> 1);
    for (let i = 0, j = 0; i < coords.length; i += 2, j++) {
        const cellX = coords[i];
        const cellY = coords[i + 1];
        heap[j] = { cellX, cellY, minD: cellMinDistanceSqr(p, cs, cellX, cellY) };
    }
    heapifyMin(heap);

    let best: Point | undefined = undefined;
    let bestD = Infinity;
    let entry = heapPopMin(heap);
    while (entry !== undefined && bestD > entry.minD) {
        const bucket = cells.get(spatialCellKey(entry.cellX, entry.cellY));
        if (bucket !== undefined) {
            for (const q of bucket) {
                const d = distanceSqr(p, q);
                if (d < bestD) {
                    bestD = d;
                    best = q;
                }
            }
        }
        entry = heapPopMin(heap);
    }

    return best;
}

function pointKey(p: Point | undefined): string {
    return p === undefined ? '' : `${p.x},${p.y}`;
}

export function findNearestPoints(start: Point | undefined, end: Point | undefined, a: Province, b: Province | undefined): [Point, Point] {
    if (start && end) { return [start, end]; }
    if (!b) { return [bboxCenter(a.boundingBox), bboxCenter(a.boundingBox)]; };
    // Normalize an "end-only" call to the "start-only" shape: keep the known endpoint in `start`
    // (moving it from `end`) and swap the two provinces so the search still targets the "other"
    // province. Note this swap also fires when *both* endpoints are missing, which decides which
    // province's bounding-box center the empty-point-set fallback below uses (see test
    // 'falls back to bounding-box center when the other province has no boundary points').
    if (!start) {
        const savedEndpoint = end;
        const savedProvince = a;
        start = savedEndpoint;
        a = b;
        end = undefined;
        b = savedProvince;
    }

    // L1: the result is stable within one loaded map, memoize per province pair. The key is formed
    // *after* the normalization above, so the "end-only" shape and the equivalent "start-only"
    // shape (provinces swapped by the caller) share one cache entry.
    let cacheByB = nearestPairResultCache.get(a);
    if (cacheByB === undefined) {
        nearestPairResultCache.set(a, cacheByB = new WeakMap());
    }
    let cacheByKey = cacheByB.get(b);
    if (cacheByKey === undefined) {
        cacheByB.set(b, cacheByKey = new Map());
    }
    const key = `${pointKey(start)}|${pointKey(end)}`;
    const cached = cacheByKey.get(key);
    if (cached !== undefined) {
        return cached;
    }

    let result: [Point, Point];
    if (!start) {
        // Two-set nearest pair: iterate the smaller point set and query the other set's grid. The
        // nearest grid hit for the true pair partner is exact, so the global minimum is found.
        const indexA = getSpatialIndex(a);
        const indexB = getSpatialIndex(b);
        let bestPair: [Point, Point] | undefined = undefined;
        let bestD = Infinity;
        if (indexA.points.length <= indexB.points.length) {
            for (const p of indexA.points) {
                const q = findNearestInGrid(indexB.grid, p);
                if (q !== undefined) {
                    const d = distanceSqr(p, q);
                    if (d < bestD) {
                        bestD = d;
                        bestPair = [p, q];
                    }
                }
            }
        } else {
            for (const p of indexB.points) {
                const q = findNearestInGrid(indexA.grid, p);
                if (q !== undefined) {
                    const d = distanceSqr(p, q);
                    if (d < bestD) {
                        bestD = d;
                        bestPair = [p, q];
                    }
                }
            }
        }
        result = bestPair ?? [bboxCenter(a.boundingBox), bboxCenter(a.boundingBox)];
    } else {
        // Single-point nearest neighbor on the other province's boundary.
        const nearest = findNearestInGrid(getSpatialIndex(b).grid, start);
        result = nearest !== undefined ? [start, nearest] : [bboxCenter(a.boundingBox), bboxCenter(a.boundingBox)];
    }

    cacheByKey.set(key, result);
    return result;
}

function getColorByColorSet(
    colorSet: ColorSet,
    province: Province,
    worldMap: FEWorldMap,
    renderContext: RenderContext
): number {
    const { provinceToState,
        provinceToStrategicRegion,
        stateToSupplyArea,
        topBar } = renderContext;
    switch (colorSet) {
        case 'provincetype':
            return (province.type === 'land' ? 0x007F00 : province.type === 'lake' ? 0x00FFFF : 0x00007F) | (province.coastal ? 0x7F0000 : 0);
        case 'country':
            {
                const stateId = provinceToState[province.id];
                const owner = worldMap.getStateOwner(worldMap.getStateById(stateId));
                // O(1) tag -> color lookup replaces a per-province countries.find() scan.
                return owner === undefined ? defaultColor(province) : worldMap.getCountryColorByTag()[owner] ?? defaultColor(province);
            }
        case 'terrain':
            {
                if (renderContext.extraState === undefined) {
                    renderContext.extraState = arrayToMap(worldMap.terrains, 'name');
                }

                const navalTerrain = province.type === 'land' ? undefined : worldMap.getStrategicRegionById(provinceToStrategicRegion[province.id])?.navalTerrain;
                return (renderContext.extraState as Record<string, Terrain | undefined>)[navalTerrain ?? province.terrain]?.color ?? 0;
            }
        case 'continent':
            if (renderContext.extraState === undefined) {
                let continent = 0;
                worldMap.forEachProvince(p => (p.continent > continent ? continent = p.continent : 0, false));
                renderContext.extraState = avoidPowerOf2(continent + 1);
            }
            return province.continent !== 0 ? valueAndMaxToColor(province.continent + 1, renderContext.extraState) : defaultColor(province);
        case 'stateid':
            {
                if (renderContext.extraState === undefined) {
                    renderContext.extraState = avoidPowerOf2(worldMap.statesCount);
                }
                const stateId = provinceToState[province.id];
                return stateId !== undefined ? valueAndMaxToColor(stateId < 0 ? 0 : stateId, renderContext.extraState) : defaultColor(province);
            }
        case 'warnings':
            {
                const isLand = province.type === 'land';
                const viewMode = topBar.viewMode$.value;
                const warningFilter = topBar.warningFilter.selectedValues$.value;
                const stateId = provinceToState[province.id];
                const state = worldMap.getStateById(stateId);
                const strategicRegion = worldMap.getStrategicRegionById(provinceToStrategicRegion[province.id]);
                const supplyAreaId = stateId ? stateToSupplyArea[stateId] : undefined;
                const supplyArea = worldMap.getSupplyAreaById(supplyAreaId);
                return worldMap.getProvinceWarnings(
                        viewMode !== "warnings" || warningFilter.includes('province') ? province : undefined,
                        viewMode !== "warnings" || warningFilter.includes('state') ? state : undefined,
                        viewMode !== "warnings" || warningFilter.includes('strategicregion') ? strategicRegion : undefined,
                        viewMode !== "warnings" || warningFilter.includes('supplyarea') ? supplyArea : undefined
                    ).length > 0 ?
                    (isLand ? landWarning : waterWarning) :
                    (isLand ? landNoWarning : waterNoWarning);
            }
        case 'manpower':
            {
                if (province.type === 'sea') {
                    return defaultColor(province);
                }

                if (renderContext.extraState === undefined) {
                    let maxManpower = 0;
                    worldMap.forEachState(state => (state.manpower > maxManpower ? maxManpower = state.manpower : 0, false));
                    renderContext.extraState = maxManpower;
                }

                const stateId = provinceToState[province.id];
                const state = worldMap.getStateById(stateId);
                const value = manpowerHandler(state?.manpower ?? 0) / manpowerHandler(renderContext.extraState);
                return valueToColorGYR(value);
            }
        case 'victorypoint':
            {
                if (renderContext.extraState === undefined) {
                    let maxVictoryPoint = 0;
                    worldMap.forEachState(state => Object.values(state.victoryPoints).forEach(
                        vp => vp !== undefined && vp > maxVictoryPoint ? maxVictoryPoint = vp: 0));
                    renderContext.extraState = maxVictoryPoint;
                }

                const stateId = provinceToState[province.id];
                const state = worldMap.getStateById(stateId);
                const vp = state?.victoryPoints[province.id] ?? 0;
                const value = victoryPointsHandler(vp) / victoryPointsHandler(renderContext.extraState);
                return state === undefined ? 0x000080 : (vp === 0 ? 0x008000 : valueToColorGYR(value));
            }
        case 'resources':
            {
                if (province.type === 'sea') {
                    return defaultColor(province);
                }

                if (renderContext.extraState === undefined) {
                    let maxResources = 0;
                    worldMap.forEachState(state => {
                        const numResources = Object.values(state.resources).reduce<number>((p, c) => p + (c ?? 0), 0);
                        if (numResources > maxResources) {
                            maxResources = numResources;
                        }
                        return false;
                    });
                    renderContext.extraState = maxResources;
                }

                const stateId = provinceToState[province.id];
                const state = worldMap.getStateById(stateId);
                const numResources = state ? Object.values(state.resources).reduce<number>((p, c) => p + (c ?? 0), 0) : 0;
                const value = resourcesHandler(numResources) / resourcesHandler(renderContext.extraState);
                return valueToColorGYR(value);
            }
        case 'strategicregionid':
            {
                if (renderContext.extraState === undefined) {
                    renderContext.extraState = avoidPowerOf2(worldMap.strategicRegionsCount);
                }
                const strategicRegionId = provinceToStrategicRegion[province.id];
                return valueAndMaxToColor(strategicRegionId === undefined || strategicRegionId < 0 ? 0 : strategicRegionId, renderContext.extraState);
            }
        case 'supplyareaid':
            {
                if (renderContext.extraState === undefined) {
                    renderContext.extraState = avoidPowerOf2(worldMap.supplyAreasCount);
                }
                const stateId = provinceToState[province.id];
                const supplyAreaId = stateId !== undefined ? stateToSupplyArea[stateId] : undefined;
                return supplyAreaId !== undefined ? valueAndMaxToColor(supplyAreaId < 0 ? 0 : supplyAreaId, renderContext.extraState) : defaultColor(province);
            }
        case 'supplyvalue':
            {
                if (province.type === 'sea') {
                    return defaultColor(province);
                }

                if (renderContext.extraState === undefined) {
                    let maxSupplyValue = 0;
                    worldMap.forEachSupplyArea(supplyArea => (supplyArea.value > maxSupplyValue ? maxSupplyValue = supplyArea.value: 0, false));
                    renderContext.extraState = maxSupplyValue;
                }

                const stateId = provinceToState[province.id];
                const supplyAreaId = stateId ? stateToSupplyArea[stateId] : undefined;
                const supplyArea = worldMap.getSupplyAreaById(supplyAreaId);
                const value = (supplyArea?.value ?? 0) / (renderContext.extraState);
                return valueToColorGYR(value);
            }
        default:
            return province.color;
    }
}

function manpowerHandler(manpower: number): number {
    if (manpower < 0) {
        manpower = 0;
    }
    return Math.pow(manpower, 0.2);
}

function victoryPointsHandler(victoryPoints: number): number {
    if (victoryPoints < 0) {
        victoryPoints = 0;
    }
    return Math.pow(victoryPoints, 0.5);
}

function resourcesHandler(resources: number): number {
    if (resources < 0) {
        resources = 0;
    }
    return Math.pow(resources, 0.2);
}

function valueToColorGYR(value: number): number {
    return value < 0.5 ? (0xFF00 | (Math.floor(255 * 2 * value) << 16)) : (0xFF0000 | (Math.floor(255 * 2 * (1 - value)) << 8));
}

function valueAndMaxToColor(value: number, max: number): number {
    return Math.floor(value * (0xFFFFFF / max));
}

function getHighConstrastColor(color: number): number {
    const r = (color >> 16) & 0xFF;
    const g = (color >> 8) & 0xFF;
    const b = color & 0xFF;
    return r * 0.7 + g * 2 + b * 0.3 > 3 * 0x7F ? 0 : 0xFFFFFF;
}

function avoidPowerOf2(value: number): number {
    const v = Math.log2(value);
    if (v > 0 && (v >>> 0) === v) {
        return value + 1;
    }

    return value;
}

function isCriticalPoint(path: Point[], index: number): boolean {
    return index === 0 || index === path.length - 1 ||
        (distanceHamming(path[index], path[index - 1]) > 2 && distanceHamming(path[index], path[index + 1]) > 2);
}

function defaultColor(province: Province) {
    return province.type === 'land' ? 0 : 0x1010B0;
}

function toCommaDivideNumber(value: number): string {
    return value.toString(10).replace(/(?<!^)(\d{3})(?=(?:\d{3})*$)/g, ',$1');
}

// The values whose conditions hold under the currently selected bookmark dates.
function solveWithConditionAsSet<T>(value: WithCondition<T>[] | undefined, selectedConditions: import("../../src/hoiformat/condition").ConditionItem[]): T[] {
    return value?.filter(item => applyCondition(item.condition, selectedConditions)).map(item => item.value) ?? [];
}
