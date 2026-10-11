import { vscode } from "./vscode";
import { getState, setState } from "./common";
import { feLocalize } from "./i18n";

// A shared icon grid: names arrive first so the grid renders with placeholders, then resolved
// images stream in batches that only touch their own cell. The focus tree and the idea preview each
// keep their own icon list on the host, so the picker talks through a per-source channel; the grid
// itself, its search, its column selector and its lazy image pulling are one implementation.

export type IconSource = "focus" | "idea";

// Dialog buttons: common.css styles bare <button> as a 20x20 toolbar icon button, which crushes
// text (a two-character label wraps into vertical text). Give modal buttons explicit sizing.
export function makeDialogButton(text: string): HTMLButtonElement {
	const b = document.createElement("button");
	b.textContent = text;
	b.style.cssText = "width:auto;height:auto;min-width:72px;padding:4px 12px;white-space:nowrap;" +
		"background:var(--vscode-button-background);color:var(--vscode-button-foreground);" +
		"border:1px solid var(--vscode-button-border);border-radius:2px;cursor:pointer;transform:none;";
	return b;
}

interface IconChannel {
	requestNames: string;
	requestImages: string;
	names: string;
	images: string;
	legacy: string;
}

const channels: Record<IconSource, IconChannel> = {
	focus: {
		requestNames: "requestFocusIcons",
		requestImages: "requestFocusIconImages",
		names: "focusIconNames",
		images: "focusIconImages",
		legacy: "focusIcons",
	},
	idea: {
		requestNames: "requestIdeaIcons",
		requestImages: "requestIdeaIconImages",
		names: "ideaIconNames",
		images: "ideaIconImages",
		legacy: "ideaIcons",
	},
};

interface IconStore {
	names: string[];
	images: Record<string, string>;
	// Names whose image resolution is in flight (requested but not yet delivered). Guards against
	// re-requesting while the host is still decoding; an unresolvable name stays here and shows its
	// placeholder instead of being retried.
	loading: Set<string>;
	namesArrived: boolean;
	requested: boolean;
}

function emptyStore(): IconStore {
	return { names: [], images: {}, loading: new Set(), namesArrived: false, requested: false };
}

// Kept per source and at module scope so a reopened picker reuses what already arrived; a webview
// reload (no retainContextWhenHidden) starts a fresh request.
const stores: Record<IconSource, IconStore> = { focus: emptyStore(), idea: emptyStore() };

export interface IconPickerOptions {
	source: IconSource;
	onPick: (name: string) => void;
	// Called with true when the picker opens and false when it closes. The focus tree disables canvas
	// interaction while a modal is up; the idea preview has no canvas and passes nothing.
	onModalChange?: (open: boolean) => void;
}

let pickerOverlay: HTMLDivElement | null = null;
let pickerCallback: ((name: string) => void) | null = null;
let pickerRender: (() => void) | null = null;
let pickerApplyImages: ((images: Record<string, string>) => void) | null = null;
let pickerCleanup: (() => void) | null = null;
let pickerModalChange: ((open: boolean) => void) | undefined;

export function isIconPickerOpen(): boolean {
	return pickerOverlay !== null;
}

export function closeIconPicker(): void {
	pickerCleanup?.();
	pickerCleanup = null;
	pickerRender = null;
	pickerApplyImages = null;
	pickerOverlay?.remove();
	pickerOverlay = null;
	pickerCallback = null;
	const modalChange = pickerModalChange;
	pickerModalChange = undefined;
	modalChange?.(false);
}

