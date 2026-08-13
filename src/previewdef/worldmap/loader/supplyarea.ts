import { Enum, SchemaDef } from "../../../hoiformat/schema";
import { Token } from "../../../hoiformat/hoiparser";
import { FileLoader, FolderLoader, LoadResult, mergeInLoadResult, sortItems, mergeRegion, LoadResultOD } from "./common";
import { WorldMapWarning, SupplyArea, Region, State, WorldMapWarningSource, Province } from "../definitions";
import { readFileFromModOrHOI4AsJson } from "../../../util/fileloader";
import { localize } from "../../../util/i18n";
import { error } from "../../../util/debug";
import { DefaultMapLoader } from "./provincemap";
import { StatesLoader } from "./states";
import { LoaderSession } from "../../../util/loader/loader";
import { flatMap } from "lodash";
import { UserError } from "../../../util/common";

interface SupplyAreaFile {
    supply_area: SupplyAreaDefinition[];
}

interface SupplyAreaDefinition {
    id: number;
    name: string;
    value: number;
    states: Enum;
    _token: Token;
}

const supplyAreaFileSchema: SchemaDef<SupplyAreaFile> = {
    supply_area: {
        _innerType: {
            id: "number",
            name: "string",
            value: "number",
            states: "enum",
        },
        _type: "array",
    },
};

type SupplyAreasLoaderResult = { supplyAreas: SupplyArea[], badSupplyAreasCount: number };
export class SupplyAreasLoader extends FolderLoader<SupplyAreasLoaderResult, SupplyAreaNoRegion[]> {
    constructor(private defaultMapLoader: DefaultMapLoader, private statesLoader: StatesLoader) {
        super('map/supplyareas', SupplyAreaLoader);
    }

    public async shouldReloadImpl(session: LoaderSession): Promise<boolean> {
        return await super.shouldReloadImpl(session) || await this.defaultMapLoader.shouldReload(session) || await this.statesLoader.shouldReload(session);
    }

    protected async loadImpl(session: LoaderSession): Promise<LoadResult<SupplyAreasLoaderResult>> {
        await this.fireOnProgressEvent(localize('worldmap.progress.loadingsupplyareas', 'Loading supply areas...'));
        return super.loadImpl(session);
    }

    protected async mergeFiles(fileResults: LoadResult<SupplyAreaNoRegion[]>[], session: LoaderSession): Promise<LoadResult<SupplyAreasLoaderResult>> {
        const provinceMap = await this.defaultMapLoader.load(session);
        const stateMap = await this.statesLoader.load(session);

        await this.fireOnProgressEvent(localize('worldmap.progress.mapstatetosupplyarea', 'Mapping states to supply areas...'));

        const warnings = mergeInLoadResult(fileResults, 'warnings');
        const SupplyAreas = flatMap(fileResults, c => c.result);

        const { width, provinces } = provinceMap.result;

        const { sortedSupplyAreas, badSupplyAreaId } = sortSupplyAreas(SupplyAreas, warnings);

        const { states } = stateMap.result;
        const badSupplyAreasCount = badSupplyAreaId + 1;

        const filledSupplyAreas: SupplyArea[] = new Array(sortedSupplyAreas.length);
        for (let i = badSupplyAreasCount; i < sortedSupplyAreas.length; i++) {
            if (sortedSupplyAreas[i]) {
                filledSupplyAreas[i] = calculateBoundingBox(sortedSupplyAreas[i], states, width, warnings);
            }
        }

        validateStatesInSupplyAreas(states, filledSupplyAreas, provinces, badSupplyAreasCount, warnings);

        return {
            result: {
                supplyAreas: filledSupplyAreas,
                badSupplyAreasCount,
            },
            dependencies: [this.folder + '/*'],
            warnings,
        };
    }

    public toString() {
        return `[SupplyAreasLoader]`;
    }
}

class SupplyAreaLoader extends FileLoader<SupplyAreaNoRegion[]> {
    protected async loadFromFile(): Promise<LoadResultOD<SupplyAreaNoRegion[]>> {
        const warnings: WorldMapWarning[] = [];
        return {
            result: await loadSupplyArea(this.file, warnings),
            warnings,
        };
    }

    public toString() {
        return `[SupplyAreaLoader: ${this.file}]`;
    }
}

