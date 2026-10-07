import * as vscode from "vscode";
import { EventsLoader, EventsLoaderResult } from "./loader";
import { LoaderSession } from "../../util/loader/loader";
import { debug } from "../../util/debug";
import { html, previewedFileUriScript, errorPage } from "../../util/html";
import { localize, i18nTableAsScript } from "../../util/i18n";
import { StyleTable } from "../../util/styletable";
import { HOIEvent } from "./schema";
import flatten from "lodash/flatten";
import { arrayToMap, jsonForScript } from "../../util/common";
import { buildEventGraphPayload, eventsToGraph } from "./graph";
import { EventGraphPayload } from "./payload";
import { LoaderRender, RenderContentOptions } from "../updateablepreview";
import { actionGroupHtml, iconButtonHtml } from "../toolbaricons";

// 固定工具栏条的高度。内容按它下移，enableZoom 也被告知它，图永远不会渲染到工具栏下面。
//
// 它得留出比这一行本身更多的空间：common.css 上面加 10px 内边距、下边框 1px，且这条工具栏
// 横向滚动，6px 的滚动条也在同一个盒子里——40 时留给 24px 高的搜索框与复选框的空间不够，
// 行会被裁掉。webviewsrc/eventtree.ts 里有同一个常量，两处必须一起改。
const toolbarHeight = 52;

export async function renderEventFile(
    loader: EventsLoader,
    uri: vscode.Uri,
    webview: vscode.Webview,
    options?: RenderContentOptions,
): Promise<LoaderRender> {
    try {
        const session = new LoaderSession(options?.dependencyChanged ?? false);
        const loadResult = await loader.load(session);
        debug("Loader session event tree", session.loadedLoaderNames());

        const styleTable = new StyleTable();
        const eventGraph = await renderEvents(loadResult.result, styleTable);

        const baseContent = renderShell(styleTable);

        // 整页只在 base 赋值时才组装；被跳过或只投递增量的编辑不为此付出代价。
        const fullHtml = () => html(
            webview,
            baseContent,
            [
                previewedFileUriScript(uri),
                // jsonForScript 而不是 JSON.stringify：载荷携带工作区里的本地化文本，含
                // `</script>` 的字符串会在这里提前结束标签。
                { content: `window.eventGraph = ${jsonForScript(eventGraph)};` },
                { content: i18nTableAsScript() },
                "common.js",
                "eventtree.js",
            ],
            [
                "codicon.css",
                // 共享控件样式表：.toolbar-outer、.toolbar 与开关升级成的 codicon 复选框。
                "common.css",
                // 主题 token 与卡片原语，与理念预览共享。
                "hoicard.css",
                // 卡片布局的画布——拖动层、轨道、箭头与标签——与决议预览共享。
                "hoigraph.css",
                "eventtree.css",
                // 可寻址的 id，使就地 updateBody 能通过改写这个 <style> 的 textContent 刷新
                // 服务端 StyleTable（现在只装事件图片精灵），而不必整页重载。
                { content: styleTable.toRawCss(), id: "event-server-styles" },
            ],
        );

        // 增量更新的部件：图在网页端布局与渲染，载荷传数据而不是标记。对确定性构建的载荷
        // （稳定的图序、计数器分配的 id）JSON.stringify 对相同输入逐字节相同，未变化的编辑
        // 哈希相等，LoaderPreview 直接跳过。
        return {
            html: fullHtml,
            update: { styleCss: styleTable.toRawCss(), data: { eventGraph } },
        };
    } catch (e) {
        return errorPage(webview, uri, e);
    }
}

async function renderEvents(
    eventsLoaderResult: EventsLoaderResult,
    styleTable: StyleTable,
): Promise<EventGraphPayload> {
    const eventIdToEvent = arrayToMap(
        flatten(Object.values(eventsLoaderResult.events.eventItemsByNamespace)) as HOIEvent[],
        "id",
    );
    const graph = eventsToGraph(eventIdToEvent, eventsLoaderResult.mainNamespaces);
    return buildEventGraphPayload(graph, eventsLoaderResult, styleTable);
}

// 拖动层是固定的、视口大小的透明 div：在图没盖住的地方按下就开始平移（见
// webviewsrc/util/common.ts 的 initCommon）。这三层谁盖谁由 eventtree.css 里的 --ev-layer-* 决定
// 而不是书写顺序；下面的顺序只为读起来像堆叠。
function renderShell(styleTable: StyleTable): string {
    return `
        <div id="dragger" class="${styleTable.style(
                    "dragger",
                    () => `
            width: 100vw;
            height: 100vh;
            position: fixed;
            left:0;
            top:0;
        `,
                )}"></div>
        <div id="eventtreecontent" class="${styleTable.style(
                    "eventtreecontent",
                    () => `
            position: relative;
            top: ${toolbarHeight}px;
        `,
                )}"></div>
        ${renderToolBar(styleTable)}
    `;
}

