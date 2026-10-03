import * as assert from 'assert';
import * as vscode from 'vscode';
import { renderEventFile } from '../previewdef/event/contentbuilder';
import { hashHtml, serializeUpdate, renderedHtml, LoaderRenderResult } from '../previewdef/loaderpreview';
import { EffectTreeNode, EventGraphEventNode, EventGraphOptionNode, EventGraphPayload } from '../previewdef/event/payload';
import { conditionToString } from '../hoiformat/condition';
import { contextContainer } from '../context';

// renderEventFile 成功时返回就地更新的部件 { html, update }，错误分支返回纯 html 字符串。图在
// 网页端布局与渲染，因此更新载荷携带数据而不是标记。这些用例用桩加载器驱动它，断言返回形状、
// 相同输入的哈希稳定（LoaderPreview 的跳过依赖这条性质）以及触发条件与每次调用的条件抵达载荷。

const webview = { asWebviewUri: (u: unknown) => u, cspSource: '' } as unknown as vscode.Webview;
const uri = vscode.Uri.file('/tmp/events/test.txt');

// 更新部件的哈希，与 updateablepreview 的跳过判定同一条路径。
function hashUpdate(update: unknown): number {
    return hashHtml(serializeUpdate(update as never));
}

interface StubOption {
    name?: string;
    trigger?: unknown;
    childEvents?: unknown[];
    effects?: EffectTreeNode[];
}

interface StubEvent {
    id: string;
    options?: StubOption[];
    immediate?: StubOption;
    after?: StubOption;
    trigger?: unknown;
    hidden?: boolean;
    major?: boolean;
    isTriggeredOnly?: boolean;
    type?: string;
}

function makeOption(option: StubOption | undefined): any {
    return {
        name: option?.name,
        trigger: option?.trigger ?? true,
        childEvents: option?.childEvents ?? [],
        token: undefined,
        effects: option?.effects ?? [],
    };
}

function loaderFor(events: (string | StubEvent)[]): any {
    const items = events.map(entry => {
        const event: StubEvent = typeof entry === 'string' ? { id: entry } : entry;
        return {
            type: event.type ?? 'country',
            id: event.id,
            title: `${event.id}.t`,
            namespace: 'test',
            immediate: makeOption(event.immediate),
            after: makeOption(event.after),
            options: (event.options ?? []).map(makeOption),
            token: undefined,
            major: !!event.major,
            hidden: !!event.hidden,
            isTriggeredOnly: !!event.isTriggeredOnly,
            meanTimeToHappenBase: 0,
            fire_only_once: false,
            file: 'test.txt',
            trigger: event.trigger ?? true,
        };
    });
    return {
        load: async () => ({
            result: {
                events: { eventItemsByNamespace: { test: items }, conditionExprs: [] },
                mainNamespaces: ['test'],
                gfxFiles: [],
            },
        }),
    };
}

function payloadOf(rendered: LoaderRenderResult): EventGraphPayload {
    return (rendered.update!.data as { eventGraph: EventGraphPayload }).eventGraph;
}

// 渲染 html 里某个 id 元素上的类名列表。
function classOf(html: string, id: string): string {
    const m = html.match(new RegExp(`id="${id}"[^>]*?class="([^"]*)"`));
    assert.ok(m, `expected an element with id="${id}"`);
    return m![1].trim();
}

