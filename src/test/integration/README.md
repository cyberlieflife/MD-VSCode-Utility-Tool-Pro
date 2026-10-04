# 测试层次

| 层次 | 位置 | 跑法 |
| --- | --- | --- |
| 宿主单元测试 | `src/test/*.test.ts` | `npm test`（或见下） |
| webview 单元/DOM 测试（jsdom） | `src/test/webview/*.test.ts` | 同上 |
| 跨模块集成测试（真实临时 mod 目录） | `src/test/integration/*.test.ts` | 同上 |

本仓库的 `npm test` 里 pretest 用了 `& wait`（bash 语法），在 Git Bash 下由 npm 调起 cmd 会失败。
手动方式：

```
npx tsc -p ./tsconfig.test.json && npx tsc -p ./tsconfig.webview.test.json
npx mocha --exit --require ./out-test/src/test/_vscode_stub.js \
  './out-test/src/test/**/*.test.js' './out-test-webview/src/test/webview/**/*.test.js'
```

## 打桩约定

- 宿主侧：`_vscode_stub.js` 提供最小 `vscode` 模块；需要文件系统的用例把
  `vscode.workspace.fs.{stat,readFile,readDirectory}` 换成 node fs（见
  `src/test/integration/focustreeendtoend.test.ts` 与 `src/test/parentmods.test.ts`）。
- webview 侧：spec 首行 `import './setup'`（jsdom + `acquireVsCodeApi` 桩）。`setup.ts`
  记录页面 post 出的每条消息（`takePostedMessages`），并把页面上报的未捕获错误收集起来，
  在 `afterEach` 里判测试失败 —— 故意触发错误的用例要用 `takeRuntimeErrors()` 取走它。
- 依赖 webview 入口模块的 spec 先 `delete require.cache[...]` 再 `await import(...)`，
  这样它拿到的是自己的一份实例（`focustreeinteractions.test.ts` 的 `ready` 就依赖这一点）。

## 未迁移的上游测试设施

上游还带两套本仓库没有引入的设施，都需要仓库外的东西：

- **compat 基线**（`compat/`）：对 vanilla 与 Millennium Dawn 的真实 mod 各生成一份解析/警告
  基线快照，之后跑同一套扫描比对，捕捉解析回归。基线是几百 KB 的快照、生成时还要检出数 GB
  的真实 mod，本仓库既没有可缓存的 mod 也不在 CI 里跑它。
- **VS Code 集成测试**（`@vscode/test-electron` 起真实编辑器）与 webview 冒烟脚本：需要
  Electron 与浏览器依赖，同样属于 CI 工程。

若要引入：compat 用 `vendor/` 下的 mod 检出 + 一个 `generate`/`check` 脚本对（先入库基线，再在
CI 里比对）；集成测试装 `@vscode/test-electron` 后写 `runTest.ts`。两者都不影响现有测试。
