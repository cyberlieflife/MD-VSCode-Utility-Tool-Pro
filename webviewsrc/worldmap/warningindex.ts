// Reverse index over WorldMapWarning sources for O(k) warning lookups.
//
// The warnings color set and the hover tooltips previously filtered the full warnings array per
// province (O(W) per lookup, W = total warning count). The index maps each source type/key to the
// ascending list of warning slots that reference it; a lookup unions the relevant lists, dedupes
// by slot (one warning object is reported once even when several of its sources match) and emits
// texts in the original array order - byte-identical to the reference filter + map.
import { WorldMapWarning, Province, State, StrategicRegion, SupplyArea } from '../../src/previewdef/worldmap/definitions';

export interface WarningIndex {
    byProvince: Map<number, number[]>;
    byProvinceColor: Map<number, number[]>;
    byState: Map<number, number[]>;
    byStrategicRegion: Map<number, number[]>;
    bySupplyArea: Map<number, number[]>;
    byRailway: Map<number, number[]>;
    bySupplyNode: Map<number, number[]>;
    byStateCategory: Map<string, number[]>;
    byRiver: Map<number, number[]>;
}

export function buildWarningIndex(warnings: WorldMapWarning[]): WarningIndex {
    const index: WarningIndex = {
        byProvince: new Map(),
        byProvinceColor: new Map(),
        byState: new Map(),
        byStrategicRegion: new Map(),
        bySupplyArea: new Map(),
        byRailway: new Map(),
        bySupplyNode: new Map(),
        byStateCategory: new Map(),
        byRiver: new Map(),
    };
    const pushNum = (map: Map<number, number[]>, key: number, slot: number): void => {
        let arr = map.get(key);
        if (arr === undefined) {
            map.set(key, arr = []);
        }
        arr.push(slot);
    };
    const pushStr = (map: Map<string, number[]>, key: string, slot: number): void => {
        let arr = map.get(key);
        if (arr === undefined) {
            map.set(key, arr = []);
        }
        arr.push(slot);
    };

    for (let slot = 0; slot < warnings.length; slot++) {
        for (const source of warnings[slot].source) {
            switch (source.type) {
                case 'province':
                    // A null id (the source only carries a color) still matches by color, mirroring
                    // the reference `s.id === province.id || s.color === province.color`.
                    if (source.id !== null && source.id !== undefined) {
                        pushNum(index.byProvince, source.id, slot);
                    }
                    pushNum(index.byProvinceColor, source.color, slot);
                    break;
                case 'state':
                    pushNum(index.byState, source.id, slot);
                    break;
                case 'strategicregion':
                    pushNum(index.byStrategicRegion, source.id, slot);
                    break;
                case 'supplyarea':
                    pushNum(index.bySupplyArea, source.id, slot);
                    break;
                case 'railway':
                    pushNum(index.byRailway, source.id, slot);
                    break;
                case 'supplynode':
                    pushNum(index.bySupplyNode, source.id, slot);
                    break;
                case 'statecategory':
                    pushStr(index.byStateCategory, source.name, slot);
                    break;
                case 'river':
                    pushNum(index.byRiver, source.index, slot);
                    break;
            }
        }
    }
    return index;
}

// Unions the candidate slot lists, dedupes by slot (one warning object is listed once even when
// several of its sources match) and returns the slots in ascending (= original array) order.
function collect(slots: (number[] | undefined)[]): number[] {
    const set = new Set<number>();
    for (const arr of slots) {
        if (arr) {
            for (const slot of arr) {
                set.add(slot);
            }
        }
    }
    return [...set].sort((a, b) => a - b);
}

function textsAt(warnings: WorldMapWarning[], slots: number[]): string[] {
    return slots.map(slot => warnings[slot].text);
}

// Query helpers mirroring the FEWorldMapClass.get*Warnings signatures. Each optional object gates
// its own key class exactly like the reference `source.some(...)` conditions.
export function queryProvinceWarnings(
    index: WarningIndex,
    warnings: WorldMapWarning[],
    province?: Province,
    state?: State,
    strategicRegion?: StrategicRegion,
    supplyArea?: SupplyArea,
): string[] {
    return textsAt(warnings, collect([
        province ? index.byProvince.get(province.id) : undefined,
        province ? index.byProvinceColor.get(province.color) : undefined,
        state ? index.byState.get(state.id) : undefined,
        strategicRegion ? index.byStrategicRegion.get(strategicRegion.id) : undefined,
        supplyArea ? index.bySupplyArea.get(supplyArea.id) : undefined,
    ]));
}

export function queryStateWarnings(
    index: WarningIndex,
    warnings: WorldMapWarning[],
    state: State,
    supplyArea?: SupplyArea,
): string[] {
    return textsAt(warnings, collect([
        index.byState.get(state.id),
        supplyArea ? index.bySupplyArea.get(supplyArea.id) : undefined,
    ]));
}

export function queryStrategicRegionWarnings(
    index: WarningIndex,
    warnings: WorldMapWarning[],
    strategicRegion: StrategicRegion,
): string[] {
    return textsAt(warnings, collect([index.byStrategicRegion.get(strategicRegion.id)]));
}

export function querySupplyAreaWarnings(
    index: WarningIndex,
    warnings: WorldMapWarning[],
    supplyArea: SupplyArea,
): string[] {
    return textsAt(warnings, collect([index.bySupplyArea.get(supplyArea.id)]));
}

export function queryRiverWarnings(index: WarningIndex, warnings: WorldMapWarning[], riverIndex: number): string[] {
    return textsAt(warnings, collect([index.byRiver.get(riverIndex)]));
}
