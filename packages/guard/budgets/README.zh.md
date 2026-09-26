---
description: "面向轮次、会话与运行的预算 guard：在每一步之前检查计费 token、计价成本、工具调用、挂钟时间与上下文压力上限，供选择、配置或排查该 guard 的用户与维护者阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-budgets

[English](README.md) | 中文

## 概述

使用本包可为一个 agent 在下一次模型请求之前能花多少设限。可选上限按计费 token、计价美元、工具调用或挂钟时间为单个轮次、整个会话与单次运行设界；另有一项独立上限约束实测上下文压力。某个步骤一旦到达上限，guard 会记录一条持久化的 `budget/exceeded` 事件、拒绝该步骤，轮次随即以 blocked 结束而不是继续。认领了人类消息的步骤始终进入，因此预算绝不会丢弃用户输入；所有上限在未配置时都处于关闭状态，web-app 组合包正是以全关方式挂载本插件。

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

当 agent 应当停下而不是继续消耗时，挂载本插件。无配置时它只观察轮次、不拒绝任何步骤；每设置一项上限就启用一项约束。

### 何时选择

当无人值守或长周期 agent 必须被设界时选择它：永不收敛的工具循环、运行数小时的会话，或持续计费的请求。三个范围回答三个问题——轮次上限约束一个模型请求周期，会话上限约束整段对话的计费历史，运行上限约束 kernel 开启的一次任务。上下文上限则切断请求已超出其衡量基准的轮次。

当每个轮次都必须为正确性而跑完时避免使用，也需要硬中断时不要依赖它：guard 只在步骤之间检查，因此它停止的是*下一个*模型请求，永不是在途调用。它同样无法约束自己从未观察到的工作——见[已知限制与延期工作](#known-limitations-and-deferred-work)。

### 设置上限

按部署想要的上限挂载本插件：

```yaml
- name: '@deepseek-ai/dsh-budgets'
  config:
    maxTotalTokens: 200000      # billed tokens one turn may spend
    maxToolCalls: 50            # tool calls one turn may dispatch
    maxWallMs: 600000           # milliseconds one turn may run
    maxSessionTokens: 5000000   # billed tokens the whole session may spend
    maxSessionCost: 25          # USD the session may spend, priced by usdPerMillionTokens
    maxSessionWallTime: 28800000
    maxRunTokens: 500000        # billed tokens one run may spend
    maxRunCost: 5
    maxRunWallTime: 1800000
    maxContextTokens: 200000    # measured request pressure of one step
    usdPerMillionTokens: 3      # USD per million billed tokens: what the deployment's model costs
```

| 字段 | 范围 | 默认值 | 含义 |
|---|---|---|---|
| `maxInputTokens` | 轮次 | 未设置（关闭） | 单个轮次可被计费的提示 token——未缓存的输入加上缓存读与缓存写 |
| `maxOutputTokens` | 轮次 | 未设置（关闭） | 单个轮次可被计费的补全 token |
| `maxTotalTokens` | 轮次 | 未设置（关闭） | 单个轮次可消耗的全部计费 token |
| `maxToolCalls` | 轮次 | 未设置（关闭） | 单个轮次可分发的工具调用数 |
| `maxWallMs` | 轮次 | 未设置（关闭） | 单个轮次的挂钟时长，自其 `turn/start` 起算 |
| `maxSessionTokens` | 会话 | 未设置（关闭） | 整个会话可消耗的计费 token |
| `maxSessionCost` | 会话 | 未设置（关闭） | 会话可消耗的计价美元；需要 `usdPerMillionTokens` |
| `maxSessionWallTime` | 会话 | 未设置（关闭） | 会话的挂钟年龄，自其创建时刻起算 |
| `maxRunTokens` | 运行 | 未设置（关闭） | 单次运行可消耗的计费 token |
| `maxRunCost` | 运行 | 未设置（关闭） | 运行可消耗的计价美元；需要 `usdPerMillionTokens` |
| `maxRunWallTime` | 运行 | 未设置（关闭） | 单次运行的挂钟时长，自其运行标记起算 |
| `maxContextTokens` | 上下文 | 未设置（关闭） | 下一次请求的实测请求压力 |
| `maxCostUsd` | 轮次 | 未设置（关闭） | 单个轮次可消耗的计价美元；需要 `usdPerMillionTokens` |
| `usdPerMillionTokens` | 价格 | 未设置（无作用） | 每百万计费 token 的美元价；没有成本上限时不起作用 |

未设置的上限即处于关闭状态，因此无配置挂载的插件不会拒绝任何步骤。非正数或非有限值会让插件加载失败并给出明确错误，而不是悄悄关闭它所声明的上限。没有价格的成本上限是受支持的状态而非配置错误：插件正常加载、记录一条警告，并把该维度报告为无法计量，因为 harness 自身没有计价来源，价格由部署声明其模型成本。生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-budgets)是受支持取值的完整清单。

