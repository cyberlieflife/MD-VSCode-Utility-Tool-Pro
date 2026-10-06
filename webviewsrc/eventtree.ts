import {
    tryRun,
    subscribeNavigators,
    enableZoom,
    initCommon,
    getState,
    setState,
    panning$,
    currentScale,
} from "./util/common";
import { SearchBox } from "./util/searchbox";
import { applyNav, badge } from "./util/card";
import { FilterControl, gateToggle, readFilterList, toggleBinder } from "./util/toolbar";
import { feLocalize } from "./util/i18n";
import { wireUpdateBody } from "./util/updatebody";
import {
    EventGraphEdge,
    EventGraphEventNode,
    EventGraphNode,
    EventGraphOptionNode,
    EventGraphPayload,
    EventGraphUnresolvedNode,
    EventToolbarFlags,
} from "../src/previewdef/event/payload";
import { conditionToLabel, conditionPanel } from "./util/conditiontree";
import {
    EffectTooltipOptions,
    TooltipSection,
    clampBelowToolbar,
    wireEffectTooltip,
} from "./util/hovertooltip";
import {
    IsolationHandle,
    RenderedEdge,
    RenderedNode,
    renderGraph,
    wireIsolation,
} from "./util/graphview";

// 条件/效果渲染与图的布局与决议预览共享，住在 webviewsrc/util；本模块按需从那里 import。

initCommon();

// 每个悬停图片弹窗的标记（挂在 body 上、在 #eventtreecontent 之外），重渲染时用它清扫被中途
// 换掉宿主节点而悬空的弹窗。
const hoverPictureClass = "event-hover-picture";
// 效果面板同样处理。
const effectTooltipClass = "ev-effects-tip";

// 与 src/previewdef/event/contentbuilder.ts 的 toolbarHeight 对应（真正决定条带高度的是那边）。
// 改一处另一处必须跟上，否则下面的弹窗夹取与缩放偏移与工具栏真实的下沿不再一致。
const toolbarHeight = 52;

// 悬停弹窗挂在 <body> 上，位置按视口坐标手工摆放而不是由布局决定。工具栏条现在画在它们上面，
// 落在下面就直接看不见：这里让它们始终离开工具栏。
// 悬停图片与效果面板都挂在 <body>，与工具栏和窗口边缘保持同样的距离。
const popupMargin = 4;

const effectTooltipOptions: EffectTooltipOptions = {
    className: effectTooltipClass,
    toolbarHeight,
    gap: 8,
    margin: popupMargin,
};

const emptyPayload: EventGraphPayload = {
    roots: [],
    nodes: [],
    edges: [],
    conditionExprs: [],
    toolbarFlags: {
        hasChains: false,
        hasEffects: false,
        hasHidden: false,
        hasMajor: false,
        hasNews: false,
        hasMtth: false,
        hasTriggered: false,
        hasLocalisation: false,
        hasPicture: false,
    },
    effectBlocks: [],
};

let payload: EventGraphPayload = (window as any).eventGraph ?? emptyPayload;

let showLocalisation: boolean = getState().showLocalisation ?? true;
// 选项自己的 `trigger = { ... }` 门槛（画在卡片上）与走出它的箭头上的条件是两回事，因此是两个开关。
let showOptionTriggers: boolean = getState().showOptionTriggers ?? true;
let showEdgeConditions: boolean = getState().showEdgeConditions ?? true;
let showEventConditions: boolean = getState().showEventConditions ?? true;
let showPicture: boolean = getState().showPicture ?? true;
let showEffects: boolean = getState().showEffects ?? true;

//#region 过滤

export interface VisibleGraph {
    nodes: EventGraphNode[];
    edges: EventGraphEdge[];
    roots: string[];
}

// 工具栏过滤列表的条目。每个都回答"哪些事件属于画布"，所以是一个控件而不是一组复选框。
export type EventFilter = "mtth" | "triggered" | "news" | "hidden" | "major" | "chains";

// 列表的书写顺序，也是选择被保存与读回的次序，保存的选择不会取决于读者碰巧勾选的先后。
export const eventFilters: readonly EventFilter[] = [
    "mtth",
    "triggered",
    "news",
    "hidden",
    "major",
    "chains",
];

// 旧版本写下的状态（或什么都没写）到这里是任意值，凡不是过滤器名的都丢掉而不是带进判定。
export function readFilters(stored: unknown): EventFilter[] {
    return readFilterList(eventFilters, stored);
}

