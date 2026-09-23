---
description: "演化指标：单位算力换来的能力增益与支撑指标集，从演化存储读取（ctx.evolutionMetrics）。"
kind: "package-reference"
---

# @deepseek-ai/dsh-evolution-metrics

[English](README.md) | 中文

## 概述

`dsh-evolution-metrics` 衡量演化框架是否真的在变好。北极星指标是单位算力换来的能力增益——这些运行花费的成本、token 或算力小时之上的一段通过率差值。支撑指标回答这个数字引出的问题：增益积累得多快、搜索花了多少、失败是否复发、未结清的回归债、召回的记忆价值几何，以及晋级、回滚与评估器集成表现如何。

这里不写入、也不调用模型；所有值都取自其他软件包记录的存储，缺失记录报告为不可测量而非零，因此「没有改善」与「没有测量」得以区分。

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
| `benchmark-robustness` | — | 不可测量：没有任何记录给基准任务打分。 |

### 配置

本层的部署选项，均经校验并提供默认值，因此未配置的挂载也能运行。

| 键 | 默认值 | 含义 |
|---|---|---|
| `windowRuns` | `200` | 查询未设上限时，一份报告覆盖的最新引擎运行数。 |
| `minimumRunsPerHalf` | `2` | 报告增益前，切分后每一半所需的最少运行数。 |
| `maxSignals` | `50` | 一次复发率读数覆盖的失败信号数。 |

查询可进一步收窄窗口：`taskClass` 限定到某个任务类，`since`/`until` 按记录时刻（含端点）限定，`limit` 设上限。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

### 设计理念

每项指标只有一个记录来源，并且绝不在描述不同范围的来源之间做算术。

一次引擎运行的成本在三处持久化：`evolution_meta.runs`（获胜候选自身的评估，带有同一次运行的通过、成本与时刻）、`evolution_router.outcomes`（同一次暂存写入的同一三元组），以及 `evolution_budget.spends`（该批次评估过的每个变体的累计和，因此是前两者的超集）。把其中任意两者相加都会报出两到三倍的算力消耗，所以北极星只读取 `runs`——它是唯一同时带有同一次运行的通过与否和成本的存储——而搜索额外付出的成本改由 `compute-overhead-ratio` 报告，而不是折进分母。

计费成本分母读的仍是同一批运行，因此它不是第二个范围：一次运行以其生产者据以支出的那个批次标识记录，所以一次运行的成本就是它自己那个批次记录的支出。该读数对不完整的账单很严格——若窗口内的运行并非都记录了支出，或支出未设置 `cost`，则报告为不可测量并点名缺口，因为部分求和会让增益除以少于产出它的算力。成本是部署自己的单位；只有部署以美元计费时它才是美元。

能力是已记录的通过率：窗口内的运行按时间从旧到新，切成较旧与较新两半，增益即较新一半的通过率减去较旧一半。数量为奇数时较新的一半多拿一次运行，因此处理侧看到的证据永不少于它与之比较的基线。同一增益随后除以整个窗口的成本、token、算力小时与实际经过的天数，这就是为什么每一项北极星指标共用同一个分子，只在分母上不同。

其他软件包已经算好的指标直接读取，不重算：回归债取 curator 自己的表，回滚率取 canary 自己的状态计数，评估器可靠性取健康摘要自身的比率。本层只在没有存储能回答问题时才补上算术——窗口切分、三个分母，以及搜索开销比。

### 失败与恢复

来源存储未挂载时，其指标报告为不可测量并点名缺失的存储，而报告仍携带完整指标集，因此一条命令即可回答规范中的每一项指标。来源在 `report` 运行时解析，而非挂载时，因此本层从不约束其来源的挂载顺序。

不打开任何域，也没有任何持久化，因此不发布不变式伴生模块：每次读取都重新推导的值不存在第二个独立观察。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [演化框架规范](../../../specs/evolutionary-harness-v11-deep-research.md) §55——本软件包实现的北极星指标与支撑指标集。
- [演化软件包地图](../README.zh.md)——本组的软件包及其在仓库中的位置。
- [`dsh-evolution-meta`](../evolution-meta/README.zh.md)——能力增益赖以测量的运行、成本与时刻。
- [`dsh-evolution-budget`](../evolution-budget/README.zh.md)——成本分母与搜索开销比所读取的批次支出。
- [`dsh-evolution-curator`](../evolution-curator/README.zh.md)——回归债及其背后的失败信号。
- [`dsh-evolution-canary`](../evolution-canary/README.zh.md)——回滚率所计数的部署状态。
- [`dsh-evolution-evaluator-health`](../evolution-evaluator-health/README.zh.md)——可靠性读数所依据的判定摘要。

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
- **不存在按任务的结果**——没有任何持久化记录保存单个任务、基准用例或测试是否通过。因此 `benchmark-robustness`、`skill-incremental-utility` 以及按任务的回归债都不可测量，且每一项都会点名那个能让它可计算的记录。
- **记忆效用只记录 §23 四个环节中的三个、以及 §24 四个因子中的三个**——检索、随后的决策批次、以及由调用方提供的结果都有记录，因此该读数是真实的；被注入条目是否被*使用*、是否被*引用*，以及 §24 的来源质量因子，都没有记录来源。因此这个数字是下限，其 caveat 会逐一点名缺失的每个环节，而不是把它们记作零。
- **计费成本分母需要部署自己声明价格**——`evolutionBudget.spend` 对未声明 `cost` 的支出按部署的 `pricePerMillionTokens` 计费，而当前发布的配置未设置价格，因此发布环境中的支出都不带成本。所以在运营方为自己的 token 定价之前，`capability-gain-per-cost-unit` 会点名那笔未定价的支出；它按成本单位而非美元计，因为单位就是部署自己的计费单位。
- **只有由运行推导的指标接受时间界限**——`since`、`until` 与 `taskClass` 过滤引擎运行窗口。支撑指标是全局存储的当前状态读数：canary 摘要或债务表没有可按以过滤的任务类键，而两个计数器存储（`evolution-operators`、`evolution-evaluator-strategy`）只保留 `lastAt`，因此根本无法从中重建任何窗口。
- **搜索开销按构造跨越两个范围**——该比率把累计支出与仅含获胜者的 token 相比。它衡量的是多少算力换来了这些获胜者，绝不能加到任何一侧上去。
- **评估器可靠性是判定之间的代理量**——健康存储比较的是一个判定与之后的另一个判定，而不是与人工结果比较。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

窗口建立在 `ctx.evolutionMeta.runs()` 之上，其记录以 `toISOString()` 打时间戳，因此 `since` 与 `until` 按字符串比较；由于所有记录时刻格式与时区一致，字典序即时间序。`runs()` 返回最新在前，因此窗口先取最新的 `limit` 行再反转，切分依据的是时间上的位置，而不是通过次数。

原因与注意事项由服务携带，而不是由命令撰写，这与其它演化存储一致——它们的记录本身就带 `reason` 字符串。`/metrics` 负责渲染，因此本层对数字的诚实说明随数字一起传递。

当存储开始记录本层无法测量的东西时——按任务的结果、无技能基线臂、召回命中计数器、计费成本——对应条目只需在一处从 `unavailable(...)` 改为 `metric(...)`，而指标 id 对调用方保持稳定。

</details>
