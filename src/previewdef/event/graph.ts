import repeat from "lodash/repeat";
import { getLocalisedTextQuick } from "../../util/localisationIndex";
import { localisationIndex } from "../../util/featureflags";
import { localise } from "../localise";
import { ConditionComplexExpr } from "../../hoiformat/condition";
import { Token } from "../../hoiformat/hoiparser";
import { getSpriteByGfxName } from "../../util/image/imagecache";
import { StyleTable, normalizeForStyle } from "../../util/styletable";
import { HOIEvent, HOIEventOption } from "./schema";
import {
    EventGraphEdge,
    EventGraphEventNode,
    EventGraphNode,
    EventGraphOptionNode,
    EventGraphPayload,
    EventGraphUnresolvedNode,
    EventCallSource,
    EventToolbarFlags,
    EffectTreeNode,
    LocText,
} from "./payload";
import { EventsLoaderResult } from "./loader";

// 预览遍历的事件图：在宿主构建，随后投影为纯 JSON 的 EventGraphPayload，由网页端布局与渲染。

export interface EventNode {
    event: HOIEvent;
    loop: boolean;
    children: (EventEdge | OptionNode)[];
    relatedNamespace: string[];
    token: Token | undefined;
}

export interface OptionNode {
    optionName: string;
    trigger: ConditionComplexExpr;
    children: EventEdge[];
    file: string;
    token: Token | undefined;
    effects: EffectTreeNode[];
}

export interface EventEdge {
    toScope: string;
    toNode: EventNode | string;
    days: number;
    hours: number;
    randomDays: number;
    randomHours: number;
    condition: ConditionComplexExpr;
    possibility: number | undefined;
    source: EventCallSource;
}

export function eventsToGraph(
    eventIdToEvent: Record<string, HOIEvent>,
    mainNamespaces: string[],
): EventNode[] {
    const eventIdToNode: Record<string, EventNode> = {};
    const eventHasParent: Record<string, boolean> = {};
    const eventStack: HOIEvent[] = [];

    for (const event of Object.values(eventIdToEvent)) {
        eventToNode(event, eventIdToEvent, eventStack, eventIdToNode, eventHasParent);
    }

    const result: EventNode[] = [];
    const covered = new Set<string>();

    const addRoot = (eventNode: EventNode) => {
        result.push(eventNode);
        markReachable(eventNode, covered);
    };

    for (const event of Object.values(eventIdToEvent)) {
        if (!eventHasParent[event.id]) {
            const eventNode = eventIdToNode[event.id];
            if (eventNode?.relatedNamespace.some((n) => mainNamespaces.includes(n))) {
                addRoot(eventNode);
            }
        }
    }

    // 只互相调用的事件组没有任何无父成员，上面这一遍找不到入口，整组会渲染成空白。
    // （上游案例：两个隐藏事件互相在 immediate 里调用对方。）因此仍未到达的事件按文件顺序
    // 提升为自己的根，结果保持确定性。
    for (const event of Object.values(eventIdToEvent)) {
        if (covered.has(event.id)) {
            continue;
        }
        const eventNode = eventIdToNode[event.id];
        if (eventNode?.relatedNamespace.some((n) => mainNamespaces.includes(n))) {
            addRoot(eventNode);
        }
    }

    return result;
}

// 从这个节点可达的每个事件 id，选项与调用都跟随。
function markReachable(node: EventNode, covered: Set<string>): void {
    if (covered.has(node.event.id)) {
        return;
    }
    covered.add(node.event.id);
    for (const child of node.children) {
        if ("toNode" in child) {
            if (typeof child.toNode !== "string") {
                markReachable(child.toNode, covered);
            }
        } else {
            for (const edge of child.children) {
                if (typeof edge.toNode !== "string") {
                    markReachable(edge.toNode, covered);
                }
            }
        }
    }
}

