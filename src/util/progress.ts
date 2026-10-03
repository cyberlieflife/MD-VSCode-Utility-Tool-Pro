import * as vscode from "vscode";
import { localize } from "./i18n";

/** 一个长任务运行期间汇报进度、并观察取消的地方。 */
export interface ProgressReport {
	/** 已完成文件数与已知总数，显示在标题下面的消息里。 */
	report(done: number, total: number): void;
	/** 用户在该任务的提示上按取消时被置位。 */
	readonly token: vscode.CancellationToken;
}

/** 给无法取消的任务、以及在真实令牌到达之前的窗口使用的令牌。 */
export const uncancelledToken: vscode.CancellationToken = {
	isCancellationRequested: false,
	onCancellationRequested: () => ({ dispose: () => undefined }),
};

// 每次汇报都要过一次渲染进程，按解析的文件逐个汇报会在通道上压上千条消息——而且那么快的
// 计数也没有人读得过来。
const progressRenderInterval = 100;

/**
 * 在标题为 `title` 的可取消提示下运行 `work`。
 *
 * 刻意不用索引那套共享进度：它把标题写死成"正在索引工作区"，并让其下所有构建共用同一个取消
 * 令牌——对应当一起停止的后台构建是对的，对这里不对。用户刚刚主动发起的扫描要有自己的名字，
 * 在它上面按取消不能顺带取消恰好同时在跑的索引构建。
 */
export async function withCancellableProgress<T>(
	title: string,
	work: (progress: ProgressReport) => Promise<T>,
): Promise<T> {
	type Handle = {
		report: vscode.Progress<{ message?: string }>;
		token: vscode.CancellationToken;
	};

	let markReady: (handle: Handle) => void = () => undefined;
	const ready = new Promise<Handle>((resolve) => {
		markReady = resolve;
	});

	// 提示一直显示到它 resolve，finally 里做的正是这件事。
	let markFinished: () => void = () => undefined;
	const finished = new Promise<void>((resolve) => {
		markFinished = resolve;
	});

	// 提示自身打不开时（宿主同步抛错或异步拒绝）以不可取消的句柄继续，任务仍能跑完，而不是
	// 永远挂在 ready 上。
	const continueUncancelled = () =>
		markReady({ report: { report: () => undefined }, token: uncancelledToken });

	try {
		void vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title,
				cancellable: true,
			},
			(report, token) => {
				markReady({ report, token });
				return finished;
			},
		).then(undefined, continueUncancelled);
	} catch {
		continueUncancelled();
	}

	const handle = await ready;
	let lastRenderAt = 0;

	try {
		return await work({
			token: handle.token,
			report: (done, total) => {
				const now = Date.now();
				if (now - lastRenderAt < progressRenderInterval) {
					return;
				}
				lastRenderAt = now;
				handle.report.report({
					message: localize("progress.files", "{0} / {1} files", done, total),
				});
			},
		});
	} finally {
		markFinished();
	}
}
