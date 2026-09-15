# Agent Note: `/journey export` —— 时间线与会话日志打包为 ZIP

Status: implemented

[English](2026-09-12-journey-export-zip.md) | 中文

## 问题

运维人员需要一个可携带的产物，把某个作用域的演进状态与产生该状态的对话一并带走——用于缺陷报告、归档或外部评审——而 `/journey` 渲染命令只把时间线打印成文本。

## 决策

`/journey export [range] [--out <path>]` 把 `timeline.json`（该作用域在给定区间内的演进活动）与发起调用的会话日志 `session-log.jsonl` 打包进同一个 ZIP 归档。该命令加入 `command-evolution/src/index.ts`，与既有的 `/journey` 渲染命令并列。

`executeJourneyExport()`：

1. 解析 `[range]`（默认 `7d`）与 `--out <path>`（默认 `$DSH_HOME/exports/journey-<scope>-<range>.zip`）。
2. 与渲染路径完全一致地调用 `scopeTimeline()`。
3. 经 `snapshotEvents()` 读取会话的事件日志（该接口已弃用，却是唯一的单次访问），并用 `@deepseek-ai/dsh-session-log-export` 的 `serializeSessionLog` 序列化。
4. 用 `fflate` 的 `zipSync` 同步生成 ZIP。
5. 对父目录执行 `mkdir -p` 后写入输出路径。

`parseJourneyExportArgs()` 沿用 `parseTrajectoryArgs()` 的文法；`JourneyExportArgs.range` 经 `isUsageRange` 校验后类型为 `UsageRange`；本改动新增 `fflate`（生产依赖）与 `@deepseek-ai/dsh-session-log-export`（对等依赖），并新增指向 `session-log-export/tsconfig.host.json` 的 TypeScript 项目引用。

## 考虑过的替代方案

**从持久化中读取会话日志，而不是用 `snapshotEvents()`。** 这个已弃用的接口是访问发起调用会话事件的唯一单次途径，因此导出继续使用它，并就地留下后续动作：`snapshotEvents` 被移除时改为内联序列化器。

**复用 `@deepseek-ai/dsh-session-log-export` 已有的流式 ZIP 写入器。** 打包内容只是两个小的内存缓冲区，命令里同步的 `zipSync` 调用已经够用，流式 `Zip` API 留给真正需要它的会话日志导出。

**直接调用 `parseTrajectoryArgs()` 解析参数。** 导出接受一个 `[range]` 位置参数，而 trajectory 文法没有它的位置，因此 `parseJourneyExportArgs()` 沿用其形状，而不是委托给它。

## 影响

某个作用域的时间线与产生它的对话现在作为一个文件流转，且默认输出路径落在 `$DSH_HOME/exports/` 下，而不是作用域自行指定的位置。代价是上文的生产依赖、对等依赖与项目引用，以及打包仍要经由已弃用的 `snapshotEvents()` 访问。

## 测试

`command-evolution.spec.ts` 中的 `'exports journey timeline and session log to a zip file'` 验证：

- 成功结果带有预期的输出路径。
- ZIP 中恰好包含 `timeline.json` 与 `session-log.jsonl`。
- `timeline.json` 可解析，并具有预期的顶层键（`days`、`cumulative`、`pending`）。
- `session-log.jsonl` 以会话头记录开头，其 `id` 匹配。
