import * as vscode from 'vscode';

// 扩展与模组自带工具之间的契约。一个 pack 由它所属的模组编写与维护，不由本扩展维护：pack 必须
// 满足的要求见本目录的 README.md，坏掉的 pack 会被移除而不是在这里修好。

export interface ModToolPack {
    /** camelCase。也是每个设置键的中段：`mdHoi4Utilities.modTools.<id>.<toolId>`。 */
    readonly id: string;
    /** 模组名，显示在 Run Mod Tool 选择器与错误信息里。 */
    readonly displayName: string;
    /** 这个 pack 的负责人，工具失败时指名。 */
    readonly maintainer: ModToolMaintainer;
    /**
     * 宿主如何认出这个模组：某个工作区文件夹包含这里列出的全部文件（相对文件夹的路径）时，它就是
     * 模组根目录。只挑该模组独有的文件。
     */
    readonly detect: { readonly files: readonly string[] };
    readonly tools: readonly ModTool[];
}

export interface ModToolMaintainer {
    /** 模组团队，例如 "The <mod> team"。 */
    readonly name: string;
    /** 报告 pack 问题的 https:// 链接。 */
    readonly issues: string;
}

export interface ModTool {
    /** camelCase。工具设置键的最后一段。 */
    readonly id: string;
    /** 显示在选择器里。用 `localize` 本地化。 */
    readonly title: string;
    readonly description?: string;
    /** 需要 Node（子进程、VS Code 之外的文件系统）：网页版隐藏。 */
    readonly desktopOnly?: boolean;
    /** 会运行或读取工作区里的东西：工作区未被信任前隐藏。 */
    readonly requiresTrust?: boolean;
    run(context: ModToolContext): Promise<void>;
}

export interface ModToolContext {
    /** pack 的 `detect` 文件所在的那个工作区文件夹。 */
    readonly modRoot: vscode.Uri;
    /** 写入扩展的输出通道，前缀是 pack 名。 */
    log(message: string): void;
}