export function openIconPicker(options: IconPickerOptions): void {
	closeIconPicker();

	const channel = channels[options.source];
	const store = stores[options.source];
	pickerCallback = options.onPick;
	pickerModalChange = options.onModalChange;
	options.onModalChange?.(true);

	if (!store.requested) {
		store.requested = true;
		// v:2 selects the two-stage icon stream (names, then batched images) on the extension host.
		vscode.postMessage({ command: channel.requestNames, v: 2 });
	}

	const overlay = document.createElement("div");
	overlay.className = "ft-iconpicker";
	overlay.style.cssText = "position:fixed;inset:0;z-index:4000;background:rgba(0,0,0,.4);" +
		"display:flex;align-items:center;justify-content:center;";
	const box = document.createElement("div");
	box.style.cssText = "background:var(--vscode-editor-background);color:var(--vscode-editor-foreground);" +
		"border:1px solid var(--vscode-widget-border);padding:16px;min-width:560px;max-width:900px;" +
		"max-height:70vh;display:flex;flex-direction:column;";
	const title = document.createElement("div");
	title.style.cssText = "font-weight:bold;margin-bottom:8px;";
	title.textContent = feLocalize("focustree.pickicon", "Pick icon");
	box.appendChild(title);
	// Search + per-row column count live on one line: the column selector fixes how many
	// icons fit per grid row (3/4/5/6); the icons themselves scale with the cell width.
	const toolbarRow = document.createElement("div");
	toolbarRow.style.cssText = "display:flex;align-items:center;gap:8px;margin-bottom:8px;";
	const search = document.createElement("input");
	search.type = "text";
	search.placeholder = feLocalize("focustree.search", "Search: ");
	search.style.cssText = "flex:1;min-width:0;";
	toolbarRow.appendChild(search);
	const columnsLabel = document.createElement("label");
	columnsLabel.textContent = feLocalize("focustree.percolumn", "Per column: ");
	columnsLabel.style.cssText = "white-space:nowrap;";
	toolbarRow.appendChild(columnsLabel);
	const columnsSelect = document.createElement("select");
	columnsSelect.style.cssText = "background:var(--vscode-dropdown-background);color:var(--vscode-dropdown-foreground);" +
		"border:1px solid var(--vscode-dropdown-border);";
	// Persisted per-session column count; defaults to 6 per row.
	const defaultColumns = getState().iconPickerColumns ?? 6;
	for (const n of [6, 5, 4, 3]) {
		const option = document.createElement("option");
		option.value = String(n);
		option.textContent = feLocalize("focustree.percolumn.n", "Per column: {0}", n);
		if (n === defaultColumns) {
			option.selected = true;
		}
		columnsSelect.appendChild(option);
	}
	toolbarRow.appendChild(columnsSelect);
	box.appendChild(toolbarRow);
	const grid = document.createElement("div");
	grid.className = "ft-iconpicker-grid";
	grid.style.cssText = "overflow:auto;display:grid;gap:6px;";
	box.appendChild(grid);
	const closeBtn = makeDialogButton(feLocalize("focustree.cancel", "Cancel"));
	closeBtn.style.cssText += "margin-top:8px;align-self:flex-end;";
	box.appendChild(closeBtn);
	overlay.appendChild(box);
	document.body.appendChild(overlay);
	pickerOverlay = overlay;

	// Interaction constants: search is debounced so keystrokes queue one render; the recycle pool
	// caps how many previously-decoded cells stay around for a search toggle; the request window
	// constants bound how many visible icons are pulled from the host per flush.
	const SEARCH_DEBOUNCE_MS = 200;
	const POOL_MAX_CELLS = 300;
	const FLUSH_DELAY_MS = 30;
	const SCROLL_THROTTLE_MS = 80;
	const DECODE_BATCH_MAX = 60;
	const VISIBLE_BUFFER_ROWS = 2;
	const VIEWPORT_FALLBACK_HEIGHT = 400;
	const ICON_GRID_GAP = 6;

	// Cells currently in the grid (keyed by icon name) and a recycle pool of recently removed cells
	// so a search toggle reuses the already-decoded image instead of rebuilding and re-decoding it.
	const cells = new Map<string, HTMLDivElement>();
	const pool = new Map<string, HTMLDivElement>();
	let filterTimer: number | undefined;
	let columns = defaultColumns;
	// Visible-window request bookkeeping: names waiting for the debounced flush, plus the flush and
	// scroll timers. Requests are coalesced so scrolling cannot spam one message per pixel.
	const pendingRequests = new Set<string>();
	let flushTimer: number | undefined;
	let scrollTimer: number | undefined;

	const makeCell = (name: string): HTMLDivElement => {
		const cell = document.createElement("div");
		cell.dataset.name = name;
		cell.style.cssText = "display:flex;flex-direction:column;align-items:center;cursor:pointer;" +
			"padding:4px;border:1px solid transparent;min-width:0;";
		const host = document.createElement("div");
		host.style.cssText = "width:100%;aspect-ratio:1;display:flex;align-items:center;justify-content:center;" +
			"color:var(--vscode-descriptionForeground);font-size:10px;";
		host.textContent = "?";
		const label = document.createElement("div");
		label.style.cssText = "font-size:10px;max-width:100%;overflow:hidden;text-overflow:ellipsis;" +
			"white-space:nowrap;text-align:center;";
		label.textContent = name;
		label.title = name;
		cell.appendChild(host);
		cell.appendChild(label);
		cell.addEventListener("click", () => {
			const cb = pickerCallback;
			closeIconPicker();
			cb?.(name);
		});
		return cell;
	};

	// Injects the image into a rendered cell exactly once. A cell that already decoded its image is
	// never rebuilt or re-set, so batch updates and column changes cannot trigger re-decodes.
	const setCellImage = (cell: HTMLDivElement, name: string) => {
		if (cell.dataset.imgSet === "1") {
			return;
		}
		const uri = store.images[name];
		if (!uri) {
			return;
		}
		const host = cell.firstElementChild as HTMLElement;
		const img = document.createElement("img");
		img.src = uri;
		img.style.cssText = "width:100%;aspect-ratio:1;object-fit:contain;";
		host.textContent = "";
		host.appendChild(img);
		cell.dataset.imgSet = "1";
	};

	// Measures the height of one grid row (cell height + gap) from the first rendered cell, so the
	// visible window can be computed from scrollTop/clientHeight. Falls back to 0 when the grid is
	// not laid out (jsdom / first paint), which routes to a fixed fallback window below.
	const measureStride = (): number => {
		const first = grid.firstElementChild as HTMLElement | null;
		const h = first ? first.offsetHeight : 0;
		return h > 0 ? h + ICON_GRID_GAP : 0;
	};

	// Names currently in (or just outside) the visible viewport of the grid, in grid order. Used to
	// request images only for what the user can actually see (the pull path for very large lists).
	const visibleNames = (): string[] => {
		if (grid.children.length === 0) {
			return [];
		}
		const names: string[] = [];
		for (let i = 0; i < grid.children.length; i++) {
			const name = (grid.children[i] as HTMLElement).dataset.name;
			if (name) {
				names.push(name);
			}
		}
		const stride = measureStride();
		const viewport = grid.clientHeight || VIEWPORT_FALLBACK_HEIGHT;
		if (stride <= 0 || columns <= 0) {
			// Not measurable (jsdom / pre-layout): fall back to a fixed first block.
			return names.slice(0, Math.min(names.length, columns * (VISIBLE_BUFFER_ROWS + 2)));
		}
		const rows = Math.ceil(names.length / columns);
		const startRow = Math.max(0, Math.floor(grid.scrollTop / stride) - VISIBLE_BUFFER_ROWS);
		const endRow = Math.min(rows, Math.ceil((grid.scrollTop + viewport) / stride) + VISIBLE_BUFFER_ROWS);
		const start = startRow * columns;
		const end = Math.min(names.length, endRow * columns);
		return start >= end ? [] : names.slice(start, end);
	};

	// Single request outlet: enqueues visible names that are neither delivered nor in flight, then
	// flushes them as one message after FLUSH_DELAY_MS (coalescing bursts from scroll/filter).
	const scheduleFlush = () => {
		if (flushTimer !== undefined) {
			return;
		}
		flushTimer = window.setTimeout(() => {
			flushTimer = undefined;
			const names = [...pendingRequests].filter(n => !(n in store.images) && !store.loading.has(n));
			pendingRequests.clear();
			if (names.length === 0) {
				return;
			}
			const batch = names.slice(0, DECODE_BATCH_MAX);
			for (const n of batch) {
				store.loading.add(n);
			}
			vscode.postMessage({ command: channel.requestImages, names: batch });
		}, FLUSH_DELAY_MS);
	};

	const requestVisibleNow = () => {
		if (!grid.isConnected) {
			return;
		}
		for (const name of visibleNames()) {
			if (!(name in store.images) && !store.loading.has(name)) {
				pendingRequests.add(name);
			}
		}
		scheduleFlush();
	};

	// Scroll is throttled so the window is recomputed (and missing icons requested) at most once per
	// SCROLL_THROTTLE_MS instead of on every scroll event.
	const requestVisibleSoon = () => {
		if (scrollTimer !== undefined) {
			return;
		}
		scrollTimer = window.setTimeout(() => {
			scrollTimer = undefined;
			requestVisibleNow();
		}, SCROLL_THROTTLE_MS);
	};

	// Diff the grid against the current filter: only cells that appear/disappear are touched, and a
	// newly shown cell whose image already arrived is filled immediately. Order is preserved by
	// inserting each cell before the next already-placed one (walked back to front).
	const applyFilter = () => {
		const q = search.value.trim().toLowerCase();
		const matches = q ? store.names.filter(n => n.toLowerCase().includes(q)) : store.names.slice();
		const wanted = new Set(matches);
		for (const [name, cell] of cells) {
			if (!wanted.has(name)) {
				cell.remove();
				cells.delete(name);
				pool.set(name, cell);
				while (pool.size > POOL_MAX_CELLS) {
					pool.delete(pool.keys().next().value as string);
				}
			}
		}
		let nextSibling: HTMLElement | null = null;
		for (let i = matches.length - 1; i >= 0; i--) {
			const name = matches[i];
			let cell = cells.get(name);
			if (!cell) {
				cell = pool.get(name);
				if (cell) {
					pool.delete(name);
				} else {
					cell = makeCell(name);
				}
				cells.set(name, cell);
				setCellImage(cell, name);
				grid.insertBefore(cell, nextSibling);
			}
			nextSibling = cell;
		}
	};

	let emptyHint: HTMLElement | null = null;
	const ensureEmptyHint = (text: string) => {
		if (emptyHint === null) {
			emptyHint = document.createElement("div");
			emptyHint.style.cssText = "color:var(--vscode-descriptionForeground);padding:12px;text-align:center;";
			grid.appendChild(emptyHint);
		}
		emptyHint.textContent = text;
	};
	const removeEmptyHint = () => {
		emptyHint?.remove();
		emptyHint = null;
	};

	let render = () => {
		applyFilter();
		if (cells.size === 0) {
			ensureEmptyHint(store.namesArrived
				? feLocalize("focustree.noiconmatch", "No matching icons.")
				: feLocalize("focustree.iconloading", "Loading icons…"));
		} else {
			removeEmptyHint();
		}
		requestVisibleNow();
	};

	// Applies the selected per-row column count. Cells are width:100% with a square image, so the
	// CSS grid re-flows them on a column change without rebuilding (or re-decoding) anything.
	const applyColumns = () => {
		columns = parseInt(columnsSelect.value, 10) || 6;
		setState({ iconPickerColumns: columns });
		grid.style.gridTemplateColumns = `repeat(${columns}, 1fr)`;
		// A narrower/wider grid shows a different window, so request the new visible names.
		requestVisibleNow();
	};

	// Debounced search: keystrokes queue a single render 200ms after the last one, and the render
	// only diffs the grid instead of rebuilding it.
	const onSearchInput = () => {
		if (filterTimer !== undefined) {
			clearTimeout(filterTimer);
		}
		filterTimer = window.setTimeout(() => {
			filterTimer = undefined;
			grid.scrollTop = 0;
			render();
		}, SEARCH_DEBOUNCE_MS);
	};

	const cleanup = () => {
		if (filterTimer !== undefined) {
			clearTimeout(filterTimer);
			filterTimer = undefined;
		}
		if (flushTimer !== undefined) {
			clearTimeout(flushTimer);
			flushTimer = undefined;
		}
		if (scrollTimer !== undefined) {
			clearTimeout(scrollTimer);
			scrollTimer = undefined;
		}
		pendingRequests.clear();
	};

	search.addEventListener("input", onSearchInput);
	columnsSelect.addEventListener("change", applyColumns);
	closeBtn.addEventListener("click", closeIconPicker);
	grid.addEventListener("scroll", requestVisibleSoon, { passive: true });
	pickerRender = render;
	pickerApplyImages = (images) => {
		for (const name in images) {
			const cell = cells.get(name);
			if (cell) {
				setCellImage(cell, name);
			}
		}
		// A batch landing frees the in-flight set; pull the next visible window (a no-op when the
		// host already pushed everything).
		requestVisibleNow();
	};
	pickerCleanup = cleanup;
	applyColumns();
	render();
}

