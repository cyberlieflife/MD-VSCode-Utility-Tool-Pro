import './setup';
import * as assert from 'assert';
import {
    chainedIds,
    chipTextFor,
    filteredGraph,
    matchesQuery,
    readFilters,
} from '../../../webviewsrc/eventtree';
import {
    EventGraphEdge,
    EventGraphEventNode,
    EventGraphNode,
    EventGraphOptionNode,
    EventGraphPayload,
} from '../../previewdef/event/payload';

// 事件图网页端的纯函数：过滤（含链的收缩保持）、搜索匹配、箭头标签与选择净化。载荷按最简
// 形状构造，只填被测函数读取的字段。

function eventNode(id: string, overrides: Partial<EventGraphEventNode> = {}): EventGraphEventNode {
    return {
        id,
        kind: 'event',
        eventId: id,
        eventType: 'country',
        scope: '{event_target}',
        title: { key: id + '.t', text: id + ' title' },
        descriptions: [],
        major: false,
        hidden: false,
        fireOnlyOnce: false,
        isTriggeredOnly: false,
        loop: false,
        meanTimeToHappenBase: 1,
        trigger: true,
        ...overrides,
    };
}

function optionNode(id: string): EventGraphOptionNode {
    return { id, kind: 'option', name: { key: id, text: id }, trigger: true };
}

function edge(from: string, to: string, overrides: Partial<EventGraphEdge> = {}): EventGraphEdge {
    return {
        from,
        to,
        structural: false,
        source: 'option',
        scope: '{event_target}',
        days: 0,
        hours: 0,
        randomDays: 0,
        randomHours: 0,
        condition: true,
        ...overrides,
    };
}

function structuralEdge(from: string, to: string): EventGraphEdge {
    return {
        from,
        to,
        structural: true,
        source: 'option',
        scope: '',
        days: 0,
        hours: 0,
        randomDays: 0,
        randomHours: 0,
        condition: true,
    };
}

function payloadOf(nodes: EventGraphNode[], edges: EventGraphEdge[], roots: string[]): EventGraphPayload {
    return {
        roots,
        nodes,
        edges,
        conditionExprs: [],
        toolbarFlags: {
            hasChains: true,
            hasEffects: false,
            hasHidden: true,
            hasMajor: false,
            hasNews: true,
            hasMtth: true,
            hasTriggered: true,
            hasLocalisation: false,
            hasPicture: false,
        },
        effectBlocks: [],
    };
}

// A（隐藏）--选项--> A.a --调用--> B（新闻）--选项--> B.b --调用--> C（隐藏）。
// 选 hidden 过滤器时 A 与 C 保留、B 被丢，链条应从 A.a 直连 C 并标注跨过了 B。
function chainPayload(): EventGraphPayload {
    return payloadOf(
        [
            eventNode('A', { hidden: true }),
            optionNode('A.a'),
            eventNode('B', { eventType: 'news' }),
            optionNode('B.b'),
            eventNode('C', { hidden: true }),
        ],
        [
            structuralEdge('A', 'A.a'),
            edge('A.a', 'B', { scope: 'OVERLORD', days: 3, randomDays: 2, condition: { scopeName: '', nodeContent: 'is_subject = yes' } }),
            structuralEdge('B', 'B.b'),
            edge('B.b', 'C', { hours: 5, condition: true }),
        ],
        ['A'],
    );
}

