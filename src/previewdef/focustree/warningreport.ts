import * as vscode from "vscode";
import * as path from "path";
import { Commands } from "../../constants";
import { parseHoi4File } from "../../hoiformat/hoiparser";
import { createTimeSlicer, mapLimit, yieldToEventLoop } from "../../util/common";
import { error } from "../../util/debug";
import { useConditionInFocus } from "../../util/featureflags";
import { listFilesFromModOrHOI4, readFileFromModOrHOI4 } from "../../util/fileloader";
import { localize } from "../../util/i18n";
import { Logger } from "../../util/logger";
import { isRecord } from "../../util/messageguards";
import { ProgressReport, uncancelledToken, withCancellableProgress } from "../../util/progress";
import { sendEvent } from "../../util/telemetry";
import { getConfiguration } from "../../util/vsccommon";
import {
	convertFocusFileNodeToJson,
	extractOrListIds,
	FocusTree,
	getFocusTreeWithFocusFile,
} from "./schema";

// 焦点树的警告报告：预览里会显示的警告，一次性为全部文件收集，并输出 Markdown 审计报告。

export interface ReportedWarning {
	treeId: string;
	source: string;
	text: string;
}

export interface FileWarnings {
	file: string;
	warnings: ReportedWarning[];
	parseError?: string;
}

export interface ParsedFocusFile {
	path: string;
	file: ReturnType<typeof convertFocusFileNodeToJson>;
}

const focusFolder = "common/national_focus";
export const auditReportFileName = "focus-tree-audit.md";

// 读取的并发上限：审计要读完整个 common/national_focus，串行在大型模组上偏慢，全并发又会把
// 宿主线程压住。
const auditLoadConcurrency = 8;

async function loadBounded<T>(
	files: string[],
	load: (file: string) => Promise<T | undefined>,
): Promise<T[]> {
	const loaded = await mapLimit(files, auditLoadConcurrency, async (file) => {
		try {
			return await load(file);
		} catch (e) {
			Logger.warn(`[Audit] can't read ${file}: ${e}`);
			return undefined;
		}
	});
	return loaded.filter((e): e is T => e !== undefined);
}

/**
 * 焦点树预览会显示的警告，一次性为每个文件收集，各自列在定义相关焦点的文件之下。
 *
 * 共享焦点会并入每个引用它的国家树，关于它的警告也随之而来，按树读取会把一个共享焦点的问题
 * 每个国家列一遍。改为按定义文件归集，它只列一次，就在需要修的地方。
 */
export function collectFocusWarnings(parsed: ParsedFocusFile[]): FileWarnings[] {
	const work = collectFocusWarningSteps(parsed, useConditionInFocus);
	let next = work.next();
	while (!next.done) {
		next = work.next();
	}
	return next.value;
}

/**
 * 与 collectFocusWarnings 相同，但让出主线程并在每次让出后检查取消：一次审计要解析整个
 * common/national_focus，同步跑完会把扩展宿主按住。
 */
export async function collectFocusWarningsAsync(
	parsed: ParsedFocusFile[],
	token: Pick<vscode.CancellationToken, "isCancellationRequested"> = uncancelledToken,
): Promise<FileWarnings[] | undefined> {
	const work = collectFocusWarningSteps(parsed, useConditionInFocus);
	const slice = createTimeSlicer();
	while (!token.isCancellationRequested) {
		const next = work.next();
		if (next.done) {
			// 即使审计很小，也要先处理一次挂起的取消，再发布报告。
			await yieldToEventLoop();
			return token.isCancellationRequested ? undefined : next.value;
		}
		await slice();
	}
	return undefined;
}

