import { Node, Token } from "../../hoiformat/hoiparser";
import { Raw, SchemaDef, convertNodeToJson, HOIPartial, isSymbolNode } from "../../hoiformat/schema";
import { nodeToString } from "../../hoiformat/tostring";
import { extractEffectValue, GuardedEffectItem, findGuardedEffectItems, projectEffects } from "../../hoiformat/effect";
import { ConditionComplexExpr, ConditionItem, conditionToString, extractConditionValue, extractConditionalExprs } from "../../hoiformat/condition";
import { Scope, ScopeType } from "../../hoiformat/scope";
import { EffectTreeNode } from "../sharedpayload";
import { uniqBy } from "lodash";

export interface HOIEvents {
    eventItemsByNamespace: Record<string, HOIEvent[]>;
    // 解析本文件时遇到的所有条件叶子（与焦点树、MIO 的收集方式一致），预览把它们作为可开关的
    // 表达式提供。
    conditionExprs: ConditionItem[];
}

export type HOIEventType = 'country' | 'state' | 'unit_leader' | 'news' | 'operative_leader';

export interface HOIEvent {
    type: HOIEventType;
    id: string;
    title: string;
    // 事件的 `desc = { ... }` 文本：可以是本地化键、字面字符串，或带 `text = ...` 的块。事件可以有
    // 多条（按国家等条件各写一条），这里保留全部，让卡片按原样列出。
    descriptions: string[];
    namespace: string;
    picture?: string;
    immediate: HOIEventOption;
    // `after = { ... }` 块：事件被关闭后（无论选了哪个选项，无选项的隐藏事件也一样）执行的内容。
    // 与 immediate 一样读取，因为它发起的调用同样延续事件链。
    after: HOIEventOption;
    options: HOIEventOption[];
    token: Token | undefined;
    major: boolean;
    hidden: boolean;
    isTriggeredOnly: boolean;
    meanTimeToHappenBase: number;
    fire_only_once: boolean;
    file: string;
    // 事件自身的 `trigger = { ... }` 门槛；未声明时为 true。
    trigger: ConditionComplexExpr;
}

export interface HOIEventOption {
    name?: string;
    childEvents: ChildEvent[];
    token: Token | undefined;
    // 选项的 `trigger = { ... }` 门槛：选项出现的条件；未声明时为 true。
    trigger: ConditionComplexExpr;
    // 选项的 `ai_chance = { ... }` 块原文；AI 选这个选项的权重。未声明时缺省。
    aiChance: string | undefined;
    // 选项所做的全部内容，供预览悬停展示（与子事件取自同一棵效果树，见 projectEffects）。
    effects: EffectTreeNode[];
}

export interface ChildEvent {
    scopeName: string;
    eventName: string;
    days: number;
    hours: number;
    randomDays: number;
    randomHours: number;
    // 这次调用的守卫条件（由外层每个 if / else_if / else 折叠而来）；无条件调用为 true。
    condition: ConditionComplexExpr;
    // 调用位于 random_list 分支时该分支的权重。
    possibility?: number;
}

interface EventFile {
    add_namespace: string[];
    country_event: EventDef[];
    news_event: EventDef[];
    state_event: EventDef[];
    unit_leader_event: EventDef[];
    operative_leader_event: EventDef[];
}

interface EventDef {
    id: string;
    title: string;
    picture: string;
    is_triggered_only: boolean;
    major: boolean;
    hidden: boolean;
    mean_time_to_happen: MeanTimeToHappen;
    fire_only_once: boolean;
    option: Raw[];
    immediate: Raw;
    after: Raw;
    trigger: Raw;
    desc: Raw[];
    _token: Token;
}

interface EventDescriptionDef {
    text: string;
}

interface MeanTimeToHappen {
    base: number;
    factor: number;
    days: number;
    months: number;
    years: number;
}

interface EventOptionDef {
    name: string;
    trigger: Raw;
    ai_chance: Raw;
    original_recipient_only: boolean;
    _token: Token;
}

interface EventEffectDef {
    id: string;
    days: number;
    hours: number;
    random: number;
    random_hours: number;
    random_days: number;
}

const eventOptionDefSchema: SchemaDef<EventOptionDef> = {
    name: "string",
    trigger: "raw",
    ai_chance: "raw",
    original_recipient_only: "boolean",
};

const eventDescriptionDefSchema: SchemaDef<EventDescriptionDef> = {
    text: "string",
};

const eventDefSchema: SchemaDef<EventDef> = {
    id: "string",
    title: "string",
    picture: "string",
    is_triggered_only: "boolean",
    major: "boolean",
    hidden: "boolean",
    fire_only_once: "boolean",
    mean_time_to_happen: {
        base: "number",
        factor: "number",
        days: "number",
        months: "number",
        years: "number",
    },
    option: {
        _innerType: "raw",
        _type: "array",
    },
    immediate: "raw",
    after: "raw",
    trigger: "raw",
    desc: {
        _innerType: "raw",
        _type: "array",
    },
};

