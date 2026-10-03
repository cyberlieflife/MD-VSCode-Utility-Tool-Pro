import * as vscode from "vscode";
import { Node } from "../hoiformat/hoiparser";
import { parseHoi4File } from "../hoiformat/hoiparser";
import { createTimeSlicer, debounceByInput, mapLimit } from "./common";
import { debug } from "./debug";
import { ideaSwapIndex } from "./featureflags";
import { listFilesFromModOrHOI4, readFileFromModOrHOI4 } from "./fileloader";
import { localize } from "./i18n";
import { Logger } from "./logger";

// The idea -> idea swaps a mod scripts with `swap_ideas = { remove_idea = X add_idea = Y }`, which
// the idea preview follows from an idea to the one that replaces it. A chain can leave the
// previewed file -- focus trees, decisions, scripted effects and scripted GUIs swap ideas too -- so
// the whole `common` and `events` trees are scanned rather than the ideas folder alone.
//
// Three things keep the scan affordable:
//  * a file is parsed only when its text mentions `swap_ideas`, so the thousands of files that
//    cannot hold a swap are read but never parsed;
//  * an edit re-indexes that one file instead of dropping the whole index (a full rebuild would
//    otherwise follow every keystroke-debounce in any common/ or events/ file);
//  * a build that finishes after the index was invalidated discards its result instead of
//    overwriting a newer one.
//
// Unlike the GFX and localisation indexes there is no on-disk half: a swap is a few bytes and this
// index is only ever asked about the handful of ideas in the file on screen.

export interface IdeaSwap {
	from: string;
	to: string;
	file: string;
	start: number;
	end: number;
}

// What is stored per file: the swap without the file name, which the map key already carries.
interface SwapRecord {
	from: string;
	to: string;
	start: number;
	end: number;
}

const swapRoots = ["common", "events"];

// The cheapest possible filter for "this file cannot hold a swap".
const swapMarker = "swap_ideas";

// file (relative to the workspace root, e.g. "common/ideas/my_ideas.txt") -> its swaps.
let swapsByFile: Map<string, SwapRecord[]> | undefined;
let buildPromise: Promise<void> | undefined;
// Bumped by every invalidation and by every build; a build writes its result only when it is still
// the newest one, so a slow build cannot land on top of the index a newer one built.
let revision = 0;
// How many times a build that could not list every root has been retried. Bounded, so a root that
// is genuinely unreadable does not trigger a fresh scan on every lookup.
let incompleteRetries = 0;

// Edits that arrive while the index is still building. Replayed once it is ready, because the
// build's own read may have raced the edit.
const pendingReindex = new Map<string, string | undefined>();

async function loadSwaps(relativePath: string, text: string | undefined): Promise<SwapRecord[]> {
	const content = text ?? (await readFileFromModOrHOI4(relativePath))[0].toString();
	if (!content.includes(swapMarker)) {
		return [];
	}

	// Tokens are kept: a swap carries the position of its `swap_ideas` block so the preview can
	// navigate to it. Not the cached parser: the caller may hold a newer text than the disk copy.
	return extractIdeaSwaps(parseHoi4File(content, localize("infile", "In file {0}:\n", relativePath)));
}

async function buildSwapIndex(myRevision: number): Promise<void> {
	const index = new Map<string, SwapRecord[]>();
	const slicer = createTimeSlicer();
	let incompleteRoots = 0;
	for (const root of swapRoots) {
		let files: string[];
		try {
			files = await listFilesFromModOrHOI4(root, { recursively: true });
		} catch (e) {
			// A mod with no events/ folder at all is ordinary; a failing root costs only that root.
			Logger.warn(`[ideaSwap] cannot list ${root}: ${e}`);
			incompleteRoots++;
			continue;
		}

		const txtFiles = files.filter((file) => file.toLowerCase().endsWith(".txt"));
		await mapLimit(txtFiles, 8, async (file) => {
			const relativePath = `${root}/${file}`.replace(/\/+/g, "/");
			try {
				const swaps = await loadSwaps(relativePath, undefined);
				if (swaps.length > 0) {
					index.set(relativePath, swaps);
				}
			} catch (e) {
				debug(`[ideaSwap] cannot parse ${relativePath}:`, e);
			}
			// Let the event loop run between files so a large mod does not freeze the window for
			// the whole scan.
			await slicer();
		});
	}

	if (myRevision !== revision) {
		// The index was invalidated (or rebuilt) while this build ran; its result is stale.
		return;
	}
	swapsByFile = index;

	// A root that failed to list may be a transient IO failure; drop the memo so the next lookup
	// scans again instead of serving the half index for the rest of the session.
	if (incompleteRoots > 0 && incompleteRetries < 3) {
		incompleteRetries++;
		buildPromise = undefined;
	} else if (incompleteRoots === 0) {
		incompleteRetries = 0;
	}

	const pending = [...pendingReindex.entries()];
	pendingReindex.clear();
	for (const [relativePath, text] of pending) {
		await reindexFile(relativePath, text);
	}
}

