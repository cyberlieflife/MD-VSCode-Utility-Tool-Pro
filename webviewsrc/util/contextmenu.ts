// Shared fixed-position context menu for webview previews. Extracted from the focus tree
// implementation so the world map can pop the same kind of menu; the caller supplies the CSS
// class name so existing test selectors keep working per preview.

let contextMenuEl: HTMLDivElement | null = null;

// Current open menu (or null), for callers that need to test clicks against it.
export function sharedContextMenuEl(): HTMLDivElement | null {
    return contextMenuEl;
}

export function closeContextMenu() {
    if (contextMenuEl) {
        contextMenuEl.remove();
        contextMenuEl = null;
    }
}

export function showContextMenu(className: string, x: number, y: number, items: { label: string; onClick: () => void }[]) {
    closeContextMenu();
    const menu = document.createElement('div');
    menu.className = className;
    menu.style.cssText = 'position:fixed;left:' + x + 'px;top:' + y + 'px;z-index:2000;' +
        'background:var(--vscode-menu-background);color:var(--vscode-menu-foreground);' +
        'border:1px solid var(--vscode-menu-border);box-shadow:0 2px 8px rgba(0,0,0,.3);' +
        'font-size:12px;min-width:160px;';
    for (const item of items) {
        const el = document.createElement('div');
        el.style.cssText = 'padding:4px 12px;cursor:pointer;white-space:nowrap;';
        el.textContent = item.label;
        el.addEventListener('pointerdown', (e) => e.stopPropagation());
        el.addEventListener('click', () => {
            closeContextMenu();
            item.onClick();
        });
        menu.appendChild(el);
    }
    document.body.appendChild(menu);
    contextMenuEl = menu;
}