function* collectFocusWarningSteps(
	parsed: ParsedFocusFile[],
	useCondition: boolean,
): Generator<void, FileWarnings[]> {
	const treesByFile = new Map<string, FocusTree[]>();
	const importers: ParsedFocusFile[] = [];
	for (const entry of parsed) {
		const { path: filePath, file } = entry;
		const importsShared = useCondition && file.focus_tree.some(
			(tree) => extractOrListIds(tree.shared_focus).length > 0,
		);
		if (importsShared) {
			importers.push(entry);
		}
		// 引用共享焦点的文件，其自身树会在第二遍连同供体重建，所以这一遍只提供它的共享/联合焦点。
		const firstPass = importsShared ? { ...file, focus_tree: [] } : file;
		treesByFile.set(filePath, getFocusTreeWithFocusFile(firstPass, [], filePath, {}, useCondition));
		yield;
	}

	// 预览只在条件打开时才把共享焦点并入树；关闭时第一遍就是它显示的内容。
	if (useCondition) {
		const sharedTrees = [...treesByFile.entries()].flatMap(([filePath, trees]) =>
			trees.filter((tree) => tree.isSharedFocues).map((tree) => ({ filePath, tree })),
		);
		for (const { path: filePath, file } of importers) {
			const donors = sharedTrees.filter((s) => s.filePath !== filePath).map((s) => s.tree);
			treesByFile.set(filePath, getFocusTreeWithFocusFile(file, donors, filePath, {}, useCondition));
			yield;
		}
	}

	const reported = new Map<string, ReportedWarning[]>();
	const seen = new Set<string>();
	const add = (file: string, warning: ReportedWarning) => {
		const key = `${file}\n${warning.source}\n${warning.text}`;
		if (seen.has(key)) {
			return;
		}
		seen.add(key);
		const list = reported.get(file);
		if (list === undefined) {
			reported.set(file, [warning]);
		} else {
			list.push(warning);
		}
	};

	// 文件自己的树先来，使供养文件与国家树都携带的同一条警告以供养文件的树名列出。
	for (const ownTreesOnly of [true, false]) {
		for (const [filePath, trees] of treesByFile) {
			for (const tree of trees) {
				for (const warning of tree.warnings) {
					const definedIn = tree.focuses[warning.source]?.file ?? filePath;
					if ((definedIn === filePath) === ownTreesOnly) {
						add(definedIn, { treeId: tree.id, source: warning.source, text: warning.text });
					}
				}
			}
		}
	}

	return [...reported.entries()].map(([file, warnings]) => ({ file, warnings }));
}

function oneLine(text: string): string {
	return text.replace(/\s*[\r\n]+\s*/g, " ").trim();
}

/** 一个文件的警告作为 Markdown 小节：复制按钮为它的树复制的正是这一段。 */
export function formatFileWarnings(file: FileWarnings): string {
	const lines = [`## ${file.file}`, ""];
	if (file.parseError !== undefined) {
		lines.push(
			"- " + localize("focustree.audit.parsefailed", "Could not parse this file: {0}", oneLine(file.parseError)),
		);
	}
	for (const warning of file.warnings) {
		lines.push(`- \`${warning.source}\` (\`${warning.treeId}\`): ${oneLine(warning.text)}`);
	}
	return lines.join("\n") + "\n";
}

export function formatFocusWarningReport(files: FileWarnings[], checkedFileCount: number): string {
	const withProblems = files
		.filter((f) => f.warnings.length > 0 || f.parseError !== undefined)
		.sort((a, b) => a.file.localeCompare(b.file));
	const problemCount = withProblems.reduce(
		(sum, f) => sum + f.warnings.length + (f.parseError !== undefined ? 1 : 0),
		0,
	);

	const sections = [
		`# ${localize("focustree.audit.title", "Focus tree warnings")}`,
		localize(
			"focustree.audit.summary",
			"Checked {0} focus tree files: {1} warnings in {2} files.",
			checkedFileCount,
			problemCount,
			withProblems.length,
		),
	];
	if (withProblems.length === 0) {
		sections.push(localize("focustree.audit.nowarnings", "No warnings."));
	}
	return sections.join("\n\n") + "\n" + withProblems.map((f) => "\n" + formatFileWarnings(f)).join("");
}

function isWarningList(value: unknown): value is { source: string; text: string }[] {
	return Array.isArray(value) && value.every(
		(w) => isRecord(w) && typeof w.source === "string" && typeof w.text === "string",
	);
}

/**
 * 应答预览的复制按钮：`msg` 是网页端为屏幕上那棵树发来的内容，`file` 是被预览的文件。
 * 剪贴板拿到的是审计报告里同格式的一段，段标题固定是预览文件——读的人正看着它；报告则按
 * 警告来源焦点所在文件归集，共享焦点的条目因而可能出现在报告的另一段落里。
 */