describe('webview/eventtree filteredGraph', () => {
    it('is not a filter at all when nothing is selected', () => {
        const payload = chainPayload();
        const graph = filteredGraph(payload, []);
        assert.strictEqual(graph.nodes, payload.nodes);
        assert.strictEqual(graph.edges, payload.edges);
        assert.strictEqual(graph.roots, payload.roots);
    });

    it('keeps only the events matching the one selected filter', () => {
        const graph = filteredGraph(chainPayload(), ['hidden']);
        const ids = graph.nodes.filter(n => n.kind === 'event').map(n => (n as EventGraphEventNode).eventId);
        assert.deepStrictEqual(ids, ['A', 'C']);
    });

    it('ors two filters together, so selecting more shows more', () => {
        const graph = filteredGraph(chainPayload(), ['hidden', 'news']);
        const ids = graph.nodes.filter(n => n.kind === 'event').map(n => (n as EventGraphEventNode).eventId);
        assert.deepStrictEqual(ids, ['A', 'B', 'C']);
    });

    it('keeps every choice of a kept event, dead ends included', () => {
        const graph = filteredGraph(chainPayload(), ['hidden']);
        assert.ok(graph.nodes.some(n => n.id === 'A.a'), 'the option of a kept event must stay');
    });

    it('does not mutate the payload it was given', () => {
        const payload = chainPayload();
        const before = payload.edges.length;
        filteredGraph(payload, ['hidden']);
        assert.strictEqual(payload.edges.length, before);
    });

    // 被丢掉的事件不是删除而是收缩：通往它的调用重定向到它最终到达的地方，并携带经过的 id。
    it('redirects the call over the dropped event rather than cutting the chain', () => {
        const graph = filteredGraph(chainPayload(), ['hidden']);
        const call = graph.edges.find(e => e.from === 'A.a' && !e.structural);
        assert.ok(call, 'the redirected call must exist');
        assert.strictEqual(call!.to, 'C');
        assert.deepStrictEqual(call!.skipped, ['B']);
    });

    it('keeps what the call was, so the delay and the guard are not invented anew', () => {
        const graph = filteredGraph(chainPayload(), ['hidden']);
        const call = graph.edges.find(e => e.from === 'A.a' && !e.structural)!;
        assert.strictEqual(call.scope, 'OVERLORD');
        assert.strictEqual(call.days, 3);
        assert.strictEqual(call.randomDays, 2);
        assert.deepStrictEqual(call.condition, { scopeName: '', nodeContent: 'is_subject = yes' });
    });

    it('gives an event whose only caller was dropped a root of its own', () => {
        const graph = filteredGraph(chainPayload(), ['news']);
        assert.ok(graph.roots.includes('B'), 'the kept event must be reachable');
    });
});

describe('webview/eventtree chainedIds', () => {
    // 事件 --结构边--> 选项 --调用边--> 事件 是两跳；选项那跳折叠到所属事件上。
    it('treats an event called by another event as part of a chain', () => {
        const payload = chainPayload();
        const linked = chainedIds(payload.nodes, payload.edges);
        assert.ok(linked.has('A'));
        assert.ok(linked.has('B'));
        assert.ok(linked.has('C'));
    });

    it('counts a call from the immediate block the same way', () => {
        const payload = payloadOf(
            [
                eventNode('A'),
                eventNode('B'),
            ],
            [edge('A', 'B', { source: 'immediate' })],
            ['A'],
        );
        const linked = chainedIds(payload.nodes, payload.edges);
        assert.ok(linked.has('A'));
        assert.ok(linked.has('B'));
    });

    it('does not treat a lone event as a chain', () => {
        const payload = payloadOf([eventNode('A'), eventNode('B')], [], ['A', 'B']);
        const linked = chainedIds(payload.nodes, payload.edges);
        assert.strictEqual(linked.size, 0);
    });

    // 未解析调用只会因某个选项调用它而存在，是要保留的跨文件链端。
    it('counts an unresolved call as a chain end', () => {
        const payload = payloadOf(
            [
                eventNode('A'),
                optionNode('A.a'),
                { id: 'missing:0', kind: 'unresolved', eventId: 'missing', scope: '{event_target}' } as EventGraphNode,
            ],
            [structuralEdge('A', 'A.a'), edge('A.a', 'missing:0')],
            ['A'],
        );
        const linked = chainedIds(payload.nodes, payload.edges);
        assert.ok(linked.has('A'));
        assert.ok(linked.has('missing:0'));
    });
});

