import { Node, Token } from "../../hoiformat/hoiparser";
import { HOIPartial, SchemaDef, Position, convertNodeToJson, positionSchema, Raw, Enum, isSymbolNode } from "../../hoiformat/schema";
import { normalizeNumberLike } from "../../util/hoi4gui/common";
import { flatten, chain, groupBy } from 'lodash';
import { ConditionItem, ConditionComplexExpr, extractConditionValues, extractConditionValue, extractConditionalExprs, sortConditionExprs, applyCondition } from "../../hoiformat/condition";
import { countryScope } from "../../hoiformat/scope";
import { useConditionInFocus } from "../../util/featureflags";
import { randomString, Warning } from "../../util/common";
import { localize } from "../../util/i18n";
import * as path from 'path';
import { parseInlayWindowRef } from "./inlay";
import { ContainerWindowType } from "../../hoiformat/gui";

export interface FocusTree {
    id: string;
    focuses: Record<string, Focus>;
    inlayWindowRefs: FocusTreeInlayRef[];
    inlayWindows: FocusTreeInlay[];
    inlayConditionExprs: ConditionItem[];
    allowBranchOptions: string[];
    conditionExprs: ConditionItem[];
    isSharedFocues: boolean;
    continuousFocusPositionX?: number;
    continuousFocusPositionY?: number;
    // 文件里这棵树的连续焦点框写回目标：拖动它之后改的是树自己的 continuous_focus_position。
    // 树在文件里没有 token 时缺失（例如纯内存构造的树），此时框不可拖动。
    continuousFocusSource?: { file: string; start: number };
    // 文件声明的初始视图位置（命中了 focus 时用该焦点所在格，否则用给定的 x/y 格）；未声明时
    // undefined，预览仍在左上角打开。
    initialShowPosition?: { focus?: string; x: number; y: number };
    // 树自己的 shortcut 块，按文件顺序。伪树没有。
    shortcuts?: FocusTreeShortcut[];
    searchFilters: string[];
    warnings: FocusWarning[];
}

export interface FocusTreeShortcut {
    name: string;
    target: string;
}

interface FocusIconWithCondition {
    icon: string | undefined;
    condition: ConditionComplexExpr;
}

export interface Focus {
    x: number;
    y: number;
    id: string;
    icon: FocusIconWithCondition[];
    textIcon?: string;
    overlay?: string;
    searchFilters: string[];
    prerequisite: string[][];
    exclusive: string[];
    hasAllowBranch: boolean;
    inAllowBranch: string[];
    allowBranch: ConditionComplexExpr | undefined;
    relativePositionId: string | undefined;
    offset: Offset[];
    token: Token | undefined;
    // Source positions of the x/y value tokens in the focus file, used to write drag moves back.
    xToken: { start: number; end: number } | undefined;
    yToken: { start: number; end: number } | undefined;
    file: string;
    text?: string;
}

export interface FocusWarning extends Warning<string> {
    navigations?: { file: string, start: number, end: number }[];
    // 本条警告涉及的其他焦点（例如配对中的另一个），使网页端能高亮全部相关焦点而不只是警告来源。
    relatedSources?: string[];
    // 由布局校验器产出。这类警告描述的是某一棵树自己的网格，addSharedFocus 不会把它重放进并入
    // 该焦点的树：宿主树用不同的网格摆放这个焦点，多半只有违规组的一部分随之过去。
    layout?: boolean;
}

export interface FocusTreeInlayRef {
    id: string;
    position: { x: number; y: number; };
    file: string;
    token: Token | undefined;
}

export interface FocusTreeInlay {
    id: string;
    file: string;
    token: Token | undefined;
    windowName?: string;
    guiFile?: string;
    guiWindow?: HOIPartial<ContainerWindowType>;
    internal: boolean;
    visible: ConditionComplexExpr;
    position: { x: number; y: number; };
    scriptedImages: FocusInlayImageSlot[];
    scriptedButtons: FocusTreeInlayButtonMeta[];
    conditionExprs: ConditionItem[];
}

export interface FocusInlayImageSlot {
    id: string;
    file: string;
    token: Token | undefined;
    gfxOptions: FocusInlayGfxOption[];
}

export interface FocusInlayGfxOption {
    gfxName: string;
    condition: ConditionComplexExpr;
    file: string;
    token: Token | undefined;
    gfxFile?: string;
}

export interface FocusTreeInlayButtonMeta {
    id: string;
    file: string;
    token: Token | undefined;
    available?: ConditionComplexExpr;
}

interface Offset {
    x: number;
    y: number;
    trigger: ConditionComplexExpr | undefined;
}

interface InitialShowPositionDef extends Position {
    focus?: string;
}

interface FocusTreeDef {
    id: string;
    // 引用列表保持 raw：单符号（shared_focus = SH_a）、裸 id 块与 focus = 块三种写法都由
    // extractOrListIds 遍历。
    shared_focus: (Raw | undefined)[];
    focus: FocusDef[];
    continuous_focus_position: Position;
    initial_show_position: InitialShowPositionDef;
    inlay_window: Raw[];
    shortcut: ShortcutDef[];
    _token: Token;
}

interface ShortcutDef {
    name: string;
    target: string;
}

interface FocusDef {
    id: string;
    icon: Raw[];
    text_icon: string;
    overlay: string;
    x: Raw;
    y: Raw;
    prerequisite: FocusOrORList[];
    mutually_exclusive: FocusOrORList[];
    relative_position_id: string;
    allow_branch: Raw[]; /* FIXME not symbol node */
    offset: OffsetDef[];
    _token: Token;
    text?: string;
    search_filters: Enum;
}

