import { GridBoxItem } from "../../src/util/hoi4gui/gridboxcommon";
import {
    warningBadgeClass,
    warningBoxClass,
    warningEntryClass,
    warningFlashClass,
} from "../../src/util/hoi4gui/warningstyles";
import { applyIconState } from "../../src/previewdef/toolbaricons";
import { feLocalize } from "./i18n";

// 网格树（焦点树或 MIO 特质树）的警告在网页端的展示：被警告点名的节点加红框与角标，面板按条目
// 列出。`idPrefix` 把节点 id 变成它的网格项元素 id（`focus_` 或 `trait_`）。

interface TreeWarning {
    text: string;
    source: string;
    relatedSources?: string[];
}

export interface WarnedTree {
    warnings: TreeWarning[];
}

// 一条警告涉及的每个节点（来源与相关来源），使配对的两端都带上标记。
export function warningIdsFor(tree: WarnedTree): Set<string> {
    const ids = new Set<string>();
    for (const warning of tree.warnings) {
        ids.add(warning.source);
        for (const related of warning.relatedSources ?? []) {
            ids.add(related);
        }
    }
    return ids;
}

/**
 * 每个格子解析到多少个被警告的节点，按节点 id 归集。叠在同一格上的节点互相遮盖，只有最后渲染的
 * 那个可见——角标上的计数是看出那里还藏着多个节点的唯一途径。计数只覆盖已带警告的节点，从别的
 * 文件并入的共享/联合焦点堆叠（校验器刻意忽略）不会造出标记。
 *
 * 全程用 Map：id 是模组提供的 token，名为 constructor 或 __proto__ 的 id 否则会落到原型上。
 */
export function warningCellCountsFor(
    items: GridBoxItem[],
    warningIds: Set<string>,
): Record<string, number> {
    const countByCell = new Map<string, number>();
    const cellById = new Map<string, string>();
    for (const item of items) {
        if (!warningIds.has(item.id)) {
            continue;
        }
        const cell = item.gridX + "," + item.gridY;
        cellById.set(item.id, cell);
        countByCell.set(cell, (countByCell.get(cell) ?? 0) + 1);
    }

    const countById: Record<string, number> = {};
    for (const [id, cell] of cellById) {
        countById[id] = countByCell.get(cell) ?? 1;
    }
    return countById;
}

// 每个节点的警告文本，归在警告的来源与每个相关来源之下，配对的两端都能在悬停里自我说明。
function warningTextsById(tree: WarnedTree): Map<string, string[]> {
    const texts = new Map<string, string[]>();
    for (const warning of tree.warnings) {
        for (const id of [warning.source, ...(warning.relatedSources ?? [])]) {
            const nodeTexts = texts.get(id);
            if (nodeTexts) {
                nodeTexts.push(warning.text);
            } else {
                texts.set(id, [warning.text]);
            }
        }
    }
    return texts;
}

// 节点被警告点名后加上红框与警告角标，使问题在树上就能看见，而不只是警告面板里的一行。
// 每次（重）渲染后运行，含就地更新路径。
export function applyWarningMarkers(
    tree: WarnedTree,
    items: GridBoxItem[],
    idPrefix: string,
    visible: boolean,
): void {
    const warningIds = warningIdsFor(tree);
    if (warningIds.size === 0) {
        return;
    }

    const cellCounts = warningCellCountsFor(items, warningIds);
    const texts = warningTextsById(tree);

    warningIds.forEach((id) => {
        // 被 allow_branch 隐藏、或属于另一棵树的节点没有元素。
        const element = document.getElementById(idPrefix + id);
        if (!element) {
            return;
        }

        // 通过 DOM 构建而不是 innerHTML：任何来自模组 id 的内容都不会插进标记。
        const marker = document.createElement("div");
        marker.className = warningBoxClass;
        if (!visible) {
            marker.style.display = "none";
        }
        const badge = document.createElement("span");
        badge.className = warningBadgeClass;
        const stacked = cellCounts[id] ?? 1;
        badge.textContent = stacked > 1 ? `⚠×${stacked}` : "⚠";
        marker.appendChild(badge);
        element.appendChild(marker);

        // 悬停提示挂在本就携带节点 id 与位置标题的 .navigator 子元素上；标记自身是
        // pointer-events:none，显示不了提示。
        const navigator = element.querySelector(".navigator") as HTMLElement | null;
        const nodeTexts = texts.get(id);
        if (navigator && nodeTexts) {
            // 原始 title 先记下来：clearWarningMarkers 要把它还原回去，增量 patch 才能把没变的
            // 格子判为未变（title 也是 innerHTML 的一部分）。
            if (!navigator.hasAttribute("data-warning-base-title")) {
                navigator.setAttribute("data-warning-base-title", navigator.title);
            }
            navigator.title = [navigator.title, ...nodeTexts.map((t) => `⚠ ${t}`)]
                .filter((line) => line)
                .join("\n");
        }
    });
}

