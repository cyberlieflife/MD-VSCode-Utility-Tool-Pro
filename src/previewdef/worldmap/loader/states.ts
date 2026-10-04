import * as vscode from "vscode";
import { Bookmark, BookmarkDate, MapLoaderExtra, State, Province, WithCondition, WorldMapWarning, WorldMapWarningSource, Region, StateCategory } from "../definitions";
import { Enum, SchemaDef, CustomMap, DetailValue, Raw, convertNodeToJson } from "../../../hoiformat/schema";
import { readFileFromModOrHOI4, readFileFromModOrHOI4AsJson } from "../../../util/fileloader";
import { error } from "../../../util/debug";
import { LoadResult, FolderLoader, FileLoader, mergeInLoadResult, sortItems, mergeRegion, convertColor, LoadResultOD } from "./common";
import { parseHoi4File, Token, Node as HoiNode, NodeValue } from "../../../hoiformat/hoiparser";
import { arrayToMap, UserError } from "../../../util/common";
import { DefaultMapLoader } from "./provincemap";
import { localize } from "../../../util/i18n";
import { ensureLocalisationIndex, getLocalisedTextUnchecked } from "../../../util/localisationIndex";
import { isoBySettingName } from "../../../util/locales";
import { LoaderSession, mergeInLoadResultUnique } from "../../../util/loader/loader";
import { flatMap } from "lodash";
import { ResourceDefinitionLoader } from "./resource";
import { bookmarkDateToString, BookmarksLoader, compareBookmarkDate, toBookmarkDate } from "./bookmarks";
import { ConditionComplexExpr, ConditionItem, extractConditionalExprs, simplifyCondition, sortConditionExprs } from "../../../hoiformat/condition";
import { EffectComplexExpr, EffectItem, extractEffectValue } from "../../../hoiformat/effect";
import { Scope } from "../../../hoiformat/scope";

interface StateFile {
    state: StateDefinition[];
}

interface StateDefinition {
    id: number;
    name: string;
    manpower: number;
    state_category: string;
    history: Raw;
    provinces: Enum;
    impassable: boolean;
    impassable_ignored_links: Enum;
    resources: CustomMap<number>;
    _token: Token;
}

// Buildings live inside the history block in HOI4 state files (vanilla and mods alike).
// Claims use add_claim_by (one TAG per line) in vanilla files.
interface StateHistory {
    owner: string;
    controller: string;
    victory_points: Enum[];
    add_core_of: string[];
    add_claim_by: string[];
    set_demilitarized_zone: boolean;
    buildings: CustomMap<number>;
}

const stateFileSchema: SchemaDef<StateFile> = {
    state: {
        _innerType: {
            id: "number",
            name: "string",
            manpower: "number",
            state_category: "string",
            history: "raw",
            provinces: "enum",
            impassable: "boolean",
            impassable_ignored_links: "enum",
            resources: {
                _innerType: "number",
                _type: "map",
            },
        },
        _type: "array",
    },
};

const stateHistorySchema: SchemaDef<StateHistory> = {
    owner: "string",
    controller: "string",
    victory_points: {
        _innerType: "enum",
        _type: "array",
    },
    add_core_of: {
        _innerType: "string",
        _type: "array",
    },
    add_claim_by: {
        _innerType: "string",
        _type: "array",
    },
    set_demilitarized_zone: "boolean",
    buildings: {
        _innerType: "number",
        _type: "map",
    },
};

interface StateCategoryFile {
    state_categories: CustomMap<StateCategoryDefinition>;
}

interface StateCategoryDefinition {
    color: DetailValue<Enum>;
    // Base building slots granted by this category (vanilla: 0-12).
    local_building_slots: number;
}

const stateCategoryFileSchema: SchemaDef<StateCategoryFile> = {
    state_categories: {
        _innerType: {
            color: {
                _innerType: "enum",
                _type: "detailvalue",
            },
            local_building_slots: "number",
        },
        _type: "map",
    },
};

type StateNoBoundingBox = Omit<State, keyof Region>;

type StateLoaderResult = { states: State[], badStatesCount: number, stateCategories: string[], stateCategoryNames: Record<string, string>, stateCategorySlots: Record<string, number> };
export class StatesLoader extends FolderLoader<StateLoaderResult, StateNoBoundingBox[], MapLoaderExtra, MapLoaderExtra, [() => BookmarksLoader]> {
    private categoriesLoader: StateCategoriesLoader;