interface FocusIconDef {
    trigger: Raw;
    value: string;
}

interface OffsetDef {
    x: number;
    y: number;
    trigger: Raw[];
}

interface FocusOrORList {
    focus: string[];
    // Schema 键与文件键都按小写比较，因此这里必须是小写 or。OR 块与 shared_focus 引用保持
    // raw：纯 string schema 表达不了块值（经 convertString 变成 undefined），裸 id 块
    // （OR = { a b }）与 focus = a 两种写法都由 extractOrListIds 遍历。
    or: (Raw | undefined)[];
}

interface FocusFile {
    focus_tree: FocusTreeDef[];
    shared_focus: FocusDef[];
    joint_focus: FocusDef[];
}

const focusOrORListSchema: SchemaDef<FocusOrORList> = {
    focus: {
        _innerType: "string",
        _type: 'array',
    },
    // Schema keys are matched against lowercased file keys, so this must be lowercase.
    or: {
        _innerType: "raw",
        _type: 'array',
    },
};

const focusSchema: SchemaDef<FocusDef> = {
    id: "string",
    icon: {
        _innerType: 'raw',
        _type: 'array',
    },
    text_icon: "string",
    overlay: "string",
    search_filters: "enum",
    x: "raw",
    y: "raw",
    prerequisite: {
        _innerType: focusOrORListSchema,
        _type: 'array',
    },
    mutually_exclusive: {
        _innerType: focusOrORListSchema,
        _type: 'array',
    },
    relative_position_id: "string",
    allow_branch: {
        _innerType: 'raw',
        _type: 'array',
    },
    offset: {
        _innerType: {
            x: "number",
            y: "number",
            trigger: {
                _innerType: 'raw',
                _type: 'array',
            },
        },
        _type: 'array',
    },
    text: "string",
};

const focusTreeSchema: SchemaDef<FocusTreeDef> = {
    id: "string",
    shared_focus: {
        _innerType: "raw",
        _type: "array",
    },
    focus: {
        _innerType: focusSchema,
        _type: 'array',
    },
    continuous_focus_position: positionSchema,
    initial_show_position: {
        ...positionSchema,
        focus: "string",
    },
    inlay_window: {
        _innerType: 'raw',
        _type: 'array',
    },
    shortcut: {
        _innerType: {
            name: "string",
            target: "string",
        },
        _type: "array",
    },
};

const focusFileSchema: SchemaDef<FocusFile> = {
    focus_tree: {
        _innerType: focusTreeSchema,
        _type: "array",
    },
    shared_focus: {
        _innerType: focusSchema,
        _type: "array",
    },
    joint_focus: {
        _innerType: focusSchema,
        _type: "array",
    },
};

const focusIconSchema: SchemaDef<FocusIconDef> = {
    trigger: "raw",
    value: "string",
};

export function convertFocusFileNodeToJson(node: Node, constants: {}): HOIPartial<FocusFile> {
    return convertNodeToJson<FocusFile>(node, focusFileSchema, constants);
}

export function getFocusTreeWithFocusFile(file: HOIPartial<FocusFile>, sharedFocusTrees: FocusTree[], filePath: string, constants: {} ): FocusTree[] {
    const focusTrees: FocusTree[] = [];
    if (file.shared_focus.length > 0) {
        const conditionExprs: ConditionItem[] = [];
        const warnings: FocusWarning[] = [];
        const focuses = getFocuses(file.shared_focus, conditionExprs, filePath, warnings, constants);
        // 片段：缺失的相对位置锚点（另一个文件里的焦点）不报告，但布局检查照跑。
        runLayoutValidation(focuses, warnings, false);
        sortConditionExprs(conditionExprs);
        const sharedFocusTree = {
            id: localize('focustree.sharedfocuses', '<Shared focuses>'),
            focuses,
            inlayWindowRefs: [],
            inlayWindows: [],
            inlayConditionExprs: [],
            allowBranchOptions: getAllowBranchOptions(focuses),
            conditionExprs,
            isSharedFocues: true,
            searchFilters: chain(focuses).flatMap(f => f.searchFilters).uniq().value(),
            warnings,
        };
        focusTrees.push(sharedFocusTree);
        sharedFocusTrees = [sharedFocusTree, ...sharedFocusTrees];
    }

    if (file.joint_focus.length > 0) {
        const conditionExprs: ConditionItem[] = [];
        const warnings: FocusWarning[] = [];
        const focuses = getFocuses(file.joint_focus, conditionExprs, filePath, warnings, constants);
        // 与共享焦点文件同样是片段：缺失锚点不报告，布局检查照跑。
        runLayoutValidation(focuses, warnings, false);

        focusTrees.push({
            id: getJointFocusTreeId(filePath),
            focuses,
            inlayWindowRefs: [],
            inlayWindows: [],
            inlayConditionExprs: [],
            allowBranchOptions: getAllowBranchOptions(focuses),
            conditionExprs,
            isSharedFocues: false,
            searchFilters: chain(focuses).flatMap(f => f.searchFilters).uniq().value(),
            warnings,
        });
    }

    for (const focusTree of file.focus_tree) {
        const conditionExprs: ConditionItem[] = [];
        const warnings: FocusWarning[] = [];
        const focuses = getFocuses(focusTree.focus, conditionExprs, filePath, warnings, constants);

        if (useConditionInFocus) {
            for (const sharedFocus of extractOrListIds(focusTree.shared_focus)) {
                if (!sharedFocus) {
                    continue;
                }
                addSharedFocus(focuses, filePath, sharedFocusTrees, sharedFocus, conditionExprs, warnings);
            }
        }

        runLayoutValidation(focuses, warnings, true);
        sortConditionExprs(conditionExprs);
        focusTrees.push({
            id: focusTree.id ?? localize('focustree.ananymous', '<Anonymous focus tree>'),
            focuses,
            inlayWindowRefs: focusTree.inlay_window
                .map(v => v?._raw)
                .filter((v): v is Node => v !== undefined)
                .map(v => parseInlayWindowRef(v, filePath))
                .filter((v): v is FocusTreeInlayRef => v !== undefined),
            inlayWindows: [],
            inlayConditionExprs: [],
            allowBranchOptions: getAllowBranchOptions(focuses),
            continuousFocusPositionX: normalizeNumberLike(focusTree.continuous_focus_position?.x, 0) ?? 50,
            continuousFocusPositionY: normalizeNumberLike(focusTree.continuous_focus_position?.y, 0) ?? 1000,
            ...(focusTree._token
                ? {
                    continuousFocusSource: {
                        file: filePath,
                        start: focusTree._token.start,
                    },
                }
                : {}),
            ...(focusTree.initial_show_position
                ? {
                    initialShowPosition: {
                        ...(focusTree.initial_show_position.focus
                            ? { focus: focusTree.initial_show_position.focus }
                            : {}),
                        x: normalizeNumberLike(focusTree.initial_show_position.x, 0) ?? 0,
                        y: normalizeNumberLike(focusTree.initial_show_position.y, 0) ?? 0,
                    },
                }
                : {}),
            shortcuts: focusTree.shortcut
                .filter((v): v is ShortcutDef => !!v?.name && !!v.target)
                .map((v) => ({ name: v.name, target: v.target })),
            conditionExprs,
            isSharedFocues: false,
            searchFilters: chain(focuses).flatMap(f => f.searchFilters).uniq().value(),
            warnings,
        });
    }

    focusTrees.sort((a, b) => a.id.localeCompare(b.id));
    return focusTrees;
}