// 标记与挂在 .navigator 上的警告行都是上一次渲染加上去的装饰：增量 patch 按 innerHTML 比较
// 格子，任何残留都会让被标记过的格子每次都判为变化、整格重建。patch 之前必须把它们全部撤掉。
export function clearWarningMarkers(): void {
    document.querySelectorAll("." + warningBoxClass).forEach((element) => element.remove());
    document.querySelectorAll("[data-warning-base-title]").forEach((element) => {
        const baseTitle = element.getAttribute("data-warning-base-title") ?? "";
        if (baseTitle === "") {
            element.removeAttribute("title");
        } else {
            element.setAttribute("title", baseTitle);
        }
        element.removeAttribute("data-warning-base-title");
    });
}

// 翻转既有标记元素而不是重建树，大树上也即时生效。
export function setWarningMarkersVisible(visible: boolean): void {
    const markers = document.getElementsByClassName(warningBoxClass);
    for (let i = 0; i < markers.length; i++) {
        (markers[i] as HTMLDivElement).style.display = visible ? "block" : "none";
    }

    const button = document.getElementById("toggle-warning-markers") as HTMLButtonElement | null;
    if (button) {
        applyIconState(button, "warningMarkers", visible, feLocalize);
    }
}

// 警告面板为每条警告列出一个可点击条目：激活它会关闭面板并把出问题的节点滚动到视野中、短暂闪光，
// 警告不必按坐标去手工寻找。
export function renderWarningList(tree: WarnedTree, idPrefix: string): void {
    const warnings = document.getElementById("warnings") as HTMLDivElement | null;
    if (!warnings) {
        return;
    }

    warnings.textContent = "";
    if (tree.warnings.length === 0) {
        const empty = document.createElement("div");
        empty.textContent = feLocalize("worldmap.warnings.nowarnings", "No warnings.");
        warnings.appendChild(empty);
        return;
    }

    for (const warning of tree.warnings) {
        const entry = document.createElement("div");
        entry.className = warningEntryClass;
        entry.setAttribute("role", "button");
        entry.tabIndex = 0;
        entry.textContent = `[${warning.source}] ${warning.text}`;
        const reveal = () => revealNode(idPrefix + warning.source);
        entry.addEventListener("click", reveal);
        entry.addEventListener("keydown", (e) => {
            if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                reveal();
            }
        });
        warnings.appendChild(entry);
    }
}

export function revealNode(elementId: string): void {
    hideWarningPanel();

    // 被条件隐藏的节点没有元素；此时条目只是关掉面板。
    const element = document.getElementById(elementId);
    if (!element) {
        return;
    }

    // 可选调用：jsdom 没有实现 scrollIntoView，测试里让条目照常完成而不是抛出。
    element.scrollIntoView?.({ block: "center", inline: "center" });
    element.classList.add(warningFlashClass);
    setTimeout(() => element.classList.remove(warningFlashClass), 1200);
}

function hideWarningPanel(): void {
    const container = document.getElementById("warnings-container") as HTMLDivElement | null;
    if (container) {
        container.style.display = "none";
        document.body.style.overflow = "";
    }
    const button = document.getElementById("show-warnings");
    if (button) {
        applyIconState(button, "showWarnings", false, feLocalize);
    }
}

// 显示警告按钮开合面板。绑在外壳上，外壳比树的每次重建都活得久，所以只接一次。
export function bindWarningPanelButton(): void {
    const showWarnings = document.getElementById("show-warnings") as HTMLButtonElement | null;
    const warnings = document.getElementById("warnings-container") as HTMLDivElement | null;
    if (!showWarnings || !warnings) {
        return;
    }
    showWarnings.addEventListener("click", () => {
        const visible = warnings.style.display === "block";
        document.body.style.overflow = visible ? "" : "hidden";
        warnings.style.display = visible ? "none" : "block";
        applyIconState(showWarnings, "showWarnings", !visible, feLocalize);
    });
}
