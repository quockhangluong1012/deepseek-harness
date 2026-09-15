# Agent Note: 整理器 CLI 子动词 —— `/curator adopt`、`purge`、`rollback`、`ledger`、`pin`、`unpin`

Status: implemented

[English](2026-09-12-curator-cli-verbs.md) | 中文

## 问题

`improvement.spec.md` 的 WireCountedTrigger 第 4 项要求 `/curator` 命令暴露整理器服务本就执行的整理操作。该命令止步于 `status` 与 `run`，因此用户无法从 CLI 认领 agent 创建的技能、清理已过期的技能、回滚某次记录在案的通过、读取通过台账，或把技能固定以免被清理。

## 决策

`packages/evolution/command-evolution/src/index.ts` 注册 6 个整理器子动词：

- **`/curator adopt <name>`** —— 调用 `curator.adopt(name)`，渲染成功或错误
- **`/curator purge [--dry-run]`** —— 调用 `curator.purge({ dryRun })`，渲染被清理的技能列表
- **`/curator rollback --id <id>`** —— 调用 `curator.rollbackPass(id)`，渲染被恢复的技能
- **`/curator ledger`** —— 调用 `curator.passes()`，渲染最新的通过排在最前
- **`/curator pin <name>`** —— 调用 `telemetry.setPinned(name, true)`，渲染成功
- **`/curator unpin <name>`** —— 调用 `telemetry.setPinned(name, false)`，渲染成功

参数校验发生在整理器解析之前，因此即便整理器未挂载，畸形输入也会报出用法——与原有 `status`/`run` 动词的行为一致。

pin 与 unpin 只需要 telemetry，不需要整理器；它们经 `ctx.get('evolutionSkillTelemetry')` 解析。错误信息从 `Error` 实例中提取 `.message`，以获得干净的输出。`executeCuratorRun` 被内联，而不再保留为一行包装。

## 考虑过的替代方案

**先解析整理器，再校验参数。** 拒绝：先校验才能让畸形命令在整理器未挂载时也报出用法，并让新动词与既有 `status`/`run` 动词保持同一行为。

**让 `pin`/`unpin` 也要求挂载整理器。** 拒绝：这两个动词只触碰 `telemetry.setPinned`，因此直接解析 `ctx.get('evolutionSkillTelemetry')`，在未挂载整理器的组合中依然可用。

**把 `executeCuratorRun` 保留为一行包装。** 舍弃：不增加任何行为的包装被内联，动词直接分派到通过执行器。

## 后果

六项整理操作现在可从命令面触达，缺失挂载时会报出错误，而不是静默失败。代价是命令面本身：每个动词的参数文法与错误路径都必须与整理器和 telemetry 服务保持同步，`command-evolution.spec.ts` 中 24 个新测试用例钉住它们。

## 测试

`command-evolution.spec.ts` 中 24 个新测试用例覆盖：

- 每个动词的参数解析（缺参/多参的用法错误）
- 成功路径及其预期输出文本
- curator/telemetry 服务方法的错误传播
- 整理器缺失 → 对整理器动词报出诚实的错误