function getJointFocusTreeId(filePath: string): string {
    const fileName = path.basename(filePath, path.extname(filePath));
    const label = localize('focustree.jointfocustree', '<Joint focus tree>');
    return fileName ? `${label} (${fileName})` : label;
}

/**
 * 依赖文件的 shared/joint 伪树中，真正在本文件旁边列出自己的那些。其焦点已经被本文件的某棵树
 * 合并走（useConditionInFocus 开启时的 `shared_focus` 引用）的伪树不再列出：它只会重复那些焦点，
 * 而且多出的这一个条目会让只有单棵国策树的文件也弹出树选择器。
 */
export function importedPseudoTreesToShow(ownTrees: FocusTree[], imported: FocusTree[]): FocusTree[] {
    const merged = new Set<string>();
    for (const tree of ownTrees) {
        if (!tree.isSharedFocues) {
            Object.keys(tree.focuses).forEach((id) => merged.add(id));
        }
    }
    return imported.filter(
        (tree) => tree.isSharedFocues && !Object.keys(tree.focuses).some((id) => merged.has(id)),
    );
}

/**
 * 预览的树选择器里列出的树。文件至少有一棵真正的 `focus_tree` 时只列它们：共享焦点在合并它的树
 * 里就能看到，不再单独作为 `<Shared focuses>` 条目出现。只有共享或联合焦点的文件仍保留伪树，
 * 否则没有东西可显示。loader 的结果保留全部树，因为其它文件要从这些伪树里合并。
 */
export function focusTreesToDisplay(trees: FocusTree[]): FocusTree[] {
    const ownTrees = trees.filter((tree) => !tree.isSharedFocues);
    return ownTrees.length > 0 ? ownTrees : trees;
}

export function getGfxNameForSearchFilter(filter: string): string {
    return `GFX_${filter}`;
}

/**
 * Lightweight ID-only extraction for the shared focus index.
 * Skips expensive per-focus parsing (icons, conditions, prerequisites)
 * that getFocusTree/getFocuses/getFocus would do.
 */
export function extractFocusIds(node: Node): string[] {
    const constants = {};
    const file = convertFocusFileNodeToJson(node, constants);
    const ids: string[] = [];

    for (const tree of file.focus_tree) {
        for (const focus of tree.focus) {
            if (focus.id) { ids.push(focus.id); }
        }
    }
    for (const focus of file.shared_focus) {
        if (focus.id) { ids.push(focus.id); }
    }
    for (const focus of file.joint_focus) {
        if (focus.id) { ids.push(focus.id); }
    }

    return ids;
}

export function getFocusTree(node: Node, sharedFocusTrees: FocusTree[], filePath: string): FocusTree[] {
    const constants = {};
    const file = convertFocusFileNodeToJson(node, constants);

    return getFocusTreeWithFocusFile(file, sharedFocusTrees, filePath, constants);
}

/**
 * Lightweight icon-name extraction for the create-focus icon picker. Collects every focus icon
 * GFX name (workspace + vanilla focus files) without the expensive per-icon resolution.
 */
