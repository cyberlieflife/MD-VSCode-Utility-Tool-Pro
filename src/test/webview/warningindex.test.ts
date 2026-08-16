import './setup';
import * as assert from 'assert';
import { buildWarningIndex, queryProvinceWarnings, queryStateWarnings, queryStrategicRegionWarnings, querySupplyAreaWarnings, queryRiverWarnings, WarningIndex } from '../../../webviewsrc/worldmap/warningindex';
import { WorldMapWarning, WorldMapWarningSource, Province, State, StrategicRegion, SupplyArea } from '../../../src/previewdef/worldmap/definitions';

// A tiny seeded PRNG so the property tests are deterministic across CI runs.
function makeRandom(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
        s = (s * 1664525 + 1013904223) >>> 0;
        return s / 0x100000000;
    };
}

function makeWarning(slot: number, sources: WorldMapWarningSource[]): WorldMapWarning {
    return { source: sources, relatedFiles: [], text: 'warning-' + slot };
}

function makeProvince(id: number, color: number): Province {
    return { id, color } as unknown as Province;
}

function makeState(id: number): State {
    return { id } as unknown as State;
}

function makeStrategicRegion(id: number): StrategicRegion {
    return { id } as unknown as StrategicRegion;
}

function makeSupplyArea(id: number): SupplyArea {
    return { id } as unknown as SupplyArea;
}

// Reference implementations replicating the original filter + map scans.
function bruteForceProvinceWarnings(warnings: WorldMapWarning[], province?: Province, state?: State, sr?: StrategicRegion, sa?: SupplyArea): string[] {
    return warnings
        .filter(v => v.source.some(s =>
            (province && s.type === 'province' && (s.id === province.id || s.color === province.color)) ||
            (state && s.type === 'state' && s.id === state.id) ||
            (sr && s.type === 'strategicregion' && s.id === sr.id) ||
            (sa && s.type === 'supplyarea' && s.id === sa.id)
        ))
        .map(v => v.text);
}

function bruteForceStateWarnings(warnings: WorldMapWarning[], state: State, sa?: SupplyArea): string[] {
    return warnings
        .filter(v => v.source.some(s =>
            (s.type === 'state' && s.id === state.id) ||
            (sa && s.type === 'supplyarea' && s.id === sa.id)
        ))
        .map(v => v.text);
}

function bruteForceStrategicRegionWarnings(warnings: WorldMapWarning[], sr: StrategicRegion): string[] {
    return warnings.filter(v => v.source.some(s => s.type === 'strategicregion' && s.id === sr.id)).map(v => v.text);
}

function bruteForceSupplyAreaWarnings(warnings: WorldMapWarning[], sa: SupplyArea): string[] {
    return warnings.filter(v => v.source.some(s => s.type === 'supplyarea' && s.id === sa.id)).map(v => v.text);
}

function bruteForceRiverWarnings(warnings: WorldMapWarning[], riverIndex: number): string[] {
    return warnings.filter(v => v.source.some(s => s.type === 'river' && s.index === riverIndex)).map(v => v.text);
}

function indexFor(warnings: WorldMapWarning[]): WarningIndex {
    return buildWarningIndex(warnings);
}