const eventFileSchema: SchemaDef<EventFile> = {
    add_namespace: {
        _innerType: "string",
        _type: "array",
    },
    country_event: {
        _innerType: eventDefSchema,
        _type: "array",
    },
    news_event: {
        _innerType: eventDefSchema,
        _type: "array",
    },
    unit_leader_event: {
        _innerType: eventDefSchema,
        _type: "array",
    },
    state_event: {
        _innerType: eventDefSchema,
        _type: "array",
    },
    operative_leader_event: {
        _innerType: eventDefSchema,
        _type: "array",
    },
};

const eventEffectDefSchema: SchemaDef<EventEffectDef> = {
    id: "string",
    days: "number",
    hours: "number",
    random: "number",
    random_hours: "number",
    random_days: "number",
};

export function getEvents(node: Node, filePath: string): HOIEvents {
    const eventFile = convertNodeToJson<EventFile>(node, eventFileSchema);
    const eventItemsByNamespace: Record<string, HOIEvent[]> = {};
    for (const namespace of eventFile.add_namespace) {
        if (namespace) {
            eventItemsByNamespace[namespace] = [];
        }
    }

    const conditionExprs: ConditionItem[] = [];
    fillEvents(eventFile.country_event, 'country', filePath, eventItemsByNamespace, conditionExprs);
    fillEvents(eventFile.news_event, 'news', filePath, eventItemsByNamespace, conditionExprs);
    fillEvents(eventFile.state_event, 'state', filePath, eventItemsByNamespace, conditionExprs);
    fillEvents(eventFile.unit_leader_event, 'unit_leader', filePath, eventItemsByNamespace, conditionExprs);
    fillEvents(eventFile.operative_leader_event, 'operative_leader', filePath, eventItemsByNamespace, conditionExprs);

    return {
        eventItemsByNamespace,
        conditionExprs: uniqBy(conditionExprs, e => e.scopeName + '@' + e.nodeContent),
    };
}

function fillEvents(eventDefs: HOIPartial<EventDef>[], type: HOIEventType, filePath: string, eventItemsByNamespace: Record<string, HOIEvent[]>, conditionExprs: ConditionItem[]) {
    for (const eventDef of eventDefs) {
        const converted = convertEvent(eventDef, filePath, type, conditionExprs);
        if (converted) {
            const listOfNamespace = eventItemsByNamespace[converted.namespace];
            if (listOfNamespace) {
                listOfNamespace.push(converted);
            }
        }
    }
}

function eventTypeToScopeType(eventType: HOIEventType): ScopeType {
    switch (eventType) {
        case 'country':
        case 'news':
            return 'country';
        case 'state':
            return 'state';
        case 'unit_leader':
            return 'leader';
        case 'operative_leader':
            return 'operative';
        default:
            return 'unknown';
    }
}

function convertEvent<T extends HOIEventType>(eventDef: HOIPartial<EventDef>, file: string, type: T, conditionExprs: ConditionItem[]): HOIEvent & { type: T } | undefined {
    if (!eventDef.id) {
        return undefined;
    }

    const id = eventDef.id;
    const title = eventDef.title ?? (id + '.t');
    const namespace = id.split('.')[0];
    const picture = eventDef.picture;

    const scopeType = eventTypeToScopeType(type);
    const scope: Scope = { scopeName: `{event_target}`, scopeType };

    const trigger = eventDef.trigger ?
        extractConditionValue(eventDef.trigger._raw.value, scope, conditionExprs).condition :
        true;

    const immediate = convertOption(eventDef.immediate, scope, conditionExprs);
    const after = convertOption(eventDef.after, scope, conditionExprs);
    const options = eventDef.option.map(o => convertOption(o, scope, conditionExprs));

    const descriptions = eventDef.desc
        .filter((d): d is Raw => d !== undefined)
        .map(convertDescription)
        .filter((d): d is string => d !== undefined);

    const meanTimeToHappenBase = eventDef.mean_time_to_happen ?
        Math.floor(eventDef.mean_time_to_happen.factor ??
            eventDef.mean_time_to_happen.base ??
            eventDef.mean_time_to_happen.days ??
            (eventDef.mean_time_to_happen.months ? Math.floor(eventDef.mean_time_to_happen.months) * 30 : undefined) ??
            (eventDef.mean_time_to_happen.years ? Math.floor(eventDef.mean_time_to_happen.years) * 365 : undefined) ??
            1) :
        1;

    return {
        type,
        id,
        title,
        descriptions,
        namespace,
        picture,
        file,
        immediate,
        after,
        options,
        token: eventDef._token,
        major: !!eventDef.major,
        hidden: !!eventDef.hidden,
        isTriggeredOnly: !!eventDef.is_triggered_only,
        meanTimeToHappenBase,
        fire_only_once: !!eventDef.fire_only_once,
        trigger,
    };
}