// 默认空：opt-in 过滤器绝不能在第一次打开预览时藏掉任何东西。
//
// 这个声明必须在 `eventFilters` 之后，不能与其他恢复的开关放在一起：`readFilters` 会提升但
// 它读的列表不会，提前调用会撞上 const 的暂时性死区、把整个模块（连同画布）带下去。测试编译成
// commonjs 时同样的读是属性访问、安静地得到 undefined，只有打包后的预览会暴露。
let filters: EventFilter[] = readFilters(getState().eventFilters);

// 同一选项在每种到达它的作用域情形下都会作为节点发出一次，因此可以有多个结构父节点。
// 当成单一 id 会静默丢掉链节。
function ownersOfOptions(edges: EventGraphEdge[]): Map<string, string[]> {
    const owners = new Map<string, string[]>();
    for (const edge of edges) {
        if (!edge.structural) {
            continue;
        }
        const list = owners.get(edge.to);
        if (list) {
            list.push(edge.from);
        } else {
            owners.set(edge.to, [edge.from]);
        }
    }
    return owners;
}

// 事件属于一条链，当它的某个选项调用了另一个事件，或另一个事件的选项调用了它。链接是两跳——
// 事件 --结构边--> 选项 --调用边--> 事件——因此先把选项那跳折叠到它所属的事件上再数两端。
// 事件自己的 `immediate` 或 `after` 块发起的调用是同一条链接、中间没有选项，同样计入。
export function chainedIds(nodes: EventGraphNode[], edges: EventGraphEdge[]): Set<string> {
    const byId = new Map(nodes.map((n) => [n.id, n]));
    // 不是选项的都算链的端点：事件，或对没有已加载文件定义的事件 id 的未解析调用——它存在
    // 只因某个选项调用了它，正是链视图要的跨文件链接。
    const isChainEnd = (id: string): boolean => byId.get(id)?.kind !== "option";
    const owners = ownersOfOptions(edges);

    const linked = new Set<string>();
    for (const edge of edges) {
        if (edge.structural || !byId.has(edge.from) || !isChainEnd(edge.to)) {
            continue;
        }
        const froms = isChainEnd(edge.from) ? [edge.from] : (owners.get(edge.from) ?? []);
        for (const from of froms) {
            // 自己调用自己的事件计入：箭头画在画布上，丢掉它唯一连接的卡片会让读者莫名。
            // 在这里守卫 `from !== edge.to` 才会要求两个不同事件。
            linked.add(from);
            linked.add(edge.to);
        }
    }

    return linked;
}

function matchesFilter(
    node: EventGraphEventNode,
    filter: EventFilter,
    linked: Set<string> | undefined,
): boolean {
    switch (filter) {
        // 完全没声明 mean_time_to_happen 的事件 meanTimeToHappenBase 也是 1，分不出两者；
        // `is_triggered_only` 能，而且正是卡片自己徽章画的那条线：事件要么等自己的时钟，要么等被调用。
        case "mtth":
            return !node.isTriggeredOnly;
        case "triggered":
            return node.isTriggeredOnly;
        case "news":
            return node.eventType === "news";
        case "hidden":
            return node.hidden;
        case "major":
            return node.major;
        case "chains":
            return linked?.has(node.id) ?? false;
    }
}

