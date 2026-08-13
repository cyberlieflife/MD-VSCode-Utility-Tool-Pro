import * as assert from 'assert';
import { State, Province } from '../previewdef/worldmap/definitions';
import { checkStatesContiguous } from '../previewdef/worldmap/loader/supplyarea';

// A province is identified by id; its edges list the neighbouring province ids (or -1). The
// `impassable` flag mirrors HOI4's `ProvinceEdge.type` gate in statesAreAdjacent.
function makeProvince(id: number, edges: { to: number; impassable?: boolean }[]): Province {
    return {
        id,
        color: id,
        type: 'land',
        coastal: false,
        terrain: '',
        continent: 0,
        boundingBox: { x: 0, y: 0, w: 0, h: 0 },
        centerOfMass: { x: 0, y: 0 },
        mass: 0,
        coverZones: [],
        edges: edges.map(e => ({ to: e.to, type: e.impassable ? 'impassable' : 'land', path: [] })),
    };
}

function makeState(id: number, provinces: number[]): State {
    return {
        id,
        name: '',
        manpower: 0,
        category: '',
        owner: undefined,
        provinces,
        cores: [],
        impassable: false,
        impassableIgnoredLinks: [],
        victoryPoints: {},
        resources: {},
        boundingBox: { x: 0, y: 0, w: 0, h: 0 },
        centerOfMass: { x: 0, y: 0 },
        mass: 0,
        file: '',
        token: null,
    };
}

// Naive reference matching the pre-optimization implementation (O(S^2 * P^2 * E)): for every
// candidate state pair, scan state A's provinces, their edges, and state B's provinces. The
// indexed BFS must produce identical results for the same input.
function statesAreAdjacentReference(stateA: State, stateB: State, provinces: (Province | undefined | null)[]): boolean {
    return stateA.provinces.some(p =>
        provinces[p]?.edges
            .some(e => e.type !== 'impassable' && stateB.provinces.some(p2 => provinces[p2] && e.to === p2)) ?? false
        );
}

function checkStatesContiguousReference(states: State[], provinces: (Province | undefined | null)[]): [number, number] | undefined {
    if (states.length === 0) {
        return undefined;
    }

    const accessedStates: Record<number, boolean> = {};
    const stack: State[] = [states[0]];
    accessedStates[stack[0].id] = true;

    while (stack.length) {
        const currentState = stack.pop()!;
        for (const state of states) {
            if (accessedStates[state.id]) {
                continue;
            }

            if (statesAreAdjacentReference(state, currentState, provinces)) {
                stack.push(state);
                accessedStates[state.id] = true;
            }
        }
    }

    const inAccessedState = states.find(state => !accessedStates[state.id]);
    return inAccessedState === undefined ? undefined : [inAccessedState.id, parseInt(Object.keys(accessedStates)[0])];
}

