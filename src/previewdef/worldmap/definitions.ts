import { ConditionComplexExpr, ConditionItem } from "../../hoiformat/condition";
import { Token } from "../../hoiformat/hoiparser";
import { Warning } from "../../util/common";

export type { ConditionItem };

export interface WorldMapData {
    width: number;
    height: number;
    provinces: (Province | undefined | null)[]; // count of provinces
    states: (State | undefined | null)[];
    countries: Country[];
    strategicRegions: (StrategicRegion | undefined | null)[];
    supplyAreas: (SupplyArea | undefined | null)[];
    railways: (Railway | undefined | null)[];
    supplyNodes: (SupplyNode | undefined | null)[];
    provincesCount: number;
    statesCount: number;
    countriesCount: number;
    strategicRegionsCount: number;
    supplyAreasCount: number;
    railwaysCount: number;
    supplyNodesCount: number;
    badProvincesCount: number; // will be * -1
    badStatesCount: number; // will be * -1;
    badStrategicRegionsCount: number;
    badSupplyAreasCount: number;
    continents: string[];
    terrains: Terrain[];
    resources: Resource[];
    factoryImages: FactoryImages;
    stateCategories: string[];
    // Relative path of the province definition file (from map/default.map), for opening a province's definition line.
    provinceDefinitionsFile: string;
    // State category key -> localised display name, for UI dropdowns (falls back to the key).
    stateCategoryNames: Record<string, string>;
    // State category key -> base building slots, for UI hints (missing when undefined in the file).
    stateCategorySlots: Record<string, number>;
    rivers: River[];
    // Every condition leaf the state histories produced, offered as toggles in the webview.
    conditionExprs: ConditionItem[];
    bookmarks: Bookmark[];
    warnings: WorldMapWarning[];
}

export interface ProvinceBmp {
    width: number;
    height: number;
    colorByPosition: Uint32Array; // width * height
    colorToProvince: Record<number, ProvinceGraph>;
    provinces: ProvinceGraph[];
}

export interface ProvinceMap {
    width: number;
    height: number;
    colorByPosition: Uint32Array; // width * height
    provinces: (Province | undefined | null)[]; // count of provinces
    badProvincesCount: number;
    continents: string[];
    terrains: Terrain[];
    rivers: River[];
    // Relative path of the province definition file (from map/default.map), for opening a province's definition line.
    provinceDefinitionsFile: string;
}

export interface ProvinceGraph extends Region {
    color: number;
    coverZones: Zone[];
    edges: ProvinceEdgeGraph[];
}

export interface ProvinceDefinition {
    id: number;
    color: number;
    type: string;
    coastal: boolean;
    terrain: string;
    continent: number;
    // 0-based line index of this province's row in the definition file. Provinces that exist only
    // in the bmp (no definition row) have no line to jump to.
    lineNumber?: number;
}

export type Province = Omit<ProvinceGraph & ProvinceDefinition, 'edges'> & {
    edges: ProvinceEdge[];
};

export interface ProvinceEdgeGraph {
    toColor: number;
    path: Point[][];
}

export interface ProvinceEdgeAdjacency {
    from: number;
    to: number;
    through?: number;
    type: 'impassable' | string;
    start?: Point;
    stop?: Point;
    rule?: string;
    row: string[];
}

export type ProvinceEdge = Omit<ProvinceEdgeGraph & ProvinceEdgeAdjacency, 'from' | 'row' | 'toColor'>;

export interface State extends Region, TokenInFile {
    id: number;
    name: string;
    manpower: number;
    category: string;
    // History values are lists of value + condition: a bookmark date selects which entry applies.
    // The first entry whose condition holds under the selected conditions wins.
    owner: WithCondition<string>[];
    controller: WithCondition<string>[];
    provinces: number[];
    cores: WithCondition<string>[];
    impassable: boolean;
    impassableIgnoredLinks: number[];
    victoryPoints: Record<number, number | undefined>;
    resources: Record<string, number | undefined>;
    buildings: Record<string, number | undefined>;
    claimBy: WithCondition<string>[];
    isDemilitarizedZone: WithCondition<boolean>[];
}

export interface WithCondition<T> {
    condition: ConditionComplexExpr;
    value: T;
}

export interface Bookmark {
    name: string;
    date: BookmarkDate;
}

export interface BookmarkDate {
    year: number;
    month: number;
    day: number;
    hour: number;
}

export interface Railway {
    provinces: number[];
    level: number;
}

export interface SupplyNode {
    province: number;
    level: number;
}

export interface WorldMapWarning extends Warning<WorldMapWarningSource[]> {
    relatedFiles: string[];
}

export type WorldMapWarningSource = WarningSourceProvince | WarningSourceIdOnly | WarningSourceName | WarningRiver;

interface WarningSourceBase {
    type: string;
}

interface WarningSourceProvince extends WarningSourceBase {
    type: 'province';
    id: number | null;
    color: number;
}

