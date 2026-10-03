import * as vscode from "vscode";
import { Commands } from "../constants";
import { describeLiveIndexBuilds } from "./indexCache";
import { localize } from "./i18n";
import { Logger } from "./logger";

// 「显示索引状态」命令：把正在进行的索引构建列成一行行说明（起止时间、当前阶段与进度）。
// 索引构建跑在后台，卡住时预览只是拿不到图标/本地化，只有这条命令能让读者看到它停在哪一步；
// 正常完成的构建会在日志里留下各自的耗时明细。
export function registerIndexStatusCommand(): vscode.Disposable {
	return vscode.commands.registerCommand(Commands.ShowIndexStatus, () => {
		const live = describeLiveIndexBuilds();
		const summary =
			live.length === 0
				? localize("indexStatus.idle", "No index build is running.")
				: localize(
						"indexStatus.running",
						"Index builds running: {0}",
						live.join("; "),
					);
		Logger.info(`[Index] status: ${summary}`);
		void vscode.window.showInformationMessage(summary);
	});
}