export function extractFocusIcons(node: Node): string[] {
    const constants = {};
    const file = convertFocusFileNodeToJson(node, constants);
    const icons = new Set<string>();

    const collect = (focus: HOIPartial<FocusDef> | undefined): void => {
        for (const icon of focus?.icon ?? []) {
            const raw = icon?._raw;
            const value = raw?.value;
            if (typeof value === 'string') {
                icons.add(value);
            } else if (value && typeof value === 'object' && 'name' in value) {
                const name = value.name;
                if (typeof name === 'string') {
                    icons.add(name);
                }
            }
        }
    };

    for (const tree of file.focus_tree ?? []) {
        for (const focus of tree.focus ?? []) {
            collect(focus);
        }
    }
    for (const focus of file.shared_focus ?? []) {
        collect(focus);
    }
    for (const focus of file.joint_focus ?? []) {
        collect(focus);
    }

    return [...icons];
}

function nodeValueToString(value: Node["value"]): string | undefined {
    if (typeof value === "string") {
        return value;
    }
    return isSymbolNode(value) ? value.name : undefined;
}

/**
 * 从原始节点列表里读出裸焦点 id。纯 string schema 表达不了块值（经 convertString 变成
 * undefined），因此 prerequisite/mutually_exclusive 的 OR 块与 focus_tree 的 shared_focus
 * 引用都保持 raw 在这里遍历。单符号形式（OR = focus_a、shared_focus = SH_a）与块形式
 * （OR = { focus_a focus_b }、OR = { focus = focus_a focus = focus_b }、shared_focus = { SH_a SH_b }）都接受。
 */
export function extractOrListIds(orList: (Raw | undefined)[]): string[] {
    return flatten(
        orList
            .map((v) => v?._raw)
            .filter((v): v is Node => v !== undefined)
            .map((node) => {
                const value = node.value;
                if (Array.isArray(value)) {
                    return value
                        .map((child) =>
                            child.name === "focus"
                                ? nodeValueToString(child.value)
                                : child.name,
                        )
                        .filter((v): v is string => typeof v === "string");
                }
                const single = nodeValueToString(value);
                return single !== undefined ? [single] : [];
            }),
    );
}

function getFocuses(hoiFocuses: HOIPartial<FocusDef>[], conditionExprs: ConditionItem[], filePath: string, warnings: FocusWarning[], constants: {}): Record<string, Focus> {
    const focuses: Record<string, Focus> = {};

    for (const hoiFocus of hoiFocuses) {
        const focus = getFocus(hoiFocus, conditionExprs, filePath, warnings, constants);
        if (focus !== null) {
            if (focus.id in focuses) {
                const otherFocus = focuses[focus.id];
                warnings.push({
                    text: localize('focustree.warnings.focusidconflict', "There're more than one focuses with ID {0} in file: {1}.", focus.id, filePath),
                    source: focus.id,
                    navigations: [
                        {
                            file: filePath,
                            start: focus.token?.start ?? 0,
                            end: focus.token?.end ?? 0,
                        },
                        {
                            file: filePath,
                            start: otherFocus.token?.start ?? 0,
                            end: otherFocus.token?.end ?? 0,
                        },
                    ]
                });
            }
            focuses[focus.id] = focus;
        }
    }

    // Propagate inAllowBranch from prerequisites to dependents via BFS
    // Build reverse map: prerequisite -> focuses that depend on it
    const allowBranchDependents = new Map<string, string[]>();
    for (const key in focuses) {
        const prereqs = flatten(focuses[key].prerequisite).filter(p => p in focuses);
        for (const p of prereqs) {
            if (!allowBranchDependents.has(p)) { allowBranchDependents.set(p, []); }
            allowBranchDependents.get(p)!.push(key);
        }
    }

    // Seed queue with focuses that have allowBranch
    const abQueue: string[] = [];
    for (const key in focuses) {
        if (focuses[key].hasAllowBranch) {
            abQueue.push(key);
        }
    }

    while (abQueue.length > 0) {
        const sourceKey = abQueue.shift()!;
        const source = focuses[sourceKey];
        const deps = allowBranchDependents.get(sourceKey);
        if (!deps) { continue; }
        for (const depKey of deps) {
            const dep = focuses[depKey];
            let changed = false;
            for (const ab of source.inAllowBranch) {
                if (!dep.inAllowBranch.includes(ab)) {
                    dep.inAllowBranch.push(ab);
                    changed = true;
                }
            }
            if (changed) {
                abQueue.push(depKey);
            }
        }
    }

    return focuses;
}

// Extracts a focus coordinate (x or y) from its raw schema node: the numeric value plus the
// exact source span of the value token (used to write drag moves back into the file). Missing or
// non-numeric values yield { value: undefined, token: undefined }.
function getFocusCoordinate(raw: HOIPartial<Raw> | undefined): { value: number; token: { start: number; end: number } | undefined } | undefined {
    const node = raw?._raw;
    if (!node) {
        return undefined;
    }
    const value = typeof node.value === 'number' ? node.value : undefined;
    const token = node.valueStartToken ? { start: node.valueStartToken.start, end: node.valueStartToken.end } : undefined;
    return { value: value ?? 0, token };
}