function ensureIndexBuilt(): Promise<void> {
	if (buildPromise === undefined) {
		const myRevision = ++revision;
		buildPromise = buildSwapIndex(myRevision).catch((e: unknown) => {
			// A failed build must not be cached, or every later lookup serves an empty index.
			buildPromise = undefined;
			throw e;
		});
	}
	return buildPromise;
}

async function reindexFile(relativePath: string, text: string | undefined): Promise<void> {
	const index = swapsByFile;
	if (index === undefined) {
		// Still building: the build would otherwise race this edit, so replay it afterwards.
		pendingReindex.set(relativePath, text);
		return;
	}

	try {
		const swaps = await loadSwaps(relativePath, text);
		if (swaps.length > 0) {
			index.set(relativePath, swaps);
		} else {
			index.delete(relativePath);
		}
	} catch (e) {
		debug(`[ideaSwap] cannot parse ${relativePath}:`, e);
	}
}

const scheduleReindex = debounceByInput(
	(relativePath: string, text: string | undefined) => {
		void reindexFile(relativePath, text);
	},
	(relativePath: string) => relativePath,
	300,
	{ trailing: true },
);

function invalidateIndex(): void {
	revision++;
	buildPromise = undefined;
	swapsByFile = undefined;
	pendingReindex.clear();
}

// The workspace-relative path a change can affect, or undefined for anything else: files outside
// the workspace, and files that are neither .txt nor under a scanned root, cannot hold a swap.
function swapRelativePath(uri: vscode.Uri): string | undefined {
	const folder = vscode.workspace.getWorkspaceFolder(uri);
	if (folder === undefined) {
		return undefined;
	}
	const folderPath = folder.uri.path.endsWith("/") ? folder.uri.path : folder.uri.path + "/";
	if (!uri.path.startsWith(folderPath)) {
		return undefined;
	}

	const relativePath = decodeURIComponent(uri.path.substring(folderPath.length));
	const lower = relativePath.toLowerCase();
	if (!lower.endsWith(".txt") || !swapRoots.some((root) => lower.startsWith(root + "/"))) {
		return undefined;
	}
	return relativePath;
}

function forgetFile(relativePath: string): void {
	pendingReindex.delete(relativePath);
	swapsByFile?.delete(relativePath);
}

export function registerIdeaSwapIndex(): vscode.Disposable {
	const disposables: vscode.Disposable[] = [];
	disposables.push(vscode.workspace.onDidChangeTextDocument((e) => {
		const relativePath = swapRelativePath(e.document.uri);
		if (relativePath !== undefined) {
			// The editor's text, not the disk copy: an unsaved edit is already what the preview shows.
			scheduleReindex(relativePath, e.document.getText());
		}
	}));
	disposables.push(vscode.workspace.onDidCreateFiles((e) => {
		for (const uri of e.files) {
			const relativePath = swapRelativePath(uri);
			if (relativePath !== undefined) {
				scheduleReindex(relativePath, undefined);
			}
		}
	}));
	disposables.push(vscode.workspace.onDidDeleteFiles((e) => {
		for (const uri of e.files) {
			const relativePath = swapRelativePath(uri);
			if (relativePath !== undefined) {
				forgetFile(relativePath);
			}
		}
	}));
	disposables.push(vscode.workspace.onDidRenameFiles((e) => {
		for (const file of e.files) {
			const oldPath = swapRelativePath(file.oldUri);
			if (oldPath !== undefined) {
				forgetFile(oldPath);
			}
			const newPath = swapRelativePath(file.newUri);
			if (newPath !== undefined) {
				scheduleReindex(newPath, undefined);
			}
		}
	}));
	disposables.push(vscode.workspace.onDidChangeWorkspaceFolders(() => invalidateIndex()));
	disposables.push(vscode.workspace.onDidChangeConfiguration((e) => {
		if (e.affectsConfiguration("mdHoi4Utilities.installPath") || e.affectsConfiguration("mdHoi4Utilities.modFile")) {
			invalidateIndex();
		}
	}));
	return vscode.Disposable.from(...disposables);
}

/**
 * Every swap reachable from the given ideas, following the chain in both directions until it stops
 * growing. A chain that leaves the previewed file is followed out of it, so the reader sees where
 * an idea ends up even when the rest of the chain is defined elsewhere.
 */