function channelFor(type: unknown): { channel: IconChannel; store: IconStore } | undefined {
	if (typeof type !== "string") {
		return undefined;
	}
	for (const source of ["focus", "idea"] as IconSource[]) {
		const channel = channels[source];
		if (type === channel.names || type === channel.images || type === channel.legacy) {
			return { channel, store: stores[source] };
		}
	}
	return undefined;
}

/**
 * Feeds a message from the host into the icon picker. Returns true when the message was the
 * picker's and the caller should stop handling it. Safe to call when no picker is open: the data is
 * still stored so a picker opened later renders it immediately.
 */
export function handleIconPickerMessage(msg: any): boolean {
	const found = channelFor(msg?.type);
	if (!found) {
		return false;
	}
	const { channel, store } = found;

	// Legacy single-shot payload (a host without the two-stage protocol): migrate it into the
	// per-phase state in one step so the grid is immediately ready with images.
	if (msg.type === channel.legacy) {
		const icons: { name: string; imageUri?: string }[] = msg.icons ?? [];
		store.names = icons.map(i => i.name).sort((a, b) => a.localeCompare(b));
		const images: Record<string, string> = {};
		for (const icon of icons) {
			if (icon.imageUri) {
				images[icon.name] = icon.imageUri;
			}
		}
		store.images = images;
		store.namesArrived = true;
		pickerRender?.();
		return true;
	}

	// Phase 1: the sorted name list arrives first (cheap), so the grid renders immediately with
	// placeholders and becomes searchable.
	if (msg.type === channel.names) {
		const names: string[] = msg.names ?? [];
		store.names = names.slice().sort((a, b) => a.localeCompare(b));
		store.namesArrived = true;
		pickerRender?.();
		return true;
	}

	// Phase 2: a batch of resolved images; only the matching cells are updated.
	const images: Record<string, string> = {};
	for (const icon of msg.images ?? []) {
		store.loading.delete(icon?.name);
		if (icon?.imageUri) {
			images[icon.name] = icon.imageUri;
			store.images[icon.name] = icon.imageUri;
		}
	}
	pickerApplyImages?.(images);
	return true;
}