function getFocus(hoiFocus: HOIPartial<FocusDef>, conditionExprs: ConditionItem[], filePath: string, warnings: FocusWarning[], constants: {}): Focus | null {
    const id = hoiFocus.id ?? `[missing_id_${randomString(8)}]`;

    if (!hoiFocus.id) {
        warnings.push({
            text: localize('focustree.warnings.focusnoid', "A focus defined in this file don't have ID: {0}.", filePath),
            source: id,
        });
    }

    const xRaw = getFocusCoordinate(hoiFocus.x);
    const yRaw = getFocusCoordinate(hoiFocus.y);
    const x = xRaw?.value ?? 0;
    const y = yRaw?.value ?? 0;
    const relativePositionId = hoiFocus.relative_position_id;

    const exclusive = chain(hoiFocus.mutually_exclusive)
        .flatMap(f => f.focus.concat(extractOrListIds(f.or)))
        .filter((s): s is string => s !== undefined)
        .value();
    const prerequisite = hoiFocus.prerequisite
        .map(p => p.focus.concat(extractOrListIds(p.or)).filter((s): s is string => s !== undefined));
    const icon = parseFocusIcon(hoiFocus.icon.filter((v): v is Raw => v !== undefined).map(v => v._raw), constants, conditionExprs);
    const textIcon = hoiFocus.text_icon;
    const overlay = hoiFocus.overlay;
    const hasAllowBranch = hoiFocus.allow_branch.length > 0;
    const allowBranchCondition = extractConditionValues(hoiFocus.allow_branch.filter((v): v is Raw => v !== undefined).map(v => v._raw.value), countryScope, conditionExprs).condition;
    const offset: Offset[] = hoiFocus.offset.map(o => ({
        x: o.x ?? 0,
        y: o.y ?? 0,
        trigger: o.trigger ? extractConditionValues(o.trigger.filter((v): v is Raw => v !== undefined).map(v => v._raw.value), countryScope, conditionExprs).condition : false,
    }));

    const text = hoiFocus.text;

    return {
        id,
        icon,
        textIcon,
        overlay,
        searchFilters: hoiFocus.search_filters?._values ?? [],
        x,
        y,
        xToken: xRaw?.token,
        yToken: yRaw?.token,
        relativePositionId,
        prerequisite,
        exclusive,
        hasAllowBranch,
        inAllowBranch: hasAllowBranch ? [id] : [],
        allowBranch: allowBranchCondition,
        offset,
        token: hoiFocus._token,
        file: filePath,
        text,
    };
}

function addSharedFocus(focuses: Record<string, Focus>, filePath: string, sharedFocusTrees: FocusTree[], sharedFocusId: string, conditionExprs: ConditionItem[], warnings: FocusWarning[]) {
    const sharedFocusTree = sharedFocusTrees.find(sft => sharedFocusId in sft.focuses);
    if (!sharedFocusTree) {
        return;
    }

    const sharedFocuses = sharedFocusTree.focuses;

    // Build reverse dependency map: focus -> focuses that depend on it
    const dependents = new Map<string, string[]>();
    // Track how many unresolved prerequisites each candidate has
    const unresolvedCount = new Map<string, number>();

    for (const key in sharedFocuses) {
        if (key in focuses) { continue; }
        const prereqs = flatten(sharedFocuses[key].prerequisite).filter(p => p in sharedFocuses);
        if (prereqs.length === 0) { continue; }
        let unresolved = 0;
        for (const p of prereqs) {
            if (!(p in focuses)) {
                unresolved++;
                if (!dependents.has(p)) { dependents.set(p, []); }
                dependents.get(p)!.push(key);
            }
        }
        unresolvedCount.set(key, unresolved);
    }

    // BFS: start from the requested shared focus, propagate to dependents
    const queue: string[] = [sharedFocusId];
    focuses[sharedFocusId] = sharedFocuses[sharedFocusId];
    updateConditionExprsByFocus(sharedFocuses[sharedFocusId], conditionExprs);

    while (queue.length > 0) {
        const added = queue.shift()!;
        const deps = dependents.get(added);
        if (!deps) { continue; }
        for (const dep of deps) {
            const count = (unresolvedCount.get(dep) ?? 1) - 1;
            unresolvedCount.set(dep, count);
            if (count <= 0 && !(dep in focuses)) {
                const focus = sharedFocuses[dep];
                if (focus.id in focuses) {
                    const otherFocus = focuses[focus.id];
                    warnings.push({
                        text: localize('focustree.warnings.focusidconflict2', "There're more than one focuses with ID {0} in files: {1}, {2}.", focus.id, filePath, focus.file),
                        source: focus.id,
                        navigations: [
                            {
                                file: focus.file,
                                start: focus.token?.start ?? 0,
                                end: focus.token?.end ?? 0,
                            },
                            {
                                file: filePath,
                                start: otherFocus.token?.start ?? 0,
                                end: otherFocus.token?.end ?? 0,
                            },
                        ]
                    });
                }
                focuses[dep] = focus;
                updateConditionExprsByFocus(focus, conditionExprs);
                queue.push(dep);
            }
        }
    }

    for (const warning of sharedFocusTree.warnings) {
        // 布局警告描述的是供体自己的网格；宿主树用不同的网格摆放并入的焦点，重放它多半是错的。
        if (warning.layout) {
            continue;
        }
        if (warning.source in focuses) {
            warnings.push(warning);
        }
    }
}

function updateConditionExprsByFocus(focus: Focus, conditionExprs: ConditionItem[]) {
    if (focus.allowBranch) {
        extractConditionalExprs(focus.allowBranch, conditionExprs);
    }

    for (const offset of focus.offset) {
        if (offset.trigger) {
            extractConditionalExprs(offset.trigger, conditionExprs);
        }
    }

    for (const icon of focus.icon) {
        extractConditionalExprs(icon.condition, conditionExprs);
    }
}