export async function getIdeaSwaps(ideaIds: string[]): Promise<IdeaSwap[]> {
	if (!ideaSwapIndex || ideaIds.length === 0) {
		return [];
	}

	if (swapsByFile === undefined && buildPromise === undefined) {
		vscode.window.setStatusBarMessage(
			"$(loading~spin) " + localize("ideaSwapIndex.building", "Building idea swap index..."),
			ensureIndexBuilt(),
		);
	}
	await ensureIndexBuilt().catch((e: unknown) => {
		Logger.warn(`[ideaSwap] lookup for ${ideaIds.length} idea(s) served without the index: ${e}`);
	});

	const index = swapsByFile;
	if (index === undefined) {
		return [];
	}

	// from/to -> the swaps that touch it. Built per lookup: the lookup runs once per preview build,
	// and a map rebuilt here cannot go stale behind a rebuild of the index itself.
	const byIdea = new Map<string, IdeaSwap[]>();
	const addTo = (id: string, swap: IdeaSwap) => {
		const list = byIdea.get(id);
		if (list === undefined) {
			byIdea.set(id, [swap]);
		} else {
			list.push(swap);
		}
	};
	for (const [file, records] of index) {
		for (const record of records) {
			const swap: IdeaSwap = { from: record.from, to: record.to, file, start: record.start, end: record.end };
			addTo(record.from, swap);
			addTo(record.to, swap);
		}
	}

	const seen = new Set<string>();
	const found = new Map<string, IdeaSwap>();
	const queue = [...ideaIds];

	// Bounded so a mod that swaps an idea back and forth across hundreds of files cannot turn one
	// preview into an unbounded walk. Chains in practice are a handful of steps.
	let budget = 1000;
	while (queue.length > 0 && budget-- > 0) {
		const id = queue.shift();
		if (id === undefined || seen.has(id)) {
			continue;
		}
		seen.add(id);

		for (const swap of byIdea.get(id) ?? []) {
			const key = `${swap.from}\u0000${swap.to}\u0000${swap.file}\u0000${swap.start}`;
			if (found.has(key)) {
				continue;
			}
			found.set(key, swap);
			queue.push(swap.from, swap.to);
		}
	}

	// Sorted so the payload is deterministic whatever order the maps happen to iterate in.
	return [...found.values()].sort(
		(a, b) =>
			a.from.localeCompare(b.from) ||
			a.to.localeCompare(b.to) ||
			a.file.localeCompare(b.file) ||
			a.start - b.start,
	);
}

/**
 * Every `swap_ideas` block in a parse tree, wherever it sits.
 */
export function extractIdeaSwaps(node: Node): SwapRecord[] {
	const result: SwapRecord[] = [];
	walk(node);
	return result;

	function walk(current: Node): void {
		if (!Array.isArray(current.value)) {
			return;
		}

		for (const child of current.value) {
			if (child.name?.toLowerCase() === "swap_ideas") {
				readSwapBlock(child, result);
				// A swap block holds nothing but remove_idea/add_idea, so there is nothing below it
				// worth descending into.
				continue;
			}
			walk(child);
		}
	}
}

function readSwapBlock(node: Node, into: SwapRecord[]): void {
	if (!Array.isArray(node.value)) {
		return;
	}

	const removed: string[] = [];
	const added: string[] = [];
	for (const child of node.value) {
		const name = child.name?.toLowerCase();
		const value = symbolName(child.value);
		if (value === undefined) {
			continue;
		}
		if (name === "remove_idea") {
			removed.push(value);
		} else if (name === "add_idea") {
			added.push(value);
		}
	}

	if (removed.length === 0 || added.length === 0) {
		return;
	}

	const start = node.nameToken?.start ?? 0;
	const end = node.valueEndToken?.end ?? node.nameToken?.end ?? start;

	// The usual block is one of each. When a block lists several, matching counts pair up in the
	// order written -- that is what the game does -- and mismatched counts fall back to every
	// combination rather than dropping the extras.
	if (removed.length === added.length) {
		for (let i = 0; i < removed.length; i++) {
			pushSwap(into, removed[i], added[i], start, end);
		}
		return;
	}

	for (const from of removed) {
		for (const to of added) {
			pushSwap(into, from, to, start, end);
		}
	}
}

function pushSwap(
	into: SwapRecord[],
	from: string | undefined,
	to: string | undefined,
	start: number,
	end: number,
): void {
	if (from === undefined || to === undefined || from === to) {
		return;
	}
	into.push({ from, to, start, end });
}

function symbolName(value: Node["value"]): string | undefined {
	if (typeof value === "string") {
		return value;
	}
	if (typeof value === "object" && value !== null && !Array.isArray(value)) {
		return value.name;
	}
	return undefined;
}