describe('webview/eventtree matchesQuery', () => {
    // 查询由 SearchBox 统一小写后传入，字段在比较时小写化。
    it('matches the id and both title forms', () => {
        const node = eventNode('test.1');
        assert.ok(matchesQuery(node, 'test.1'));
        assert.ok(matchesQuery(node, 'test'));
        assert.ok(matchesQuery(node, 'title'));
        assert.ok(matchesQuery(node, '.t'));
        assert.ok(!matchesQuery(node, 'nope'));
    });

    it('never matches an option', () => {
        assert.ok(!matchesQuery(optionNode('test.1.a'), 'test.1.a'));
    });

    it('does not match on an empty query', () => {
        assert.ok(!matchesQuery(eventNode('test.1'), ''));
    });
});

describe('webview/eventtree readFilters', () => {
    it('reads nothing out of a state that has never held a selection', () => {
        assert.deepStrictEqual(readFilters(undefined), []);
        assert.deepStrictEqual(readFilters(null), []);
        assert.deepStrictEqual(readFilters('hidden'), []);
    });

    it('keeps only values that are filter names', () => {
        assert.deepStrictEqual(readFilters(['hidden', 'bogus', 3, 'news']), ['news', 'hidden']);
    });

    // 保存的选择不取决于读者碰巧勾选的先后。
    it('normalises the order to the list order', () => {
        assert.deepStrictEqual(readFilters(['hidden', 'news']), ['news', 'hidden']);
    });
});

describe('webview/eventtree chipTextFor', () => {
    it('is empty for a plain player call in the event scope', () => {
        assert.strictEqual(chipTextFor(edge('a', 'b'), false), '');
    });

    it('reports the scope, the delay and the random spread', () => {
        const text = chipTextFor(edge('a', 'b', { scope: 'OVERLORD', days: 3, randomDays: 2 }), false);
        assert.ok(text.includes('OVERLORD'));
        assert.ok(text.includes('3-5'));
    });

    it('falls back to hours when the call is measured in them', () => {
        const text = chipTextFor(edge('a', 'b', { hours: 5, randomHours: 1 }), false);
        assert.ok(text.includes('5-6'));
    });

    it('names the block a call the event makes itself came from', () => {
        assert.ok(chipTextFor(edge('a', 'b', { source: 'immediate' }), false).includes('immediate'));
        assert.ok(chipTextFor(edge('a', 'b', { source: 'after' }), false).includes('after'));
    });

    it('shows a random_list weight as written', () => {
        const text = chipTextFor(edge('a', 'b', { possibility: 3 }), false);
        assert.ok(text.includes('3'));
    });

    it('mentions the events a filter bridged over', () => {
        const text = chipTextFor(edge('a', 'b', { skipped: ['x', 'y'] }), false);
        assert.ok(text.includes('2'));
    });

    it('adds the condition only when the edge is shown as guarded', () => {
        const guarded = edge('a', 'b', { condition: { scopeName: '', nodeContent: 'is_subject = yes' } });
        assert.ok(!chipTextFor(guarded, false).includes('is_subject'));
        assert.ok(chipTextFor(guarded, true).includes('is_subject'));
    });
});