    constructor(private defaultMapLoader: DefaultMapLoader, private resourcesLoader: ResourceDefinitionLoader, private bookmarksLoader: BookmarksLoader) {
        super('history/states', StateLoader, () => this.bookmarksLoader);
        this.categoriesLoader = new StateCategoriesLoader();
        this.categoriesLoader.onProgress(e => this.onProgressEmitter.fire(e));
    }

    public async shouldReloadImpl(session: LoaderSession): Promise<boolean> {
        return await super.shouldReloadImpl(session) || await this.defaultMapLoader.shouldReload(session)
            || await this.categoriesLoader.shouldReload(session) || await this.resourcesLoader.shouldReload(session)
            || await this.bookmarksLoader.shouldReload(session);
    }

    protected async loadImpl(session: LoaderSession): Promise<LoadResult<StateLoaderResult>> {
        await this.fireOnProgressEvent(localize('worldmap.progress.loadingstates', 'Loading states...'));
        return super.loadImpl(session);
    }

    protected async mergeFiles(fileResults: LoadResult<StateNoBoundingBox[], MapLoaderExtra>[], session: LoaderSession): Promise<LoadResult<StateLoaderResult, MapLoaderExtra>> {
        const provinceMap = await this.defaultMapLoader.load(session);
        const stateCategories = await this.categoriesLoader.load(session);
        const resources = arrayToMap((await this.resourcesLoader.load(session)).result, 'name');

        await this.fireOnProgressEvent(localize('worldmap.progress.mapprovincestostates', 'Mapping provinces to states...'));

        const warnings = mergeInLoadResult([stateCategories, ...fileResults], 'warnings');
        // One entry per distinct condition leaf: the same bookmark date appears in every state file.
        const conditionExprs = mergeInLoadResultUnique< 'conditionExprs', { conditionExprs: ConditionItem[] }>(
            fileResults.map(r => ({ conditionExprs: r.conditionExprs ?? [] })),
            'conditionExprs',
            (a, b) => a.nodeContent === b.nodeContent && a.scopeName === b.scopeName,
        );
        sortConditionExprs(conditionExprs);
        const { provinces, width, height } = provinceMap.result;

        const states = flatMap(fileResults, c => c.result);

        const { sortedStates, badStateId } = sortStates(states, warnings);

        const filledStates: State[] = new Array(sortedStates.length);
        for (let i = badStateId + 1; i < sortedStates.length; i++) {
            if (sortedStates[i]) {
                const state = calculateBoundingBox(sortedStates[i], provinces, width, height, warnings);
                filledStates[i] = state;

                if (!(state.category in stateCategories.result)) {
                    warnings.push({
                        source: [{ type: 'state', id: i }],
                        relatedFiles: [ state.file ],
                        text: localize('worldmap.warnings.statecategorynotexist', "State category of state {0} is not defined: {1}.", i, state.category),
                    });
                }

                for (const key in state.resources) {
                    if (state.resources[key] !== undefined && !(key in resources)) {
                        warnings.push({
                            source: [{ type: 'state', id: i }],
                            relatedFiles: [ state.file ],
                            text: localize('worldmap.warnings.resourcenotexist', "Resource {0} used in state {1} is not defined.", key, i),
                        });
                    }
                }
            }
        }

        const badStatesCount = badStateId + 1;
        validateProvinceInState(provinces, filledStates, badStatesCount, warnings);

        // Localised category names for the edit dialog's dropdown; the game's own localisation
        // files key them by the bare category name. The index is built on demand (it is otherwise
        // only prewarmed for focus-tree previews) and missing translations fall back to the key.
        await ensureLocalisationIndex();
        const stateCategoryNames: Record<string, string> = {};
        const stateCategorySlots: Record<string, number> = {};
        for (const name of Object.keys(stateCategories.result)) {
            stateCategoryNames[name] = getLocalisedTextUnchecked(name, targetLocalisationLanguage()) ?? name;
            const slots = stateCategories.result[name].buildingSlots;
            if (slots !== undefined) {
                stateCategorySlots[name] = slots;
            }
        }

        return {
            result: {
                states: filledStates,
                badStatesCount,
                stateCategories: Object.keys(stateCategories.result).sort(),
                stateCategoryNames,
                stateCategorySlots,
            },
            dependencies: [this.folder + '/*', ...stateCategories.dependencies],
            warnings,
            conditionExprs,
        };
    }

