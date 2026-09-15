# Agent Note: manifest 一致性（全量清扫批次 2）

Status: implemented

[English](2026-09-13-manifest-conformance-batch-2.md) | 中文

## 问题

`pnpm run constraints` 在五类问题上失败——本批为全量清扫修复的第 2 批（日期 2026-09-13，设计见 `docs/superpowers/specs/2026-09-13-full-sweep-fixes-design.md`）；五类问题都已在本批次修复：

1. 七个 manifest 仍带 `0.1.5-alpha.1`，而根包（以及 `checkDshFamilyVersion` 中的 dsh 家族规则）要求 `0.1.5-rc.2`：`client/ui-progress`、`client/ui-usage-dashboard`、`client/ui-workspace-memory`、`context/workspace-memory-context`、`session/usage-ledger`、`workspace/workspace-memory`、`workspace/workspace-memory-llm`。
2. `client/ui-usage-dashboard` 发布了 `lib/types/**/*.js`，但没有任何 export 默认指向 `./lib/types/`（`usesEmittedTreeDefaults` 为 false），因此该条目是陈旧的。
3. `client/hmr` 确实会产出 `lib/watch.js` 以及带哈希的 `lib/bundle-watch-*.js`（已在 `packages/client/hmr/lib/` 中对照 `./watch` 导出核实），所以错的是门禁，而不是 manifest。
4. `packages/client/ui-sidebar-textpreview/` 只剩 `lib/` 与 `node_modules`，没有任何已跟踪文件：这是已删除包留下的未跟踪残留。
5. `experimental/webworker-packer` 的 CLI 早已在 `verify-application-entrypoints.ts:26-46` 中归类为仅构建用的私有包，且该门禁通过。

## 决策

1. 七个版本号逐包各改一行提升到位。
2. 删除陈旧的 `files` 条目；`./remote` 导出一向由 `hasTypertRemoteNavigation` 预期，保持不动。
3. 经既有的 `packageFileExtras` 逃生口声明真实产出，并把该 manifest 的 `files` 重排为门禁的规范顺序（extra 排在 `lib/client.js` 之后）。
4. 从磁盘删除该无 manifest 目录，它没有任何可提交内容。
5. 对 `webworker-packer` CLI 不做改动，记录为已处理。

## 考虑过的替代方案

**让 `scripts/clean.ts` 删除没有 manifest 的包目录。** 该方案被延期：`clean` 有意拒绝这类目录（第 113 行），而自动删除未知目录比这次一次性手工删除风险更高。

**放宽约束门禁的默认文件列表，而不是按包声明产出。** 只有 `client/hmr` 会产出带哈希的 watch 包，因此既有的 `packageFileExtras` 逃生口既能让共享的文件规则保持窄小，又能把包特有的知识留在 manifest 中。

**让 `client/ui-usage-dashboard` 真正默认指向 `./lib/types/`，使已发布的 glob 成立。** 那里没有任何 export 默认指向（`usesEmittedTreeDefaults` 为 false），因此该条目相对该包实际发布的导出面就是陈旧的；修复应落在 `files` 上。

## 影响

没有运行时代码改动，因此预期没有行为或快照变化；本批次只改 `version` 与 `files` 字段，并删除一个不含已跟踪文件的未跟踪目录。

## 验证

`node --import tsx/esm scripts/check-workspace-constraints.ts` 以 0 退出，且没有任何违规行（此前为：7 个版本 + 2 个 files + 1 个层级错误）。