// 把图收窄到匹配任一选中过滤器的事件——OR，两个过滤器比一个显示更多，空选择不是过滤而是整个文件。
//
// 它绝不做的是把一条链切成两半：从链中间被丢掉的事件不是删除而是被收缩掉，通往它的调用被
// 重定向到它最终到达的地方，并携带经过的 id，使箭头能说明缺了什么。下游没有任何保留事件的
// 事件会失去箭头，因为没有什么可指。
export function filteredGraph(
    source: EventGraphPayload,
    filters: readonly EventFilter[],
): VisibleGraph {
    if (filters.length === 0) {
        return { nodes: source.nodes, edges: source.edges, roots: source.roots };
    }

    const linked = filters.includes("chains")
        ? chainedIds(source.nodes, source.edges)
        : undefined;

    // 未解析节点是对没有已加载文件定义的事件的调用：它没有自己的属性可过滤，只有在链的远端
    // 才能保留。
    const keptEvents = new Set<string>();
    for (const node of source.nodes) {
        if (node.kind === "event") {
            if (filters.some((filter) => matchesFilter(node, filter, linked))) {
                keptEvents.add(node.id);
            }
        } else if (node.kind === "unresolved" && linked?.has(node.id)) {
            keptEvents.add(node.id);
        }
    }

    // 选项属于它的事件、从不单独过滤：保留的事件保留它提供的每个选择，死胡同也算。
    const kept = new Set(keptEvents);
    for (const edge of source.edges) {
        if (edge.structural && keptEvents.has(edge.from)) {
            kept.add(edge.to);
        }
    }

    // 事件的调用落在哪里，选项那跳折叠掉，使下面的遍历一次走一个事件而不是在两类节点间交替。
    const owners = ownersOfOptions(source.edges);
    const callsOf = new Map<string, string[]>();
    for (const edge of source.edges) {
        if (edge.structural) {
            continue;
        }
        // 带 owner 的 id 是选项，调用属于它上面的事件；其余是事件自己发起的调用，
        // 即 `immediate` 或 `after` 块。
        const froms = owners.get(edge.from) ?? [edge.from];
        for (const from of froms) {
            const list = callsOf.get(from);
            if (list) {
                list.push(edge.to);
            } else {
                callsOf.set(from, [edge.to]);
            }
        }
    }

    // 广度优先：每个保留的事件都按最短的丢件路径到达，箭头上的计数是两者之间真正缺失的卡片数，
    // 而不是遍历误入的整个区域的大小。
    const bridgeCache = new Map<string, { to: string; skipped: string[] }[]>();
    const bridgesFrom = (start: string): { to: string; skipped: string[] }[] => {
        const cached = bridgeCache.get(start);
        if (cached) {
            return cached;
        }

        const bridges: { to: string; skipped: string[] }[] = [];
        const parent = new Map<string, string | undefined>([[start, undefined]]);
        const queue = [start];
        while (queue.length > 0) {
            const current = queue.shift();
            if (current === undefined) {
                continue;
            }
            for (const next of callsOf.get(current) ?? []) {
                if (parent.has(next)) {
                    continue;
                }
                parent.set(next, current);
                if (kept.has(next)) {
                    const skipped: string[] = [];
                    for (let at: string | undefined = current; at !== undefined; at = parent.get(at)) {
                        skipped.unshift(at);
                    }
                    bridges.push({ to: next, skipped });
                } else {
                    queue.push(next);
                }
            }
        }

        bridgeCache.set(start, bridges);
        return bridges;
    };

    const edges: EventGraphEdge[] = [];
    for (const edge of source.edges) {
        if (!kept.has(edge.from)) {
            continue;
        }
        if (kept.has(edge.to)) {
            edges.push(edge);
        } else if (!edge.structural) {
            for (const bridge of bridgesFrom(edge.to)) {
                edges.push({ ...edge, to: bridge.to, skipped: bridge.skipped });
            }
        }
    }

    const hasParent = new Set(edges.map((e) => e.to));
    // 幸存的声明根保持原有位次：正是它让一个纯环（没有任何无父成员）的组可达。其余因为唯一
    // 调用者被丢掉而失去父节点的追加在后面，否则纵向打包永远不会访问到它们。
    const roots = source.roots.filter((r) => kept.has(r));
    for (const node of source.nodes) {
        if (kept.has(node.id) && !hasParent.has(node.id) && !roots.includes(node.id)) {
            roots.push(node.id);
        }
    }

    return { nodes: source.nodes.filter((n) => kept.has(n.id)), edges, roots };
}

// 对标识一个事件的内容做不区分大小写的子串匹配：id，以及两种形式的标题。两种而不是本地化
// 开关恰好显示的那一种——开关决定画什么、不决定事件叫什么，只匹配显示形式会让同一个查询
// 视无关开关找到不同的卡片。索引关闭时两者相等，第二个字段是白送的。
//
// 选项刻意不可搜索：读者找的是事件。
export function matchesQuery(node: EventGraphNode, query: string): boolean {
    if (query === "" || node.kind === "option") {
        return false;
    }
    const title = node.title;
    return [node.eventId, title?.text ?? "", title?.key ?? ""].some((field) =>
        field.toLowerCase().includes(query),
    );
}

//#endregion

//#region 节点标记