    public toString() {
        return `[StatesLoader]`;
    }
}

class StateLoader extends FileLoader<StateNoBoundingBox[], MapLoaderExtra> {
    constructor(file: string, private bookmarkLoaderGetter: () => BookmarksLoader) {
        super(file);
    }

    protected async loadFromFile(session: LoaderSession): Promise<LoadResultOD<StateNoBoundingBox[], MapLoaderExtra>> {
        const bookmarks = await this.bookmarkLoaderGetter().load(session);
        const conditionExprs: ConditionItem[] = [];
        const warnings: WorldMapWarning[] = [];
        return {
            result: await loadState(this.file, warnings, bookmarks.result.bookmarks, conditionExprs),
            warnings,
            conditionExprs,
        };
    }

    public toString() {
        return `[StateLoader: ${this.file}]`;
    }
}

class StateCategoriesLoader extends FolderLoader<Record<string, StateCategory>, StateCategory[]> {
    constructor() {
        super('common/state_category', StateCategoryLoader);
    }

    protected async loadImpl(session: LoaderSession): Promise<LoadResult<Record<string, StateCategory>>> {
        await this.fireOnProgressEvent(localize('worldmap.progress.loadstatecategories', 'Loading state categories...'));
        return super.loadImpl(session);
    }

    protected async mergeFiles(fileResults: LoadResult<StateCategory[]>[]): Promise<LoadResult<Record<string, StateCategory>>> {
        const warnings = mergeInLoadResult(fileResults, 'warnings');
        const categories: Record<string, StateCategory> = {};

        fileResults.forEach(result => result.result.forEach(category => {
            if (category.name in categories) {
                warnings.push({
                    source: [{ type: 'statecategory', name: category.name }],
                    relatedFiles: [category.file, categories[category.name].file],
                    text: localize('worldmap.warnings.statecategoryconflict', "There're multiple state categories have name \"{0}\".", category.name),
                });
            }

            categories[category.name] = category;
        }));
    
        return {
            result: categories,
            dependencies: [this.folder + '/*'],
            warnings,
        };
    }

    public toString() {
        return `[StateCategoriesLoader]`;
    }
}

class StateCategoryLoader extends FileLoader<StateCategory[]> {
    protected async loadFromFile(): Promise<LoadResultOD<StateCategory[]>> {
        const warnings: WorldMapWarning[] = [];
        return {
            result: await loadStateCategory(this.file, warnings),
            warnings,
        };
    }

    public toString() {
        return `[StateCategoryLoader: ${this.file}]`;
    }
}

async function loadState(stateFile: string, globalWarnings: WorldMapWarning[], bookmarks: Bookmark[], conditionExprs: ConditionItem[]): Promise<StateNoBoundingBox[]> {
    const [buffer] = await readFileFromModOrHOI4(stateFile);
    return loadStateFromContent(buffer.toString(), stateFile, globalWarnings, bookmarks, conditionExprs);
}

