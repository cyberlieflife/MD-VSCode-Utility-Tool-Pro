import * as vscode from 'vscode';
import { Commands, ConfigurationKey, ContextName } from '../constants';
import { setVscodeContext } from '../context';
import { localize } from '../util/i18n';
import { Logger } from '../util/logger';
import { getConfiguration } from '../util/vsccommon';
import { ModTool, ModToolPack } from './api';
import { modToolPacks } from './registry';

// 托管 registry.ts 里的模组 pack，与扩展其余部分隔离：这是 src/modtools/ 之外唯一被导入的模块
// （只由 extension.ts 导入），这里没有东西能从注册中抛出，每一次进入 pack 的调用——找它的模组、
// 运行一个工具——都各自受保护，坏掉的 pack 只赔上它自己的工具。

export const modToolsSection = `${ConfigurationKey}.modTools`;

export interface ModToolHostEnvironment {
    /** 总开关，`modTools.enabled`。 */
    enabled(): boolean;
    /** 某个工具自己的开关，`modTools.<pack>.<tool>`。 */
    toolEnabled(pack: ModToolPack, tool: ModTool): boolean;
    isWeb: boolean;
    isTrusted(): boolean;
    folders(): readonly vscode.Uri[];
    exists(uri: vscode.Uri): Promise<boolean>;
}

export interface AvailableModTool {
    readonly pack: ModToolPack;
    readonly tool: ModTool;
    readonly modRoot: vscode.Uri;
}

export function toolSettingKey(pack: ModToolPack, tool: ModTool): string {
    return `modTools.${pack.id}.${tool.id}`;
}

function log(pack: ModToolPack, message: string): void {
    Logger.info(`[Mod tools] ${pack.displayName}: ${message}`);
}

function messageOf(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
}

async function findModRoot(pack: ModToolPack, env: ModToolHostEnvironment): Promise<vscode.Uri | undefined> {
    for (const folder of env.folders()) {
        const found = await Promise.all(pack.detect.files.map(file => env.exists(vscode.Uri.joinPath(folder, file))));
        if (found.length > 0 && found.every(Boolean)) {
            return folder;
        }
    }
    return undefined;
}

/**
 * 此刻能在本工作区运行的工具：总开关打开、pack 的模组已打开、工具已开启且此处允许（桌面、信任）。
 * 查看时抛出的 pack 被记录并跳过，其余仍然列出。
 */
export async function findAvailableModTools(
    packs: readonly ModToolPack[], env: ModToolHostEnvironment,
): Promise<AvailableModTool[]> {
    if (!env.enabled()) {
        return [];
    }
    const result: AvailableModTool[] = [];
    for (const pack of packs) {
        try {
            const tools = pack.tools.filter(tool =>
                env.toolEnabled(pack, tool)
                && !(tool.desktopOnly && env.isWeb)
                && !(tool.requiresTrust && !env.isTrusted()));
            if (tools.length === 0) {
                continue;
            }
            const modRoot = await findModRoot(pack, env);
            if (modRoot) {
                result.push(...tools.map(tool => ({ pack, tool, modRoot })));
            }
        } catch (e) {
            Logger.error(`[Mod tools] ${pack.displayName} could not be loaded and is skipped: ${messageOf(e)}`);
        }
    }
    return result;
}

/**
 * 运行一个工具。它抛出的任何东西都在这里结束，变成一条指名维护该工具的模组团队、并给出其 issue
 * 追踪器的消息——本扩展不为模组工具提供支持。
 */
export async function runModTool({ pack, tool, modRoot }: AvailableModTool): Promise<void> {
    try {
        await tool.run({ modRoot, log: message => log(pack, message) });
    } catch (e) {
        Logger.error(`[Mod tools] ${pack.displayName} / ${tool.title} failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
        const report = localize('modtools.report', 'Report to {0}', pack.maintainer.name);
        const choice = await vscode.window.showErrorMessage(
            localize('modtools.failed',
                'Mod tool "{0}" failed: {1}. This tool is maintained by {2}, not by this extension; please report it to them.',
                tool.title, messageOf(e), pack.maintainer.name),
            report,
        );
        if (choice === report) {
            await vscode.env.openExternal(vscode.Uri.parse(pack.maintainer.issues));
        }
    }
}

type ModToolPickItem = vscode.QuickPickItem & { available?: AvailableModTool };

export function pickItems(available: readonly AvailableModTool[]): ModToolPickItem[] {
    const items: ModToolPickItem[] = [];
    let lastPack: ModToolPack | undefined;
    for (const entry of available) {
        if (entry.pack !== lastPack) {
            items.push({ label: entry.pack.displayName, kind: vscode.QuickPickItemKind.Separator });
            lastPack = entry.pack;
        }
        items.push({ label: entry.tool.title, description: entry.tool.description, available: entry });
    }
    return items;
}

function vscodeEnvironment(): ModToolHostEnvironment {
    return {
        enabled: () => getConfiguration().get<boolean>('modTools.enabled', false) === true,
        toolEnabled: (pack, tool) => getConfiguration().get<boolean>(toolSettingKey(pack, tool), true) !== false,
        isWeb: IS_WEB_EXT,
        isTrusted: () => vscode.workspace.isTrusted,
        folders: () => (vscode.workspace.workspaceFolders ?? []).map(folder => folder.uri),
        exists: async uri => {
            try {
                await vscode.workspace.fs.stat(uri);
                return true;
            } catch {
                return false;
            }
        },
    };
}

/**
 * 注册 Run Mod Tool 命令并让 `mdHoi4ModToolsAvailable` 保持最新。从不抛出：连模组工具都设置不了
 * 时，扩展其余部分照常运行。
 */
export function registerModTools(
    packs: readonly ModToolPack[] = modToolPacks,
    env: ModToolHostEnvironment = vscodeEnvironment(),
): vscode.Disposable {
    const disposables: vscode.Disposable[] = [];
    try {
        let generation = 0;
        const refresh = async () => {
            const current = ++generation;
            let available = false;
            try {
                available = (await findAvailableModTools(packs, env)).length > 0;
            } catch (e) {
                Logger.error(`[Mod tools] ${messageOf(e)}`);
            }
            if (current === generation) {
                setVscodeContext(ContextName.ModToolsAvailable, available);
            }
        };

        disposables.push(vscode.commands.registerCommand(Commands.RunModTool, async () => {
            const available = await findAvailableModTools(packs, env);
            if (available.length === 0) {
                await vscode.window.showInformationMessage(localize('modtools.none',
                    'No mod tools are available here. Switch them on under Settings > Mod tools, and open the mod they belong to.'));
                return;
            }
            const picked = await vscode.window.showQuickPick(pickItems(available), {
                placeHolder: localize('modtools.pick', 'Choose a mod tool. Mod tools are maintained by their mods, not by this extension.'),
            });
            if (picked?.available) {
                await runModTool(picked.available);
            }
        }));
        disposables.push(vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration(modToolsSection)) {
                void refresh();
            }
        }));
        disposables.push(vscode.workspace.onDidChangeWorkspaceFolders(() => void refresh()));
        disposables.push(vscode.workspace.onDidGrantWorkspaceTrust(() => void refresh()));
        void refresh();
    } catch (e) {
        Logger.error(`[Mod tools] could not be set up: ${messageOf(e)}`);
    }
    return vscode.Disposable.from(...disposables);
}