function eventToNode(
    event: HOIEvent,
    eventIdToEvent: Record<string, HOIEvent>,
    eventStack: HOIEvent[],
    eventIdToNode: Record<string, EventNode>,
    eventHasParent: Record<string, boolean>,
): EventNode {
    const cachedNode = eventIdToNode[event.id];
    if (cachedNode) {
        return cachedNode;
    }

    eventStack.push(event);
    const eventNode: EventNode = {
        event,
        children: [],
        relatedNamespace: [event.namespace],
        token: event.token,
        loop: false,
    };
    eventIdToNode[event.id] = eventNode;

    // 先事件自己的两个效果块，再是选项。调用来自哪个块必须携带而不是猜：`immediate` 与 `after`
    // 都没有名字，读名字的做法分不清两者。
    const blocks: { block: HOIEventOption; source: EventCallSource }[] = [
        { block: event.immediate, source: "immediate" },
        { block: event.after, source: "after" },
        ...event.options.map((option) => ({ block: option, source: "option" as const })),
    ];

    for (const { block: option, source } of blocks) {
        // 块只有在有名字时才拿到自己的卡片：那就是两个事件级块，以及名字是 schema 读不成字符串的
        // 动态 `name = { text = ... }` 块的选项——这样的选项一直把调用挂在事件上，此处仍然如此。
        const hasCard = option.name !== undefined;
        const callSource: EventCallSource = hasCard
            ? "option"
            : source === "option"
                ? "immediate"
                : source;
        const optionNode: OptionNode = {
            optionName: option.name ?? ":" + source,
            trigger: option.trigger,
            children: [],
            file: event.file,
            token: option.token,
            effects: option.effects,
        };
        if (hasCard) {
            eventNode.children.push(optionNode);
        }

        for (const childEvent of option.childEvents) {
            const childEventItem = eventIdToEvent[childEvent.eventName];
            eventHasParent[childEvent.eventName] = true;

            let toNode: EventNode | string;
            if (!childEventItem) {
                toNode = childEvent.eventName;
            } else if (eventStack.includes(childEventItem)) {
                toNode = eventToNode(childEventItem, eventIdToEvent, eventStack, eventIdToNode, eventHasParent);
                toNode = {
                    ...toNode,
                    children: [],
                    loop: true,
                };
            } else {
                toNode = eventToNode(childEventItem, eventIdToEvent, eventStack, eventIdToNode, eventHasParent);
                toNode.relatedNamespace.forEach((n) => {
                    if (!eventNode.relatedNamespace.includes(n)) {
                        eventNode.relatedNamespace.push(n);
                    }
                });
            }

            const eventEdge: EventEdge = {
                toNode,
                toScope: childEvent.scopeName,
                days: childEvent.days,
                hours: childEvent.hours,
                randomDays: childEvent.randomDays,
                randomHours: childEvent.randomHours,
                condition: childEvent.condition,
                possibility: childEvent.possibility,
                source: callSource,
            };

            if (hasCard) {
                optionNode.children.push(eventEdge);
            } else {
                eventNode.children.push(eventEdge);
            }
        }
    }

    eventStack.pop();
    return eventNode;
}

interface ScopeContext {
    fromStack: string[];
    currentScopeName: string;
}

// 不区分大小写：tryMoveScope 保留文件里的作用域拼写，而文件可能写 FROM。只匹配小写形式会让
// 每个 FROM 调用解析成字面名字而不是触发它的事件。
const fromScopeRegex = /^from(?:\.from)*$/i;

// 文件实际用到的 FROM 链深度：`from` 为 1，`from.from` 为 2，没有任何调用写 FROM 时为 0。
// 只有栈顶这么多条能被读回，这正是把 visitNode 的节点身份限定住的前提。
function maxFromDepthOf(graph: EventNode[]): number {
    let depth = 0;
    const seen = new Set<EventNode | OptionNode>();

    const visit = (node: EventNode | OptionNode): void => {
        if (seen.has(node)) {
            return;
        }
        seen.add(node);

        for (const child of node.children) {
            if ("toNode" in child) {
                if (fromScopeRegex.test(child.toScope)) {
                    depth = Math.max(depth, child.toScope.split(".").length);
                }
                if (typeof child.toNode !== "string") {
                    visit(child.toNode);
                }
            } else {
                visit(child);
            }
        }
    };

    graph.forEach(visit);
    return depth;
}

function nextScope(scopeContext: ScopeContext, toScope: string): ScopeContext {
    let currentScopeName: string;
    if (fromScopeRegex.test(toScope)) {
        const fromCount = toScope.split(".").length;
        const fromIndex = scopeContext.fromStack.length - fromCount;
        if (fromIndex < 0) {
            currentScopeName =
                (scopeContext.fromStack.length > 0
                    ? (scopeContext.fromStack[0] ?? scopeContext.currentScopeName)
                    : scopeContext.currentScopeName) + repeat(".FROM", -fromIndex);
        } else {
            currentScopeName = scopeContext.fromStack[fromIndex] ?? scopeContext.currentScopeName;
        }
    } else {
        currentScopeName = toScope.replace(/\{event_target\}/g, scopeContext.currentScopeName);
    }

    return {
        fromStack: [...scopeContext.fromStack, scopeContext.currentScopeName],
        currentScopeName,
    };
}

//#region 可序列化载荷