export function loadStateFromContent(content: string, stateFile: string, globalWarnings: WorldMapWarning[], bookmarks: Bookmark[] = [], conditionExprs: ConditionItem[] = []): StateNoBoundingBox[] {
    try {
        const nodes = parseHoi4File(content, localize('infile', 'In file {0}:\n', stateFile));
        const data = convertNodeToJson<StateFile>(nodes, stateFileSchema);
        const result: StateNoBoundingBox[] = [];

        for (const state of data.state) {
            const warnings: string[] = [];
            const id = state.id ? state.id : (warnings.push(localize('worldmap.warnings.statenoid', "A state in {0} doesn't have id field.", stateFile)), -1);
            const name = state.name ? state.name : (warnings.push(localize('worldmap.warnings.statenoname', "The state doesn't have name field.")), '');
            const manpower = state.manpower ?? 0;
            const category = state.state_category ? state.state_category : (warnings.push(localize('worldmap.warnings.statenocategory', "The state doesn't have category field.")), '');
            const provinces = state.provinces._values.map(v => parseInt(v));
            const impassable = state.impassable ?? false;
            const impassableIgnoredLinks = state.impassable_ignored_links?._values.map(v => parseInt(v)) ?? [];
            const resources = arrayToMap(
                Object.values(state.resources._map), '_key', v => v._value);
            // Buildings may use named keys (industrial_complex / arms_factory) in current HOI4 or
            // numeric keys (1 = civilian, 4 = military) in older mods; both are kept as-is so the
            // webview can read either spelling. Provincial buildings (e.g. 3838 = { naval_base = 3 })
            // convert to undefined values and are ignored by the renderer. The history is kept raw
            // (so its dated blocks can be walked for bookmarks), hence the explicit conversion here.
            const historyData = state.history?._raw ? convertNodeToJson<StateHistory>(state.history._raw, stateHistorySchema) : undefined;
            const buildings = arrayToMap(
                Object.values(historyData?.buildings?._map ?? {}), '_key', v => v._value);

            const history = loadStateHistory(id, state.history, bookmarks, conditionExprs, content);
            const victoryPointsArray = history.victoryPointsArray;

            if (provinces.length === 0) {
                globalWarnings.push({
                    source: [{ type: 'state', id }],
                    relatedFiles: [stateFile],
                    text: localize('worldmap.warnings.statenoprovinces', "State {0} in \"{1}\" doesn't have provinces.", id, stateFile),
                });
            }

            for (const vpPair of victoryPointsArray) {
                if (!provinces.includes(vpPair[0])) {
                    warnings.push(localize('worldmap.warnings.provincenothere', 'Province {0} not included in this state. But victory points defined here.', vpPair[0]));
                }
            }

            globalWarnings.push(...warnings.map<WorldMapWarning>(warning => ({
                source: [{ type: 'state', id }],
                relatedFiles: [stateFile],
                text: warning,
            })));

            result.push({
                id, name, manpower, category, provinces, impassable, impassableIgnoredLinks, resources, buildings,
                owner: history.owner,
                controller: history.controller,
                cores: history.cores,
                claimBy: history.claimBy,
                isDemilitarizedZone: history.isDemilitarizedZone,
                victoryPoints: history.victoryPoints,
                file: stateFile,
                token: state._token ?? null,
            });
        }

        return result;
    } catch (e) {
        error(e);
        return [];
    }
}

interface StateHistoryResult {
    owner: WithCondition<string>[];
    controller: WithCondition<string>[];
    victoryPoints: Record<number, number | undefined>;
    victoryPointsArray: [number, number][];
    cores: WithCondition<string>[];
    claimBy: WithCondition<string>[];
    isDemilitarizedZone: WithCondition<boolean>[];
}

/**
 * Resolves a state's history into value lists guarded by conditions. With no bookmarks (or a
 * history without dated blocks) every value is unconditional, so the first entry is the only one.
 * With bookmarks, dated history blocks become conditions on the bookmark dates and the entries are
 * ordered newest-first, letting the webview pick the entry matching the selected date.
 */
