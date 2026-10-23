import { traceDimClass, traceLineClass } from "../../src/util/hoi4gui/tracestyles";

// 网格树（焦点树或 MIO 特质树）的前置连线追踪。密集的树在节点下方画出上百条交错的连线，
// 用眼睛跟线几乎不可能。Shift+点击一个节点后，除该节点自己的前置产生的连线外，其余连线全部变暗；
// 节点本身不动，只过滤连线。

// 导出使测试能断言类真的落在渲染出的连线上（整套行为就是这两个类）。
export function applyPrerequisiteTrace(
    root: HTMLElement,
    nodeId: string | undefined,
): void {
    const connections = root.querySelectorAll("[data-conn-from]");
    for (let i = 0; i < connections.length; i++) {
        const connection = connections[i] as HTMLElement;
        connection.classList.remove(traceLineClass, traceDimClass);
        if (nodeId === undefined) {
            continue;
        }

        // data-conn-from 是拥有这条连线的节点，data-conn-type 在 renderGridBoxConnection 把斜向的
        // "parent" 翻成 "child" 之前写入，因此这个组合恰好表示"该节点的某个前置产生的线"。
        // 互斥连线是 "related"，和其余连线一起变暗。
        const isPrerequisiteOfTraced =
            connection.dataset.connFrom === nodeId &&
            connection.dataset.connType === "parent";
        connection.classList.add(
            isPrerequisiteOfTraced ? traceLineClass : traceDimClass,
        );
    }
}

export interface TracingOptions {
    // 捕获点击、以及渲染树的元素。
    contentId: string;
    placeholderId: string;
    // 追踪时显示的状态行文本；节点 id 来自模组文件，只作为文本写入。
    statusText: (nodeId: string) => string;
}

export interface Tracing {
    // 重建后把仍然激活的追踪重新画上：连线 div 每次渲染都是新的。
    reapply(): void;
}

// 绑在外壳元素上，外壳比树的每次重建都活得久，所以只接一次。
export function subscribeTracing(options: TracingOptions): Tracing {
    let tracedId: string | undefined;

    const reapply = () => {
        const placeholder = document.getElementById(options.placeholderId);
        if (placeholder) {
            applyPrerequisiteTrace(placeholder, tracedId);
        }
    };

    const setTraced = (nodeId: string | undefined) => {
        tracedId = nodeId;
        reapply();

        const status = document.getElementById("trace-status");
        if (status) {
            status.textContent = nodeId ? options.statusText(nodeId) : "";
        }

        const container = document.getElementById("trace-status-container");
        if (container) {
            container.style.display = nodeId ? "flex" : "none";
        }
    };

    const content = document.getElementById(options.contentId);
    if (content) {
        content.addEventListener(
            "click",
            (e) => {
                if (!e.shiftKey) {
                    return;
                }

                // 捕获阶段：在这里停住事件，气泡阶段的 .navigator 处理器才不会同时跳到编辑器里的
                // 节点，也不会让落在复选框上的 Shift+点击把它勾上。
                e.preventDefault();
                e.stopPropagation();

                const item = (e.target as Element | null)?.closest(
                    "[data-gridbox-item]",
                ) as HTMLElement | null;
                const id = item?.dataset.gridboxItem;
                if (!id) {
                    return;
                }

                setTraced(id === tracedId ? undefined : id);
            },
            true,
        );
    }

    const clearButton = document.getElementById("clear-trace");
    clearButton?.addEventListener("click", () => setTraced(undefined));

    window.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && tracedId !== undefined) {
            setTraced(undefined);
        }
    });

    // 点击空白画布清除追踪。平移结束时也是同一块画布上的点击，所以只有按下与抬起位置相同的
    // 才算一次点击。
    const dragger = document.getElementById("dragger");
    if (dragger) {
        let downX = 0;
        let downY = 0;
        dragger.addEventListener("mousedown", (e) => {
            downX = e.pageX;
            downY = e.pageY;
        });
        dragger.addEventListener("mouseup", (e) => {
            if (
                tracedId !== undefined &&
                Math.abs(e.pageX - downX) < 4 &&
                Math.abs(e.pageY - downY) < 4
            ) {
                setTraced(undefined);
            }
        });
    }

    return { reapply };
}