// 渲染路径用真实的就地更新消息（与宿主 updateBody 发出的形状相同）驱动，断言页面产物。
describe('webview/eventtree DOM rendering', () => {
    const toolbarHtml = [
        '<style id="event-server-styles"></style>',
        '<input type="checkbox" id="show-localisation">',
        '<input type="checkbox" id="show-option-triggers">',
        '<input type="checkbox" id="show-edge-conditions">',
        '<input type="checkbox" id="show-event-conditions">',
        '<input type="checkbox" id="show-picture">',
        '<input type="checkbox" id="show-effects">',
        '<div id="ev-filter-container"><div id="ev-filters" class="select multiple-select"><span class="value"></span></div></div>',
        '<input id="ev-searchbox" type="text"><span id="ev-search-count"></span>',
    ].join('');

    function render(payload: EventGraphPayload): HTMLElement {
        document.body.innerHTML = '<div id="eventtreecontent"></div>' + toolbarHtml;
        window.dispatchEvent(new MessageEvent('message', {
            data: { type: 'updateBody', styleCss: '', data: { eventGraph: payload } },
        }));
        return document.getElementById('eventtreecontent')!;
    }

    it('builds an event card with its id, glyphs and badges', () => {
        const content = render(payloadOf(
            [eventNode('test.1', { major: true, hidden: true, fireOnlyOnce: true })],
            [],
            ['test.1'],
        ));
        const card = content.querySelector('.ev-card-event') as HTMLElement;
        assert.ok(card, 'an event card must be built');
        assert.strictEqual(card.querySelector('.ev-id')!.textContent, 'test.1');
        assert.ok(card.querySelector('.ev-badge-major'), 'major badge');
        assert.ok(card.querySelector('.ev-badge-hidden'), 'hidden badge');
        assert.ok(card.querySelector('.ev-marker-major'), 'major glyph');
        assert.ok(card.querySelector('.ev-marker-mtth'), 'the mean-time glyph every event carries');
    });

    it('shows the event trigger as a panel only when the event declares one', () => {
        const withTrigger = render(payloadOf(
            [eventNode('test.1', { trigger: { scopeName: '', nodeContent: 'has_country_flag = gate' } })],
            [],
            ['test.1'],
        ));
        const panel = withTrigger.querySelector('.ev-cond') as HTMLElement;
        assert.ok(panel, 'expected a trigger panel');
        assert.ok(panel.textContent!.includes('has_country_flag = gate'));

        const withoutTrigger = render(payloadOf([eventNode('test.1')], [], ['test.1']));
        assert.strictEqual(withoutTrigger.querySelector('.ev-cond'), null);
    });

    it('marks a gated option with the gate class and its trigger panel', () => {
        const gatedOption: EventGraphOptionNode = {
            id: 'o1',
            kind: 'option',
            name: { key: 'test.1.a', text: 'The choice' },
            trigger: { scopeName: '', nodeContent: 'tag = FROM' },
        };
        const content = render(payloadOf(
            [eventNode('test.1'), gatedOption],
            [structuralEdge('test.1', 'o1')],
            ['test.1'],
        ));
        const card = content.querySelector('.ev-card-option') as HTMLElement;
        assert.ok(card, 'an option card must be built');
        assert.ok(card.classList.contains('ev-card-gated'), 'a gated option wears the gate class');
        assert.ok(card.querySelector('.ev-cond'), 'its trigger is shown');
    });

    it('renders a call to an undefined event as its own unresolved card', () => {
        const unresolved: EventGraphNode = { id: 'missing:0', kind: 'unresolved', eventId: 'test.missing', scope: '{event_target}' };
        const content = render(payloadOf(
            [eventNode('test.1'), unresolved],
            [edge('test.1', 'missing:0', { source: 'immediate' })],
            ['test.1'],
        ));
        const card = content.querySelector('.ev-card-unresolved') as HTMLElement;
        assert.ok(card, 'expected an unresolved card');
        assert.ok(card.textContent!.includes('test.missing'));
    });

    it('puts an effects dot on a card whose block has effects, and none on one that has not', () => {
        const withEffects = render(payloadOf([eventNode('test.1', { effectsRef: 0 })], [], ['test.1']));
        assert.ok(withEffects.querySelector('.ev-effects-dot'), 'expected the dot');

        const without = render(payloadOf([eventNode('test.1')], [], ['test.1']));
        assert.strictEqual(without.querySelector('.ev-effects-dot'), null);
    });

    it('makes every card a keyboard-reachable tab stop', () => {
        const content = render(payloadOf([eventNode('test.1')], [], ['test.1']));
        const card = content.querySelector('.ev-card-event') as HTMLElement;
        assert.strictEqual(card.tabIndex, 0);
    });
});