function loadStateHistory(
    stateId: number,
    rawHistory: Raw | undefined,
    bookmarks: Bookmark[],
    conditionExprs: ConditionItem[],
    source: string,
): StateHistoryResult {
    const history = rawHistory?._raw ? convertNodeToJson<StateHistory>(rawHistory._raw, stateHistorySchema) : undefined;
    const victoryPointsArray = history?.victory_points.filter(v => v._values.length >= 2).map(v => v._values.slice(0, 2).map(v => parseInt(v)) as [number, number]) ?? [];
    const victoryPoints = arrayToMap(victoryPointsArray, '0', v => v[1]);

    if (bookmarks.length === 0 || !rawHistory) {
        const defaultOwner = history?.owner;
        const defaultController = history?.controller;
        const defaultIsDemilitarizedZone = history?.set_demilitarized_zone;
        const defaultCores = history?.add_core_of.filter((v, i, a): v is string => v !== undefined && i === a.indexOf(v)).map(v => ({ value: v, condition: true as const })) ?? [];
        const defaultClaimBy = history?.add_claim_by.filter((v, i, a): v is string => v !== undefined && i === a.indexOf(v)).map(v => ({ value: v, condition: true as const })) ?? [];
        return {
            owner: defaultOwner ? [{ value: defaultOwner, condition: true }] : [],
            controller: defaultController ? [{ value: defaultController, condition: true }] : [],
            isDemilitarizedZone: defaultIsDemilitarizedZone !== undefined ? [{ value: defaultIsDemilitarizedZone, condition: true }] : [],
            victoryPoints,
            victoryPointsArray,
            cores: defaultCores,
            claimBy: defaultClaimBy,
        };
    }

    // Flatten the history items into a list of {date, effect, condition} and sort by date.
    const scope: Scope = { scopeName: `State ${stateId}`, scopeType: 'state' };
    const dateHistoryEffects: { date: BookmarkDate, effects: { effect: EffectItem, condition: ConditionComplexExpr }[] }[] = [];

    const historyEffect = extractEffectValue(rawHistory._raw.value, scope);
    dateHistoryEffects.push({ date: { year: 0, month: 0, day: 0, hour: 0 }, effects: findHistoryItems(historyEffect.effect) });

    for (const { key, node } of collectDatedHistoryNodes(rawHistory._raw, source)) {
        const effect = extractEffectValue(node.value as NodeValue, scope);
        dateHistoryEffects.push({ date: toBookmarkDate(key), effects: findHistoryItems(effect.effect) });
    }
    dateHistoryEffects.sort((a, b) => compareBookmarkDate(a.date, b.date));

    const owner: WithCondition<string>[] = [];
    const controller: WithCondition<string>[] = [];
    const isDemilitarizedZone: WithCondition<boolean>[] = [];
    const cores: WithCondition<string>[] = [];
    const claimBy: WithCondition<string>[] = [];

    if (dateHistoryEffects.some(e => e.effects.length > 0)) {
        const bookmarkConditions: ConditionItem[] = [];
        for (let i = 0; i < bookmarks.length; i++) {
            bookmarkConditions.push({ scopeName: '', nodeContent: bookmarkDateToString(bookmarks[i].date) });
        }

        // An entry dated D applies when the selected bookmark is at or after D. Entries are pushed
        // oldest-first and reversed below, so the newest matching entry is the one the webview reads.
        const conditionForDate = (date: BookmarkDate): ConditionComplexExpr => {
            let index = 0;
            while (index < bookmarks.length && compareBookmarkDate(bookmarks[index].date, date) < 0) {
                index++;
            }
            // The entry is dated after every bookmark: no selection makes it current.
            if (index === bookmarks.length) {
                return false;
            }
            // Dated before the first bookmark (the undated history block): always in effect.
            if (index === 0) {
                return true;
            }
            return { type: 'or', items: bookmarkConditions.slice(index) };
        };

        for (const { date, effects } of dateHistoryEffects) {
            const bookmarkCondition = conditionForDate(date);
            if (bookmarkCondition === false) {
                continue;
            }
            for (const { effect, condition } of effects) {
                extractFromEffect(stateId, scope, effect, condition, bookmarkCondition, owner, controller, cores, claimBy, isDemilitarizedZone, conditionExprs);
            }
        }

        owner.reverse();
        controller.reverse();
        isDemilitarizedZone.reverse();
    }

    return { owner, controller, victoryPoints, victoryPointsArray, cores, claimBy, isDemilitarizedZone };
}

const historyItemTypes = [
    'owner', 'transfer_state_to', 'transfer_state',
    'controller', 'set_state_controller', 'set_state_controller_to',
    'add_core_of', 'remove_core_of',
    'set_demilitarized_zone',
    'add_claim_by', 'remove_claim_by', 'add_state_claim', 'remove_state_claim',
];
function findHistoryItems(
    effect: EffectComplexExpr,
    conditions: ConditionComplexExpr[] = [],
    result: { effect: EffectItem, condition: ConditionComplexExpr }[] = []
): { effect: EffectItem, condition: ConditionComplexExpr }[] {
    if (effect === null) {
        return result;
    }

    if ('nodeContent' in effect) {
        if (effect.node.name && historyItemTypes.includes(effect.node.name?.toLowerCase())) {
            result.push({ effect, condition: simplifyCondition({ type: 'and', items: conditions }) });
        }
    } else if ('condition' in effect) {
        effect.items.forEach(item => findHistoryItems(item, conditions.concat(effect.condition), result));
    } else {
        effect.items.forEach(item => findHistoryItems(item.effect, conditions, result));
    }

    return result;
}