interface BuildContext {
    nodes: EventGraphNode[];
    edges: EventGraphEdge[];
    loaderResult: EventsLoaderResult;
    styleTable: StyleTable;
    nextId: { value: number };
    // 见 maxFromDepthOf：限定参与节点身份的作用域栈深度。
    maxFromDepth: number;
    // 同一作用域情形下再次到达的事件是图里的同一个盒子，第二次到达直接连到已发出的盒子而不是
    // 再走一遍它的子树。
    //
    // 没有这条记忆，载荷是一棵树，交叉链接密集的文件会爆炸：每条额外路径都会复制它下面的一切。
    // （上游案例：588 个事件产出 94,951 个节点与 55 MB 载荷。）键里带上作用域才能保住真正重要的
    // 区分——同一事件在 OVERLORD 与 FROM 触发是两个盒子——同时折叠掉完全相同的重走。
    //
    // 键是当前作用域加上 FROM 栈顶 maxFromDepth 条，而不是只有当前作用域：两条路径可以带着不同
    // 的调用者到达同一作用域，而更深处的一条 `FROM` 调用要对着这些调用者解析。栈里比
    // maxFromDepth 更深的内容没有任何调用能读回，不进键就不会合并两个后续会不同的盒子——
    // 也让折叠保持有效，而整栈入键做不到。
    visited: Map<EventNode | OptionNode, Map<string, string>>;
    // 驻留的效果块，键是 schema 为每个选项构建一次的数组。同一选项在每种作用域情形下作为节点
    // 发出一次，因此节点按索引引用块而不是各自带副本。
    effectBlocks: EffectTreeNode[][];
    effectRefs: Map<EffectTreeNode[], number>;
}

function internEffects(effects: EffectTreeNode[], context: BuildContext): number | undefined {
    if (effects.length === 0) {
        return undefined;
    }

    const existing = context.effectRefs.get(effects);
    if (existing !== undefined) {
        return existing;
    }

    const index = context.effectBlocks.length;
    context.effectBlocks.push(effects);
    context.effectRefs.set(effects, index);
    return index;
}

export async function buildEventGraphPayload(
    graph: EventNode[],
    loaderResult: EventsLoaderResult,
    styleTable: StyleTable,
): Promise<EventGraphPayload> {
    const context: BuildContext = {
        nodes: [],
        edges: [],
        loaderResult,
        styleTable,
        nextId: { value: 0 },
        maxFromDepth: maxFromDepthOf(graph),
        visited: new Map(),
        effectBlocks: [],
        effectRefs: new Map(),
    };

    const roots: string[] = [];
    for (const eventNode of graph) {
        const scopeContext: ScopeContext = { fromStack: [], currentScopeName: "EVENT_TARGET" };
        roots.push(await visitNode(eventNode, scopeContext, context));
    }

    return {
        roots,
        nodes: context.nodes,
        edges: context.edges,
        conditionExprs: loaderResult.events.conditionExprs,
        toolbarFlags: toolbarFlagsOf(context.nodes, context.edges, context.effectBlocks),
        effectBlocks: context.effectBlocks,
    };
}

// 每个判定都是精确的：标记为 false 时，它控制的开关在两个位置产出相同输出，隐藏它不会拿走任何东西。
export function toolbarFlagsOf(
    nodes: EventGraphNode[],
    edges: EventGraphEdge[],
    effectBlocks: EffectTreeNode[][],
): EventToolbarFlags {
    return {
        // 每条非结构边都是一个选项（或即时、after 块）在调用事件，恰好是一条链节。
        hasChains: edges.some((e) => !e.structural),
        // 块按引用的节点驻留，表非空意味着至少一张卡片带圆点与悬停面板。
        hasEffects: effectBlocks.length > 0,
        // 过滤器只在文件里有事件匹配时才提供：过滤一个文件里没有的属性只会清空画布。
        hasHidden: nodes.some((n) => n.kind === "event" && n.hidden),
        hasMajor: nodes.some((n) => n.kind === "event" && n.major),
        hasNews: nodes.some((n) => n.kind === "event" && n.eventType === "news"),
        hasMtth: nodes.some((n) => n.kind === "event" && !n.isTriggeredOnly),
        hasTriggered: nodes.some((n) => n.kind === "event" && n.isTriggeredOnly),
        // 看的是设置而不是"有没有解析出内容"：索引开着时即使 .yml 还缺，这个开关也是真实的；
        // 按解析结果门控会让控件随本地化文件的编辑来回出现消失。
        hasLocalisation: !!localisationIndex,
        hasPicture: nodes.some((n) => n.kind === "event" && n.picture !== undefined),
    };
}