// 卡片对过滤从它下面拿走的事件说了什么：它自己的箭头现在跨过的每个 id，按走过的次序。
// 按事件收集，某个事件三个选项都跨过同一张卡片时只提一次。
function skippedByEventOf(graph: VisibleGraph): Map<string, string[]> {
    const owners = ownersOfOptions(graph.edges);
    const byEvent = new Map<string, string[]>();
    for (const edge of graph.edges) {
        if (!edge.skipped?.length) {
            continue;
        }
        for (const from of owners.get(edge.from) ?? [edge.from]) {
            const list = byEvent.get(from) ?? [];
            for (const id of edge.skipped) {
                if (!list.includes(id)) {
                    list.push(id);
                }
            }
            byEvent.set(from, list);
        }
    }
    return byEvent;
}

// 事件实际属于的每种类型各一个字形，顺序固定，使每一行的读法一致、major 的新闻事件不必在
// 两者中挑选。每个形状在样式表里固定一种颜色，因此一张卡片上三个字形是三种颜色而不是一种——
// 这正是过去按作用域给整行上色做不到的。
function buildMarkers(node: EventGraphEventNode): HTMLDivElement {
    const markers = document.createElement("div");
    markers.className = "ev-markers";
    markers.title = node.eventType + "_event";

    const glyph = (className: string, title: string) => {
        const element = document.createElement("span");
        element.className = "ev-marker " + className;
        element.title = title;
        markers.appendChild(element);
    };

    if (node.eventType === "news") {
        glyph("ev-marker-news", feLocalize("eventtree.news", "News"));
    }
    if (node.major) {
        glyph("ev-marker-major", feLocalize("eventtree.major", "Major"));
    }
    if (node.hidden) {
        glyph("ev-marker-hidden", feLocalize("eventtree.hidden", "Hidden"));
    }
    // 每个事件非此即彼，这一行从不空。
    if (node.isTriggeredOnly) {
        glyph("ev-marker-triggered", feLocalize("eventtree.istriggeredonly", "Is triggered only"));
    } else {
        glyph("ev-marker-mtth", feLocalize("eventtree.mtth", "Mean time to happen"));
    }

    return markers;
}

function textFor(loc: { key: string; text: string }): string {
    return showLocalisation ? loc.text : loc.key;
}

// 卡片背后有效果面板的唯一提示。它是绝对定位的，因此有效果面板的卡片和没有的一样高——
// 布局依赖这一点，它按测出的高度预留空间。
function applyEffectsDot(card: HTMLDivElement, ...effectsRefs: (number | undefined)[]): void {
    if (!showEffects || effectsRefs.every((ref) => ref === undefined)) {
        return;
    }
    const dot = document.createElement("span");
    dot.className = "ev-effects-dot";
    card.appendChild(dot);
}

function buildEventCard(node: EventGraphEventNode): HTMLDivElement {
    const card = document.createElement("div");
    card.className = "ev-card ev-card-event" + (node.hidden ? " ev-card-hidden" : "");
    card.tabIndex = 0;
    applyNav(card, node.nav);

    if (node.picture) {
        card.classList.add("event-picture-host");
        card.setAttribute("picture-style-key", node.picture.styleKey);
        card.setAttribute("picture-width", String(node.picture.width));
    }

    const head = document.createElement("div");
    head.className = "ev-head";

    head.appendChild(buildMarkers(node));

    const text = document.createElement("div");
    text.className = "ev-text";
    const id = document.createElement("div");
    id.className = "ev-id";
    id.textContent = node.eventId;
    text.appendChild(id);
    const sub = document.createElement("div");
    sub.className = "ev-sub";
    sub.textContent = textFor(node.title);
    text.appendChild(sub);
    // The event's own `desc` text, one line per description block. It reads the same way the title
    // does: the localisation toggle swaps between the key and the resolved text.
    for (const description of node.descriptions) {
        const descLine = document.createElement("div");
        descLine.className = "ev-desc";
        descLine.textContent = textFor(description);
        text.appendChild(descLine);
    }
    head.appendChild(text);
    card.appendChild(head);

    const meta = document.createElement("div");
    meta.className = "ev-meta";
    if (node.major) {
        badge(meta, "ev-badge-major", feLocalize("eventtree.major", "Major"));
    }
    if (node.hidden) {
        badge(meta, "ev-badge-hidden", feLocalize("eventtree.hidden", "Hidden"));
    }
    if (node.fireOnlyOnce) {
        badge(meta, "", feLocalize("eventtree.fireonlyonce", "Fire only once"));
    }
    if (node.loop) {
        badge(meta, "ev-badge-loop", feLocalize("eventtree.loop", "Loop"));
    }
    const skipped = skippedByEvent.get(node.id);
    if (skipped?.length) {
        badge(meta, "ev-badge-skipped", feLocalize("eventtree.skipped", "{0} filtered out", skipped.length));
        const element = meta.lastElementChild as HTMLElement;
        element.title = feLocalize(
            "eventtree.skippedtitle",
            "Filtered out between this event and the next: {0}",
            skipped.join(", "),
        );
    }
    badge(
        meta,
        "",
        node.isTriggeredOnly
            ? feLocalize("eventtree.istriggeredonly", "Is triggered only")
            : `${node.meanTimeToHappenBase} ${feLocalize("days", "day(s)")}`,
    );
    // 字形行的颜色过去说事件在哪种作用域触发；现在说它是哪几种事件，因此作用域改为写出来。
    // country 事件占绝大多数、徽章会出现在几乎每张卡片上，所以只写其余类型。
    if (node.eventType !== "country") {
        badge(meta, "", node.eventType + "_event");
    }
    badge(meta, "", node.scope);
    card.appendChild(meta);

    if (showEventConditions && node.trigger !== true) {
        card.appendChild(conditionPanel(node.trigger, feLocalize("eventtree.eventtrigger", "Event trigger")));
    }

    applyEffectsDot(card, node.effectsRef, node.afterEffectsRef);
    return card;
}

