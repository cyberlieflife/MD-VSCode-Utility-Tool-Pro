import './setup';
import * as assert from 'assert';
import { propagateAllowBranches, evaluateAllowBranch, AllowBranchFocus } from '../../../webviewsrc/focusbranch';

// A tiny seeded PRNG so the property tests are deterministic across CI runs.
function makeRandom(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
        s = (s * 1664525 + 1013904223) >>> 0;
        return s / 0x100000000;
    };
}

// Reference implementation replicating the original while-changed scan in focustree.ts.
function referencePropagate(focuses: Record<string, AllowBranchFocus>, seeds: Record<string, boolean>): Record<string, boolean> {
    const allowBranchOptionsValue: Record<string, boolean> = { ...seeds };
    let changed = true;
    while (changed) {
        changed = false;
        for (const key in focuses) {
            const focus = focuses[key];
            if (focus.prerequisite.length === 0) {
                continue;
            }
            if (focus.id in allowBranchOptionsValue) {
                continue;
            }
            let allow = true;
            for (const andPrerequests of focus.prerequisite) {
                if (andPrerequests.length === 0) {
                    continue;
                }
                allow = allow && andPrerequests.some(p => allowBranchOptionsValue[p] === true);
                const deny = andPrerequests.every(p => allowBranchOptionsValue[p] === false);
                if (deny) {
                    allowBranchOptionsValue[focus.id] = false;
                    changed = true;
                    break;
                }
            }
            if (allow) {
                allowBranchOptionsValue[focus.id] = true;
                changed = true;
            }
        }
    }
    return allowBranchOptionsValue;
}

describe('webview/focustree/propagateAllowBranches', function () {
    it('leaves everything undecided when there are no seeds', function () {
        const focuses: Record<string, AllowBranchFocus> = {
            a: { id: 'a', prerequisite: [['b']] },
            b: { id: 'b', prerequisite: [['c']] },
            c: { id: 'c', prerequisite: [] },
        };
        assert.deepStrictEqual(propagateAllowBranches(focuses, {}), {});
    });

    it('propagates a true seed down the chain', function () {
        const focuses: Record<string, AllowBranchFocus> = {
            a: { id: 'a', prerequisite: [['b']] },
            b: { id: 'b', prerequisite: [['c']] },
            c: { id: 'c', prerequisite: [] },
        };
        assert.deepStrictEqual(propagateAllowBranches(focuses, { c: true }), { c: true, b: true, a: true });
    });

    it('propagates a false seed (deny) down the chain', function () {
        const focuses: Record<string, AllowBranchFocus> = {
            a: { id: 'a', prerequisite: [['b']] },
            b: { id: 'b', prerequisite: [['c']] },
            c: { id: 'c', prerequisite: [] },
        };
        assert.deepStrictEqual(propagateAllowBranches(focuses, { c: false }), { c: false, b: false, a: false });
    });

    it('resolves AND-groups: every group needs a true member, any fully-false group denies', function () {
        const focuses: Record<string, AllowBranchFocus> = {
            and: { id: 'and', prerequisite: [['x', 'y']] },
            deny: { id: 'deny', prerequisite: [['x', 'y'], ['z']] },
        };
        // [x,y] has a true member -> 'and' true; [z] fully false -> 'deny' false.
        assert.deepStrictEqual(
            propagateAllowBranches(focuses, { x: false, y: true, z: false }),
            { x: false, y: true, z: false, and: true, deny: false },
        );
    });

    it('keeps an undecidable focus at its previous value', function () {
        const focuses: Record<string, AllowBranchFocus> = {
            a: { id: 'a', prerequisite: [['b']] },
        };
        // b is neither true nor false: 'a' cannot be decided and stays out of the result.
        const result = propagateAllowBranches(focuses, { b: undefined as unknown as boolean });
        assert.strictEqual(result.a, undefined);
    });

    it('survives cycles without hanging', function () {
        const focuses: Record<string, AllowBranchFocus> = {
            a: { id: 'a', prerequisite: [['b']] },
            b: { id: 'b', prerequisite: [['a']] },
        };
        // No seed: nothing propagates, no infinite loop.
        assert.deepStrictEqual(propagateAllowBranches(focuses, {}), {});
        // Seed a=true: a is a seed (skipped), b follows from a.
        assert.deepStrictEqual(propagateAllowBranches(focuses, { a: true }), { a: true, b: true });
    });

    it('evaluateAllowBranch matches the scan decision for individual focuses', function () {
        const focuses: Record<string, AllowBranchFocus> = {
            a: { id: 'a', prerequisite: [['b'], ['c', 'd']] },
        };
        const state = { b: true, c: false, d: true };
        assert.strictEqual(evaluateAllowBranch(focuses.a, state), true);
        // Group [b] fully false -> deny, regardless of the other group.
        assert.strictEqual(evaluateAllowBranch(focuses.a, { ...state, b: false }), false);
        // b undecided: group [b] has no true member and is not fully false -> undecidable.
        assert.strictEqual(evaluateAllowBranch(focuses.a, { ...state, b: undefined as unknown as boolean }), undefined);
        // Group [c, d] fully false -> deny.
        assert.strictEqual(evaluateAllowBranch(focuses.a, { ...state, c: false, d: false }), false);
    });

    it('matches the reference scan across randomized focus graphs and seeds', function () {
        const rand = makeRandom(0xB0B0ACE);
        for (let trial = 0; trial < 80; trial++) {
            const focuses: Record<string, AllowBranchFocus> = {};
            const count = 2 + Math.floor(rand() * 14);
            for (let i = 0; i < count; i++) {
                const groups: string[][] = [];
                const groupCount = Math.floor(rand() * 3);
                for (let g = 0; g < groupCount; g++) {
                    const members: string[] = [];
                    const memberCount = 1 + Math.floor(rand() * 4);
                    for (let m = 0; m < memberCount; m++) {
                        // Random focus ids, including references to non-existent focuses and the
                        // focus itself (undefined state members behave like the scan).
                        members.push('f' + Math.floor(rand() * (count + 2)));
                    }
                    groups.push(members);
                }
                const id = 'f' + i;
                focuses[id] = { id, prerequisite: groups };
            }

            const seeds: Record<string, boolean> = {};
            for (const id in focuses) {
                if (rand() > 0.65) {
                    seeds[id] = rand() > 0.5;
                }
            }
            // Occasionally seed ids that are not focuses at all (branch options).
            if (rand() > 0.7) {
                seeds['branch' + Math.floor(rand() * 5)] = rand() > 0.5;
            }

            const expected = referencePropagate(focuses, seeds);
            const got = propagateAllowBranches(focuses, seeds);
            assert.deepStrictEqual(got, expected, `trial ${trial} mismatch`);
        }
    });
});