function getAllowBranchOptions(focuses: Record<string, Focus>): string[] {
    return chain(focuses)
        .filter(f => f.hasAllowBranch && f.allowBranch !== true)
        .map(f => f.id)
        .uniq()
        .value();
}

function resolveFocusPosition(
    focus: Focus,
    focuses: Record<string, Focus>,
): { x: number; y: number } {
    // 与网页端 getFocusPosition 对应，只是不含依赖条件的 offset 处理：解析出的位置是焦点自身的
    // x/y 加上 relative_position_id 链逐级解析的位置。环会被切断（由 validateRelativePositionId 报告）。
    let x = focus.x;
    let y = focus.y;
    const seen = new Set<string>([focus.id]);
    let current =
        focus.relativePositionId !== undefined
            ? focuses[focus.relativePositionId]
            : undefined;
    while (current !== undefined && !seen.has(current.id)) {
        x += current.x;
        y += current.y;
        seen.add(current.id);
        current =
            current.relativePositionId !== undefined
                ? focuses[current.relativePositionId]
                : undefined;
    }
    return { x, y };
}

/**
 * 焦点树常见布局错误的检查（这些错误会让游戏渲染出一棵坏树）：前置焦点没有排在依赖它的焦点
 * 上方（除非两者是互斥行里的同行伙伴，见下）、互斥焦点不在同一行、同一行上间距小于两个网格
 * 单位（精灵宽两个单位，会重叠）。位置像预览那样沿 relative_position_id 链解析；依赖条件的
 * offset 被忽略。
 *
 * 按定义文件逐个检查，因此国家树会标记并入它的共享/联合焦点而不只是自己的。两组从不互相比较：
 * 被并入的焦点由按国家取位的 offset 块摆放，本检查忽略它们，跨边界的一对会读出游戏画不出的碰撞。
 *
 * allow_branch 永远不会同时显示的两个焦点同样不做重叠检查：以 `has_country_flag = X` 与
 * `NOT = { has_country_flag = X }` 为门的一对替代项常常画在同一个位置，屏幕上只会有一个。
 */
function validateFocusLayout(
    focuses: Record<string, Focus>,
    warnings: FocusWarning[],
) {
    for (const [filePath, fileFocuses] of Object.entries(
        groupBy(Object.values(focuses), "file"),
    )) {
        validateFocusLayoutOfFile(focuses, warnings, filePath, fileFocuses);
    }
}

