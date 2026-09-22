---
description: "评估器策略进化：带按任务类推荐的持久每评估器信任统计（ctx.evolutionEvaluatorStrategy）。"
kind: "package-reference"
---

# @deepseek-ai/dsh-evolution-evaluator-strategy

[English](README.md) | 中文

## 概述

`dsh-evolution-evaluator-strategy` 学习对某个任务类该信任哪个评估器。每条判定都与其后的地面真值配对；用自身核对自身的判定不能佐证任何东西；只有独立配对，例如搜索集通过与留出集通过核对，才会推动评估器的权重。§28 追加第二条规则：与产出候选的模型一起记录的判定，就是评判者给自己的产出打分，属非独立证据，并单独计入 `selfJudgedSamples`。平滑的佐证权重按任务类对评估器排序；推荐在某个评估器拥有足够独立样本后指名最受佐证者，并给出 §28 放在最终晋级复核上的那条路由。此包不调用任何模型。

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

挂载插件并配合存储域。调用者记录每个评估器判定、其后的地面真值，以及涉及的两个模型；排序与推荐回答某个任务类该信任哪个评估器。

```ts
await ctx.evolutionEvaluatorStrategy.observe({
  evaluator: 'scorer-v1',
  taskClass: 'writer',
  candidateModel: 'deepseek-chat',
  judgeModel: 'deepseek-reasoner',
  verdict: true,
  groundTruth: true,
  independent: true,
})
const ranked = ctx.evolutionEvaluatorStrategy.ranking('writer')
const trusted = ctx.evolutionEvaluatorStrategy.recommend('writer')
```

`observe(outcome)` 按任务类幂等更新该评估器的统计，只把独立的匹配配对计为佐证；`judgeIndependence(judgeModel, candidateModel)` 是 §28 的规则，把来自候选自身模型的判定称为 `same-model`；`strategies(taskClass?)` 按评估器顺序列出各行；`ranking(taskClass)` 按平滑佐证权重对该类的评估器排序，并给出 `ctx.evolutionModelRoutes` 指派给 `promotion-review` 角色的路由，未指派时为 `null`；`recommend(taskClass)` 返回拥有至少 `minimumSamples` 个独立样本的最佳排序评估器，没有任何评估器达到该门槛时返回 `undefined`。

### 配置

存储的单一部署选项，带默认值校验，因此未配置的挂载仍可运行。

| 键 | 默认值 | 含义 |
|---|---|---|
| `minimumSamples` | `3` | 评估器可被推荐前所需的独立样本数。 |

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

### 设计概念

佐证是唯一的学习信号。`updatedStrategy` 总是提高样本数，但只有独立配对——`outcome.independent` 且评判者不是候选自身的模型——才提高 `independentSamples`，只有判定与其地面真值相等的独立配对才提高 `corroborations`。用自身核对自身的判定、或来自产出候选的模型的判定，都不会推动任何数字；后一种情况会计入 `selfJudgedSamples`，使该行显示其记录中有多少是评判者给自己的产出打分。`weightOf` 用一次佐证对两次观测的贝塔先验平滑 `(corroborations + 1) / (independentSamples + 2)`，在没有独立证据时返回零，因此一次侥幸匹配无法超过长期记录。

存储是单表域：`evolution_evaluator_strategy` 版本 2，一张按评估器与任务类连接键控的 `strategies` 表，存 `{ evaluator, taskClass, samples, independentSamples, corroborations, selfJudgedSamples, weight, lastAt }`；版本 1 的行读作零条自评判定。排序在读取时由表推导，因此配置变更会重新排序，而无需重写已记录行。

### 最强已配置验证者（§28）

§28 的拓扑以「最终晋级复核 → 最强验证者」收尾，而指派那条路由的地方是 `evolution-model-routes`。因此 `ranking` 与 `recommend` 会把该存储为 `promotion-review` 角色推荐的路由作为 `promotionReview` 附在每个条目上，未指派时为 `null`，于是推荐会说明在它的裁定被采纳前该由哪个模型复核。点名它不会触发任何路由：没有运行会由一条推荐启动。

### 失败与恢复

存储启动前读取会抛错。`observe` 按评估器与类幂等更新，因此同一评估器对同一类的重复判定就地累积而非重复。

不发布不变量伴生文件，因为域表是本状态的唯一副本，没有第二个独立观测可与之核对。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [进化式 Harness 规范](../../../specs/evolutionary-harness-v11-deep-research.md) §9——学习哪些评估器产生有用的改进，这是元进化的基础。
- [进化包地图](../README.zh.md)——本组包及其仓库位置。
- [`dsh-evolution-optimizer`](../evolution-optimizer/README.zh.md)——通过可选记录接缝把每次暂存写入的评分器判定与其留出地面真值配对的消费者。
- [`dsh-evolution-evaluator-health`](../evolution-evaluator-health/README.zh.md)——跟踪合奏一致性、漂移与校准的姊妹包，而本包学习实际该信任哪个评估器。
- [`dsh-evolution-model-routes`](../evolution-model-routes/README.zh.md)——持有本包推荐所点名的、作为最强已配置验证者的 `promotion-review` 路由的存储。

-----

<a id="model-experience"></a>
## 模型体验

无——本存储不注册任何模型面内容。

#### KV 缓存效果

此处没有任何内容进入模型请求，因此提供方缓存复用不受影响。将排序渲染进提示词的消费者拥有该请求的前缀。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

以下限制界定本存储不适用的情形，是当前的包约束。

- **地面真值来自调用者**——存储用调用者提供的任何地面真值来评判判定；它从不自己测量留出结果，因此 `independent: true` 配对只与调用者一样独立。
- **未记录的候选模型无法核对**——§28 规则需要两个模型身份；记录空 `candidateModel` 的调用者会得到 `independent` 读数，因为无法证明评判者的身份就是候选的。记录产出路由，这项检查才有意义。
- **只记录的存储，不调用模型**——本包学习该信任哪个评估器；它从不运行评估或自行改变合奏。
- **每个评估器与类只有一个权重**——策略权重按任务类孤立学习；跨相似类的合并先验需要本存储没有的类分类法。
- **无权重衰减**——佐证永远累积；评估器或任务变化时，新证据落地会把权重推向新值，但旧证据永不显式过期。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

排序在读取时由表推导，因此配置变更会重新排序，无需重写已记录行；`observe` 做幂等更新，因此同一评估器对同一类的重复判定就地累积。按设计佐证是唯一的学习信号：非独立配对只提高 `samples` 而不推动权重，因此尚不能提供独立地面真值的调用者仍可记录判定流。晋级复核查询在每次排序调用时读取一次模型路由存储，并把未挂载的存储视为「未指派验证者」，而不是让排序失败。

</details>