interface WarningSourceIdOnly extends WarningSourceBase {
    type: 'state' | 'strategicregion' | 'supplyarea' | 'railway' | 'supplynode';
    id: number;
}

interface WarningSourceName extends WarningSourceBase {
    type: 'statecategory';
    name: string;
}

interface WarningRiver extends WarningSourceBase {
    type: 'river';
    name: string;
    index: number;
}

export interface Country {
    tag: string;
    color: number;
    // Localised country name (falls back to undefined when the localisation has no entry).
    localisedName?: string;
    // The country's definition file, for opening it from the map.
    file: string;
}

export interface Terrain {
    name: string;
    color: number;
    isNaval: boolean;
    file: string;
}

export interface Resource {
    name: string;
    // Localised display name for UI lists (falls back to name when no translation exists).
    displayName: string;
    iconFrame: number;
    imageUri: string;
    file: string;
}

export interface FactoryImages {
    civilian: string;
    military: string;
}

export interface StrategicRegion extends Region, TokenInFile {
    id: number;
    name: string;
    provinces: number[];
    navalTerrain: string | null;
}

export interface SupplyArea extends Region, TokenInFile {
    id: number;
    name: string;
    value: number;
    states: number[];
}

export interface StateCategory {
    name: string;
    color: number;
    file: string;
    // Base building slots from the category definition (undefined when the file omits it).
    buildingSlots: number | undefined;
}

export interface RiverBmp {
    width: number;
    height: number;
    rivers: River[];
}

export interface River {
    colors: Record<number, number>;
    ends: number[];
    boundingBox: Zone;
}

export interface Point {
    x: number;
    y: number;
}

export interface Zone {
    x: number;
    y: number;
    w: number;
    h: number;
}

export interface Region {
    boundingBox: Zone;
    centerOfMass: Point;
    mass: number;
}

export interface TokenInFile {
    file: string;
    token: Token | null;
}

export type WorldMapMessage = LoadedMessage | RequestMapItemMessage | MapItemMessage | ErrorMessage | ProgressMessage | ProvinceMapSummaryMessage | OpenFileMessage | ExportMapMessage | MoveProvinceMessage | AddMapItemMessage | SelectMapItemMessage | EditStateMessage;

export interface LoadedMessage {
    command: 'loaded';
    force: boolean;
}

export interface RequestMapItemMessage {
    command: 'requestprovinces' | 'requeststates' | 'requestcountries' | 'requeststrategicregions' | 'requestsupplyareas' | 'requestrailways' | 'requestsupplynodes';
    start: number;
    end: number;
}

export interface MapItemMessage {
    command: 'provinces' | 'states' | 'countries' | 'warnings' | 'continents' | 'terrains' | 'strategicregions' | 'supplyareas' | 'railways' | 'supplynodes' | 'resources';
    data: string;
    start: number;
    end: number;
    count?: number;
    badCount?: number;
}

export interface ErrorMessage {
    command: 'error';
    data: string;
}

export interface ProgressMessage {
    command: 'progress';
    data: string;
}

export interface ProvinceMapSummaryMessage {
    command: 'provincemapsummary';
    data: WorldMapData;
}

export interface OpenFileMessage {
    command: 'openfile';
    type: 'state' | 'strategicregion' | 'supplyarea' | 'country' | 'provincedefinition';
    file: string;
    start: number | undefined;
    end: number | undefined;
    // Selects the whole line at this 0-based index; used when the file has one row per map item
    // (province definitions) instead of a token range.
    lineNumber?: number;
}

export interface ExportMapMessage {
    command: 'exportmap' | 'requestexportmap';
    dataUrl?: string;
}

export interface MoveProvinceMessage {
    command: 'moveprovince';
    type: 'state' | 'strategicregion',
    province: number,
    to: number,
    from: number | undefined,
    toFile: string,
    fromFile: string | undefined,
    // A state move carries the province's strategic-region move too, so both files stay in step.
    // The host performs it in the same pass: two separate messages would each copy files and could
    // prompt for a folder twice.
    alsoMoveStrategicRegion?: StrategicRegionMove,
}

export interface StrategicRegionMove {
    to: number,
    from: number | undefined,
    toFile: string,
    fromFile: string | undefined,
}

export interface AddMapItemMessage {
    command: 'addmapitem';
    type: 'state' | 'strategicregion';
}

export interface SelectMapItemMessage {
    command: 'selectmapitem';
    type: 'state' | 'strategicregion';
    id: number;
    enterEditMode: boolean;
}

export interface EditStateMessage {
    command: 'editstate';
    id: number;
    file: string;
    owner: string | undefined;
    cores: string[];
    claims: string[];
    category: string;
    manpower: number | undefined;
    infrastructure: number | undefined;
    civilianFactories: number | undefined;
    militaryFactories: number | undefined;
    resources: Record<string, number>;
}

export type ProgressReporter = (progress: string) => Promise<void>;

export type MapLoaderExtra = {
    warnings: WorldMapWarning[];
    conditionExprs?: ConditionItem[];
};
