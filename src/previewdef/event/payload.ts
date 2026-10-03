import { ConditionComplexExpr, ConditionItem } from "../../hoiformat/condition";
import { HOIEventType } from "./schema";

// 事件图的可序列化投影：宿主构建，网页端负责布局与渲染。
// 本模块被 webview bundle 引入，保持无运行时依赖——不引 vscode、图片缓存、本地化索引。

// LocText、NavTarget 与效果树与其他预览共享，定义在 sharedpayload.ts；在这里转出，让所有
// 本模块的使用方无需改动。
export {
    LocText,
    NavTarget,
    EffectLine,
    EffectGroup,
    EffectChoice,
    EffectTreeNode,
} from "../sharedpayload";
import { LocText, NavTarget, EffectTreeNode } from "../sharedpayload";

// 调用写在事件的哪个块里：`immediate` 与 `after` 是事件自己的两个效果块——一个在卡片显示前、
// 一个在关闭后——它们的调用挂在事件上；`option` 是玩家要选择才会发生的调用，挂在选项上。
export type EventCallSource = "immediate" | "after" | "option";

interface GraphNodeBase {
    id: string;
    nav?: NavTarget;
}

export interface EventGraphEventNode extends GraphNodeBase {
    kind: "event";
    eventId: string;
    eventType: HOIEventType;
    scope: string;
    title: LocText;
    major: boolean;
    hidden: boolean;
    fireOnlyOnce: boolean;
    isTriggeredOnly: boolean;
    loop: boolean;
    meanTimeToHappenBase: number;
    trigger: ConditionComplexExpr;
    picture?: { styleKey: string; width: number };
    // 事件的 `immediate` 块，作为 EventGraphPayload.effectBlocks 的下标；事件没有即时效果时缺省。
    effectsRef?: number;
    // 事件的 `after` 块，同样处理。两个块都没有自己的卡片，这是它们唯一能出现的地方。
    afterEffectsRef?: number;
}

export interface EventGraphOptionNode extends GraphNodeBase {
    kind: "option";
    name: LocText;
    trigger: ConditionComplexExpr;
    // 选项所做的事，作为 EventGraphPayload.effectBlocks 的下标；选项体只有名字与触发条件时缺省。
    effectsRef?: number;
}

// 对某个没有已加载文件定义的事件 id 的调用。
export interface EventGraphUnresolvedNode extends GraphNodeBase {
    kind: "unresolved";
    eventId: string;
    scope: string;
    title?: LocText;
}

export type EventGraphNode =
    | EventGraphEventNode
    | EventGraphOptionNode
    | EventGraphUnresolvedNode;

export interface EventGraphEdge {
    from: string;
    to: string;
    // 事件到它自己某个选项的边：没有作用域、延迟或条件——它是事件的结构而不是调用。
    structural: boolean;
    // 这次调用来自事件的哪个块。结构边通向选项卡片，因此带 `option`。
    source: EventCallSource;
    scope: string;
    days: number;
    hours: number;
    randomDays: number;
    randomHours: number;
    condition: ConditionComplexExpr;
    possibility?: number;
    // 被过滤器从 `from` 与 `to` 之间移除的事件。由网页端在围绕被过滤事件收缩图时合成，
    // 使链条保住箭头而不断成两截——宿主从不设置。
    skipped?: string[];
}

// 本文件实际能用到的工具栏控件。开关的标记为 false 时两个位置产出逐字节相同的输出，
// 网页端宁可隐藏它，也不提供一个预览兑现不了的控件。过滤器标记同理：文件里没有事件能匹配的
// 过滤器只会清空画布，其条目会从过滤列表里去掉。
//
// 这些随载荷传输而不是在宿主决定工具栏标记，因为工具栏属于烘焙好的外壳：随文件变化的标记
// 需要整页 HTML 重赋值才能应用，会把页面拆掉、每次翻转都丢失滚动与缩放。作为载荷字段，
// 它们通过初始脚本与每次就地更新同样到达页面，并且在被哈希的更新内，只有标记变化的更不会
// 被跳过。
export interface EventToolbarFlags {
    // 有某个选项（或即时块）调用另一个事件，因此存在可过滤的链。
    hasChains: boolean;
    hasEffects: boolean;
    // 存在隐藏事件。
    hasHidden: boolean;
    hasMajor: boolean;
    hasNews: boolean;
    // 有事件按自己的时钟触发，也有事件只在被效果调用时触发。两者互补，因此全是触发式事件的
    // 文件只提供后者。
    hasMtth: boolean;
    hasTriggered: boolean;
    // 本地化索引已开启。关闭时每个 LocText 的 text 等于 key，开关只是把字符串换成它自己。
    hasLocalisation: boolean;
    hasPicture: boolean;
}

export interface EventGraphPayload {
    roots: string[];
    nodes: EventGraphNode[];
    edges: EventGraphEdge[];
    conditionExprs: ConditionItem[];
    toolbarFlags: EventToolbarFlags;
    // 文件里每个不同的效果块，节点按索引引用而不是自带副本。同一个选项在每种作用域情形下都会
    // 作为节点发出一次，内联其效果会让它们随遍历次数倍增而不是随文件——正是 graph.ts 里
    // `visited` 记忆要防的膨胀。
    effectBlocks: EffectTreeNode[][];
}
