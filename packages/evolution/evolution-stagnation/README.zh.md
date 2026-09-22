---
description: "停滞检测：统计技能在无有意义改进情况下的评估运行次数，并在前沿停滞时给出下一个多样性策略（ctx.evolutionStagnation）。"
kind: "package-reference"
---

# @deepseek-ai/dsh-evolution-stagnation

[English](README.md) | 中文

## 概述

`dsh-evolution-stagnation` 维护跨运行的按技能评估运行日志——每个暂存优化器写入对应一条——并检测技能何时停止改进。每次运行携带测量的三元组和改进标志：它是否击败了该技能的最佳成绩，其中 token 与耗时收益必须先越过下限。一旦技能停滞超过配置的阈值，检测器便会给出下一个策略，并沿 §32 的阶梯攀升——多样性、新算子、新任务、评估器，最终更换模型。优化器通过可选存储接缝记录暂存写入，`command-evolution` 通过 `/stagnation` 读取状态。此包不调用任何模型。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

挂载插件并配合存储域。只要存储已挂载，运行就来自优化器的暂存写入；操作者读取状态，并在任务制度变更时重置技能。

```ts
await ctx.evolutionStagnation.recordRun({
  runId: 'staged-0',
  skill: 'writer',
  score: { pass: true, tokens: 3, wallTimeMs: 5 },
})
const status = ctx.evolutionStagnation.status('writer')
if (status.stagnant) console.log(status.strategy)
```

`recordRun(input)` 将运行编号为技能运行计数加一，并标记其是否在意义上改进了该技能的最佳成绩。`runs(skill?)` 按最新优先列出运行；`status(skill)` 报告最佳成绩、距上次改进以来的运行数、相对配置阈值的停滞标志，以及当前应采取的策略；`reset(skill)` 在任务制度变更时丢弃一个技能的历史。`/stagnation` 命令渲染状态、列出运行并重置技能。

### 配置

检测器的部署选项，默认值适用于常规节奏；两者都带默认值校验，因此未配置的挂载仍可运行。

| 键 | 默认值 | 含义 |
|---|---|---|
| `threshold` | `5` | 技能停滞前的无意义改进运行次数。 |
| `relativeImprovement` | `0.05` | 被视为有意义的相对 token 或耗时收益下限。 |

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

### 设计概念

检测逻辑是纯函数。`betterThan` 将一个成绩与最佳成绩比较：技能的第一个成绩总是改进空最佳成绩，通过收益占主导，而在通过不变时，至少 `relativeImprovement` 的 token 减少（或 token 不变时同等规模的耗时减少）才算数；低于下限的均为抖动。`bestOf` 跟踪精英顶端——先通过，再少 token，再快耗时——无下限。`generationsSince` 统计最后一次改进运行之后的运行数，并在每次改进处重置。`strategyFor` 在阈值以下保持常规利用，每满一个阈值跨度攀升一级阶梯——`diversity`、`newOperators`、`newTasks`、`newEvaluators`——最终封顶于 `newModel`。

存储是按运行的域：`evolution_stagnation` 版本 1，一个按运行标识键控的 `runs` 表，存 `{ runId, skill, generation, score, improved, at }`。状态在读取时由完整运行历史推导，因此改进标志是已记录事实，而策略始终反映当前配置。

### 失败与恢复

存储启动前读取会抛错。运行 ID 即优化器的暂存写入 ID，因此 `/stagnation` 中的 ID 始终指向真实的暂存写入。`reset` 只移除指定技能的运行，一次任务制度变更永远不会抹掉另一技能的历史。

不发布不变量伴生文件，因为域表是本状态的唯一副本，没有第二个独立观测可与之核对。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [进化式 Harness 规范](../../../specs/evolutionary-harness-v11-deep-research.md) §32——本包实现的停滞检测器。
- [进化包地图](../README.zh.md)——本组包及其仓库位置。
- [`dsh-evolution-optimizer`](../evolution-optimizer/README.zh.md)——通过可选记录接缝将暂存写入变为运行的生产者。
- [`dsh-evolution-novelty-search`](../evolution-novelty-search/README.zh.md)——其档案新奇度正是 §32 阶梯首先点名的多样性杠杆的姊妹存储。

-----

<a id="model-experience"></a>
## 模型体验

无——本存储不注册任何模型面内容。

#### KV 缓存效果

此处没有任何内容进入模型请求，因此提供方缓存复用不受影响。将停滞事实渲染进提示词的消费者拥有该请求的前缀。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

以下限制界定本存储不适用的情形，是当前的包约束。

- **记录策略而不执行策略**——检测器只给出下一个策略（§58.12：信任被记录而非强制）；更换变异算子、任务、评估器或模型仍是操作者的职责。
- **每次运行一个三元组**——一次运行是一个测量三元组；配对运行与多种子比较未跟踪。
- **重置是粗糙工具**——`reset` 丢弃整个技能历史；窗口化或衰减历史需要在域上加保留逻辑。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

优化器通过可选存储记录，因此未挂载停滞包的部署行为完全不变；存储失败路径记录警告而非使优化失败。状态在读取时由历史推导，因此配置变更会重新排序策略，而无需重写已记录运行。

</details>