function validateFocusLayoutOfFile(
    focuses: Record<string, Focus>,
    warnings: FocusWarning[],
    filePath: string,
    fileFocuses: Focus[],
) {
    // 对整棵树解析，使锚定到宿主树自身焦点的共享焦点落在预览画它的位置。
    const entries = fileFocuses.map((focus) => ({
        focus,
        position: resolveFocusPosition(focus, focuses),
    }));
    const positions = new Map(
        entries.map((entry) => [entry.focus.id, entry.position] as const),
    );

    // 焦点的某个互斥伙伴解析到与它相同的行时，它就是并排替代行的一员（一行五个替代项、其中两个
    // 要求同行更早的一个的情形），那里的前置是同行伙伴而不是错误。按焦点缓存：y 是该焦点自己
    // 解析出的行，对给定 id 不会变化。
    const rowMateCache = new Map<string, boolean>();
    const hasExclusiveRowMate = (id: string, y: number): boolean => {
        const cached = rowMateCache.get(id);
        if (cached !== undefined) {
            return cached;
        }
        const focus = focuses[id];
        const result =
            focus !== undefined &&
            focus.exclusive.some((exclusive) => {
                const other = focuses[exclusive];
                return (
                    exclusive !== id &&
                    other !== undefined &&
                    other.file === filePath &&
                    positions.get(exclusive)?.y === y
                );
            });
        rowMateCache.set(id, result);
        return result;
    };

    const reportedPairs = new Set<string>();
    const pairKey = (a: string, b: string) =>
        a < b ? `${a}\u0001${b}` : `${b}\u0001${a}`;

    // 两个焦点只有在游戏能同时显示时才会在屏幕上重叠。可见性沿用预览自己的模型（网页端的
    // calculateFocusAllowed）：带 allow_branch 的焦点在条件成立时显示，其下方的焦点在每组前置
    // 都至少有一个显示项时显示。涉及到的 allow_branch 条件的所有真/假组合都会被尝试；把它们
    // 当成独立处理覆盖的情形多于游戏能达到的，因此只有任何组合都不显示两者时才豁免一对。
    const visibleTogetherCache = new Map<string, boolean>();
    const canBeVisibleTogether = (a: string, b: string): boolean => {
        const key = pairKey(a, b);
        const cached = visibleTogetherCache.get(key);
        if (cached !== undefined) {
            return cached;
        }
        const result = computeVisibleTogether(focuses, a, b);
        visibleTogetherCache.set(key, result);
        return result;
    };

    for (const { focus, position } of entries) {
        // OR 组的前置完成其中任意一个即可，因此只有组里没有任何选项排在依赖者上方、或与依赖者
        // 同行但该行并非互斥替代行时，才是布局问题。
        for (const group of focus.prerequisite) {
            const options = group.filter((p) => {
                const prerequisite = focuses[p];
                return (
                    p !== focus.id &&
                    prerequisite !== undefined &&
                    prerequisite.file === filePath
                );
            });
            const anySatisfied = options.some((p) => {
                const optionPosition = positions.get(p);
                if (optionPosition === undefined) {
                    return false;
                }
                if (optionPosition.y < position.y) {
                    return true;
                }
                // 同行只有在互斥能解释这一行时才可接受——依赖者自身或其链接的前置都可以。
                // 排在依赖者下方的前置永远不能被豁免。
                return (
                    optionPosition.y === position.y &&
                    (hasExclusiveRowMate(focus.id, position.y) ||
                        hasExclusiveRowMate(p, position.y))
                );
            });
            if (options.length > 0 && !anySatisfied) {
                warnings.push({
                    text: localize(
                        "focustree.warnings.prerequisitenotabove",
                        "Prerequisite {0} of focus {1} is not positioned above it.",
                        options.join(", "),
                        focus.id,
                    ),
                    source: focus.id,
                    relatedSources: options,
                });
            }
        }

        // 互斥焦点并排绘制并以水平红色标记相连，因此必须同行。X 不同是正常情形而不是错误：
        // 标准写法把替代项放在两列之外，由 allow_branch 隐藏落选者、offset 把幸存者滑进空出的槽位。
        for (const exclusive of focus.exclusive) {
            const exclusiveFocus = focuses[exclusive];
            if (
                exclusive === focus.id ||
                exclusiveFocus === undefined ||
                exclusiveFocus.file !== filePath
            ) {
                continue;
            }
            const key = pairKey(focus.id, exclusive);
            if (reportedPairs.has(key)) {
                continue;
            }
            reportedPairs.add(key);
            const exclusivePosition = positions.get(exclusive);
            if (
                exclusivePosition !== undefined &&
                exclusivePosition.y !== position.y
            ) {
                warnings.push({
                    text: localize(
                        "focustree.warnings.exclusivenotsamey",
                        "Mutually exclusive focuses {0} and {1} are not on the same row.",
                        focus.id,
                        exclusive,
                    ),
                    source: focus.id,
                    relatedSources: [exclusive],
                });
            }
        }
    }

    // 叠在完全相同解析位置上的焦点各折叠成一条警告，一堆焦点在同一处只出一行而不是每对一行。
    const stacks = new Map<string, string[]>();
    for (const { focus, position } of entries) {
        const key = `${position.x}\u0001${position.y}`;
        const stack = stacks.get(key);
        if (stack === undefined) {
            stacks.set(key, [focus.id]);
        } else {
            stack.push(focus.id);
        }
    }
    for (const fullStack of stacks.values()) {
        // 只有游戏能同时显示的成员才算重叠。
        const stack =
            fullStack.length > 1
                ? fullStack.filter((id) =>
                        fullStack.some(
                            (other) => other !== id && canBeVisibleTogether(id, other),
                        ),
                    )
                : fullStack;
        const first = stack[0];
        if (stack.length > 1 && first !== undefined) {
            warnings.push({
                text: localize(
                    "focustree.warnings.sameposition",
                    "Focuses {0} share the same position, so their icons overlap.",
                    stack.join(", "),
                ),
                source: first,
                relatedSources: stack.slice(1),
            });
        }
    }

    // 焦点图标跨两个网格列，因此同一行其余成对焦点之间至少要隔两个 X 单位，否则精灵重叠。
    // 同位置的成对由上面的堆叠覆盖。
    for (let i = 0; i < entries.length; i++) {
        const entryA = entries[i];
        if (entryA === undefined) {
            continue;
        }
        for (let j = i + 1; j < entries.length; j++) {
            const entryB = entries[j];
            if (entryB === undefined) {
                continue;
            }
            if (
                entryA.position.y !== entryB.position.y ||
                entryA.position.x === entryB.position.x
            ) {
                continue;
            }
            if (
                Math.abs(entryA.position.x - entryB.position.x) < 2 &&
                canBeVisibleTogether(entryA.focus.id, entryB.focus.id)
            ) {
                warnings.push({
                    text: localize(
                        "focustree.warnings.overlap",
                        "Focuses {0} and {1} are less than 2 apart on the same row, so their icons overlap.",
                        entryA.focus.id,
                        entryB.focus.id,
                    ),
                    source: entryA.focus.id,
                    relatedSources: [entryB.focus.id],
                });
            }
        }
    }
}

// 超过这么多个不同的 allow_branch 条件，就直接假定一对可以同时显示（保留其警告），
// 而不是穷举 2^n 种组合。
const maxAllowBranchConditions = 12;

function computeVisibleTogether(
    focuses: Record<string, Focus>,
    a: string,
    b: string,
): boolean {
    const roots = chain([
        ...(focuses[a]?.inAllowBranch ?? []),
        ...(focuses[b]?.inAllowBranch ?? []),
    ]).uniq().value();
    if (roots.length === 0) {
        return true;
    }

    const conditions: ConditionItem[] = [];
    for (const root of roots) {
        const allowBranch = focuses[root]?.allowBranch;
        if (allowBranch !== undefined) {
            extractConditionalExprs(allowBranch, conditions);
        }
    }
    if (conditions.length > maxAllowBranchConditions) {
        return true;
    }

    for (let mask = 0; mask < 1 << conditions.length; mask++) {
        const trueExprs = conditions.filter((_, i) => (mask & (1 << i)) !== 0);
        const isHidden = hiddenByAllowBranch(focuses, trueExprs);
        if (!isHidden(a) && !isHidden(b)) {
            return true;
        }
    }
    return false;
}