export async function copyTreeWarnings(msg: unknown, file: string): Promise<void> {
	if (!isRecord(msg) || typeof msg.treeId !== "string" || !isWarningList(msg.warnings)) {
		return;
	}
	if (msg.warnings.length === 0) {
		void vscode.window.showInformationMessage(
			localize("focustree.copywarnings.none", "This focus tree has no warnings."),
		);
		return;
	}
	const treeId = msg.treeId;
	const warnings = msg.warnings.map((w) => ({ treeId, source: w.source, text: w.text }));
	try {
		await vscode.env.clipboard.writeText(formatFileWarnings({ file, warnings }));
		void vscode.window.showInformationMessage(
			localize("focustree.copywarnings.done", "Copied {0} warnings.", warnings.length),
		);
	} catch (e) {
		error(e);
		void vscode.window.showErrorMessage(
			localize("focustree.copywarnings.failed", "Could not copy the warnings: {0}", `${e instanceof Error ? e.message : e}`),
		);
	}
}

/** 读取并检查每个焦点树文件；读者取消时返回 undefined。 */
export async function buildFocusTreeAuditReport(
	progress: ProgressReport,
	includeVanilla: boolean,
): Promise<string | undefined> {
	const options = { hoi4: includeVanilla };
	const files = (await listFilesFromModOrHOI4(focusFolder, options))
		.filter((file) => file.toLowerCase().endsWith(".txt"))
		.map((file) => `${focusFolder}/${file}`);

	let done = 0;
	const loaded = await loadBounded(files, async (filePath) => {
		if (progress.token.isCancellationRequested) {
			return undefined;
		}
		try {
			const [buffer] = await readFileFromModOrHOI4(filePath, options);
			if (progress.token.isCancellationRequested) {
				return undefined;
			}
			// 索引只要名字与值；位置 token 会显著抬高整轮审计的峰值内存。
			const node = parseHoi4File(buffer.toString(), "", { keepTokens: false });
			return { path: filePath, file: convertFocusFileNodeToJson(node, {}) };
		} catch (e) {
			return { path: filePath, parseError: e instanceof Error ? e.message : String(e) };
		} finally {
			progress.report(++done, files.length);
		}
	});

	if (progress.token.isCancellationRequested) {
		return undefined;
	}

	const parsed = loaded.filter((f): f is ParsedFocusFile => "file" in f);
	const failed: FileWarnings[] = loaded
		.filter((f): f is { path: string; parseError: string } => "parseError" in f)
		.map((f) => ({ file: f.path, warnings: [], parseError: f.parseError }));

	const warnings = await collectFocusWarningsAsync(parsed, progress.token);
	if (warnings === undefined) {
		return undefined;
	}

	return formatFocusWarningReport([...warnings, ...failed], files.length);
}

function reportFolderUri(folder: string): vscode.Uri {
	if (path.isAbsolute(folder)) {
		return vscode.Uri.file(folder);
	}
	const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
	if (workspaceFolder === undefined) {
		throw new Error(
			localize(
				"focustree.audit.noworkspace",
				"The report folder {0} is relative, but no workspace folder is open. Use an absolute path.",
				folder,
			),
		);
	}
	return vscode.Uri.joinPath(workspaceFolder.uri, folder);
}

async function showReport(report: string, folder: string): Promise<void> {
	if (folder === "") {
		const document = await vscode.workspace.openTextDocument({ language: "markdown", content: report });
		await vscode.window.showTextDocument(document);
		return;
	}
	const folderUri = reportFolderUri(folder);
	await vscode.workspace.fs.createDirectory(folderUri);
	const reportUri = vscode.Uri.joinPath(folderUri, auditReportFileName);
	await vscode.workspace.fs.writeFile(reportUri, Buffer.from(report, "utf8"));
	await vscode.window.showTextDocument(reportUri);
}

export async function auditFocusTrees(): Promise<void> {
	sendEvent("auditFocusTrees");
	const config = getConfiguration();
	const folder = (config.get<string>("auditor.reportFolder") ?? "").trim();
	const includeVanilla = config.get<boolean>("auditor.includeVanilla") ?? false;

	try {
		const report = await withCancellableProgress(
			localize("focustree.audit.progress", "Checking focus trees"),
			(progress) => buildFocusTreeAuditReport(progress, includeVanilla),
		);
		// 取消什么都不说：读者按了取消，他本来就知道。
		if (report !== undefined) {
			await showReport(report, folder);
		}
	} catch (e) {
		error(e);
		void vscode.window.showErrorMessage(
			localize("focustree.audit.failed", "Checking the focus trees failed: {0}", `${e instanceof Error ? e.message : e}`),
		);
	}
}

export function registerAuditFocusTreesCommand(): vscode.Disposable {
	return vscode.commands.registerCommand(Commands.AuditFocusTrees, auditFocusTrees);
}
