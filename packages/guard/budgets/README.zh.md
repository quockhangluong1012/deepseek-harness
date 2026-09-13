---
description: "单轮次预算 guard：在每步之前检查 token 压力、工具调用与挂钟时间上限，供选择、配置或排查该 guard 的用户与维护者阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-budgets

[English](README.md) | 中文

## 概述

使用本包可为一个轮次能消耗多少设限。三项可选上限——实测请求压力、已分发的工具调用、挂钟时长——会在每个拟进入的步骤之前检查；任一项到达后，guard 会记录一条持久化的 `budget/exceeded` 事件、拒绝该步骤，轮次随即以 blocked 结束，而不是继续下去。认领了人类消息的步骤始终进入，因此预算绝不会丢弃用户说过的话；所有上限在未配置时都处于关闭状态。`dsh` web-app 组合包以三项上限全关的方式挂载本插件，部署可按组合逐项选择启用。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

当会话应当停下而不是继续在一个失控轮次上消耗时，挂载本插件。无配置时它只观察轮次、不拒绝任何步骤；每设置一项上限就启用一项约束。

### 何时选择

当无人值守或长周期运行的 agent 必须受到约束时选择它——永远不收敛的工具循环、持续数小时的轮次，或靠自身输出不断膨胀的上下文。当每个轮次都必须完整跑完才正确时避免使用；当你需要硬性中断时也不适用：guard 在步骤之间检查，因此它停止的是*下一个*模型请求，而不是已经发出的调用。它同样不适合会话级或按天预算，因为每个轮次都会重新获得完整的额度。

### 设置各项上限

按部署需要挂载插件并给出上限：