type SupplyAreaNoRegion = Omit<SupplyArea, keyof Region>;
async function loadSupplyArea(file: string, globalWarnings: WorldMapWarning[]): Promise<SupplyAreaNoRegion[]> {
    const result: SupplyAreaNoRegion[] = [];
    try {
        const data = await readFileFromModOrHOI4AsJson<SupplyAreaFile>(file, supplyAreaFileSchema);
        for (const supplyArea of data.supply_area) {
            const warnings: string[] = [];
            const id = supplyArea.id ? supplyArea.id : (warnings.push(localize('worldmap.warnings.supplyareanoid', "A supply area in \"{0}\" doesn't have id field.", file)), -1);
            const name = supplyArea.name ? supplyArea.name : (warnings.push(localize('worldmap.warnings.supplyareanoname', "Supply area {0} doesn't have name field.", id)), '');
            const value = supplyArea.value ?? 0;
            const states = supplyArea.states._values.map(v => parseInt(v));

            if (states.length === 0) {
                warnings.push(localize('worldmap.warnings.supplyareanostates', "Supply area {0} in \"{1}\" doesn't have states.", id, file));
            }

            globalWarnings.push(...warnings.map<WorldMapWarning>(warning => ({
                source: [{ type: 'supplyarea', id }],
                relatedFiles: [file],
                text: warning,
            })));

            result.push({
                id,
                name,
                states,
                value,
                file,
                token: supplyArea._token ?? null,
            });
        }

    } catch (e) {
        error(e);
    }

    return result;
}

function sortSupplyAreas(supplyAreas: SupplyAreaNoRegion[], warnings: WorldMapWarning[]): { sortedSupplyAreas: SupplyAreaNoRegion[], badSupplyAreaId: number } {
    const { sorted, badId } = sortItems(
        supplyAreas,
        10000,
        (maxId) => { throw new UserError(localize('worldmap.warnings.supplyareaidtoolarge', 'Max supply area ID is too large: {0}.', maxId)); },
        (newSupplyArea, existingSupplyArea, badId) => warnings.push({
                source: [{ type: 'supplyarea', id: badId }],
                relatedFiles: [newSupplyArea.file, existingSupplyArea.file],
                text: localize('worldmap.warnings.supplyareaidconflict', "There're more than one supply areas using ID {0}.", newSupplyArea.id),
            }),
        (startId, endId) => warnings.push({
                source: [{ type: 'supplyarea', id: startId }],
                relatedFiles: [],
                text: localize('worldmap.warnings.supplyareanotexist', "Supply area with id {0} doesn't exist.", startId === endId ? startId : `${startId}-${endId}`),
            }),
    );

    return {
        sortedSupplyAreas: sorted,
        badSupplyAreaId: badId,
    };
}

function calculateBoundingBox(supplyAreaNoRegion: SupplyAreaNoRegion, states: (State | undefined | null)[], width: number, warnings: WorldMapWarning[]): SupplyArea {
    return mergeRegion(
        supplyAreaNoRegion,
        'states',
        states,
        width, 
        stateId => warnings.push({
                source: [{ type: 'supplyarea', id: supplyAreaNoRegion.id }],
                relatedFiles: [supplyAreaNoRegion.file],
                text: localize('worldmap.warnings.stateinsupplyareanotexist', "State {0} used in supply area {1} doesn't exist.", stateId, supplyAreaNoRegion.id),
            }),
        () => warnings.push({
                source: [{ type: 'supplyarea', id: supplyAreaNoRegion.id }],
                relatedFiles: [supplyAreaNoRegion.file],
                text: localize('worldmap.warnings.supplyareanovalidstates', "Supply area {0} doesn't have valid states.", supplyAreaNoRegion.id),
            }),
    );
}

function validateStatesInSupplyAreas(
    states: (State | undefined | null)[],
    supplyAreas: (SupplyArea | undefined | null)[],
    provinces: (Province | undefined | null)[],
    badSupplyAreasCount: number,
    warnings: WorldMapWarning[]
) {
    const stateToSupplyArea: Record<number, number> = {};

    for (let i = badSupplyAreasCount; i < supplyAreas.length; i++) {
        const supplyArea = supplyAreas[i];
        if (!supplyArea) {
            continue;
        }

        const statesInSupplyArea = supplyArea.states.map(s => {
            const state = states[s];
            if (stateToSupplyArea[s] !== undefined) {
                if (!state) {
                    return undefined;
                }

                warnings.push({
                    source: [
                        ...[supplyArea.id, stateToSupplyArea[s]].map<WorldMapWarningSource>(id => ({ type: 'supplyarea', id })),
                        { type: 'state', id: s }
                    ],
                    relatedFiles: [supplyArea.file, supplyAreas[stateToSupplyArea[s]]!.file, state.file],
                    text: localize('worldmap.warnings.stateinmultiplesupplyareas', 'State {0} exists in multiple supply areas: {1}, {2}.', s, stateToSupplyArea[s], supplyArea.id),
                });
            } else {
                stateToSupplyArea[s] = supplyArea.id;
            }

            return state;
        }).filter((s): s is State => !!s);

        const badStates = checkStatesContiguous(statesInSupplyArea, provinces);
        if (badStates) {
            warnings.push({
                source: [{ type: 'supplyarea', id: i }],
                relatedFiles: [supplyArea.file],
                text: localize('worldmap.warnings.statesnotcontiguous', 'States in supply area {0} are not contiguous: {1}, {2}.', i, badStates[0], badStates[1]),
            });
        }
    }

    for (let i = 1; i < states.length; i++) {
        const state = states[i];
        if (!state) {
            continue;
        }
        if (!(i in stateToSupplyArea)) {
            warnings.push({
                source: [{ type: 'state', id: i }],
                relatedFiles: [state.file],
                text: localize('worldmap.warnings.statenosupplyarea', 'State {0} is not in any supply area.', i),
            });
        }
    }
}

