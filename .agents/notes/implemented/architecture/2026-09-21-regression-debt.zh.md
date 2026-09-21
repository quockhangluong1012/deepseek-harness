# Agent Note: Curator 回归债务

Status: implemented

[English](2026-09-21-regression-debt.md) | 中文

## Problem

`specs/evolutionary-harness-v11-deep-research.md` §53 把 Metrics 升级为「学习速度 + 回归债务 + 能力前沿」。Curator 把失败技能 stage 到只追加的账本上，但跨 pass 没有逐失败的记忆：一个决定性的 `trigger_review` 失败连续存活五个 pass，与首次出现看起来完全一样；consolidation 也没有 backlog 指明循环尚未回答什么。

## Decision

每个技能的每个决定性失败对应一条 open debt，存于 `evolution_curator` 域（版本 2，与既有表并列）的 `debt` 表。`RegressionDebt`（`packages/evolution/evolution-curator/src/types.ts`）携带技能名、merge key、最新消息、首次/最近目击时间、连续 pass 数、上报会话数，以及打开它时的技能修订。每个 pass 对每个技能：新 merge key 以 1 个 pass 建 debt；重复目击则加深（最新消息、最多会话、pass 数加一）；修订变化则关闭旧 debt 并建新 debt，因为新正文尚未回答旧失败；变沉默的失败即使另一个仍在也关闭自己的 debt。`debt()` 同步列出全部 open debt——先按 pass 数，再按会话数，然后按名称与 merge key——`CuratorReport` 携带同一名单。Dry run 不写任何东西。键用 NUL 分隔符拼接名称与 merge key（`debtKeyOf`），使按技能的前缀扫描无歧义。Debt 命名失败，不命名裁决：consolidation 与未来的基准增长读到的是要瞄准什么，而不是已经决定了什么。

## Alternatives considered

- **在 staging 账本上加计数器**——拒绝：账本是「stage 过什么」的只追加证据，不是当前状态存储；逐失败的 open/close/deepen 语义不属于它。
- **把 debt 自动送入优化**——拒绝：debt 是回归 backlog，晋升仍归 consolidation 与 optimizer trigger；混为一谈会把每个 lingering 失败都变成一次优化运行。
- **任何无目击的 pass 全局关闭 debt**——按技能收窄：信号按技能归因，沉默只对变安静的那个技能有意义。

## Consequences

- Pass 报告现在以与 `debt()` 服务状态页面相同的形状携带未回答失败的 backlog。
- 按修订限定的 debt 使 `patch`/`consolidate` 裁决可证伪：旧失败只在新正文不再复现它时关闭；复现的新正文以 1 个 pass 重开，而不是继承一段它没造成的历史。
- 该域仍是这份状态的唯一副本，因此不发布 invariant 伴生包——README 按包规则记录了原因。

## Deviations from the plan

- 无：本切片只是 §53 回归债务行，限定在一个包、一张表、一个报告字段。

## Testing

- Curator 套件全绿（81 tests）：debt 生命周期（open、加深、沉默关闭、修订重置）、全序、dry-run 不写东西、feedback-store 失败不阻塞 pass。
- `reads fail before the curator starts` 补上同步 `debt()` 守卫。
- Curator README 以两种语言记录该表。

## Left alone

- 同一 §53 行的学习速度与能力前沿指标仍是未来切片。
- Optimizer 与 consolidation 不自动消费 debt：读者按需 opt in。
