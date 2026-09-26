---
description: "演化指标：单位算力换来的能力增益与支撑指标集，从演化存储读取（ctx.evolutionMetrics）。"
kind: "package-reference"
---

# @deepseek-ai/dsh-evolution-metrics

[English](README.md) | 中文

## 概述

`dsh-evolution-metrics` 衡量演化框架是否真的在变好：北极星指标是单位算力换来的能力增益——这些运行花费的成本、token 或算力小时之上的一段通过率差值；支撑指标覆盖增益速率、开销、复发失败、回归债、召回记忆的价值，以及晋级、回滚与评估器集成的表现。

这里不调用模型：所有值都取自其他软件包记录的存储，缺失记录报告为不可测量，而非零。

另外六套只读模型覆盖这些运行留下的工作：`coding`、`research`、`mentor`、`longHorizon`、`uncertainty`、`selfModel`。本层拥有的是那个呈现面，而不是记录本身。

## 目录

- [使用本软件包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本软件包

挂载插件即可；它不需要存储域，也不注入任何服务。一次调用返回整份报告，可选地限定到某个任务类。

```ts
const report = ctx.evolutionMetrics.report({ taskClass: 'writer' })

report.window        // runs, from, to, and the two half-rates the gain compares
report.northStar     // one entry per compute denominator
report.supporting    // the ten supporting metrics
```

每一项形状相同：`value`（数值，不可计算时为 `null`）、`unit`、`inputs`（它来自哪个存储、哪条读取路径、哪些字段）、`unavailableReason`（不可计算的原因，已测量时为 `null`），以及 `caveat`（这个数字没有告诉你什么，测量完整时为 `null`）。

| 指标 | 测量来源 | 含义 |
|---|---|---|
| `capability-gain-per-cost-unit` | `ctx.evolutionMeta.runs()`、`ctx.evolutionBudget.spends()` | 同一增益按窗口内这些运行自身所计费的每单位成本计。除非每次运行的批次都记录了带价格的支出，否则不可测量。 |
| `capability-gain-per-million-tokens` | `ctx.evolutionMeta.runs()` | 窗口较新一半相对较旧一半的通过率增益，按窗口所花每百万 token 计。 |
| `capability-gain-per-compute-hour` | `ctx.evolutionMeta.runs()` | 同一增益按评分器累计的墙钟时间每小时计。 |
| `learning-velocity` | `ctx.evolutionMeta.runs()` | 同一增益按窗口实际经过的每天计。 |
| `compute-overhead-ratio` | `ctx.evolutionBudget.spends()`、`ctx.evolutionMeta.runs()` | 搜索所花的 token 除以获胜运行所测量的 token。 |
| `failure-recurrence` | `ctx.evolutionFeedback.signals()`、`ctx.evolutionSkillTelemetry.entries()` | 在多个会话中重复出现的已观察失败占比。 |
| `regression-debt` | `ctx.evolutionCurator.debt()` | 经过一轮 curator 处理后仍未关闭的失败。 |
| `promotion-quality` | `ctx.evolutionLineage.experiments()` | 所记录实验里候选确有改进的占比。 |
| `rollback-rate` | `ctx.evolutionCanary.summary()` | 上线之后又被回滚的部署占比。 |
| `evaluator-reliability` | `ctx.evolutionEvaluatorHealth.summary()` | 未被后续判定推翻的评估器判定占比。 |
| `skill-incremental-utility` | — | 不可测量：没有任何存储把使用技能的运行与不使用技能的运行配对。 |
| `memory-utility` | `ctx.evolutionMemory.recallUtility()` | 召回台账中被召回记忆的 §24 效用均值：`相关性 × 决策影响 × 结果增益`。 |
| `benchmark-robustness` | `ctx.evolutionBenchmark.outcomes()` | 已执行的基准任务中，其运行通过者的占比。在运行 pass 记录结果之前不可测量。 |

§13.2 的编码指标集由已记录的会话日志折叠而成——与内核计数器、轨迹投影所依据的是同一批记录；§5.4 的基线读数也来自同一个窗口。表中最后七行是 §18.3 的内核计数器，同样读自这一次折叠：即 §18.3 要求、而 §13.2 与 §5.4 的任何读数都未表达的任务、验证、运行、策略、审批与检查点族。`run.wall_ms` 与 `run.cost_usd` 即上表的 `latency` 与 `cost`，`subagent.success_rate` 是 `subagent-waste` 的补，`memory.recall_utility` 与 `skill.utility` 是 `memory-utility` 与 `skill-incremental-utility`，而 `evolution.capability_gain_per_compute` 是北极星指标。`context.compactions`、`sandbox.denied` 与 `workflow.resume_success` 并非内核计数器，故此处不为它们命名任何读数。

```ts
const coding = await ctx.evolutionMetrics.coding({ since: '2026-01-01T00:00:00.000Z' })

coding.window     // sessions, from, to
coding.metrics    // verified success, false completion, regression, recovery, planning,
                  // verification coverage, human intervention, cost, latency, loop rate,
                  // tool failure rate, subagent waste, context utilization, average tokens,
                  // and the three verified-success ratios
```

| 指标 | 测量来源 | 含义 |
|---|---|---|
| `cost` | `assistant/message.usage`、`usdPerMillionTokens` | 按部署的单一统一价格计的每会话计费美元数，含缓存流量。未配置价格或未报告用量时不可测量。 |
| `average-tokens` | `assistant/message.usage` | 每会话的计费输入、缓存与补全 token 数：同一笔支出的 token 一侧。 |
| `loop-rate` | `readKernelMetrics().failuresByKind`、`.tasksCreated` | 窗口内开启任务的会话中，记录过 `no-progress` 或 `stalled` 失败者所占比例——轨迹投影把这两类读作 `loop_detected`。按会话计：计数器不把失败与它所终结的运行配对。 |
| `tool-failure-rate` | `readKernelMetrics().toolCalls`、`.actionsFailed` | 已记录的 tool 调用中，其自身结算回执报告 `failed` 的占比。 |
| `subagent-waste` | `delegation/received`、`readKernelMetrics().taskOutcomes` | 被委派的子运行中，其接收会话未达到任何 `completed` 任务状态者所占比例。 |
| `context-utilization` | `assistant/message.usage`、`request/context.contextWindow` | 单条已定案消息所报告的最大提示词一侧（含缓存流量）与该会话声明的最新窗口之比。 |
| `verified-success-per-usd` | 窗口的已验证完成数、其已定价支出 | 每美元计费支出对应的已验证完成数。零支出时不可测量，绝不报告为无穷比。 |
| `verified-success-per-million-tokens` | 窗口的已验证完成数、其计费 token 数 | 每百万计费 token 对应的已验证完成数。 |
| `verified-success-per-10-minutes` | 窗口的已验证完成数、其已关闭轮次 | 每十分钟已关闭轮次合计对应的已验证完成数。 |
| `task-success-rate` | `readKernelMetrics().taskOutcomes` | 窗口内达到终态的任务中最终 `completed` 者的占比。同一分母下经认证的那一份即 `verified-success`。 |
| `verification-pass-rate` | `readKernelMetrics().verifications`、`.verificationsPassed` | 已记录的验证结果中状态为 `pass` 者的占比。既非 `pass` 也非 `fail` 的状态不推动任何一侧。 |
| `steps` | `readKernelMetrics().steps` | 窗口日志所记录的模型步（`step/start`）数。 |
| `tool-calls` | `readKernelMetrics().toolCalls` | 窗口所记录的每一个 `tool/call`，包含从未结算出 action 的调用。 |
| `policy-denials` | `readKernelMetrics().policyDenied` | 合成策略决策中效果为 `deny` 者。能力拒绝与沙箱拒绝都作为同一条决策到来，故两个族无法区分。 |
| `approval-rejections` | `readKernelMetrics().approvalsRejected` | 人类答复中不是 `allowed-once` 者。其背后的提问即 `human-intervention` 比率。 |
| `checkpoint-resume-rate` | `readKernelMetrics().checkpoints`、`.checkpointResumes` | 已记录检查点中被恢复者的占比。计数器不把一次恢复与它所恢复的那个检查点配对。 |

§13.3 的研究指标集读取 `ctx.research` 记录下来的运行，以及这些运行的会话所记录的主张与观察。它的窗口是运行窗口：`runs`、`sessions`、`from`、`to`，并由 `sessionId`、按运行定案时刻（尚未定案时为开始时刻）的 `since`/`until`，以及 `limit` 收窄。每一项指标都是占比。

```ts
const research = await ctx.evolutionMetrics.research({ sessionId })

research.window   // sessions, runs, from, to
research.metrics  // the seven §13.3 metrics, in spec order
```

| 指标 | 测量来源 | 含义 |
|---|---|---|
| `claim-accuracy` | `claim/updated`、运行阶段 | 这些运行所主张的主张中，经证据定案且站得住的比例：`supported` 占 `supported`、`contradicted` 与 `rejected` 总和之比。 |
| `source-quality` | `evidence/recorded`、`claim/updated` | 窗口内主张所引用的观察中，记录信任标签为 `trusted` 的占比。 |
| `evidence-coverage` | 运行的答案、主张、观察 | 已定案答案中，`documented`、`observation`、`interpretation` 与 `inference` 这几类陈述里，建立在一个至少引用了一条观察的主张之上的占比。 |
| `contradiction-recall` | 运行阶段 | 主张过主张的运行中，其 `contradiction-search` 阶段以 `produced` 定案的占比。 |
| `uncertainty-calibration` | `claim/updated` | 已定案主张中，其记录的信心与记录的状态在半信心分界上一致的占比。 |
| `citation-correctness` | 运行的答案、`claim/updated` | 答案的引用中，指向该运行记录为 `supported` 的主张的占比。 |
| `unsupported-claim-rate` | `claim/updated` | 窗口内运行所主张的主张中，未引用任何观察的占比。 |

§13.4 的辅导指标集读取单个学习者的持久记录（`ctx.learnerModel`）与为其记录的误解循环（`ctx.misconception`）。它的查询必须点名学习者，因为两个存储都不提供学习者列表。

```ts
const mentor = ctx.evolutionMetrics.mentor({ learnerId })

mentor.learnerId  // the learner the report covers
mentor.metrics    // the six §13.4 metrics, in spec order
```

| 指标 | 测量来源 | 含义 |
|---|---|---|
| `misconception-detection` | 学习者记录 | 学习者评审过的案例中，被某条已记录误解在其 `caseIds` 中点名的占比。 |
| `explanation-quality` | 已记录循环 | 已记录循环中，越过 explain 阶段的占比；该阶段唯一的完成记录是调用方的一次 `delivered` 观察。 |
| `exercise-relevance` | 循环、学习者记录 | 布置了练习的循环中，其误解被记录计为复发的占比。 |
| `learning-improvement` | 学习者记录 | 已记录的按概念案例影响中，强化了该概念的占比。 |
| `retention` | 学习者记录 | 紧随一次强化之后的判定中，没有再次削弱该概念的占比。 |
| `repeated-mistake-reduction` | 学习者记录 | 记录计为复发的误解中，当前状态为 `resolved` 的占比。 |

§13.5 长跨度指标集读取 `ctx.evolutionBenchmark.run()` 为每个它执行过的基准任务记录下来的持久结果。它的窗口是结果窗口：`tasks`、`scored`、`failed`、`from`、`to`，由 `since`/`until` 按结果记录时刻收窄，并由最新 `limit`（否则 `maxOutcomes`）设上限。

```ts
const horizon = ctx.evolutionMetrics.longHorizon()

horizon.window   // tasks, scored, failed, from, to
horizon.tiers    // one entry per horizon tier: 10, 20, 50, and the open-ended 100+
```

每个层级按规格顺序携带 §13.5 要求的五个轴：

| 指标 | 轴 | 含义 |
|---|---|---|
| `benchmark-robustness` | 成功 | 该层级中产生了裁定的结果里，运行通过者的占比。 |
| `verification-coverage` | 流程纪律 | 其中其运行记录了对自己工作的验证的占比。 |
| `recovery-efficiency` | 恢复 | 它们记录的失败中，被某次恢复决策回答的占比。 |
| `context-pressure` | 上下文压力 | 该层级任一次运行达到的上下文窗口占用占比的最大值，仅计两侧都报告了的运行。 |
| `cost` | 预算用量 | 每个任务的计费 token 数，对该层级的结果求和。 |
| `latency` | 预算用量 | 每个任务的墙钟时间，同样求和。 |

这些读数背后的资料只在运行被记录时折叠一次：[`dsh-evolution-benchmark`](../evolution-benchmark/README.zh.md) 的运行 pass 把内核自己的计数器与 token 计费器自己的上下文压力投影折叠到每次尝试所收获的会话上，因此这一层只是聚合一行的结果记录里已有的东西。

§43 的不确定性只读模型呈现 [`dsh-evolution-uncertainty`](../evolution-uncertainty/README.zh.md) 从其持久信号推导出的评估任务队列。查询以 `skill` 收窄该队列，并以 `limit` 设上限；窗口报告 `tasks`、`signals` 与队列首行的 `topPriority`。分组与排序都由该存储完成，故本报告绝不重新推导其中任何一项。

```ts
const queued = ctx.evolutionMetrics.uncertainty({ skill: 'writer' })

queued.window   // skill, tasks, signals, topPriority
queued.metrics  // queue depth and the corroborated share
```

| 指标 | 测量来源 | 含义 |
|---|---|---|
| `uncertainty-queue-depth` | `ctx.evolutionUncertainty.queue()` | 该存储队列所持有的评估任务数，每项由一条或多条已分组、等待复评的信号构成。 |
| `uncertainty-corroboration` | `ctx.evolutionUncertainty.queue()` | 队列中被 §43 五类中不止一类标记的任务占比——不按每一类各自的信号条数加权。 |

§42 的自我模型只读模型呈现 [`dsh-evolution-self-model`](../evolution-self-model/README.zh.md) 从其持久的单能力条目排序得出的能力前沿。窗口报告 `skills`（该存储持有多少份评估）与 `capabilities`（前沿排序了多少条目）；排序由该存储完成，故本报告绝不重新推导其顺序。

```ts
const self = ctx.evolutionMetrics.selfModel()

self.window   // skills, capabilities
self.metrics  // the frontier's mean pass rate and its weakest entry's
```

| 指标 | 测量来源 | 含义 |
|---|---|---|
| `self-model-frontier-pass-rate` | `ctx.evolutionSelfModel.gaps()` | 前沿各条运行通过率的不加权均值，故仅有两次观察支撑的能力与有二十次者权重相同。 |
| `self-model-weakest-pass-rate` | `ctx.evolutionSelfModel.gaps()` | 前沿排在首位的那项能力的运行通过率，即 `nextToLearn()` 所返回者。 |

### 配置

本层的部署选项，均经校验并提供默认值，因此未配置的挂载也能运行。

| 键 | 默认值 | 含义 |
|---|---|---|
| `windowRuns` | `200` | 查询未设上限时，一份报告覆盖的最新引擎运行数。 |
| `minimumRunsPerHalf` | `2` | 报告增益前，切分后每一半所需的最少运行数。 |
| `maxSignals` | `50` | 一次复发率读数覆盖的失败信号数。 |
| `maxSessions` | `200` | 一次编码报告读取的最新会话数，查询未设上限时也覆盖这么多。 |
| `maxOutcomes` | `200` | 一份长跨度报告覆盖的最新基准结果数，查询未设上限时也覆盖这么多。 |
| `usdPerMillionTokens` | 无 | 一百万个计费 token 的统一美元价格。未设置时，编码窗口的所有美元读数都不可测量。 |

查询可进一步收窄窗口：`taskClass` 限定到某个任务类，`since`/`until` 按记录时刻（含端点）限定，`limit` 设上限。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

### 设计理念

每项指标只有一个记录来源，并且绝不在描述不同范围的来源之间做算术。

一次引擎运行的成本在三处持久化：`evolution_meta.runs`（获胜候选自身的评估，带有同一次运行的通过、成本与时刻）、`evolution_model_routes.evidence`（同一次暂存写入的同一三元组），以及 `evolution_budget.spends`（该批次评估过的每个变体的累计和，因此是前两者的超集）。把其中任意两者相加都会报出两到三倍的算力消耗，所以北极星只读取 `runs`——它是唯一同时带有同一次运行的通过与否和成本的存储——而搜索额外付出的成本改由 `compute-overhead-ratio` 报告，而不是折进分母。

计费成本分母读的仍是同一批运行，因此它不是第二个范围：一次运行以其生产者据以支出的那个批次标识记录，所以一次运行的成本就是它自己那个批次记录的支出。该读数对不完整的账单很严格——若窗口内的运行并非都记录了支出，或支出未设置 `cost`，则报告为不可测量并点名缺口，因为部分求和会让增益除以少于产出它的算力。成本是部署自己的单位；只有部署以美元计费时它才是美元。

能力是已记录的通过率：窗口内的运行按时间从旧到新，切成较旧与较新两半，增益即较新一半的通过率减去较旧一半。数量为奇数时较新的一半多拿一次运行，因此处理侧看到的证据永不少于它与之比较的基线。同一增益随后除以整个窗口的成本、token、算力小时与实际经过的天数，这就是为什么每一项北极星指标共用同一个分子，只在分母上不同。

其他软件包已经算好的指标直接读取，不重算：回归债取 curator 自己的表，回滚率取 canary 自己的状态计数，评估器可靠性取健康摘要自身的比率。本层只在没有存储能回答问题时才补上算术——窗口切分、三个分母，以及搜索开销比。

**本层拥有的是只读模型的呈现面，而不是记录本身。** 框架所报告的每一项指标都在这里呈现；而评估器健康、不确定性与自我模型这三个只读模型背后的存储，仍各自保有自己的、带版本的持久域与自己的写入方：`evolution_evaluator_health`、`evolution_uncertainty` 与 `evolution_selfmodel` 都不迁移到此处，因为一个打开了持久域的无状态消费者就必须同时拥有填满它的那次写入，而本层什么都不写。迁移过来的是呈现。`evaluator-reliability` 本就是支撑集里的一行；`uncertainty` 与 `selfModel` 补上队列与前沿，各自读取宿主已经挂载的那个存储。各个控制循环仍直接调用它们据以驱动行为的那些存储——`evolution-actuator` 排空该队列，`command-evolution` 的自我模型与不确定性命令读取前沿与队列——因为呈现一项指标与驱动一个闭环是两件不同的事，而让控制循环绕经指标层会把依赖方向倒置。内核计数器是同一种整合形态：`readKernelMetrics` 仍是内核的纯折叠，而 §18.3 中其他任何读数都未表达的各族，则在早已折叠过它的那一个编码窗口上呈现。

后几套指标集把这同一条规则用在「工作留下的记录」上。研究窗口是运行窗口：由 `ctx.research.runs()` 点名运行，每个运行所属的会话只打开一次，并折叠成这些运行的引用据以解析的主张与观察记录；而一个会话的主张只有通过这些运行的各阶段才进入指标集——因此这套指标测量的是已记录的研究工作，而不是某个会话记录过的每一条主张。辅导报告只读一个学习者，因为学习者记录没有名单：报告点名它所覆盖的学习者，并且它的两个存储都是同步读取的。§13.5 报告读的是本组同伴写下的记录：基准运行 pass 为每个执行过的任务记录一条结果，每条都已从那次运行自己的会话折叠而来，因此 `longHorizon` 不打开任何会话日志——它给持久行划分窗口，再按跨度层级聚合。

### 失败与恢复

来源存储未挂载时，其指标报告为不可测量并点名缺失的存储，而报告仍携带完整指标集，因此一条命令即可回答规范中的每一项指标。来源在 `report` 运行时解析，而非挂载时，因此本层从不约束其来源的挂载顺序。

后几套指标集以更细的粒度遵循同一条规则。未挂载的研究控制器、会话存储、学习者模型、误解引擎或基准存储，只会让读取它的那些指标不可测量并点名该存储：没有会话存储时，研究报告仍携带它读到的运行窗口；引擎缺失时，辅导报告仍能从学习者记录测出检测、改善、保持与减少；基准存储缺失时，长跨度报告会点名该存储，而不是把四个空层级报成零。已挂载但对本次查询没有任何内容的存储，报告的是它实际的那个空记录，而绝不是零。

最后补上的这两套只读模型以同样方式降级。未挂载不确定性存储时，`uncertainty()` 仍返回两项读数并点名该存储，窗口为空；存储已挂载但没有任何信号时，它返回实测的零个任务，而佐证占比则点名它所需的记录。未挂载自我模型存储时，`selfModel()` 为两项读数都点名该存储；存储已挂载但没有任何能力条目时，它点名本会排出一项能力的那次观察。

不打开任何域，也没有任何持久化，因此不发布不变式伴生模块：每次读取都重新推导的值不存在第二个独立观察。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [演化框架规范](../../../specs/evolutionary-harness-v11-deep-research.md) §55——本软件包实现的北极星指标与支撑指标集。
- [演化软件包地图](../README.zh.md)——本组的软件包及其在仓库中的位置。
- [`dsh-evolution-meta`](../evolution-meta/README.zh.md)——能力增益赖以测量的运行、成本与时刻。
- [`dsh-evolution-budget`](../evolution-budget/README.zh.md)——成本分母与搜索开销比所读取的批次支出。
- [`dsh-evolution-benchmark`](../evolution-benchmark/README.zh.md)——其运行 pass 写下的持久任务结果是 §13.5 报告与 `benchmark-robustness` 的读取对象。
- [`dsh-evolution-curator`](../evolution-curator/README.zh.md)——回归债及其背后的失败信号。
- [`dsh-evolution-canary`](../evolution-canary/README.zh.md)——回滚率所计数的部署状态。
- [`dsh-evolution-evaluator-health`](../evolution-evaluator-health/README.zh.md)——可靠性读数所依据的判定摘要。
- [`dsh-evolution-uncertainty`](../evolution-uncertainty/README.zh.md)——不确定性只读模型所呈现的持久信号与已分组的评估任务队列。
- [`dsh-evolution-self-model`](../evolution-self-model/README.zh.md)——自我模型只读模型所呈现的单技能评估与能力前沿。
- [`dsh-agent-kernel`](../../runtime/agent-kernel/README.zh.md)——`readKernelMetrics`，§13.2、§5.4 与 §18.3 读数背后的纯折叠，以及研究指标集所读的主张与观察记录，以 `claim/updated` 与 `evidence/recorded` 记录。
- [`dsh-research-controller`](../../research/research-controller/README.zh.md)——研究窗口所覆盖的运行，以及复核所接受的答案。
- [`dsh-learner-model`](../../mentor/learner-model/README.zh.md)——辅导读数所依据的按学习者记录。
- [`dsh-misconception`](../../mentor/misconception/README.zh.md)——解释与练习读数所依据的已记录「讲解—重评」循环。

-----

<a id="model-experience"></a>
## 模型体验

无。本层不注册任何面向模型的东西。`/metrics` 是向操作者汇报；没有任何指标进入提示词、工具结果或会话事件。

#### KV Cache 影响

此处没有任何内容进入模型请求，因此提供方的缓存复用不受影响。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

这些限制界定了这些数字能说明什么、不能说明什么。它们是本软件包当前的约束。

- **所有由运行推导的指标都以晋级路径为条件**——优化器在候选被暂存时记录一次运行，而对被拒、留出集未通过或批次被截断的情况一概不记录。这里的通过率是被暂存尝试中通过的比例，而非能力水平；并且没有任何已记录序列能回答“改动有多经常完全没带来改进”。
- **按任务的结果只存在于基准语料**——`ctx.evolutionBenchmark.run()` 为每个执行过的基准任务记录一条持久结果，§13.5 报告与 `benchmark-robustness` 读的正是这些行。没有任何记录保存单个*测试*是否通过，也没有任何记录保存某个场景的不使用技能臂，因此 `skill-incremental-utility` 与按任务的回归债仍不可测量，且每一项都会点名那个能让它可计算的记录。
- **记忆效用只记录 §23 四个环节中的三个、以及 §24 四个因子中的三个**——检索、随后的决策批次、以及由调用方提供的结果都有记录，因此该读数是真实的；被注入条目是否被*使用*、是否被*引用*，以及 §24 的来源质量因子，都没有记录来源。因此这个数字是下限，其 caveat 会逐一点名缺失的每个环节，而不是把它们记作零。
- **计费成本分母需要部署自己声明价格**——`evolutionBudget.spend` 对未声明 `cost` 的支出按部署的 `pricePerMillionTokens` 计费，而当前发布的配置未设置价格，因此发布环境中的支出都不带成本。所以在运营方为自己的 token 定价之前，`capability-gain-per-cost-unit` 会点名那笔未定价的支出；它按成本单位而非美元计，因为单位就是部署自己的计费单位。
- **编码美元读数使用部署声明的单一统一价格**——`usdPerMillionTokens` 以同一费率给编码窗口的每个计费 token 计价；未设置时，`cost` 与 `verified-success-per-usd` 会点名缺失的价格，而不是报出一个数字。这些读数不读取任何路由的目录价格，因此各路由成本不同的部署读到的是施加于其 token 的平均费率，而不是账单；之所以以美元为单位，只是因为部署声明的是美元价格。
- **只有由运行推导的指标接受时间界限**——`since`、`until` 与 `taskClass` 过滤引擎运行窗口。支撑指标是全局存储的当前状态读数：canary 摘要或债务表没有可按以过滤的任务类键，而两个计数器存储（`evolution-operators`、`evolution-evaluator-strategy`）只保留 `lastAt`，因此根本无法从中重建任何窗口。
- **搜索开销按构造跨越两个范围**——该比率把累计支出与仅含获胜者的 token 相比。它衡量的是多少算力换来了这些获胜者，绝不能加到任何一侧上去。
- **评估器可靠性是判定之间的代理量**——健康存储比较的是一个判定与之后的另一个判定，而不是与人工结果比较。
- **研究指标集读的是运行自己的记录，而不是某个语料库**——总体就是窗口内运行所记录的内容，并经其会话日志解析；而 `evidence-coverage` 与 `citation-correctness` 只读已定案运行的答案，因此未定案的运行只贡献主张、观察与它的矛盾检索，不贡献答案。一条主张的证据列表不会说明某个观察是支持还是反驳它（内核的列表不带方向），也不会说明来源属于哪一类，因此 `source-quality` 读的是观察者记录的信任标签，`contradiction-recall` 读的是检索已运行并有产出，而不是它找到了材料中实际存在的矛盾。
- **辅导指标集只能看到辅导记录下来的东西**——没有任何检测点名过的误解，在每一项辅导读数的分子与分母中都不存在；而辅导什么都没发现的案例计为一次漏检。每一项学习者读数都属于单个学习者，因为两个存储都不提供学习者列表。
- **`explanation-quality` 与 `exercise-relevance` 读的是一个循环走到哪一步，而不是教得多好**——explain 阶段唯一的完成记录是调用方的一次 `delivered` 观察；练习只有在服务于记录计为复发的信念时才算相关，因为没有任何记录说明它的题目是否与其自述的目标相符。
- **`repeated-mistake-reduction` 读的是误解的已解决状态**——错误条目只计次数、不带状态，因此读到的是复发背后那条已被解决的信念，而记录会永久保留已解决的条目。
- **只读模型的呈现面只有一层，记录并非如此**——其只读模型在此呈现的那三个存储仍各自保有自己的持久域与写入方，因此新增指标的维护者必须把它加在这里，且不得从本软件包打开 `evolution_uncertainty` 或 `evolution_selfmodel`。呈现一个只读模型与驱动一个闭环是两件不同的事，故 `evolution-actuator` 与 `command-evolution` 仍直接读取那些存储。
- **`uncertainty-queue-depth` 读的是存储的上限，而非每一条信号**——该存储返回的队列已受其自身 `queueLimit` 限制，且一个任务在其信号被解决后便离开队列，因此这个深度是仍在等待的量，而不是曾经被标记过的总量。
- **`self-model-frontier-pass-rate` 对每项能力等权**——仅有两次观察支撑的能力与有二十次者权重相同，而每项分数旁记录的 confidence 才说明它依托多少证据。`self-model-weakest-pass-rate` 是同一份薄弱程度在队列首位的读法，其排序先按 confidence、再按覆盖技能来打破平局。
- **部分 §18.3 名称没有可读的计数器**——`context.compactions`、`context.omitted_bytes` 与 `context.conflicts` 属于上下文编译器的所有者；`sandbox.denied` 与 `workflow.resume_success` 没有对应的内核字段；`recovery.by_kind` 是一个分布而非该折叠所保留的比率。本层只报告内核计数器能佐证的各族，其余不为其命名任何读数。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

窗口建立在 `ctx.evolutionMeta.runs()` 之上，其记录以 `toISOString()` 打时间戳，因此 `since` 与 `until` 按字符串比较；由于所有记录时刻格式与时区一致，字典序即时间序。`runs()` 返回最新在前，因此窗口先取最新的 `limit` 行再反转，切分依据的是时间上的位置，而不是通过次数。

原因与注意事项由服务携带，而不是由命令撰写，这与其它演化存储一致——它们的记录本身就带 `reason` 字符串。`/metrics` 负责渲染，因此本层对数字的诚实说明随数字一起传递。

当存储开始记录本层无法测量的东西时——无技能基线臂、召回命中计数器、计费成本——对应条目只需在一处从 `unavailable(...)` 改为 `metric(...)`，而指标 id 对调用方保持稳定。

</details>