// Adjacency index built once per supply area: maps each state to the set of states it touches
// through at least one non-impassable province edge. Building it is O(P * E) under the loader's
// single-owner invariant (a province id belongs to exactly one state, enforced by sortItems/sortItems
// dense arrays), plus the BFS below walks only the actual adjacency lists — replacing the previous
// O(S^2 * P^2 * E) worst case (every candidate state pair re-scanning all provinces/edges). Should a
// province id ever appear in several states' lists, each such edge costs O(k1 * k2) owner pairs
// (still bounded, and the Set dedupes the adjacency).
//
// Two invariants of the original scan are preserved exactly:
// 1. Only provinces that actually exist in the `provinces` array take part (the reference checked
//    `provinces[p] && e.to === p2` on both endpoints, so a state referencing a non-existent
//    province id must not become an adjacency bridge).
// 2. Reachability follows the reference's in-edge direction: a candidate state A is adjacent to
//    the current state B when some province of A owns an edge whose target belongs to B
//    (`stateA.provinces.some(p => provinces[p]?.edges.some(e => stateB.provinces.some(p2 => e.to === p2)))`).
//    The index therefore records target-owner -> source-owner edges, so the BFS expands from B
//    towards A exactly like the reference loop did.
interface StateAdjacencyIndex {
    stateById: Map<number, State>;
    stateAdjacency: Map<number, Set<number>>;
}

function buildStateAdjacencyIndex(states: State[], provinces: (Province | undefined | null)[]): StateAdjacencyIndex {
    const stateById = new Map<number, State>();
    const provinceToStates = new Map<number, number[]>();
    for (const state of states) {
        stateById.set(state.id, state);
        for (const p of state.provinces) {
            // Skip province ids that do not exist in the map: the reference never reached through
            // them (`provinces[p] && ...`), so they must not bridge two states here either.
            if (!provinces[p]) {
                continue;
            }
            let owners = provinceToStates.get(p);
            if (owners === undefined) {
                provinceToStates.set(p, owners = []);
            }
            owners.push(state.id);
        }
    }

    const stateAdjacency = new Map<number, Set<number>>();
    const addAdjacency = (from: number, to: number) => {
        let neighbors = stateAdjacency.get(from);
        if (neighbors === undefined) {
            stateAdjacency.set(from, neighbors = new Set());
        }
        neighbors.add(to);
    };
    for (const province of provinces) {
        if (!province) {
            continue;
        }
        const sourceOwners = provinceToStates.get(province.id);
        if (sourceOwners === undefined) {
            continue;
        }
        for (const edge of province.edges) {
            if (edge.type === 'impassable') {
                continue;
            }
            const targetOwners = provinceToStates.get(edge.to);
            if (targetOwners === undefined) {
                continue;
            }
            // In-edge direction: the reference's `statesAreAdjacent(stateA, stateB)` scans stateA's
            // provinces for an edge whose target belongs to stateB, so BFS from currentState (B)
            // expands towards every candidate A whose province points at B. The adjacency list of
            // the target owner must therefore contain the source owner: record target -> source.
            for (const sourceOwner of sourceOwners) {
                for (const targetOwner of targetOwners) {
                    if (sourceOwner !== targetOwner) {
                        addAdjacency(targetOwner, sourceOwner);
                    }
                }
            }
        }
    }

    return { stateById, stateAdjacency };
}

export function checkStatesContiguous(states: State[], provinces: (Province | undefined | null)[]): [number, number] | undefined {
    if (states.length === 0) {
        return undefined;
    }

    const { stateById, stateAdjacency } = buildStateAdjacencyIndex(states, provinces);
    const accessedStates: Record<number, boolean> = {};
    const stack: State[] = [states[0]];
    accessedStates[stack[0].id] = true;

    while (stack.length) {
        const currentState = stack.pop()!;
        const neighbors = stateAdjacency.get(currentState.id);
        if (neighbors === undefined) {
            continue;
        }
        for (const neighborId of neighbors) {
            if (accessedStates[neighborId]) {
                continue;
            }
            const neighborState = stateById.get(neighborId);
            if (neighborState === undefined) {
                continue;
            }
            stack.push(neighborState);
            accessedStates[neighborId] = true;
        }
    }

    const inAccessedState = states.find(state => !accessedStates[state.id]);
    // Object.keys on an integer-keyed object enumerates in ascending numeric order, so this is the
    // smallest *visited* state id, not necessarily states[0] — preserved from the original scan.
    return inAccessedState === undefined ? undefined : [inAccessedState.id, parseInt(Object.keys(accessedStates)[0])];
}