function buildOptionCard(node: EventGraphOptionNode): HTMLDivElement {
    const gated = showOptionTriggers && node.trigger !== true;
    const card = document.createElement("div");
    card.className = "ev-card ev-card-option" + (gated ? " ev-card-gated" : "");
    card.tabIndex = 0;
    applyNav(card, node.nav);

    const head = document.createElement("div");
    head.className = "ev-head";

    const marker = document.createElement("span");
    marker.className = "ev-marker" + (gated ? " ev-marker-decision" : "");
    if (!gated) {
        marker.style.setProperty("--ev-dot", "var(--ev-border)");
    }
    head.appendChild(marker);

    const text = document.createElement("div");
    text.className = "ev-text";
    const id = document.createElement("div");
    id.className = "ev-id";
    id.textContent = node.name.key;
    text.appendChild(id);
    if (showLocalisation && node.name.text !== node.name.key) {
        const sub = document.createElement("div");
        sub.className = "ev-sub";
        sub.textContent = node.name.text;
        text.appendChild(sub);
    }
    head.appendChild(text);
    card.appendChild(head);

    if (gated) {
        card.appendChild(conditionPanel(node.trigger, feLocalize("eventtree.optiontrigger", "Option trigger")));
    }

    // The option's `ai_chance` block decides how likely the AI is to pick it. It is shown verbatim,
    // like the other script blocks, under the same "show effects" toggle that reveals script bodies.
    if (showEffects && node.aiChance) {
        const ai = document.createElement("div");
        ai.className = "ev-ai-chance";
        const aiHead = document.createElement("div");
        aiHead.className = "ev-ai-chance-head";
        aiHead.textContent = feLocalize("eventtree.aichance", "AI chance");
        const aiBody = document.createElement("pre");
        aiBody.className = "ev-ai-chance-body";
        aiBody.textContent = node.aiChance;
        ai.appendChild(aiHead);
        ai.appendChild(aiBody);
        card.appendChild(ai);
    }

    applyEffectsDot(card, node.effectsRef);
    return card;
}

function buildUnresolvedCard(node: EventGraphUnresolvedNode): HTMLDivElement {
    const card = document.createElement("div");
    card.className = "ev-card ev-card-event ev-card-unresolved";
    card.tabIndex = 0;

    const head = document.createElement("div");
    head.className = "ev-head";

    const marker = document.createElement("span");
    marker.className = "ev-marker";
    marker.style.setProperty("--ev-dot", "var(--ev-border)");
    marker.title = feLocalize("eventtree.unresolved", "Unresolved event");
    head.appendChild(marker);

    const text = document.createElement("div");
    text.className = "ev-text";
    const id = document.createElement("div");
    id.className = "ev-id";
    id.textContent = node.eventId;
    text.appendChild(id);
    if (node.title) {
        const sub = document.createElement("div");
        sub.className = "ev-sub";
        sub.textContent = textFor(node.title);
        text.appendChild(sub);
    }
    head.appendChild(text);
    card.appendChild(head);

    const meta = document.createElement("div");
    meta.className = "ev-meta";
    badge(meta, "ev-badge-hidden", feLocalize("eventtree.unresolved", "Unresolved event"));
    badge(meta, "", node.scope);
    card.appendChild(meta);

    return card;
}