async function visitNode(
    node: EventNode | OptionNode | string,
    scopeContext: ScopeContext,
    context: BuildContext,
): Promise<string> {
    if (typeof node === "string") {
        const id = node + ":" + context.nextId.value++;
        context.nodes.push(await makeUnresolvedNode(id, node, scopeContext, context));
        return id;
    }

    const scopeKey = [
        ...scopeContext.fromStack.slice(scopeContext.fromStack.length - context.maxFromDepth),
        scopeContext.currentScopeName,
    ].join(">");
    const perScope = context.visited.get(node);
    const seen = perScope?.get(scopeKey);
    if (seen !== undefined) {
        return seen;
    }

    const id = nodeKey(node) + ":" + context.nextId.value++;
    // 先认领 id 再递归，循环会连回这个盒子而不是无限递归。eventToNode 已用 `loop` 克隆断环，
    // 但克隆是新对象、命不中这条记忆，所以守卫必须独立成立。
    if (perScope) {
        perScope.set(scopeKey, id);
    } else {
        context.visited.set(node, new Map([[scopeKey, id]]));
    }

    if ("event" in node) {
        context.nodes.push(await makeEventGraphNode(id, node, scopeContext, context));
    } else {
        context.nodes.push(await makeOptionGraphNode(id, node, context));
    }

    for (const child of node.children) {
        if ("toNode" in child) {
            const childId = await visitNode(child.toNode, nextScope(scopeContext, child.toScope), context);
            context.edges.push({
                from: id,
                to: childId,
                structural: false,
                source: child.source,
                scope: child.toScope,
                days: child.days,
                hours: child.hours,
                randomDays: child.randomDays,
                randomHours: child.randomHours,
                condition: child.condition,
                possibility: child.possibility,
            });
        } else {
            const childId = await visitNode(child, scopeContext, context);
            context.edges.push({
                from: id,
                to: childId,
                structural: true,
                source: "option",
                scope: "",
                days: 0,
                hours: 0,
                randomDays: 0,
                randomHours: 0,
                condition: true,
            });
        }
    }

    return id;
}

function nodeKey(node: EventNode | OptionNode | string): string {
    if (typeof node === "string") {
        return node;
    }
    return "event" in node ? node.event.id : node.optionName;
}

async function makeEventGraphNode(
    id: string,
    node: EventNode,
    scopeContext: ScopeContext,
    context: BuildContext,
): Promise<EventGraphEventNode> {
    const event = node.event;
    const picture = event.picture
        ? await getSpriteByGfxName(event.picture, context.loaderResult.gfxFiles)
        : undefined;

    return {
        id,
        kind: "event",
        eventId: event.id,
        eventType: event.type,
        scope: scopeContext.currentScopeName,
        title: await localise(event.title),
        major: event.major,
        hidden: event.hidden,
        fireOnlyOnce: event.fire_only_once,
        isTriggeredOnly: event.isTriggeredOnly,
        loop: node.loop,
        meanTimeToHappenBase: event.meanTimeToHappenBase,
        trigger: event.trigger,
        // immediate 与 after 块都没有自己的卡片——它们的调用挂在事件上——所以这里是它们的
        // 效果唯一能出现的地方。
        effectsRef: internEffects(event.immediate.effects, context),
        afterEffectsRef: internEffects(event.after.effects, context),
        nav: event.token
            ? { start: event.token.start, end: event.token.end, file: event.file }
            : undefined,
        picture: picture
            ? {
                    styleKey: context.styleTable.style(
                        "event-picture-" + normalizeForStyle(event.picture ?? "-empty"),
                        () => `
                            background-image: url(${picture.image.uri});
                            background-size: ${picture.image.width}px;
                            width: ${picture.image.width}px;
                            height: ${picture.image.height}px;
                        `,
                    ),
                    width: picture.image.width,
                }
            : undefined,
    };
}

async function makeOptionGraphNode(
    id: string,
    node: OptionNode,
    context: BuildContext,
): Promise<EventGraphOptionNode> {
    return {
        id,
        kind: "option",
        name: await localise(node.optionName),
        trigger: node.trigger,
        effectsRef: internEffects(node.effects, context),
        nav: node.token
            ? { start: node.token.start, end: node.token.end, file: node.file }
            : undefined,
    };
}

async function makeUnresolvedNode(
    id: string,
    eventId: string,
    scopeContext: ScopeContext,
    _context: BuildContext,
): Promise<EventGraphUnresolvedNode> {
    // 未解析的 id 本身不是本地化键，先试它、再试它的 `.t` 标题键；两者都解析不出时报空而不回显 id。
    let title: LocText | undefined = undefined;
    if (localisationIndex) {
        const direct = await getLocalisedTextQuick(eventId);
        if (direct && direct !== eventId) {
            title = { key: eventId, text: direct };
        } else {
            const titleKey = `${eventId}.t`;
            const viaTitle = await getLocalisedTextQuick(titleKey);
            if (viaTitle && viaTitle !== titleKey) {
                title = { key: titleKey, text: viaTitle };
            }
        }
    }

    return {
        id,
        kind: "unresolved",
        eventId,
        scope: scopeContext.currentScopeName,
        title,
    };
}

//#endregion