describe('webview/worldmap/warning index', function () {
    describe('province warnings', function () {
        it('matches by province id', function () {
            const warnings = [
                makeWarning(0, [{ type: 'province', id: 7, color: 0x111111 }]),
                makeWarning(1, [{ type: 'province', id: 8, color: 0x222222 }]),
            ];
            const index = indexFor(warnings);
            assert.deepStrictEqual(queryProvinceWarnings(index, warnings, makeProvince(7, 0x999999)), ['warning-0']);
        });

        it('matches by color when the source has a null id', function () {
            const warnings = [
                makeWarning(0, [{ type: 'province', id: null, color: 0xABCDEF }]),
            ];
            const index = indexFor(warnings);
            assert.deepStrictEqual(queryProvinceWarnings(index, warnings, makeProvince(3, 0xABCDEF)), ['warning-0']);
            // A province with the same id but a different color must not match.
            assert.deepStrictEqual(queryProvinceWarnings(index, warnings, makeProvince(3, 0x000000)), []);
        });

        it('lists a warning once even when several of its sources match', function () {
            const warnings = [
                makeWarning(0, [
                    { type: 'province', id: 1, color: 0x111111 },
                    { type: 'state', id: 5 },
                ]),
            ];
            const index = indexFor(warnings);
            assert.deepStrictEqual(queryProvinceWarnings(index, warnings, makeProvince(1, 0x111111), makeState(5)), ['warning-0']);
        });

        it('keeps the original warning array order', function () {
            const warnings = [
                makeWarning(0, [{ type: 'province', id: 2, color: 0x222222 }]),
                makeWarning(1, [{ type: 'province', id: 1, color: 0x111111 }]),
                makeWarning(2, [{ type: 'province', id: 2, color: 0x222222 }]),
            ];
            const index = indexFor(warnings);
            assert.deepStrictEqual(queryProvinceWarnings(index, warnings, makeProvince(2, 0x222222)), ['warning-0', 'warning-2']);
        });
    });

    describe('region warnings', function () {
        it('resolves state, strategic region and supply area lookups', function () {
            const warnings = [
                makeWarning(0, [{ type: 'state', id: 10 }]),
                makeWarning(1, [{ type: 'strategicregion', id: 20 }]),
                makeWarning(2, [{ type: 'supplyarea', id: 30 }]),
            ];
            const index = indexFor(warnings);
            assert.deepStrictEqual(queryStateWarnings(index, warnings, makeState(10)), ['warning-0']);
            assert.deepStrictEqual(queryStrategicRegionWarnings(index, warnings, makeStrategicRegion(20)), ['warning-1']);
            assert.deepStrictEqual(querySupplyAreaWarnings(index, warnings, makeSupplyArea(30)), ['warning-2']);
            assert.deepStrictEqual(queryStateWarnings(index, warnings, makeState(10), makeSupplyArea(30)), ['warning-0', 'warning-2']);
        });

        it('resolves river warnings by index', function () {
            const warnings = [
                makeWarning(0, [{ type: 'river', name: 'r', index: 4 }]),
                makeWarning(1, [{ type: 'river', name: 'r2', index: 5 }]),
            ];
            const index = indexFor(warnings);
            assert.deepStrictEqual(queryRiverWarnings(index, warnings, 4), ['warning-0']);
        });

        it('ignores unrelated source kinds (statecategory)', function () {
            const warnings = [
                makeWarning(0, [{ type: 'statecategory', name: 'urban' }]),
            ];
            const index = indexFor(warnings);
            assert.deepStrictEqual(queryProvinceWarnings(index, warnings, makeProvince(1, 1)), []);
            assert.deepStrictEqual(queryStateWarnings(index, warnings, makeState(1)), []);
        });
    });

    describe('equivalence with the reference scans', function () {
        it('matches the filter + map implementations across randomized warning sets', function () {
            const rand = makeRandom(0xAB00A11);
            for (let trial = 0; trial < 50; trial++) {
                const warnings: WorldMapWarning[] = [];
                const count = 5 + Math.floor(rand() * 40);
                for (let i = 0; i < count; i++) {
                    const sources: WorldMapWarningSource[] = [];
                    const sourceCount = 1 + Math.floor(rand() * 3);
                    for (let j = 0; j < sourceCount; j++) {
                        const kind = Math.floor(rand() * 7);
                        if (kind === 0) {
                            sources.push({ type: 'province', id: rand() > 0.3 ? 1 + Math.floor(rand() * 20) : null, color: 1 + Math.floor(rand() * 50) });
                        } else if (kind === 1) {
                            sources.push({ type: 'state', id: 1 + Math.floor(rand() * 20) });
                        } else if (kind === 2) {
                            sources.push({ type: 'strategicregion', id: 1 + Math.floor(rand() * 20) });
                        } else if (kind === 3) {
                            sources.push({ type: 'supplyarea', id: 1 + Math.floor(rand() * 20) });
                        } else if (kind === 4) {
                            sources.push({ type: 'railway', id: 1 + Math.floor(rand() * 20) });
                        } else if (kind === 5) {
                            sources.push({ type: 'supplynode', id: 1 + Math.floor(rand() * 20) });
                        } else {
                            sources.push({ type: 'river', name: 'r', index: 1 + Math.floor(rand() * 20) });
                        }
                    }
                    warnings.push(makeWarning(i, sources));
                }

                const index = indexFor(warnings);
                for (let q = 0; q < 12; q++) {
                    const province = rand() > 0.3 ? makeProvince(1 + Math.floor(rand() * 20), 1 + Math.floor(rand() * 50)) : undefined;
                    const state = rand() > 0.4 ? makeState(1 + Math.floor(rand() * 20)) : undefined;
                    const sr = rand() > 0.5 ? makeStrategicRegion(1 + Math.floor(rand() * 20)) : undefined;
                    const sa = rand() > 0.6 ? makeSupplyArea(1 + Math.floor(rand() * 20)) : undefined;
                    const river = rand() > 0.7 ? 1 + Math.floor(rand() * 20) : undefined;

                    assert.deepStrictEqual(
                        queryProvinceWarnings(index, warnings, province, state, sr, sa),
                        bruteForceProvinceWarnings(warnings, province, state, sr, sa),
                        `trial ${trial} q ${q} province query`);
                    if (state) {
                        assert.deepStrictEqual(
                            queryStateWarnings(index, warnings, state, sa),
                            bruteForceStateWarnings(warnings, state, sa),
                            `trial ${trial} q ${q} state query`);
                    }
                    if (sr) {
                        assert.deepStrictEqual(
                            queryStrategicRegionWarnings(index, warnings, sr),
                            bruteForceStrategicRegionWarnings(warnings, sr),
                            `trial ${trial} q ${q} sr query`);
                    }
                    if (sa) {
                        assert.deepStrictEqual(
                            querySupplyAreaWarnings(index, warnings, sa),
                            bruteForceSupplyAreaWarnings(warnings, sa),
                            `trial ${trial} q ${q} sa query`);
                    }
                    if (river !== undefined) {
                        assert.deepStrictEqual(
                            queryRiverWarnings(index, warnings, river),
                            bruteForceRiverWarnings(warnings, river),
                            `trial ${trial} q ${q} river query`);
                    }
                }
            }
        });
    });
});