// `desc` 写成三种形状之一：本地化键（符号）、字面字符串，或 `desc = { text = ... }` 块。三者
// 都归到一个字符串上；认不出的形状返回 undefined 而不是空串，以免把空描述混进列表。
function convertDescription(descriptionRaw: Raw): string | undefined {
    const descriptionNode = descriptionRaw._raw;
    if (isSymbolNode(descriptionNode.value)) {
        return descriptionNode.value.name;
    }
    if (typeof descriptionNode.value === "string") {
        return descriptionNode.value;
    }

    const descriptionDef = convertNodeToJson<EventDescriptionDef>(descriptionNode, eventDescriptionDefSchema);
    return descriptionDef.text;
}

function convertOption(optionRaw: Raw | undefined, scope: Scope, conditionExprs: ConditionItem[]): HOIEventOption {
    if (optionRaw === undefined) {
        return { childEvents: [], token: undefined, trigger: true, aiChance: undefined, effects: [] };
    }

    const optionDef = convertNodeToJson<EventOptionDef>(optionRaw._raw, eventOptionDefSchema);
    const name = optionDef.name;

    const trigger = optionDef.trigger ?
        extractConditionValue(optionDef.trigger._raw.value, scope, conditionExprs).condition :
        true;

    // 选项自己的键是元数据而不是效果：不排除它们，树里会把 name/trigger/ai_chance 和选项真正做的
    // 事并列。只在块顶层排除，那才是它们能出现的位置——效果里嵌套的 `trigger` 是另一个键，保留。
    const effect = extractEffectValue(optionRaw._raw.value, scope, optionOwnKeys);
    const childEventItems = findGuardedEffectItems(effect.effect, eventTypes);
    const childEvents = childEventItems
        .map(effectItemToChildEvent)
        .filter((e): e is ChildEvent => e !== undefined);
    // 两次调用同一事件只有在连线展示的全部内容都相同时才是同一条边：作用域、守卫条件、延迟与
    // random_list 权重。按全部键去重才能把 if/else_if 分支分开——这正是链条像工作流的原因——
    // 也不会让不同延迟的调用继承第一次调用的时间。
    const uniqueChildEvents = uniqBy(
        childEvents,
        e => [
            e.eventName,
            e.scopeName,
            conditionToString(e.condition),
            e.days,
            e.hours,
            e.randomDays,
            e.randomHours,
            e.possibility ?? '',
        ].join('@'),
    );

    for (const childEvent of uniqueChildEvents) {
        extractConditionalExprs(childEvent.condition, conditionExprs);
    }

    return {
        name,
        childEvents: uniqueChildEvents,
        token: optionDef._token,
        trigger,
        aiChance: optionDef.ai_chance ? nodeToString(optionDef.ai_chance._raw) : undefined,
        effects: projectEffects(effect.effect),
    };
}

const optionOwnKeys = ['name', 'trigger', 'ai_chance', 'original_recipient_only'];

const eventTypes = ['country_event', 'news_event', 'state_event', 'unit_leader_event', 'operative_leader_event'];

function effectItemToChildEvent(guarded: GuardedEffectItem): ChildEvent | undefined {
    const { item, condition, possibility } = guarded;
    const eventEffectDef = getEventEffectDef(item.node);
    if (!eventEffectDef) {
        return undefined;
    }

    return {
        scopeName: item.scopeName,
        eventName: eventEffectDef.id,
        days: eventEffectDef.days,
        hours: eventEffectDef.hours,
        randomDays: eventEffectDef.random_days,
        randomHours: eventEffectDef.random_hours === 0 ? eventEffectDef.random : eventEffectDef.random_hours,
        condition,
        possibility,
    };
}

function getEventEffectDef(node: Node): EventEffectDef | undefined {
    if (isSymbolNode(node.value)) {
        return { id: node.value.name, days: 0, hours: 0, random: 0, random_days: 0, random_hours: 0 };
    }

    if (typeof node.value === 'string') {
        return { id: node.value, days: 0, hours: 0, random: 0, random_days: 0, random_hours: 0 };
    }

    const callEventDef = convertNodeToJson<EventEffectDef>(node, eventEffectDefSchema);
    return callEventDef.id === undefined ? undefined : {
        id: callEventDef.id,
        days: callEventDef.days ?? 0,
        hours: callEventDef.hours ?? 0,
        random: callEventDef.random ?? 0,
        random_days: callEventDef.random_days ?? 0,
        random_hours: callEventDef.random_hours ?? 0,
    };
}