describe('previewdef/event renderEventFile in-place update', () => {
    it('returns { html, update } carrying the event graph payload', async () => {
        const rendered = await renderEventFile(loaderFor(['test.1']), uri, webview) as LoaderRenderResult;
        assert.strictEqual(typeof rendered, 'object');
        assert.strictEqual(typeof rendered.html, 'function');
        assert.ok(rendered.update);
        assert.strictEqual(typeof rendered.update.styleCss, 'string');

        const graph = payloadOf(rendered);
        assert.strictEqual(graph.roots.length, 1);
        assert.strictEqual(graph.nodes.length, 1);
        const node = graph.nodes[0] as EventGraphEventNode;
        assert.strictEqual(node.kind, 'event');
        assert.strictEqual(node.eventId, 'test.1');
    });

    it('hashUpdate is stable for identical input, even though the full html nonces differ', async () => {
        const a = await renderEventFile(loaderFor(['test.1']), uri, webview) as LoaderRenderResult;
        const b = await renderEventFile(loaderFor(['test.1']), uri, webview) as LoaderRenderResult;
        // 整页 html 每次渲染带新的 CSP nonce，永远哈希不相等；更新部件必须逐字节相同，
        // 空操作编辑才能被跳过。
        assert.notStrictEqual(renderedHtml(a), renderedHtml(b));
        assert.strictEqual(hashUpdate(a.update!), hashUpdate(b.update!));
    });

    it('hashUpdate differs when the input changed', async () => {
        const a = await renderEventFile(loaderFor(['test.1']), uri, webview) as LoaderRenderResult;
        const c = await renderEventFile(loaderFor(['test.2']), uri, webview) as LoaderRenderResult;
        assert.notStrictEqual(hashUpdate(a.update!), hashUpdate(c.update!));
    });

    it('keeps the shell class names stable across renders so an in-place update never strands them', async () => {
        const one = await renderEventFile(loaderFor(['test.1']), uri, webview) as LoaderRenderResult;
        const two = await renderEventFile(loaderFor(['test.1', 'test.2']), uri, webview) as LoaderRenderResult;

        const draggerOne = classOf(renderedHtml(one), 'dragger');
        const contentOne = classOf(renderedHtml(one), 'eventtreecontent');
        assert.strictEqual(draggerOne, 'st-dragger');
        assert.strictEqual(contentOne, 'st-eventtreecontent');
        assert.strictEqual(classOf(renderedHtml(two), 'dragger'), draggerOne);
        assert.strictEqual(classOf(renderedHtml(two), 'eventtreecontent'), contentOne);

        const styleCss = two.update!.styleCss!;
        assert.ok(styleCss.includes(`.${draggerOne} {`));
        assert.ok(styleCss.includes(`.${contentOne} {`));
    });

    it('writes the shell in the order the layers stack', async () => {
        // 真正让工具栏在最上的是 eventtree.css 里的 --ev-layer-* 层级；文档顺序不再决定它。
        // 保留这条用例使外壳仍按从底到顶书写。
        const html = renderedHtml(await renderEventFile(loaderFor(['test.1']), uri, webview) as LoaderRenderResult);
        const dragger = html.indexOf('id="dragger"');
        const toolbar = html.indexOf('class="toolbar-outer');
        assert.ok(dragger > 0 && toolbar > 0, 'both must be rendered');
        assert.ok(dragger < toolbar, 'the drag layer must come first');
    });

    // 每个文件都渲染全部控件。实际显示哪些由网页端按 payload.toolbarFlags 决定，因此标记不随
    // 文件变化，就地更新永远不必重赋外壳来改工具栏。
    it('renders the search box, every toggle and the filter list into the toolbar', async () => {
        const rendered = await renderEventFile(loaderFor(['test.1']), uri, webview) as LoaderRenderResult;
        for (const id of ['show-localisation', 'show-option-triggers', 'show-edge-conditions',
            'show-event-conditions', 'show-picture', 'show-effects']) {
            assert.ok(renderedHtml(rendered).includes(`id="${id}"`), `expected a toggle with id="${id}"`);
        }
        assert.ok(renderedHtml(rendered).includes('id="ev-searchbox"'), 'the search box must be rendered');
        assert.ok(renderedHtml(rendered).includes('id="ev-search-count"'), 'the match counter must be rendered');
        assert.ok(renderedHtml(rendered).includes('class="toolbar-outer'));
    });

    it('writes out every filter entry, for the webview to gate', async () => {
        const rendered = await renderEventFile(loaderFor(['test.1']), uri, webview) as LoaderRenderResult;
        assert.ok(renderedHtml(rendered).includes('id="ev-filters"'), 'the filter list must be rendered');
        for (const value of ['mtth', 'triggered', 'news', 'hidden', 'major', 'chains']) {
            assert.ok(
                renderedHtml(rendered).includes(`class="option" value="${value}"`),
                `expected a filter entry for ${value}`,
            );
        }
    });

    // 字形挂在属性上是因为下拉用 textContent 拉平选项，div 里的标记会被丢掉、只把类名留在标题上。
    it('carries each filter glyph on the entry, so the list shows what the cards show', async () => {
        const html = renderedHtml(await renderEventFile(loaderFor(['test.1']), uri, webview) as LoaderRenderResult);
        for (const kind of ['mtth', 'triggered', 'news', 'hidden', 'major']) {
            assert.ok(
                html.includes(`data-glyph="ev-marker ev-marker-${kind}"`),
                `expected the ${kind} filter to carry its glyph`,
            );
        }
        // 卡片上没有东西代表链，因此该条目只占住列、不画任何东西。
        assert.ok(html.includes('value="chains" data-glyph=""'), 'event chains must reserve a blank cell');
    });

    it('puts the search box before the toggles, where a narrow pane cannot scroll it away', async () => {
        const html = renderedHtml(await renderEventFile(loaderFor(['test.1']), uri, webview) as LoaderRenderResult);
        assert.ok(html.indexOf('id="ev-searchbox"') < html.indexOf('id="show-localisation"'));
    });

    it('loads common.css so the toolbar and its checkboxes are styled', async () => {
        // html() 只在安装了扩展上下文时才把样式表名解析成 URI，所以给它一个——否则每个
        // <link href> 都是空的，断言形同虚设。
        const previous = contextContainer.current;
        contextContainer.current = { extensionUri: vscode.Uri.file('/ext') } as any;
        try {
            const rendered = await renderEventFile(loaderFor(['test.1']), uri, webview) as LoaderRenderResult;
            assert.ok(renderedHtml(rendered).includes('common.css'), 'the shared widget stylesheet must be loaded');
            assert.ok(renderedHtml(rendered).includes('eventtree.css'), 'the workflow stylesheet must be loaded');
            assert.ok(renderedHtml(rendered).includes('codicon.css'));
        } finally {
            contextContainer.current = previous;
        }
    });

    it('exposes the graph to the webview as window.eventGraph', async () => {
        const rendered = await renderEventFile(loaderFor(['test.1']), uri, webview) as LoaderRenderResult;
        assert.ok(renderedHtml(rendered).includes('window.eventGraph = '));
    });

    it('escapes a payload string that would otherwise end the inline script', async () => {
        // 载荷携带直接来自工作区的文本。HTML 解析器在第一个 `</script` 结束脚本，无论它周围的
        // JavaScript 是什么意思。
        const rendered = await renderEventFile(
            loaderFor(['test.</script><img src=x>']),
            uri,
            webview,
        ) as LoaderRenderResult;

        const script = renderedHtml(rendered).match(/window\.eventGraph = (.*?);<\/script>/);
        assert.ok(script, 'expected the payload script');
        assert.ok(!script![1]!.includes('</script'), script![1]!);
        const parsed = JSON.parse(script![1]!) as EventGraphPayload;
        const ids = parsed.nodes.filter(n => n.kind === 'event').map(n => (n as EventGraphEventNode).eventId);
        assert.ok(ids.includes('test.</script><img src=x>'), ids.join(','));
    });

    it('carries the option trigger and the per-call condition into the payload', async () => {
        const optionTrigger = { scopeName: '', nodeContent: 'tag = FROM' };
        const callCondition = { scopeName: '', nodeContent: 'is_subject = yes' };
        const rendered = await renderEventFile(loaderFor([
            {
                id: 'test.1',
                trigger: { scopeName: '', nodeContent: 'has_country_flag = gate' },
                options: [{
                    name: 'test.1.a',
                    trigger: optionTrigger,
                    childEvents: [{
                        scopeName: 'OVERLORD',
                        eventName: 'test.2',
                        days: 1,
                        hours: 0,
                        randomDays: 0,
                        randomHours: 0,
                        condition: callCondition,
                    }],
                }],
            },
            'test.2',
        ]), uri, webview) as LoaderRenderResult;

        const graph = payloadOf(rendered);

        const event = graph.nodes.find(n => n.kind === 'event' && n.eventId === 'test.1') as EventGraphEventNode;
        assert.ok(event);
        assert.strictEqual(conditionToString(event.trigger), 'has_country_flag = gate');

        const option = graph.nodes.find(n => n.kind === 'option') as EventGraphOptionNode;
        assert.ok(option, 'expected an option node');
        assert.strictEqual(conditionToString(option.trigger), 'tag = FROM');

        // 事件 -> 选项是结构边；选项 -> 事件是带守卫的调用。
        const structural = graph.edges.filter(e => e.structural);
        const calls = graph.edges.filter(e => !e.structural);
        assert.strictEqual(structural.length, 1);
        assert.strictEqual(calls.length, 1);
        assert.strictEqual(calls[0]!.scope, 'OVERLORD');
        assert.strictEqual(calls[0]!.days, 1);
        assert.strictEqual(conditionToString(calls[0]!.condition), 'is_subject = yes');
    });

    it('marks an immediate call so the hidden toggle can filter it', async () => {
        const rendered = await renderEventFile(loaderFor([
            {
                id: 'test.1',
                hidden: true,
                immediate: {
                    childEvents: [{
                        scopeName: '{event_target}',
                        eventName: 'test.2',
                        days: 30,
                        hours: 0,
                        randomDays: 0,
                        randomHours: 0,
                        condition: true,
                    }],
                },
            },
            'test.2',
        ]), uri, webview) as LoaderRenderResult;

        const graph = payloadOf(rendered);
        const call = graph.edges.find(e => !e.structural);
        assert.ok(call);
        assert.strictEqual(call!.source, 'immediate');
        assert.strictEqual(call!.days, 30);

        const event = graph.nodes.find(n => n.kind === 'event' && n.eventId === 'test.1') as EventGraphEventNode;
        assert.strictEqual(event.hidden, true);
    });

    it('follows the chain on through a call made from the after block', async () => {
        const rendered = await renderEventFile(loaderFor([
            {
                id: 'test.1',
                options: [{ name: 'test.1.a' }],
                after: {
                    childEvents: [{
                        scopeName: 'ANQ',
                        eventName: 'test.2',
                        days: 0,
                        hours: 5,
                        randomDays: 0,
                        randomHours: 0,
                        condition: true,
                    }],
                },
            },
            'test.2',
        ]), uri, webview) as LoaderRenderResult;

        const graph = payloadOf(rendered);
        const event = graph.nodes.find(n => n.kind === 'event' && n.eventId === 'test.1') as EventGraphEventNode;
        const target = graph.nodes.find(n => n.kind === 'event' && n.eventId === 'test.2') as EventGraphEventNode;
        assert.ok(event && target);

        const call = graph.edges.find(e => !e.structural);
        assert.ok(call, 'expected the after call to reach the payload');
        assert.strictEqual(call!.source, 'after');
        assert.strictEqual(call!.scope, 'ANQ');
        assert.strictEqual(call!.hours, 5);
        // 从事件本身出发而不是选项：after 块无论选了哪个选项都会执行。
        assert.strictEqual(call!.from, event.id);
        assert.strictEqual(call!.to, target.id);
    });

    it('keeps the after block effects apart from the immediate ones', async () => {
        const rendered = await renderEventFile(loaderFor([
            {
                id: 'test.1',
                immediate: { effects: [{ kind: 'line', scopeName: '', content: 'set_country_flag = a' }] },
                after: { effects: [{ kind: 'line', scopeName: '', content: 'swap_ideas = { }' }] },
            },
        ]), uri, webview) as LoaderRenderResult;

        const graph = payloadOf(rendered);
        const event = graph.nodes.find(n => n.kind === 'event') as EventGraphEventNode;
        assert.ok(event.effectsRef !== undefined && event.afterEffectsRef !== undefined);
        assert.notStrictEqual(event.effectsRef, event.afterEffectsRef);
        assert.deepStrictEqual(
            graph.effectBlocks[event.afterEffectsRef!],
            [{ kind: 'line', scopeName: '', content: 'swap_ideas = { }' }],
        );
    });

    it('reports a call to an undefined event id as an unresolved node', async () => {
        const rendered = await renderEventFile(loaderFor([
            {
                id: 'test.1',
                options: [{
                    name: 'test.1.a',
                    childEvents: [{
                        scopeName: '{event_target}',
                        eventName: 'test.missing',
                        days: 0,
                        hours: 0,
                        randomDays: 0,
                        randomHours: 0,
                        condition: true,
                    }],
                }],
            },
        ]), uri, webview) as LoaderRenderResult;

        const graph = payloadOf(rendered);
        const unresolved = graph.nodes.find(n => n.kind === 'unresolved');
        assert.ok(unresolved, 'expected an unresolved node');
        assert.strictEqual((unresolved as { eventId: string }).eventId, 'test.missing');
    });

    // 值得提供哪些工具栏控件随载荷传输而不是决定标记，因此它的变化通过普通就地更新应用。
    describe('toolbar flags', () => {
        const call = (eventName: string) => ({
            scopeName: '{event_target}', eventName, days: 0, hours: 0, randomDays: 0, randomHours: 0,
            condition: true,
        });

        const flagsFor = async (events: (string | StubEvent)[]) =>
            payloadOf(await renderEventFile(loaderFor(events), uri, webview) as LoaderRenderResult).toolbarFlags;

        it('offers nothing but the mean time for a file of plain unconnected events', async () => {
            assert.deepStrictEqual(await flagsFor(['test.1', 'test.2']), {
                hasChains: false,
                hasEffects: false,
                hasHidden: false,
                hasMajor: false,
                hasNews: false,
                // 两个事件都不是触发式，都等自己的时钟。
                hasMtth: true,
                hasTriggered: false,
                // 测试环境里本地化索引是关的。
                hasLocalisation: false,
                hasPicture: false,
            });
        });

        it('reports major, news and triggered only from the events that are one', async () => {
            assert.strictEqual((await flagsFor([{ id: 'test.1', major: true }])).hasMajor, true);
            assert.strictEqual((await flagsFor([{ id: 'test.1', type: 'news' }])).hasNews, true);
            assert.strictEqual(
                (await flagsFor([{ id: 'test.1', isTriggeredOnly: true }])).hasTriggered, true);
        });

        it('splits a file between the two ways an event can fire', async () => {
            const flags = await flagsFor([
                { id: 'test.1', isTriggeredOnly: true },
                { id: 'test.2' },
            ]);
            assert.strictEqual(flags.hasMtth, true);
            assert.strictEqual(flags.hasTriggered, true);

            const triggeredOnly = await flagsFor([{ id: 'test.1', isTriggeredOnly: true }]);
            assert.strictEqual(triggeredOnly.hasMtth, false);
        });

        it('reports a chain as soon as one option calls another event', async () => {
            const flags = await flagsFor([
                { id: 'test.1', options: [{ name: 'test.1.a', childEvents: [call('test.2')] }] },
                'test.2',
            ]);
            assert.strictEqual(flags.hasChains, true);
        });

        it('reports a chain for an immediate call with no option in between', async () => {
            const flags = await flagsFor([
                { id: 'test.1', immediate: { childEvents: [call('test.2')] } },
                'test.2',
            ]);
            assert.strictEqual(flags.hasChains, true);
        });

        it('reports a chain for a call the after block makes', async () => {
            const flags = await flagsFor([
                { id: 'test.1', after: { childEvents: [call('test.2')] } },
                'test.2',
            ]);
            assert.strictEqual(flags.hasChains, true);
        });

        // 即时调用不再计入：过滤列表表达的是"只看"，已没有抑制即时箭头的机制，只有隐藏事件能被
        // 筛到。
        it('reports hidden for a hidden event, and for nothing else', async () => {
            assert.strictEqual((await flagsFor([{ id: 'test.1', hidden: true }])).hasHidden, true);
            assert.strictEqual((await flagsFor([
                { id: 'test.1', immediate: { childEvents: [call('test.2')] } },
                'test.2',
            ])).hasHidden, false);
        });

        it('reports effects only when something actually has any', async () => {
            const flags = await flagsFor([{
                id: 'test.1',
                options: [{
                    name: 'test.1.a',
                    effects: [{ kind: 'line', scopeName: '', content: 'add_political_power = 50' }],
                }],
            }]);
            assert.strictEqual(flags.hasEffects, true);
        });

        it('changes the hashed update, so a flags-only change is never skipped', async () => {
            const plain = await renderEventFile(loaderFor(['test.1']), uri, webview) as LoaderRenderResult;
            const hidden = await renderEventFile(
                loaderFor([{ id: 'test.1', hidden: true }]), uri, webview) as LoaderRenderResult;
            assert.notStrictEqual(hashUpdate(plain.update!), hashUpdate(hidden.update!));
        });
    });

    it('emits one node per event reached twice under the same scope, and links both callers to it', async () => {
        // 没有这条，载荷是一棵树，每条额外路径都会复制它下面的整棵子树；上游案例里 588 个事件
        // 产出 94,951 个节点。
        const call = (eventName: string, scopeName: string) => ({
            scopeName, eventName, days: 0, hours: 0, randomDays: 0, randomHours: 0, condition: true,
        });
        const rendered = await renderEventFile(loaderFor([
            {
                id: 'test.1',
                options: [
                    { name: 'test.1.a', childEvents: [call('test.shared', '{event_target}')] },
                    { name: 'test.1.b', childEvents: [call('test.shared', '{event_target}')] },
                ],
            },
            { id: 'test.shared', options: [{ name: 'test.shared.a' }] },
        ]), uri, webview) as LoaderRenderResult;

        const graph = payloadOf(rendered);
        const shared = graph.nodes.filter(n => n.kind === 'event' && n.eventId === 'test.shared');
        assert.strictEqual(shared.length, 1, 'the shared event must be emitted once');

        // 它的选项也只发出一次，而不是每条进入路径一次。
        assert.strictEqual(graph.nodes.filter(n => n.kind === 'option' && n.name.key === 'test.shared.a').length, 1);

        // 两个调用者仍然连到它，图显示出汇聚而不是藏起来。
        const intoShared = graph.edges.filter(e => e.to === shared[0]!.id && !e.structural);
        assert.strictEqual(intoShared.length, 2);
    });

    it('keeps the same event under two different scopes as two nodes', async () => {
        const call = (eventName: string, scopeName: string) => ({
            scopeName, eventName, days: 0, hours: 0, randomDays: 0, randomHours: 0, condition: true,
        });
        const rendered = await renderEventFile(loaderFor([
            {
                id: 'test.1',
                options: [{
                    name: 'test.1.a',
                    childEvents: [call('test.shared', 'OVERLORD'), call('test.shared', 'FROM')],
                }],
            },
            'test.shared',
        ]), uri, webview) as LoaderRenderResult;

        const graph = payloadOf(rendered);
        const shared = graph.nodes.filter(n => n.kind === 'event' && n.eventId === 'test.shared');
        assert.strictEqual(shared.length, 2, 'a different scope is a different box');
        assert.notStrictEqual((shared[0] as EventGraphEventNode).scope, (shared[1] as EventGraphEventNode).scope);
    });

    // test.a 经 ALPHA、test.b 经 BETA 进入，两者都在 SHARED 调用 test.shared——两条路径汇聚到
    // 同一个作用域，但身后的调用者不同。
    const joinChain = (tailOfShared: unknown[]) => {
        const call = (eventName: string, scopeName: string) => ({
            scopeName, eventName, days: 0, hours: 0, randomDays: 0, randomHours: 0, condition: true,
        });
        return [
            {
                id: 'test.1',
                options: [{
                    name: 'test.1.a',
                    childEvents: [call('test.a', 'ALPHA'), call('test.b', 'BETA')],
                }],
            },
            { id: 'test.a', options: [{ name: 'test.a.a', childEvents: [call('test.shared', 'SHARED')] }] },
            { id: 'test.b', options: [{ name: 'test.b.a', childEvents: [call('test.shared', 'SHARED')] }] },
            { id: 'test.shared', options: [{ name: 'test.shared.a', childEvents: tailOfShared }] },
            'test.last',
        ];
    };

    it('keeps a join apart when the callers differ and a later call reads FROM', async () => {
        // FROM 解析为触发上一层的事件，合并两个到达 test.shared 的路径会把经 test.b 的路线
        // 拿到经 test.a 的作用域。
        const rendered = await renderEventFile(loaderFor(joinChain([{
            scopeName: 'FROM', eventName: 'test.last',
            days: 0, hours: 0, randomDays: 0, randomHours: 0, condition: true,
        }])), uri, webview) as LoaderRenderResult;

        const graph = payloadOf(rendered);
        const last = graph.nodes
            .filter(n => n.kind === 'event' && n.eventId === 'test.last')
            .map(n => (n as EventGraphEventNode).scope)
            .sort();
        assert.deepStrictEqual(last, ['ALPHA', 'BETA']);
    });

    it('still collapses that join when nothing downstream reads FROM', async () => {
        // 对照：文件里任何地方都没有 FROM 调用时，调用者历史永远不可观察，两个到达是同一个盒子、
        // 载荷保持小巧。
        const rendered = await renderEventFile(
            loaderFor(joinChain([])),
            uri,
            webview,
        ) as LoaderRenderResult;

        const graph = payloadOf(rendered);
        const shared = graph.nodes.filter(n => n.kind === 'event' && n.eventId === 'test.shared');
        assert.strictEqual(shared.length, 1, 'the shared event must still be emitted once');
        assert.strictEqual(
            graph.edges.filter(e => e.to === shared[0]!.id && !e.structural).length,
            2,
            'both callers must still link to it',
        );
    });

    it('renders a group of events that only call each other', async () => {
        // 上游案例：两个隐藏事件互相在 immediate 里触发对方。谁都不是无父，根选择找不到入口，
        // 整组预览是空白。
        const call = (eventName: string) => ({
            scopeName: '{event_target}', eventName, days: 0, hours: 0, randomDays: 0, randomHours: 0, condition: true,
        });
        const rendered = await renderEventFile(loaderFor([
            { id: 'test.1', hidden: true, immediate: { childEvents: [call('test.2')] } },
            { id: 'test.2', hidden: true, immediate: { childEvents: [call('test.1')] } },
        ]), uri, webview) as LoaderRenderResult;

        const graph = payloadOf(rendered);
        assert.ok(graph.roots.length > 0, 'the group must get an entry point');
        const ids = graph.nodes.filter(n => n.kind === 'event').map(n => (n as EventGraphEventNode).eventId);
        assert.ok(ids.includes('test.1'), ids.join(','));
        assert.ok(ids.includes('test.2'), ids.join(','));
    });

    it('does not promote an event that a real root already reaches', async () => {
        const call = (eventName: string) => ({
            scopeName: '{event_target}', eventName, days: 0, hours: 0, randomDays: 0, randomHours: 0, condition: true,
        });
        const rendered = await renderEventFile(loaderFor([
            { id: 'test.0', options: [{ name: 'test.0.a', childEvents: [call('test.1')] }] },
            { id: 'test.1' },
        ]), uri, webview) as LoaderRenderResult;

        const graph = payloadOf(rendered);
        assert.strictEqual(graph.roots.length, 1, 'test.1 hangs off test.0 and must not also be a root');
    });

    it('terminates on a cycle instead of recursing forever', async () => {
        const call = (eventName: string) => ({
            scopeName: '{event_target}', eventName, days: 1, hours: 0, randomDays: 0, randomHours: 0, condition: true,
        });
        // test.0 是根；test.1 与 test.2 互相调用。注意没有入口的纯环什么都渲染不出来，
        // 因为 eventsToGraph 只把无父事件当根。
        const rendered = await renderEventFile(loaderFor([
            { id: 'test.0', options: [{ name: 'test.0.a', childEvents: [call('test.1')] }] },
            { id: 'test.1', options: [{ name: 'test.1.a', childEvents: [call('test.2')] }] },
            { id: 'test.2', options: [{ name: 'test.2.a', childEvents: [call('test.1')] }] },
        ]), uri, webview) as LoaderRenderResult;

        const graph = payloadOf(rendered);
        assert.ok(graph.nodes.length > 0, 'the chain must render');
        assert.ok(graph.nodes.length < 20, `the cycle must stay bounded, got ${graph.nodes.length} nodes`);
        assert.ok(graph.nodes.some(n => n.kind === 'event' && n.eventId === 'test.2'));
    });

    it('returns a plain string for the error page when the loader throws', async () => {
        const throwing: any = { load: async () => { throw new Error('boom'); } };
        const rendered = await renderEventFile(throwing, uri, webview);
        assert.strictEqual(typeof rendered, 'string');
    });
});
