# Agent Note：技能加载获得结果信号，简报在容量耗尽前预警

Status: implemented

[English](2026-09-16-batch3-outcome-telemetry.md) | 中文

## Problem

Review-v6 Batch 3 要求结果遥测（`SkillUsageRecord` 上的 `lastOutcome`/`failureCount`）以及内存容量 80% 时的早期警告——这是每个下游优化（GEPA 触发器、curator staging 过滤器、技能成功率）都要读取的开关。读代码时发现的两个事实改变了该 batch 的形状。

第一，review 描述的接线部分与实际不符。`markUsed` 确实有一个生产写入者——遥测 store 中的被动 `tools/post-execute` 观察器统计成功的 `skill` 工具加载——但没有任何地方记录失败，因此 `useCount` 在流动，而信号的失败一半没有流动。只加字段而不加写入者就是死数据。

第二，容量警告已有现成的安放处：`dsh-evolution-memory-context` 的简报头已打印 `Memory usage: used/cap (pct%)`，而 store 在超过 100% 时已硬拒绝（`evolution/capacity-exceeded`）。缺的只是健康与存满之间的早期警告。

## Decision

**结果遥测。**`SkillUsageRecord` 新增两个可选字段——`failureCount?: number`（首次失败前缺席）与 `lastOutcome?: 'ok' | 'failed'`——因此此前写入的记录读回时保持不变。`markUsed` 盖上 `lastOutcome: 'ok'`（它只在成功时运行，因此该标记是诚实的，而非默认值），新增的 `markFailed` 对随包附带与 `hub*` 来源沿用同样的排除语义，累加 `failureCount` 并盖上 `'failed'`。同一个 `tools/post-execute` 观察器是唯一的写入者：失败的 `skill` 工具加载现在调用 `markFailed`，而此前不记录任何东西。消费者按 `failureCount / (useCount + failureCount)` 计算失败率，该公式写在字段文档上，Batch 5 的触发器不会与 store 的含义分叉。刻意不接线：回合级任务结果（技能的建议是否真起作用）——`skill` 工具加载成功不代表回合成功，定义该信号属于拿着 scorer 数据的 GEPA batch，而非加载计数器。

**容量警告。**`dsh-evolution-memory-context` 新增经校验的 `capacityWarnPct` Config 字段（默认 0.8，沿用 `cacheHitAlertThreshold` 的比例模式），经 `EvolutionBriefInput` 穿入头部渲染。达到或超过阈值时，头部追加 `— near capacity: consolidate instead of adding`，早于 store 的硬拒绝。拒绝本身不动：先拒绝仍比自动合并更安全。

## Alternatives considered

- **只加字段、不加写入者** —— review 假定的接线方式。未采用：没有任何地方记录失败时，`useCount` 照常流动，而 `failureCount` 是死数据。
- **把两个字段设为必填** —— 未采用：可选字段让本次改动之前写入的记录原样读回，无需迁移。
- **现在就接回合级任务结果** —— 未采用：`skill` 工具加载成功不代表回合成功，定义该信号属于拿着 scorer 数据的 GEPA batch。
- **到阈值就自动合并，而不是预警** —— 未采用：保留 store 的硬拒绝，先拒绝比自动合并更安全。

## Consequences

失败的 `skill` 工具加载现在会写入记录，而此前什么都不写，因此 `lastOutcome`/`failureCount` 由真实流量填充，review 点名的读者——curator staging 过滤器、技能成功率、Batch 5 的触发器——拿到了它们各自指标所假定的值。改动前落盘的记录读回不变：两个字段均可选，且 `markUsed` 只在加载成功时盖章。

简报头现在在用量达到 `capacityWarnPct`（默认 0.8）时追加 `— near capacity: consolidate instead of adding`。该行只是提示：store 仍在超过 100% 时硬拒绝（`evolution/capacity-exceeded`），忽略警告换来的是时间，不是余量。

代价：同一份记录形状上现在有两个写入者（`markUsed`、`markFailed`），随包附带与 `hub*` 来源的排除语义随之重复；失败率定义写在字段文档里而非某个 helper 中，每个消费者都要自己套用。信号也止步于加载成功——回合级结果仍未接线（见 Deferred）。

## Testing

遥测：`markFailed` 为零使用的记录播种、ok→failed→ok 流转、随包来源排除，以及端到端观察器测试（`skill` fixture 对特定名称抛错，失败加载记 `failureCount: 1` 且无使用计数）。上下文：阈值处、高于与低于阈值的头部警告、自定义阈值，以及加载期对越界值的拒绝。两个包的作用域覆盖率在语句、分支、函数与行上均为 100%；依赖方（`evolution-curator`、`command-evolution`、`evolution-skill-manage`、`evolution-memory`）308 个测试无改动通过。

## Deferred

回合级技能结果（任务成功，而非加载成功）；若有加载路径绕过 `skill` 工具则补 `markUsed` 覆盖缺口；GEPA 触发器与优化器（Batch 5-6），它们现在有了要读取的信号。