describe('worldmap/supplyarea state contiguity', function () {
    // provinces 0-5, states A(0-1) B(2-3) C(4) D(5): A<->B adjacent, C isolated, D isolated.
    function buildFourStateMap(): { states: State[]; provinces: (Province | undefined | null)[] } {
        const provinces: (Province | undefined | null)[] = [
            makeProvince(0, [{ to: 1 }, { to: 2 }]),
            makeProvince(1, [{ to: 0 }, { to: 3 }]),
            makeProvince(2, [{ to: 0 }, { to: 3 }]),
            makeProvince(3, [{ to: 1 }, { to: 2 }]),
            makeProvince(4, []),
            makeProvince(5, []),
        ];
        const states = [
            makeState(1, [0, 1]),
            makeState(2, [2, 3]),
            makeState(3, [4]),
            makeState(4, [5]),
        ];
        return { states, provinces };
    }

    it('matches the reference on a contiguous two-state pair', function () {
        const { states, provinces } = buildFourStateMap();
        const pair = [states[0], states[1]];
        assert.deepStrictEqual(checkStatesContiguous(pair, provinces), checkStatesContiguousReference(pair, provinces));
        assert.deepStrictEqual(checkStatesContiguous(pair, provinces), undefined);
    });

    it('matches the reference on a disconnected set (isolated state not reached)', function () {
        const { states, provinces } = buildFourStateMap();
        assert.deepStrictEqual(checkStatesContiguous(states, provinces), checkStatesContiguousReference(states, provinces));
        assert.deepStrictEqual(checkStatesContiguous(states, provinces), [3, 1]);
    });

    it('returns undefined for an empty state list', function () {
        assert.deepStrictEqual(checkStatesContiguous([], []), undefined);
        assert.deepStrictEqual(checkStatesContiguousReference([], []), undefined);
    });

    it('returns undefined for a single state', function () {
        const { states, provinces } = buildFourStateMap();
        assert.deepStrictEqual(checkStatesContiguous([states[2]], provinces), undefined);
    });

    it('treats impassable edges as non-adjacent', function () {
        const provinces: (Province | undefined | null)[] = [
            makeProvince(0, [{ to: 1, impassable: true }]),
            makeProvince(1, [{ to: 0, impassable: true }]),
        ];
        const states = [makeState(1, [0]), makeState(2, [1])];
        assert.deepStrictEqual(checkStatesContiguous(states, provinces), checkStatesContiguousReference(states, provinces));
        assert.deepStrictEqual(checkStatesContiguous(states, provinces), [2, 1]);
    });

    it('matches the reference on a cycle of three states', function () {
        const provinces: (Province | undefined | null)[] = [
            makeProvince(0, [{ to: 1 }]),
            makeProvince(1, [{ to: 0 }, { to: 2 }]),
            makeProvince(2, [{ to: 1 }, { to: 3 }]),
            makeProvince(3, [{ to: 2 }]),
        ];
        const states = [makeState(1, [0]), makeState(2, [1]), makeState(3, [2])];
        assert.deepStrictEqual(checkStatesContiguous(states, provinces), checkStatesContiguousReference(states, provinces));
        assert.deepStrictEqual(checkStatesContiguous(states, provinces), undefined);
    });

    it('matches the reference on states connected via a shared province edge', function () {
        // State A owns province 0, state B owns province 1; edge 0->1 crosses the state border.
        const provinces: (Province | undefined | null)[] = [
            makeProvince(0, [{ to: 1 }]),
            makeProvince(1, [{ to: 0 }]),
        ];
        const states = [makeState(1, [0]), makeState(2, [1])];
        assert.deepStrictEqual(checkStatesContiguous(states, provinces), checkStatesContiguousReference(states, provinces));
        assert.deepStrictEqual(checkStatesContiguous(states, provinces), undefined);
    });

    it('ignores provinces that belong to no listed state', function () {
        // Province 9 is owned by an unlisted state; it must not connect A and B.
        const provinces: (Province | undefined | null)[] = [
            makeProvince(0, [{ to: 9 }]),
            makeProvince(1, [{ to: 8 }]),
        ];
        const states = [makeState(1, [0]), makeState(2, [1])];
        assert.deepStrictEqual(checkStatesContiguous(states, provinces), checkStatesContiguousReference(states, provinces));
        assert.deepStrictEqual(checkStatesContiguous(states, provinces), [2, 1]);
    });

    it('ignores ghost provinces referenced by a state but absent from the map', function () {
        // State B references province 9, which does not exist in `provinces`. The reference scan
        // requires `provinces[p2]` on the target side, so 9 must not bridge A and B.
        const provinces: (Province | undefined | null)[] = [
            makeProvince(0, [{ to: 9 }]),
            makeProvince(1, [{ to: 2 }]),
            makeProvince(2, [{ to: 1 }]),
        ];
        const states = [
            makeState(1, [0]),
            makeState(2, [1, 9]),
            makeState(3, [2]),
        ];
        assert.deepStrictEqual(checkStatesContiguous(states, provinces), checkStatesContiguousReference(states, provinces));
        assert.deepStrictEqual(checkStatesContiguous(states, provinces), [2, 1]);
    });

    it('matches the reference on an asymmetric single edge', function () {
        // Only 0 -> 1 exists; the reference expands from state B only towards candidates whose
        // province points at B, so 2 (owns 1) must be reachable from 1 (owns 0) but not vice versa.
        const provinces: (Province | undefined | null)[] = [
            makeProvince(0, [{ to: 1 }]),
            makeProvince(1, []),
        ];
        const states = [makeState(1, [0]), makeState(2, [1])];
        assert.deepStrictEqual(checkStatesContiguous(states, provinces), checkStatesContiguousReference(states, provinces));
    });

    describe('randomised equivalence against the reference', function () {
        // Deterministic PRNG (mulberry32) so failures are reproducible.
        function makeRandom(seed: number): () => number {
            let s = seed >>> 0;
            return () => {
                s = (s + 0x6D2B79F5) >>> 0;
                let t = s;
                t = Math.imul(t ^ (t >>> 15), t | 1);
                t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
                return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
            };
        }

        it('agrees with the reference across many random small maps', function () {
            const random = makeRandom(0xC0FFEE);
            for (let round = 0; round < 50; round++) {
                const provinceCount = 2 + Math.floor(random() * 12);       // 2..13 provinces
                const stateCount = 1 + Math.floor(random() * 6);          // 1..6 states
                const edgeDensity = random();

                // HOI4 province edges are symmetric (fillEdges writes each border into both
                // provinces), and so is the impassable flag (adjacencies are written into both
                // endpoints). Generate an undirected graph: an edge i<->j exists iff the random
                // draw for the (i,j) pair says so, stored on both endpoints with the same flag.
                const provinces: (Province | undefined | null)[] = [];
                const edgeMatrix: boolean[][] = [];
                const impassableMatrix: boolean[][] = [];
                for (let id = 0; id < provinceCount; id++) {
                    edgeMatrix.push(new Array<boolean>(provinceCount).fill(false));
                    impassableMatrix.push(new Array<boolean>(provinceCount).fill(false));
                }
                for (let i = 0; i < provinceCount; i++) {
                    for (let j = i + 1; j < provinceCount; j++) {
                        if (random() < edgeDensity) {
                            edgeMatrix[i][j] = edgeMatrix[j][i] = true;
                            const impassable = random() < 0.2;
                            impassableMatrix[i][j] = impassableMatrix[j][i] = impassable;
                        }
                    }
                }
                for (let id = 0; id < provinceCount; id++) {
                    const edges: { to: number; impassable?: boolean }[] = [];
                    for (let to = 0; to < provinceCount; to++) {
                        if (edgeMatrix[id][to]) {
                            edges.push({ to, impassable: impassableMatrix[id][to] });
                        }
                    }
                    provinces.push(makeProvince(id, edges));
                }

                const states: State[] = [];
                for (let s = 0; s < stateCount; s++) {
                    const p: number[] = [];
                    for (let id = 0; id < provinceCount; id++) {
                        if (random() < 0.35) {
                            p.push(id);
                        }
                    }
                    if (p.length === 0) {
                        // Keep every state non-empty so the reference scan is meaningful.
                        p.push(Math.floor(random() * provinceCount));
                    }
                    states.push(makeState(s + 1, p));
                }

                assert.deepStrictEqual(
                    checkStatesContiguous(states, provinces),
                    checkStatesContiguousReference(states, provinces),
                    `mismatch on round ${round}`,
                );
            }
        });

        it('agrees with the reference on random directed edge maps', function () {
            // The in-edge direction semantics is the riskiest part of the rewrite, so stress it:
            // every directed edge is drawn independently (asymmetric graphs included), which the
            // symmetric-generator above can never produce.
            const random = makeRandom(0xBEEF);
            for (let round = 0; round < 50; round++) {
                const provinceCount = 2 + Math.floor(random() * 12);
                const stateCount = 1 + Math.floor(random() * 6);
                const edgeDensity = random();

                const provinces: (Province | undefined | null)[] = [];
                for (let id = 0; id < provinceCount; id++) {
                    const edges: { to: number; impassable?: boolean }[] = [];
                    for (let to = 0; to < provinceCount; to++) {
                        if (to !== id && random() < edgeDensity) {
                            edges.push({ to, impassable: random() < 0.2 });
                        }
                    }
                    provinces.push(makeProvince(id, edges));
                }

                const states: State[] = [];
                for (let s = 0; s < stateCount; s++) {
                    const p: number[] = [];
                    for (let id = 0; id < provinceCount; id++) {
                        if (random() < 0.35) {
                            p.push(id);
                        }
                    }
                    if (p.length === 0) {
                        p.push(Math.floor(random() * provinceCount));
                    }
                    states.push(makeState(s + 1, p));
                }

                assert.deepStrictEqual(
                    checkStatesContiguous(states, provinces),
                    checkStatesContiguousReference(states, provinces),
                    `directed mismatch on round ${round}`,
                );
            }
        });

        it('returns the smallest visited id (not the seed) as the second element', function () {
            // Object.keys on an integer-keyed object enumerates in ascending numeric order, so the
            // original implementation returns the smallest *visited* state id here, not states[0].
            // The rewrite must preserve that exact behaviour.
            const provinces: (Province | undefined | null)[] = [
                makeProvince(0, [{ to: 1 }]),
                makeProvince(1, [{ to: 0 }]),
            ];
            const states = [makeState(100, [0]), makeState(5, [1]), makeState(50, [])];
            assert.deepStrictEqual(checkStatesContiguous(states, provinces), checkStatesContiguousReference(states, provinces));
            assert.deepStrictEqual(checkStatesContiguous(states, provinces), [50, 5]);
        });
    });
});