function buildCard(node: EventGraphNode): HTMLDivElement {
    switch (node.kind) {
        case "event":
            return buildEventCard(node);
        case "option":
            return buildOptionCard(node);
        default:
            return buildUnresolvedCard(node);
    }
}

//#endregion

//#region 渲染

let rendered: RenderedNode<EventGraphNode>[] = [];
let renderedEdges: RenderedEdge<EventGraphEdge>[] = [];
let childrenById = new Map<string, string[]>();
// 每次重建都会替换，拖动始终恢复屏幕上实际的那张图。
let isolation: IsolationHandle | undefined = undefined;
// 由 buildContent 在卡片构建前填好，供 buildEventCard 读取。没有选中过滤器时为空，
// 因为没有东西被落下。
let skippedByEvent = new Map<string, string[]>();

function buildContent(): void {
    const content = document.getElementById("eventtreecontent") as HTMLDivElement | null;
    if (!content) {
        return;
    }

    document
        .querySelectorAll("." + hoverPictureClass + ", ." + effectTooltipClass)
        .forEach((el) => el.remove());
    content.textContent = "";
    rendered = [];
    renderedEdges = [];
    isolation = undefined;

    // 在过滤器之前：这个文件用不到的控件在这里被强制回到中性位，用不到的过滤器条目也不允许
    // 保存在存储的选择里。
    applyToolbarFlags();

    const graph = filteredGraph(payload, filters);
    // 卡片在下面构建、箭头在其后，所以每张卡片对下方缺失事件要说的话先从边收集好。
    skippedByEvent = skippedByEventOf(graph);
    if (graph.nodes.length === 0) {
        const empty = document.createElement("div");
        empty.className = "ev-empty";
        empty.textContent = feLocalize("eventtree.noevents", "No event chain to show for this file.");
        content.appendChild(empty);
        // 没有可高亮的，但计数器仍要停止声称上一刻那张图的匹配数。
        search.refresh(rendered);
        return;
    }

    ({ rendered, renderedEdges, childrenById } = renderGraph({
        content,
        nodes: graph.nodes,
        edges: graph.edges,
        roots: graph.roots,
        buildCard,
        chipGuarded,
        chipText: chipTextFor,
        edgeClass,
        railLabel: (step: number) => feLocalize("eventtree.step", "step {0}", step),
    }));

    isolation = wireIsolation(rendered, renderedEdges, childrenById);
    if (showPicture) {
        showPictureWhenHover();
    }
    if (showEffects) {
        wireEffectTooltips();
    }
    subscribeNavigators();
    // 查询在每次重建中延续——开关变化、就地更新、首次加载——高亮重新落到刚构建的卡片上。
    // 只翻类名，不做布局。
    search.refresh(rendered);
}

// 箭头旁边写的所有内容：触发作用域、延迟、random_list 权重与守卫它的条件。
export function chipTextFor(edge: EventGraphEdge, guarded: boolean): string {
    const bits: string[] = [];
    if (edge.scope && edge.scope !== "{event_target}") {
        bits.push(edge.scope);
    }
    if (edge.days) {
        bits.push(
            `${edge.randomDays ? `${edge.days}-${edge.days + edge.randomDays}` : edge.days} ${feLocalize("days", "day(s)")}`,
        );
    } else if (edge.hours) {
        bits.push(
            `${edge.randomHours ? `${edge.hours}-${edge.hours + edge.randomHours}` : edge.hours} ${feLocalize("hours", "hour(s)")}`,
        );
    }
    // 调用由事件的哪个块发起。玩家选项自身不发起任何东西，因此从选项卡片出来的箭头在这里不写。
    if (edge.source === "immediate") {
        bits.push(feLocalize("eventtree.immediate", "immediate"));
    } else if (edge.source === "after") {
        bits.push(feLocalize("eventtree.after", "after"));
    }
    if (edge.possibility !== undefined) {
        // random_list 的键是相对兄弟的权重而不是百分比：3 挨着 1 意味四分之三的概率。兄弟不在
        // 这条边上，分支修正也可能在运行时改变总数，因此权重按写法显示。
        bits.push(feLocalize("eventtree.weight", "weight {0}", edge.possibility));
    }
    if (edge.skipped?.length) {
        bits.push(feLocalize("eventtree.skipped", "{0} filtered out", edge.skipped.length));
    }
    if (guarded) {
        bits.push(conditionToLabel(edge.condition));
    }
    return bits.join(" · ");
}

