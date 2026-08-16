// Incremental DOM patching for the focus-tree preview's grid content. Kept import-free of the
// focustree entry module (which reads window globals at load time) so unit tests can drive the
// patch directly.

import { StyleTable } from "../src/util/styletable";

// Compares two gridbox cells (data-gridbox-x/y plus the rendered inner content) to decide whether
// an incremental patch can keep the existing DOM node.
export function sameGridboxItem(a: HTMLElement, b: HTMLElement): boolean {
    return a.getAttribute('data-gridbox-x') === b.getAttribute('data-gridbox-x') &&
        a.getAttribute('data-gridbox-y') === b.getAttribute('data-gridbox-y') &&
        a.innerHTML === b.innerHTML;
}

// Applies a fresh gridbox render to #focustreeplaceholder incrementally: the container and style
// element are updated in place, connection elements are rebuilt, and only changed/added/removed
// focus cells touch the DOM. Unchanged cells keep their node identity, so checkbox wrappers,
// selection highlights and the scroll position survive a rebuild; interaction handlers are
// delegated on document and need no re-binding.
export function patchFocusTreeContent(placeholder: HTMLDivElement, focusTreeContent: string, styleTable: StyleTable, styleNonce: string): void {
    // First render (or after a webview reload): assign the full content like the original path.
    let existingRoot: HTMLElement | null = null;
    for (const child of Array.from(placeholder.children)) {
        if (child.tagName === 'DIV') {
            existingRoot = child as HTMLElement;
            break;
        }
    }
    if (existingRoot === null) {
        placeholder.innerHTML = focusTreeContent + styleTable.toStyleElement(styleNonce);
        return;
    }

    const template = document.createElement('template');
    template.innerHTML = focusTreeContent;
    const newRoot = template.content.firstElementChild as HTMLElement | null;
    if (newRoot === null) {
        // No grid rendered: clear the content area, keep the style element.
        for (const child of Array.from(placeholder.children)) {
            if (child.tagName !== 'STYLE') {
                child.remove();
            }
        }
        return;
    }

    // Container attributes (position/format/navigator flags) are cheap to re-apply in place.
    existingRoot.setAttribute('start', newRoot.getAttribute('start') ?? '');
    existingRoot.setAttribute('end', newRoot.getAttribute('end') ?? '');
    existingRoot.className = newRoot.className;

    // Connections are rebuilt wholesale (few elements, and their geometry depends on every cell).
    for (const el of Array.from(existingRoot.querySelectorAll<HTMLElement>('[data-conn-from], [data-cell-x]'))) {
        el.remove();
    }
    const newConnections = Array.from(newRoot.querySelectorAll<HTMLElement>('[data-conn-from], [data-cell-x]'));
    const firstItem = existingRoot.querySelector('[data-gridbox-item]');
    let previousConnection: HTMLElement | null = null;
    for (const conn of newConnections) {
        const clone = conn.cloneNode(true) as HTMLElement;
        if (previousConnection) {
            previousConnection.after(clone);
        } else if (firstItem) {
            existingRoot.insertBefore(clone, firstItem);
        } else {
            existingRoot.appendChild(clone);
        }
        previousConnection = clone;
    }

    // Cells are diffed by id in new order: unchanged cells keep their node, changed ones are
    // replaced, new ones are inserted before the next kept cell, removed ones are dropped.
    const oldItems = new Map<string, HTMLElement>();
    for (const el of existingRoot.querySelectorAll<HTMLElement>('[data-gridbox-item]')) {
        oldItems.set(el.getAttribute('data-gridbox-item')!, el);
    }
    const newItems = new Map<string, HTMLElement>();
    for (const el of newRoot.querySelectorAll<HTMLElement>('[data-gridbox-item]')) {
        newItems.set(el.getAttribute('data-gridbox-item')!, el);
    }
    const newIds = [...newItems.keys()];
    let anchor: HTMLElement | null = null;
    for (let i = newIds.length - 1; i >= 0; i--) {
        const id = newIds[i];
        const newEl = newItems.get(id)!;
        const oldEl = oldItems.get(id);
        if (oldEl) {
            if (sameGridboxItem(oldEl, newEl)) {
                anchor = oldEl;
            } else {
                const replacement = newEl.cloneNode(true) as HTMLElement;
                oldEl.replaceWith(replacement);
                anchor = replacement;
            }
        } else {
            const clone = newEl.cloneNode(true) as HTMLElement;
            if (anchor) {
                anchor.parentElement!.insertBefore(clone, anchor);
            } else {
                existingRoot.appendChild(clone);
            }
        }
    }
    for (const [id, el] of oldItems) {
        if (!newItems.has(id)) {
            el.remove();
        }
    }

    // The style element is reused and its rules replaced wholesale (rules are few relative to the
    // cell count; rule-level diffing would need reverse dependency tracking).
    let styleEl = placeholder.querySelector<HTMLStyleElement>(':scope > style');
    if (styleEl === null) {
        styleEl = document.createElement('style');
        styleEl.setAttribute('nonce', styleNonce);
        placeholder.appendChild(styleEl);
    }
    styleEl.textContent = styleTable.toRawCss();
}