function extractFromEffect(
    stateId: number,
    scope: Scope,
    effect: EffectItem,
    condition: ConditionComplexExpr,
    bookmarkCondition: ConditionComplexExpr,
    owner: WithCondition<string>[],
    controller: WithCondition<string>[],
    cores: WithCondition<string>[],
    claimBy: WithCondition<string>[],
    isDemilitarizedZone: WithCondition<boolean>[],
    conditionExprs: ConditionItem[],
) {
    const nodeName = effect.node.name?.toLowerCase();
    const combinedCondition = () => simplifyCondition({ type: 'and', items: [condition, bookmarkCondition] });

    // transfer_state_to = TAG / owner = TAG
    if ((nodeName === 'owner' || nodeName === 'transfer_state_to') && effect.scopeName === scope.scopeName) {
        const value = convertNodeToJson<string>(effect.node, 'string');
        if (!value) {
            return;
        }
        const combined = combinedCondition();
        extractConditionalExprs(combined, conditionExprs);
        owner.push({ value, condition: combined });
    }
    // TAG = { transfer_state = PREV }
    if (nodeName === 'transfer_state') {
        const value = convertNodeToJson<string>(effect.node, 'string');
        if (!value) {
            return;
        }
        if (parseInt(value) === stateId || value.toLowerCase() === 'root') {
            const combined = combinedCondition();
            extractConditionalExprs(combined, conditionExprs);
            owner.push({ value: effect.scopeName, condition: combined });
        }
    }
    // set_state_controller_to = TAG / controller = TAG
    if ((nodeName === 'controller' || nodeName === 'set_state_controller_to') && effect.scopeName === scope.scopeName) {
        const value = convertNodeToJson<string>(effect.node, 'string');
        if (!value) {
            return;
        }
        const combined = combinedCondition();
        extractConditionalExprs(combined, conditionExprs);
        controller.push({ value, condition: combined });
    }
    // TAG = { set_state_controller = PREV }
    if (nodeName === 'set_state_controller') {
        const value = convertNodeToJson<string>(effect.node, 'string');
        if (!value) {
            return;
        }
        if (parseInt(value) === stateId || value.toLowerCase() === 'root') {
            const combined = combinedCondition();
            extractConditionalExprs(combined, conditionExprs);
            controller.push({ value: effect.scopeName, condition: combined });
        }
    }
    // add_core_of = TAG
    if (nodeName === 'add_core_of' && effect.scopeName === scope.scopeName) {
        const value = convertNodeToJson<string>(effect.node, 'string');
        if (!value) {
            return;
        }
        const combined = combinedCondition();
        let item = cores.find(c => c.value === value);
        if (!item) {
            item = { value, condition: false };
            cores.push(item);
        }
        item.condition = simplifyCondition({ type: 'or', items: [item.condition, combined] });
        extractConditionalExprs(item.condition, conditionExprs);
    }
    // remove_core_of = TAG
    if (nodeName === 'remove_core_of' && effect.scopeName === scope.scopeName) {
        const value = convertNodeToJson<string>(effect.node, 'string');
        if (!value) {
            return;
        }
        const combined = combinedCondition();
        const item = cores.find(c => c.value === value);
        // No need to remove if it doesn't exist.
        if (item) {
            item.condition = simplifyCondition({ type: 'and', items: [item.condition, { type: 'ornot', items: [combined] }] });
            extractConditionalExprs(item.condition, conditionExprs);
        }
    }
    // set_demilitarized_zone = yes/no
    if (nodeName === 'set_demilitarized_zone' && effect.scopeName === scope.scopeName) {
        const value = convertNodeToJson<boolean>(effect.node, 'boolean');
        if (value === undefined) {
            return;
        }
        const combined = combinedCondition();
        extractConditionalExprs(combined, conditionExprs);
        isDemilitarizedZone.push({ value, condition: combined });
    }
    // add_claim_by = TAG
    if (nodeName === 'add_claim_by' && effect.scopeName === scope.scopeName) {
        const value = convertNodeToJson<string>(effect.node, 'string');
        if (!value) {
            return;
        }
        const combined = combinedCondition();
        let item = claimBy.find(c => c.value === value);
        if (!item) {
            item = { value, condition: false };
            claimBy.push(item);
        }
        item.condition = simplifyCondition({ type: 'or', items: [item.condition, combined] });
        extractConditionalExprs(item.condition, conditionExprs);
    }
    // remove_claim_by = TAG
    if (nodeName === 'remove_claim_by' && effect.scopeName === scope.scopeName) {
        const value = convertNodeToJson<string>(effect.node, 'string');
        if (!value) {
            return;
        }
        const combined = combinedCondition();
        const item = claimBy.find(c => c.value === value);
        // No need to remove if it doesn't exist.
        if (item) {
            item.condition = simplifyCondition({ type: 'and', items: [item.condition, { type: 'ornot', items: [combined] }] });
            extractConditionalExprs(item.condition, conditionExprs);
        }
    }
    // TAG = { add_state_claim = PREV }
    if (nodeName === 'add_state_claim') {
        const value = convertNodeToJson<string>(effect.node, 'string');
        if (!value) {
            return;
        }
        if (parseInt(value) === stateId || value.toLowerCase() === 'root') {
            const combined = combinedCondition();
            let item = claimBy.find(c => c.value === effect.scopeName);
            if (!item) {
                item = { value: effect.scopeName, condition: false };
                claimBy.push(item);
            }
            item.condition = simplifyCondition({ type: 'or', items: [item.condition, combined] });
            extractConditionalExprs(item.condition, conditionExprs);
        }
    }
    // TAG = { remove_state_claim = PREV }
    if (nodeName === 'remove_state_claim') {
        const value = convertNodeToJson<string>(effect.node, 'string');
        if (!value) {
            return;
        }
        if (parseInt(value) === stateId || value.toLowerCase() === 'root') {
            const combined = combinedCondition();
            const item = claimBy.find(c => c.value === effect.scopeName);
            // No need to remove if it doesn't exist.
            if (item) {
                item.condition = simplifyCondition({ type: 'and', items: [item.condition, { type: 'ornot', items: [combined] }] });
                extractConditionalExprs(item.condition, conditionExprs);
            }
        }
    }
}