function chipGuarded(edge: EventGraphEdge): boolean {
    return showEdgeConditions && edge.condition !== true;
}

function edgeClass(edge: EventGraphEdge, guarded: boolean): string {
    return (
        "ev-edge" +
        // 事件自己发起的（immediate 或 after 块）而不是等玩家选选项的调用：两者画同样的点线箭头。
        (edge.source !== "option" ? " ev-edge-immediate" : guarded ? " ev-edge-guarded" : "") +
        (edge.skipped?.length ? " ev-edge-bridged" : "")
    );
}

//#endregion

//#region 搜索

const search = new SearchBox<RenderedNode<EventGraphNode>>({
    boxId: "ev-searchbox",
    countId: "ev-search-count",
    stateKey: "eventSearchQuery",
    noMatchesKey: "eventtree.nomatches",
    countKey: "eventtree.searchmatches",
    matches: (item, query) => matchesQuery(item.node, query),
    target: (item) => ({ id: item.node.id, element: item.element, highlight: item.card }),
});

//#endregion

//#region 工具栏标记

// 标记为 false 的开关对这个文件改变不了任何东西，建在它输入框上的 codicon 控件被隐藏。控件是
// 输入框的下一个兄弟（Checkbox.init 用 input.after 插入），<label> 在构建控件时已被隐藏，
// 所以这里各是一个元素。
//
// 隐藏开关的存储状态被强制回什么都改变不了的位置。强制值刻意不写回 setState，读者自己的偏好
// 在文件重新有图片（或效果、本地化）时回来。过滤列表同样：文件里没有事件匹配的条目从列表与
// 作用中的选择里去掉，但从不从存储里去掉——存储的 `hidden` 在没有隐藏事件时会让画布清空，
// 而屏幕上没有任何控件能撤销它。
// 提供一个文件用不到的控件，比藏起一个它用得上的，失败小得多，所以完全不带标记的载荷回退到
// 全部显示。
const allToolbarControls: EventToolbarFlags = {
    hasChains: true,
    hasEffects: true,
    hasHidden: true,
    hasMajor: true,
    hasNews: true,
    hasMtth: true,
    hasTriggered: true,
    hasLocalisation: true,
    hasPicture: true,
};

const filterAvailability: Record<EventFilter, keyof EventToolbarFlags> = {
    mtth: "hasMtth",
    triggered: "hasTriggered",
    news: "hasNews",
    hidden: "hasHidden",
    major: "hasMajor",
    chains: "hasChains",
};

// 每个开关都重建画布，因此重建只绑定一次而不是每个调用点各绑一次。
const bindToggle = toggleBinder(buildContent);

// 拥有过滤控件与"选择是模块推入的还是读者选的"的守卫。
const filterControl = new FilterControl<EventFilter>({
    selectId: "ev-filters",
    containerId: "ev-filter-container",
    all: eventFilters,
    emptyKey: "eventtree.filterall",
    emptyText: "(All events)",
    onChange: (selection) => {
        filters = selection;
        setState({ eventFilters: filters });
        buildContent();
    },
});

function applyToolbarFlags(): void {
    const flags = payload.toolbarFlags ?? allToolbarControls;
    const state = getState();
    // 中性值显示最多的位置：没有东西可过滤时，"显示全部"才是诚实的状态。
    showLocalisation = gateToggle("show-localisation", flags.hasLocalisation, state.showLocalisation, true);
    showPicture = gateToggle("show-picture", flags.hasPicture, state.showPicture, true);
    showEffects = gateToggle("show-effects", flags.hasEffects, state.showEffects, true);
    filters = filterControl.gate(
        (filter) => flags[filterAvailability[filter]],
        readFilters(state.eventFilters),
    );
}

//#endregion

//#region 悬停图片

function showPictureWhenHover() {
    const eventNodes = document.getElementsByClassName(
        "event-picture-host",
    ) as HTMLCollectionOf<HTMLDivElement>;
    for (let i = 0; i < eventNodes.length; i++) {
        const eventNode = eventNodes.item(i);
        if (eventNode) {
            showPictureWhenHoverElement(eventNode);
        }
    }
}