### 你会得到什么

某个步骤到达已配置的上限时，guard 记录一条持久化的 `budget/exceeded` 会话事件、记录一条包含相同事实的警告，并拒绝该拟进入的步骤。事件指明预算（`scope`：`turn`、`context`、`session` 或 `run`）、上限（`name`）、被比较的值（`observed`）、已配置的限值（`limit`）、被停止的轮次与步骤、范围为运行时所属运行的身份，以及部署配置的每一项上限——数值、未设置维度读作字面量 `unbounded`，没有价格的成本维度读作 `unmeasurable`。随后循环以既有的 `blocked` 原因结束该轮次，与一直以来的被拒步骤结论相同，且不新增任何 `TurnEndReason`。已经产生的工具结果留在会话中，下一轮次从全新的轮次内事实开始。

该事件是仅日志且读取必需的：它不携带 `ignorable` 标记，因此不认识该类型的读取方会拒绝整份日志，而不是丢弃这次切断。其载荷与声明位置见生成的[持久化目录](../../../docs/persistence-catalog.zh.md#budgetexceeded--log-only)。

顺序在两处很重要。人类输入优先：如果某步骤认领的消息中包含 `source.kind === 'user'` 的消息，该步骤直接进入，上限根本不会被评估，因此拒绝永远不会丢弃用户消息或引导指令。而检查按代价从低到高进行——先计数器、再时钟、然后读取一次计费消耗、最后做上下文测量——因此已经越过较廉价上限的步骤不必为其日志重放付出代价。

### 数字从何而来

计费消耗是 token 计量器自身的提供方报告账目，读自其 `tokenUsage` 会话投影：由计量器从每一个上报了用量的已结算 assistant 尝试折叠出的四个互斥桶，重试单独计入。轮次比较会话当前读数与其 `turn/start` 到达时读数之差，会话比较整份读数，运行比较自其运行标记以来的差值。由于投影会随每次结算落地即折叠，能砍断的正是正在花费的那个轮次，而不是其后的轮次。

运行是 kernel 的持久任务：guard 以结构化方式从日志中读取运行身份与起始时刻，即 `task/created` 事件的元数据，因此不需要对 `@deepseek-ai/dsh-agent-kernel` 的编译期依赖。上下文压力是唯一读取测量值而非消耗的维度：`maxContextTokens` 比较 `ctx.tokenMeter.measure(session).totalTokens`，即请求本身而非账单。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节——点击展开</summary>

本节说明 guard 如何得知轮次、会话与运行的活动、在哪里行使否决，并指向实现它的代码；可观察行为已在[使用本包](#use-this-package)中完整覆盖。

### 设计原则

该 guard 建立在五项承诺之上：

- **在确实存在的否决边界上执行。** `agent/pre-step` 是已声明的 waterfall，循环本就把它的拒绝转成 `{ kind: 'blocked' }`；`agent/turn-stopping` 是没有否决槽位的停止事件，在那里挂监听器只会是无效负担。与规范设想执行点的完整偏差记录在 [guard-budgets Agent Note](../../../.agents/notes/implemented/feature/2026-09-12-guard-budgets.zh.md) 中。
- **事实，而非历史。** 轮次内与运行内事实存放在以会话为键的 `WeakMap` 中，并由投递的 `session/event` 维护——绝不同步读取会话日志——因此被恢复或分叉的会话无需付出代价，也不需要新增投影。
- **每个数字只有一个归属者。** 计费消耗读自 token 计量器的 `tokenUsage` 投影，上下文压力读自其 `measure()`；guard 不重新推导任何一项。
- **人类输入高于一切上限。** 认领的消息本就是为了投递；拒绝携带用户消息的步骤会将其丢弃，因此 guard 转而委派。
- **上限是配置，不是常量。** 每项界都是可在 `cordis.yml` 中改动的、带校验的可选 `Config` 字段；没有隐藏默认值，也没有测试钩子。

### 轮次与运行如何被观察和切断

一个 `session/event` 监听器构建事实。`turn/start` 写入 `{ turn, startedAt: event.time, toolCalls: 0, spend }`，其中 `spend` 是该时刻会话的计费消耗；`tool/call` 在条目存在时递增 `toolCalls`；携带可用运行身份的 `task/created` 事件写入 `{ runId, startedAt, spend }`；其余事件类型一律忽略。由于轮次条目只由插件亲眼观察到的 `turn/start` 创建、运行条目只由它见过的标记创建，插件加载时已经在途的工作永远不会被切断——而标记早于挂载时刻的运行则没有可计量的消耗。

一个 `agent/pre-step` 监听器评估拟进入的步骤。当 agent 会话没有事实、或事实属于另一个轮次、或某条认领消息带有 `source.kind === 'user'`、或没有配置任何上限、或没有任何上限到达时，它原样委派。否则它通过会话自身的 append 路径追加 `budget/exceeded` 事件、记录唯一一条警告，并在不调用 `next()` 的情况下返回 `{ kind: 'reject' }`——这正是 Cordis waterfall 定义的短路：后续监听器不再运行，循环记下 `blocked`。事件先于拒绝写入，因此即使进程随该轮次一起崩溃，持久日志仍带有切断的原因；警告与事件陈述同样的事实，而该轮次的 `blocked` 结束仍是读取方重建出的结论。

### 各项上限比较什么

`maxToolCalls` 比较该轮次已计入的 `tool/call` 事件数。`maxWallMs` 用 `Date.now() - facts.startedAt` 与该轮次自身的 `turn/start` 时间戳比较，因此是挂钟时间而非 CPU 时间。`maxSessionWallTime` 用同一时钟与会话头部的创建时刻比较，因此计入会话的整个年龄，包含空闲时段。`maxRunWallTime` 则与运行标记的时间戳比较。

`maxInputTokens`、`maxOutputTokens` 与 `maxTotalTokens` 比较该轮次的计费桶：提示 token 为未缓存输入加上两个缓存桶，总量再加补全 token。`maxSessionTokens` 与 `maxRunTokens` 对会话与运行比较同样的桶。`maxCostUsd`、`maxSessionCost` 与 `maxRunCost` 按 `usdPerMillionTokens` 以每百万 token 为这些 token 计价——提示、补全与缓存 token 一律同一费率，因为 harness 不持有按路由的费率表。`maxContextTokens` 比较 `ctx.tokenMeter.measure(agent.session).totalTokens`，即计量器对请求总压力的估算，它在安全时复用提供方用量、否则重新计价当前 surface；它衡量的是请求而不是账单。

### 源码地图

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`Config` schema、失败即报的校验、事实监听器、上限评估 |
| [`src/types.ts`](src/types.ts) | 上限表与范围/度量词汇、持久化的 `budget/exceeded` 载荷，以及 `SessionEventMap` 合并 |
| [`src/spend.ts`](src/spend.ts) | 计费 token 的拆分与单一费率计价，缺失的一侧读作无法计量 |
| [`src/run-marker.ts`](src/run-marker.ts) | 对 kernel 持久运行标记的结构化读取 |
| — | 未发布运行时不变式伴随件；guard 持有两个由自身监听器消费的弱引用会话事实表，而从日志重新推导同样事实的伴随件观察到的仍是同一批事件，而非独立关系。 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级契约不够用时阅读这些页面。它们从 pre-step 边界延伸到循环的轮次生命周期、被衡量的数字以及 guard 组地图。

- [Agent 包参考](../../../packages/core/agent/README.zh.md)——`agent/pre-step` waterfall 与循环理解的 `PreStepDecision` 取值。
- [Token 计量器](../../llm/token-meter/README.zh.md)——本 guard 直接读取而不再自行测量的 `tokenUsage`、`contextPressure` 投影与 `measure()`。
- [工具子系统参考](../../../docs/subsystems/tools.zh.md)——产生本 guard 所计 `tool/call` 事件的 `tools/execute` 流水线。
- [guard-budgets Agent Note](../../../.agents/notes/implemented/feature/2026-09-12-guard-budgets.zh.md)——设计、人类输入规则，以及本包拒绝采用的执行点。
- [生成的配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-budgets)——每一项受支持的上限及其源码声明。
- [guard 组地图](../README.zh.md)——同组 guard 包与循环卫生家族。

-----

<a id="model-experience"></a>
## 模型体验

### 有条件的轮次终止

#### 模型看到什么

不新增任何提示、工具 schema 或消息文本。上限到达意味着该轮次的下一次请求根本不会发出：轮次以循环的 `blocked` 原因结束，模型的下一次请求是下一轮次所组装的内容。已经产生的工具结果留在日志中，因此其内容不会对后续轮次隐藏。

#### Token 影响

新增零 token；测量本身不发送任何内容。到达的上限会省下它阻止的每个步骤的提示、工具 schema 与输出，这正是该约束的意义。

#### KV Cache 影响

仅追加；拒绝步骤不会给请求 surface 增加任何内容，因此既有 KV Cache 条目保持可复用。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制界定了 guard 何时并不合适。它们是当前的包约束，不是任务清单。

- **读取必需的事件**——`budget/exceeded` 记录不携带 `ignorable` 标记（append 路径无法写入该标记），因此比该事件更早的 harness 会拒绝整份日志，而不是跳过这次切断。读取由更新的 harness 切断过的日志前，请先升级读取方。
- **harness 没有计价来源**——成本上限的准确度只取决于部署配置的单一费率 `usdPerMillionTokens`，提示、补全与缓存 token 同为一份费率，过期的价格会悄悄误算每一步。更好来源的归属者尚不存在：[`@deepseek-ai/dsh-llm-deepseek`](../../llm/llm-deepseek/README.zh.md) 的模型目录未声明成本，按路由的费率只能经适配器的 `resolveModelInfo` 到达 harness。在该归属者落地之前，没有价格的成本上限会正常加载、记录一次警告，并把自身报告为 `unmeasurable`。
- **事实只覆盖被观察到的轮次与运行**——插件加载时已经打开的轮次永远不会被切断，标记早于挂载时刻的运行也没有可计量的消耗，因此从运行中途恢复的进程会从它见到的下一个标记开始计算运行上限。
- **只在步骤之间检查**——单次长时间模型调用或工具执行不会被中断；上限在下一个拟进入的步骤生效，而永不提出步骤的 agent（例如挂起的提供方调用）不会被本 guard 停止。
- **提供方上报的 token，不是账单**——投影只计入上报了用量的已结算尝试，因此未上报用量的尝试不贡献任何数值，该读数是下限；重试计入，缓存计价遵循提供方自身的规则。
- **人类输入绕过每一项上限**——这是设计使然，但也意味着持续引导的用户会让该轮次越过所有约束。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>面向维护者的工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文：未决问题与尚未确定的取向。它明确不具权威性——已交付行为、限制与已接受的取舍都在上面的章节、包代码与所链接的 Agent Note 中。

轮次字段仍与规范提出的 `maxTurnInputTokens`、`maxTurnOutputTokens` 与 `maxTurnTotalTokens` 不同：实际交付名为 `maxInputTokens`、`maxOutputTokens` 与 `maxTotalTokens`，其中 `maxTotalTokens` 保留原名是因为部署已经在配置它。会话与运行字段与规范同名，而规范的 `maxContextTokens` 在此作为压力维度交付，同名编译预算则由 [agent-context](../../runtime/agent-context/README.zh.md) 拥有。在按路由计价出现归属者之前，价格仍是部署声明的单一费率；那次改动的形态是取自 `ctx.llm.resolveModelInfo(provider, model).cost` 的路由声明成本，由 usage-ledger 的 `priceSample` 计价并按路由缓存。本家族的参考契约见[演进式 Harness 子系统](../../../docs/subsystems/evolutionary-harness.zh.md)。

</details>