/**
 * Finds the dated blocks inside a raw history node, returning each with its date key text.
 *
 * The key text is taken from the source by offset rather than from the node name: the parser
 * tokenizes `1936.1.1` as the numbers `1936.1` and `.1` (the number rule outranks the symbol rule),
 * so a date key arrives as one nameless continuation node following the node that holds the block.
 * The key therefore runs from the first token of the run up to the start of the block itself.
 */
function collectDatedHistoryNodes(history: HoiNode, source: string): { key: string, node: HoiNode }[] {
    const result: { key: string, node: HoiNode }[] = [];
    if (!Array.isArray(history.value)) {
        return result;
    }

    const children = history.value as HoiNode[];
    for (let i = 0; i < children.length; i++) {
        const child = children[i];
        if (child.operator !== '=' || child.value === null || !Array.isArray(child.value) || !child.nameToken) {
            continue;
        }

        // Walk back over the continuation tokens the tokenizer split the date into (`1936.1` + `.1`).
        let start = child.nameToken.start;
        for (let j = i - 1; j >= 0; j--) {
            const previous = children[j];
            if (previous.operator !== null || !previous.nameToken) {
                break;
            }
            start = previous.nameToken.start;
        }

        const key = source.substring(start, child.nameToken.end).trim();
        if (/^\d{4}\.\d{1,2}\.\d{1,2}(\.\d{1,2})?$/.test(key)) {
            result.push({ key, node: child });
        }
    }

    return result;
}