/**
 * 网页端 calculateFocusAllowed 的查表版：带 allow_branch 的焦点在条件不成立时隐藏，其它焦点在
 * 某一组前置全部隐藏时隐藏。树外的前置、以及环，都不会隐藏任何东西。
 */
function hiddenByAllowBranch(
    focuses: Record<string, Focus>,
    trueExprs: ConditionItem[],
): (id: string) => boolean {
    const memo = new Map<string, boolean>();
    const inProgress = new Set<string>();
    const isHidden = (id: string): boolean => {
        const cached = memo.get(id);
        if (cached !== undefined) {
            return cached;
        }
        const focus = focuses[id];
        if (focus === undefined || inProgress.has(id)) {
            return false;
        }
        inProgress.add(id);
        const hidden = focus.hasAllowBranch
            ? focus.allowBranch !== undefined &&
                !applyCondition(focus.allowBranch, trueExprs)
            : focus.prerequisite.some(
                    (group) => group.length > 0 && group.every(isHidden),
                );
        inProgress.delete(id);
        memo.set(id, hidden);
        return hidden;
    };
    return isHidden;
}

/**
 * 对一棵树运行两个布局校验，并给产出打上 layout 标记，使 addSharedFocus 能把"树自身的布局问题"
 * 与"焦点本身的警告"区分开。
 *
 * 共享或联合焦点文件是片段：游戏把它并入国家树后才解析，片段里的焦点可以正当地相对另一个文件
 * 定义的焦点摆位。这样的片段传 reportMissingRelativePositionTarget = false，不报告缺失的锚点。
 * 这些焦点仍参与布局检查：片段通常挂在一个外部锚点上，其焦点彼此之间的相对位置仍有意义。
 */
function runLayoutValidation(focuses: Record<string, Focus>, warnings: FocusWarning[], reportMissingRelativePositionTarget: boolean) {
    const layoutWarnings: FocusWarning[] = [];
    validateRelativePositionId(focuses, layoutWarnings, reportMissingRelativePositionTarget);
    validateFocusLayout(focuses, layoutWarnings);
    for (const warning of layoutWarnings) {
        warnings.push({ ...warning, layout: true });
    }
}

function validateRelativePositionId(focuses: Record<string, Focus>, warnings: FocusWarning[], reportMissingTarget: boolean = true) {
    const relativePositionId: Record<string, Focus | undefined> = {};
    const relativePositionIdChain: string[] = [];
    const circularReported: Record<string, boolean> = {};

    for (const focus of Object.values(focuses)) {
        if (focus.relativePositionId === undefined) {
            continue;
        }

        if (!(focus.relativePositionId in focuses)) {
            if (reportMissingTarget) {
                warnings.push({
                    text: localize('focustree.warnings.relativepositionidnotexist', 'Relative position ID of focus {0} not exist: {1}.', focus.id, focus.relativePositionId),
                    source: focus.id,
                });
            }
            continue;
        }

        relativePositionIdChain.length = 0;
        relativePositionId[focus.id] = focuses[focus.relativePositionId];
        let currentFocus: Focus | undefined = focus;
        while (currentFocus) {
            if (circularReported[currentFocus.id]) {
                break;
            }

            relativePositionIdChain.push(currentFocus.id);
            const nextFocus: Focus | undefined = relativePositionId[currentFocus.id];
            if (nextFocus && relativePositionIdChain.includes(nextFocus.id)) {
                relativePositionIdChain.forEach(r => circularReported[r] = true);
                relativePositionIdChain.push(nextFocus.id);
                warnings.push({
                    text: localize('focustree.warnings.relativepositioncircularref', "There're circular reference in relative position ID of these focuses: {0}.", relativePositionIdChain.join(' -> ')),
                    source: focus.id,
                });
                break;
            }
            currentFocus = nextFocus;
        }
    }
}

function parseFocusIcon(nodes: Node[], constants: {}, conditionExprs: ConditionItem[]): FocusIconWithCondition[] {
    return flatten(nodes.map(n => parseSingleFocusIcon(n, constants, conditionExprs)));
}

function parseSingleFocusIcon(node: Node, constants: {}, conditionExprs: ConditionItem[]): FocusIconWithCondition[] {
    // Simple form: icon = GFX_focus_x
    const stringResult = convertNodeToJson<string>(node, 'string', constants);
    if (stringResult) {
        return [{ icon: stringResult, condition: true }];
    }

    const children = Array.isArray(node.value) ? node.value : [];

    // Old block form: icon = { trigger = { ... }  value = GFX_focus_x }
    if (children.some(c => c.name === 'value')) {
        const iconWithCondition = convertNodeToJson<FocusIconDef>(node, focusIconSchema, constants);
        return [{
            icon: iconWithCondition.value,
            condition: iconWithCondition.trigger ? extractConditionValue(iconWithCondition.trigger._raw.value, countryScope, conditionExprs).condition : true,
        }];
    }

    // New block form (HOI4 1.19+): icon = { GFX_focus_x = { <triggers> }  GFX_focus_y = yes }
    // Each child names a GFX sprite; a block value holds its triggers, `= yes` marks the default.
    // Source order is preserved so the first matching condition wins on the client (the `= yes`
    // default is conventionally last and always matches).
    return children
        .filter((c): c is Node & { name: string } => c.name !== null)
        .map(c => Array.isArray(c.value)
            ? { icon: c.name, condition: extractConditionValue(c.value, countryScope, conditionExprs).condition }
            : { icon: c.name, condition: true });
}
