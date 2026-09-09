# Agent Note: 只读并发标记与编辑器提权对等

Status: implemented

[English](2026-09-09-read-only-concurrency-editor-escalation.md) | 中文

## Problem

只读工具错过了调度器的并行分发信号：`lsp`、`glob` 与 `grep` 从不设置 `isConcurrencySafe`，PTC 分发器无法把它们与变更型工具区分开；LSP 描述从不说同一 workspace 的查询会串行。`str_replace_editor` 映射沙箱拒绝时，没有通告 `tool-fs` write/edit 提供的 `sandbox_permissions`/`justification` 重试，于是被拒的编辑器变更给模型留了一条没有提权路径的死路。

## Decision

`lsp`、`glob` 与 `grep` 设置 `isConcurrencySafe: () => true`；LSP 描述记录按 workspace 串行，并推荐顺序或跨 workspace 扇出；其 `line`/`character` schema 从 `number` 收窄为 `integer` 以匹配运行时校验。`str_replace_editor` 在受限后端下通告 `sandbox_permissions`/`justification`，经配对校验与大声 misconfiguration 错误走批准提权策略解析变更，把拒绝映射为共享标记加提权提示。workflow 与 `ralph` 保持无标记，因为脚本执行有副作用。

## Alternatives considered

**把 workflow 与 `ralph` 标记为并发安全。** 已拒绝，因为脚本与循环执行会改变状态；该标记只属于无副作用的读操作。

**按 session id 共享任务限额，或对未结算调用判不变式失败。** 已拒绝，因为现有测试钉死了两个约定：限额按精确 owner 对象计算，step 结束允许未结算调用以便修复闭包。

**在工具调用输出上让压缩大声失败，或发布默认遥测规则。** 已拒绝，因为摘要器约定把工具调用留在 `rawOutput` 中只投影文本，而遥测保持无规则默认加可选辅助函数。

## Consequences

并行调度器分发认得出只读工具，LSP 扇出指引与提供方现实一致，编辑器拒绝携带与 `tool-fs` 相同的重试路径，工具目录携带收窄后的 LSP 坐标。