function sortStates(states: StateNoBoundingBox[], warnings: WorldMapWarning[]): { sortedStates: StateNoBoundingBox[], badStateId: number } {
    const { sorted, badId } = sortItems(
        states,
        10000,
        (maxId) => { throw new UserError(localize('worldmap.warnings.stateidtoolarge', 'Max state id is too large: {0}', maxId)); },
        (newState, existingState, badId) => warnings.push({
                source: [{ type: 'state', id: badId }],
                relatedFiles: [newState.file, existingState.file],
                text: localize('worldmap.warnings.stateidconflict', "There're more than one states using state id {0}.", newState.id),
            }),
        (startId, endId) => warnings.push({
                source: [{ type: 'state', id: startId }],
                relatedFiles: [],
                text: localize('worldmap.warnings.statenotexist', "State with id {0} doesn't exist.", startId === endId ? startId : `${startId}-${endId}`),
            }),
    );

    return {
        sortedStates: sorted,
        badStateId: badId,
    };
}

function calculateBoundingBox(noBoundingBoxState: StateNoBoundingBox, provinces: (Province | undefined | null)[], width: number, height: number, warnings: WorldMapWarning[]): State {
    const state = mergeRegion(
        noBoundingBoxState,
        'provinces',
        provinces,
        width, 
        provinceId => warnings.push({
                source: [{ type: 'state', id: noBoundingBoxState.id }],
                relatedFiles: [noBoundingBoxState.file],
                text: localize('worldmap.warnings.stateprovincenotexist', "Province {0} used in state {1} doesn't exist.", provinceId, noBoundingBoxState.id),
            }),
        () => warnings.push({
                source: [{ type: 'state', id: noBoundingBoxState.id }],
                relatedFiles: [noBoundingBoxState.file],
                text: localize('worldmap.warnings.statenovalidprovinces', "State {0} in doesn't have valid provinces.", noBoundingBoxState.id),
            })
    );

    if (state.boundingBox.w > width / 2 || state.boundingBox.h > height / 2) {
        warnings.push({
            source: [{ type: 'state', id: state.id }],
            relatedFiles: [state.file],
            text: localize('worldmap.warnings.statetoolarge', 'State {0} is too large: {1}x{2}.', state.id, state.boundingBox.w, state.boundingBox.h),
        });
    }

    return state;
}

function validateProvinceInState(provinces: (Province | undefined | null)[], states: (State | undefined | null)[], badStatesCount: number, warnings: WorldMapWarning[]) {
    const provinceToState: Record<number, number> = {};

    for (let i = badStatesCount; i < states.length; i++) {
        const state = states[i];
        if (!state) {
            continue;
        }

        state.provinces.forEach(p => {
            const province = provinces[p];
            if (provinceToState[p] !== undefined) {
                if (!province) {
                    return;
                }

                warnings.push({
                    source: [
                        ...[state.id, provinceToState[p]].map<WorldMapWarningSource>(id => ({ type: 'state', id })),
                        { type: 'province', id: p, color: province.color }
                    ],
                    relatedFiles: [state.file, states[provinceToState[p]]!.file],
                    text: localize('worldmap.warnings.provinceinmultistates', 'Province {0} exists in multiple states: {1}, {2}.', p, provinceToState[p], state.id),
                });
            } else {
                provinceToState[p] = state.id;
            }

            if (province?.type === 'sea') {
                warnings.push({
                    source: [
                        { type: 'state', id: state.id },
                        { type: 'province', id: p, color: province.color },
                    ],
                    relatedFiles: [state.file],
                    text: localize('worldmap.warnings.statehassea', "Sea province {0} shouldn't belong to a state.", p),
                });
            }
        });
    }
}

async function loadStateCategory(file: string, _warning: WorldMapWarning[]): Promise<StateCategory[]> {
    try {
        const data = await readFileFromModOrHOI4AsJson<StateCategoryFile>(file, stateCategoryFileSchema);
        const result: StateCategory[] = [];

        for (const categories of Object.values(data.state_categories._map)) {
            const name = categories._key;
            const color = convertColor(categories._value.color);
            const buildingSlots = categories._value.local_building_slots;

            result.push({ name, color, file, buildingSlots });
        }

        return result;
    } catch (e) {
        error(e);
        return [];
    }
}

// The language to translate into: the preview-localisation setting wins over the VSCode UI
// language, mirroring getLocalisedTextQuick in util/localisationIndex.
function targetLocalisationLanguage(): string {
    const previewLocalisation = vscode.workspace.getConfiguration('mdHoi4Utilities').get<string>('previewLocalisation');
    return (previewLocalisation && isoBySettingName[previewLocalisation]) || vscode.env.language;
}
