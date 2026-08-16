// Pure allow-branch state propagation for the focus-tree preview. Import-free on purpose so unit
// tests can exercise it without a DOM.

// Propagates the allow-branch options (seeds) through the focus prerequisite graph, replacing the
// previous while-changed full rescan (worst case O(V^2)) with a dependency-driven queue (O(V + E)).
//
// Semantics preserved exactly from the original scan:
// - A focus with no prerequisite groups, or whose id is already a seed, is never re-derived.
// - A focus is FALSE when any of its AND-groups is entirely false (every member === false).
// - A focus is TRUE when every AND-group has at least one true member (and none is fully false).
// - Otherwise the focus stays at its current value (undefined = allowed by default, like the scan).
// The queue re-evaluates only focuses whose referenced state actually changed, so the fixed point
// is reached without rescanning the whole tree per change.
export interface AllowBranchFocus {
    id: string;
    prerequisite: string[][];
}

export function propagateAllowBranches(
    focuses: Record<string, AllowBranchFocus>,
    seeds: Record<string, boolean>,
): Record<string, boolean> {
    const result: Record<string, boolean> = { ...seeds };
    // prerequisite member -> focuses that list it in any of their AND-groups.
    const reverseDeps = new Map<string, string[]>();
    const addDep = (member: string, dependent: string): void => {
        let deps = reverseDeps.get(member);
        if (deps === undefined) {
            reverseDeps.set(member, deps = []);
        }
        if (!deps.includes(dependent)) {
            deps.push(dependent);
        }
    };

    for (const id in focuses) {
        const focus = focuses[id];
        if (!focus || focus.prerequisite.length === 0 || id in seeds) {
            continue;
        }
        for (const group of focus.prerequisite) {
            for (const member of group) {
                addDep(member, id);
            }
        }
    }

    const queue: string[] = [];
    const enqueue = (id: string): void => {
        if (!queue.includes(id)) {
            queue.push(id);
        }
    };
    for (const seed in seeds) {
        const deps = reverseDeps.get(seed);
        if (deps) {
            for (const dep of deps) {
                enqueue(dep);
            }
        }
    }

    while (queue.length > 0) {
        const id = queue.shift()!;
        const focus = focuses[id];
        if (!focus || focus.prerequisite.length === 0 || id in seeds) {
            continue;
        }
        const next = evaluateAllowBranch(focus, result);
        // Undefined means "not yet decidable": leave the current value untouched, like the scan.
        if (next !== undefined && next !== result[id]) {
            result[id] = next;
            const deps = reverseDeps.get(id);
            if (deps) {
                for (const dep of deps) {
                    enqueue(dep);
                }
            }
        }
    }

    return result;
}

export function evaluateAllowBranch(focus: AllowBranchFocus, state: Record<string, boolean>): boolean | undefined {
    for (const group of focus.prerequisite) {
        if (group.length === 0) {
            continue;
        }
        if (group.every(p => state[p] === false)) {
            return false;
        }
    }
    let allow = true;
    for (const group of focus.prerequisite) {
        if (group.length === 0) {
            continue;
        }
        allow = allow && group.some(p => state[p] === true);
    }
    return allow ? true : undefined;
}