function showPictureWhenHoverElement(eventNode: HTMLDivElement) {
    const pictureKey = eventNode.attributes.getNamedItem("picture-style-key")?.value;
    const pictureWidthStr = eventNode.attributes.getNamedItem("picture-width")?.value;
    if (!pictureKey || !pictureWidthStr) {
        return;
    }

    const pictureWidth = parseInt(pictureWidthStr);

    let hoverElement: HTMLDivElement | undefined = undefined;

    eventNode.addEventListener("mouseenter", () => {
        if (panning$.value) {
            return;
        }
        // getBoundingClientRect 已是缩放后的像素，而精灵样式不是，因此弹窗按它所属的卡片缩放，
        // 缩小时不会显得巨大。
        const scale = currentScale();
        const position = eventNode.getBoundingClientRect();
        hoverElement = document.createElement("div");
        hoverElement.className = pictureKey + " " + hoverPictureClass;
        hoverElement.style.position = "absolute";
        hoverElement.style.transform = `scale(${scale})`;
        hoverElement.style.transformOrigin = "top left";
        hoverElement.style.left =
            position.left + window.scrollX - (pictureWidth * scale - position.width) / 2 + "px";
        hoverElement.style.top =
            clampBelowToolbar(position.top + position.height, toolbarHeight, popupMargin) +
            window.scrollY +
            "px";
        document.body.append(hoverElement);
    });

    eventNode.addEventListener("mouseleave", () => {
        hoverElement?.remove();
    });
}

//#endregion

//#region 悬停效果

function effectSectionsOf(node: EventGraphNode): TooltipSection[] {
    if (node.kind === "unresolved") {
        return [];
    }

    const refs: { head: string; ref: number | undefined }[] =
        node.kind === "event"
            ? [
                    { head: feLocalize("eventtree.immediateeffects", "Immediate effects"), ref: node.effectsRef },
                    { head: feLocalize("eventtree.aftereffects", "After effects"), ref: node.afterEffectsRef },
                ]
            : [{ head: feLocalize("eventtree.effects", "Effects"), ref: node.effectsRef }];

    const sections: TooltipSection[] = [];
    for (const { head, ref } of refs) {
        const effects = ref === undefined ? undefined : payload.effectBlocks[ref];
        if (effects && effects.length > 0) {
            sections.push({ head, effects });
        }
    }
    return sections;
}

function wireEffectTooltips(): void {
    for (const item of rendered) {
        const sections = effectSectionsOf(item.node);
        if (sections.length > 0) {
            wireEffectTooltip(item.element, sections, effectTooltipOptions);
        }
    }
}

//#endregion

// 拖动起于空白画布，弹窗很少在那一刻开着——但指针去往背景途中离开的卡片可能还在淡出，且拖动层
// 在指针绕回图上时仍持有按下。清扫一次（与重渲染同样）保证画布被移动时没有东西悬在上面。
panning$.subscribe((panning) => {
    if (!panning) {
        return;
    }
    document
        .querySelectorAll("." + hoverPictureClass + ", ." + effectTooltipClass)
        .forEach((el) => el.remove());
    isolation?.clear();
});

wireUpdateBody<EventGraphPayload>({
    contentId: "eventtreecontent",
    styleId: "event-server-styles",
    dataKey: "eventGraph",
    apply: (next) => {
        payload = next;
    },
    rebuild: buildContent,
});

window.addEventListener(
    "load",
    tryRun(function () {
        const contentElement = document.getElementById("eventtreecontent") as HTMLDivElement | null;
        if (!contentElement) {
            return;
        }
        enableZoom(contentElement, 0, toolbarHeight);

        bindToggle("show-localisation", showLocalisation, (value) => {
            showLocalisation = value;
            setState({ showLocalisation: value });
        });
        bindToggle("show-option-triggers", showOptionTriggers, (value) => {
            showOptionTriggers = value;
            setState({ showOptionTriggers: value });
        });
        bindToggle("show-edge-conditions", showEdgeConditions, (value) => {
            showEdgeConditions = value;
            setState({ showEdgeConditions: value });
        });
        bindToggle("show-event-conditions", showEventConditions, (value) => {
            showEventConditions = value;
            setState({ showEventConditions: value });
        });
        bindToggle("show-picture", showPicture, (value) => {
            showPicture = value;
            setState({ showPicture: value });
        });
        bindToggle("show-effects", showEffects, (value) => {
            showEffects = value;
            setState({ showEffects: value });
        });
        filterControl.wire(filters);

        // 在第一次 buildContent 之前，使恢复的查询由首帧渲染应用而不是等到下一次。
        search.wire();

        buildContent();
    }),
);