```yaml
- name: '@deepseek-ai/dsh-budgets'
  config:
    maxTotalTokens: 200000   # reject a step once measured request pressure reaches this
    maxToolCalls: 50         # reject a step once this many tool calls are dispatched in the turn
    maxWallMs: 600000        # reject a step once the turn has run this long
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `maxTotalTokens` | 未设置（关闭） | 单个步骤实测请求压力的上限，在该步骤之前比较 |
| `maxToolCalls` | 未设置（关闭） | 单个轮次内已分发工具调用的上限 |
| `maxWallMs` | 未设置（关闭） | 单个轮次挂钟时长的上限，从其 `turn/start` 起算 |

未设置的上限即处于关闭状态，因此无配置挂载的插件不会拒绝任何步骤。非正数或非有限值会让插件加载失败并给出明确错误，而不是悄悄关闭它所声明的上限；生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-budgets)是受支持取值的完整清单。

### 你会得到什么

当轮次到达某项已配置的上限时，guard 会记录一条持久化的 `budget/exceeded` 会话事件，指明上限、实测值、所配置的限值，以及它所停止的轮次与步骤；同时记录一条包含同样事实的警告；并拒绝拟进入的步骤。随后循环用它既有的 `blocked` 原因关闭该轮次——与历来拒绝步骤所产生的原因相同——且不新增 `TurnEndReason`。已经产生的工具结果保留在会话中，而下一个轮次以全新事实开始——它自己的 `turn/start` 会重置工具调用计数与挂钟起点。

该事件为 log-only 且读取时必需：它不携带 `ignorable` 标记，因此不认识该类型的读取方会直接拒绝整份日志，而不是丢弃这次切断。其 payload 与声明位置见生成的[持久化目录](../../../docs/persistence-catalog.zh.md#budgetexceeded--log-only)。

有两处的顺序很关键。人类输入优先：如果某步骤认领的消息中包含 `source.kind === 'user'` 的一条，该步骤就会进入，甚至不会评估各项上限，因此拒绝永远不会丢弃用户消息或 steer 指令。检查按代价从低到高进行——先工具调用，再挂钟时间，最后才是 token 测量——因此已经越过较廉价上限的轮次不必为其日志的重放付出代价。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释 guard 如何获知一个轮次的活动、在何处否决，并指出实现它的代码位置；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计理念

guard 建立在四项承诺之上：

- **在真实存在的否决边界上强制执行。** `agent/pre-step` 是已声明的 waterfall，循环本就把它的拒绝转换为 `{ kind: 'blocked' }`；`agent/turn-stopping` 是没有否决位置的停止事件，在其上挂监听器只会是无效负担。与规范中计划执行点之间的完整偏差记录在 [guard-budgets Agent Note](../../../.agents/notes/implemented/feature/2026-09-12-guard-budgets.zh.md) 中。
- **事实，而非历史。** 每个轮次的事实保存在 `WeakMap<Session, TurnFacts>` 中，由投递的 `session/event` 维护——从不同步读取会话日志——因此恢复或分叉的会话不产生额外代价，也不需要新的投影。
- **人类输入高于一切上限。** 认领的消息本就应当被投递；拒绝携带用户消息的步骤会将其丢弃，因此 guard 选择委派。
- **上限是配置，不是常量。** 每个约束都是可在 `cordis.yml` 中更改的可选且经校验的 `Config` 字段；没有隐藏默认值，也没有测试钩子。

### 轮次如何被观察与切断

一个 `session/event` 监听器构建事实：`turn/start` 写入 `{ turn, startedAt: event.time, toolCalls: 0 }`，`tool/call` 在条目存在时递增 `toolCalls`，其余事件类型一律忽略。由于条目只由插件亲眼观察到的 `turn/start` 创建，插件加载时已经打开的轮次没有事实，也就永远不会被切断。

一个 `agent/pre-step` 监听器评估拟进入的步骤。当 agent 的会话没有事实、事实属于另一个轮次、认领的消息带有 `source.kind === 'user'`，或未配置任何上限、也没有任一项到达时，它原样委派。否则它通过会话自身的 append 路径追加 `budget/exceeded` 事件，记录那一条警告，并返回 `{ kind: 'reject' }`，且不调用 `next()`——这正是 Cordis waterfall 定义的短路：后续监听器不再运行，循环记下 `blocked`。事件在拒绝之前写入，因此即使进程随该轮次一同结束，持久日志也带着这次切断的原因；警告与事件陈述同样的事实，而轮次的 `blocked` 结束仍是读取方重建出的结果。

### 各项上限分别比较什么

`maxToolCalls` 比较该轮次已计入的 `tool/call` 事件数。`maxWallMs` 用 `Date.now() - facts.startedAt` 与该轮次自身的 `turn/start` 时间戳比较，因此是挂钟时间而非 CPU 时间。`maxTotalTokens` 比较 `ctx.tokenMeter.measure(agent.session).totalTokens`——计量器对请求总压力的估算，它在安全时复用提供方用量，否则重新计价当前 surface；这是对请求的测量，不是账单。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`Config` schema、加载期失败即报的校验、轮次事实与 pre-step 监听器 |
| [`src/types.ts`](src/types.ts) | 持久化的 `budget/exceeded` payload、共享的上限名词汇，以及 `SessionEventMap` 合并 |
| — | 不发布运行时不变式伴生入口；guard 拥有一个由自身监听器消费的弱引用会话事实表，而伴生入口从日志重新推导轮次事实所观察到的仍是同一批事件，而非独立关系。 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。它们从 pre-step 边界逐步进入循环的轮次生命周期、实测压力与 guard 组映射。

- [Agent 包参考](../../../packages/core/agent/README.zh.md)——`agent/pre-step` waterfall 与循环理解的 `PreStepDecision` 取值。
- [工具子系统参考](../../../docs/subsystems/tools.zh.md)——产生本 guard 所计 `tool/call` 事件的 `tools/execute` 流水线。
- [guard-budgets Agent Note](../../../.agents/notes/implemented/feature/2026-09-12-guard-budgets.zh.md)——本包的设计、人类输入规则，以及它所拒绝的执行点。
- [生成配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-budgets)——每个受支持的上限及其源声明。
- [guard 组映射](../README.zh.md)——同组的 guard 包与循环卫生家族。

-----

<a id="model-experience"></a>
## 模型体验

### 条件性轮次终止

#### 模型看到什么

不添加提示词、工具 schema 或消息文本。上限到达意味着该轮次的下一次请求根本不会发出：轮次以循环的 `blocked` 原因关闭，而模型的下一次请求是下一个轮次组装的任何内容。已经产生的工具结果保留在日志中，因此其内容不会对后续轮次隐藏。

#### Token 影响

不增加 token；测量本身不发送任何内容。到达上限会省下它阻止的每个步骤的提示词、工具 schema 与输出，这正是设限的目的。

#### KV Cache 影响

仅追加；拒绝步骤不会向请求 surface 添加任何内容，因此现有 KV Cache 条目仍可复用。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明 guard 何时不合适。它们是当前包约束，不是任务积压。

- **读取时必需的事件**——`budget/exceeded` 记录不携带 `ignorable` 标记（append 路径无法写入该标记），因此比该事件更早的 harness 会拒绝整份日志，而不是跳过这次切断。读取由更新的 harness 切断过的日志前，请先升级读取方。
- **没有成本上限**——规范中的 `maxCostUsd` 在 harness 中没有计价来源，因此没有任何随附上限为轮次计价。在计价 seam 出现之前，token 上限是金钱的替代指标。
- **每个轮次的事实只覆盖被观察到的轮次**——插件加载时已经打开的轮次没有条目，永远不会被切断；这也意味着在轮次中途挂载的插件无法约束它挂载时所处的那个轮次。
- **只在步骤之间检查**——单次长时间模型调用或工具执行不会被中断；上限在下一个拟进入的步骤生效，而永不提出步骤的 agent（例如挂起的提供方调用）不会被本 guard 停止。
- **按轮次而非按会话**——每个轮次都会重新获得完整上限，因此长会话可以多次花掉同一份额度。
- **人类输入绕过所有上限**——这是有意为之，但也意味着持续 steer 的用户会让轮次越过全部三项约束。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文：开放问题与尚未决定的探索方向。它明确不具权威性——已交付的行为、限制与既定理由以上文、包代码和相关 Agent Note 为准。

字段名与[演化 harness 规范](../../../specs/evolutionary-harness.spec.md)表格不同：该表列出 `maxInputTokens` 与 `maxCostUsd`，而实际交付的字段是 `maxTotalTokens`，因为 `ctx.tokenMeter` 测量的是请求总压力而非仅输入 token；成本则在计价来源出现之前保持延期。

</details>