// 工具栏在 #eventtreecontent 之外，监听只绑一次、就地更新从不重绑。仿照 MIO 预览的工具栏。
//
// 每个控件总是渲染出来，包括某个文件用不到的那些：显示哪些由网页端按
// EventGraphPayload.toolbarFlags 决定。在这里决定会把答案放进烘焙好的外壳里，应用变化的
// 唯一办法是整页 HTML 重赋值——每次翻转都拆掉页面、丢失滚动与缩放。
function renderToolBar(styleTable: StyleTable): string {
    const labelStyle = styleTable.style("evToggleLabel", () => `margin-right:5px`);

    // <input> 会被隐藏并在网页端加载后替换为 codicon 复选框，因此它不带间距：两个开关之间的
    // 间隔在 eventtree.css 的 .checkbox-container-out 上。
    const toggle = (id: string, text: string) => `
        <label for="${id}" class="${labelStyle}">${text}</label>
        <input type="checkbox" id="${id}">`;

    // 放在最左：工具栏条在窄面板里横向滚动，搜索是唯一必须不滚动就能碰到的控件。
    const search = `
        <label for="ev-searchbox" class="${labelStyle}">${localize("eventtree.search", "Search: ")}</label>
        <input id="ev-searchbox" type="text" />
        <span id="ev-search-count" class="ev-search-count"></span>`;

    // 一个多选而不是一堆复选框：每个条目回答同一个问题——哪些事件属于画布——两个各自收窄
    // 同一张图的控件会让读者没有一处能读出答案。什么都不选显示全部；选多个是 OR。提供哪些
    // 条目由网页端按 EventGraphPayload.toolbarFlags 决定，所以列表本身在这里写全。
    //
    // 每个条目带上匹配事件在画布上的字形，形状词汇从使用它的控件上学。字形作为属性而不是 div
    // 内的标记传输，因为下拉会用 textContent 拉平选项，那会丢掉元素、把它的类名留在收起的
    // 组合框标题里。Event chains 没有字形——卡片上没有东西代表它——传空字符串，仍占住这一列
    // 并让六个标签对齐。
    const filterOption = (value: string, text: string, glyph: string) =>
        `<div class="option" value="${value}" data-glyph="${glyph}">${text}</div>`;
    const marker = (kind: string) => `ev-marker ev-marker-${kind}`;
    const filters = `
        <div id="ev-filter-container">
            <label for="ev-filters" class="${labelStyle}">${localize("eventtree.filters", "Filters: ")}</label>
            <div class="select-container ${styleTable.style("marginRight10", () => `margin-right:10px`)}">
                <div id="ev-filters" class="select multiple-select" tabindex="0" role="combobox">
                    <span class="value"></span>
                    ${filterOption("mtth", localize("eventtree.filtermtth", "MTTH events"), marker("mtth"))}
                    ${filterOption("triggered", localize("eventtree.filtertriggered", "Triggered only"), marker("triggered"))}
                    ${filterOption("news", localize("eventtree.filternews", "News events"), marker("news"))}
                    ${filterOption("hidden", localize("eventtree.filterhidden", "Hidden"), marker("hidden"))}
                    ${filterOption("major", localize("eventtree.filtermajor", "Major"), marker("major"))}
                    ${filterOption("chains", localize("eventtree.filterchains", "Event chains"), "")}
                </div>
            </div>
        </div>`;

    const toggles = [
        toggle("show-localisation", localize("eventtree.showlocalisation", "Show localisation")),
        toggle("show-option-triggers", localize("eventtree.showoptiontriggers", "Show option triggers")),
        toggle("show-edge-conditions", localize("eventtree.showedgeconditions", "Show arrow conditions")),
        toggle("show-event-conditions", localize("eventtree.showeventconditions", "Show event conditions")),
        toggle("show-picture", localize("eventtree.showpicture", "Show event picture")),
        toggle("show-effects", localize("eventtree.showeffects", "Show effects")),
    ].join("");

    return `<div class="toolbar-outer ${styleTable.style(
        "toolbar-height",
        () => `box-sizing: border-box; height: ${toolbarHeight}px;`,
    )}">
        <div class="toolbar">
            ${search}${filters}${toggles}
            ${actionGroupHtml({ refresh: iconButtonHtml("refresh", localize, { domId: "refresh" }) })}
        </div>
    </div>`;
}
