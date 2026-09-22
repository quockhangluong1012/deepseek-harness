---
description: "受控自模型：持久化的按技能能力记录，产出按最弱优先排序的能力前沿，指明下一步该学什么（ctx.evolutionSelfModel）。"
kind: "package-reference"
---

# @deepseek-ai/dsh-evolution-self-model

[English](README.md) | 中文

## 概述

`dsh-evolution-self-model` 维护持久化的按技能能力记录——优势、弱点、不确定领域、失败模式、偏好工具、评估器盲点——每次 upsert 递增修订号，外加按能力条目跟踪滚动通过率、来自观测数的置信度、最新优先的失败记录与覆盖技能。前沿将所有能力按最弱优先排序——先低通过率，再薄证据，再少覆盖技能——因此 `nextToLearn` 指明循环下一步该学什么。本存储只记录，不调用任何模型，也不强制学习。

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

挂载插件并配合存储域。技能在自视变化时记录整体自视；评估结果以能力观测到达；操作者读取前沿，决定循环下一步该学什么。

```ts
await ctx.evolutionSelfModel.record({
  skill: 'writer',
  strengths: ['draft'],
  weaknesses: ['brevity'],
  uncertainAreas: ['humor'],
  failureModes: ['rambling'],
  preferredTools: ['search'],
  evaluatorBlindspots: ['tone'],
  confidence: 0.6,
})
await ctx.evolutionSelfModel.observe({ capability: 'lint', skill: 'writer', pass: false, failure: 'missed rule' })
console.log(ctx.evolutionSelfModel.nextToLearn()?.capability)
```

`record(input)` 用技能的整体自视做 upsert，并将其修订号递增到上条记录之后一位。`assessment(skill)` 读取单个技能的评估，`assessments()` 按技能名列出所有评估。`observe(obs)` 把一次能力观测并入该能力的滚动条目，首次见到即创建。`capability(name)` 读取单个条目，`capabilities()` 按能力名列出所有条目。`gaps()` 把所有能力按最弱优先排序，`nextToLearn()` 返回最弱缺口，无条目时返回空。

### 配置

存储的部署选项，默认值适用于常规节奏；两者都带默认值校验，因此未配置的挂载仍可运行。

| 键 | 默认值 | 含义 |
|---|---|---|
| `maxObservations` | `10` | 使能力条目获得完全置信度的观测数。 |
| `maxFailures` | `10` | 每个能力条目保留的最新失败记录数。 |

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

### 设计概念

合并逻辑是纯函数。`mergeModel` 整体替换所有列表——输入是技能当前的整体自视，而非补丁——修订号递增到上条记录之后一位（技能首次评估为 1），写入时刻打上时间戳。`observeCapability` 跟踪至今所有观测的滚动通过率；置信度为观测数除以 `maxObservations` 并封顶于 1；附带的失败记录排在最新优先失败列表之首并按 `maxFailures` 截断；观测技能按首次出现顺序加入覆盖集合。`frontierGaps` 按最弱优先排序——先低通过率，再低置信度，再少覆盖技能，最后按能力名使并列永远确定性渲染——`nextToLearn` 返回第一个缺口或空。

存储是双表域：`evolution_selfmodel` 版本 1，一张以技能为键的 `models` 表存完整评估加修订号，一张以能力名为键的 `capabilities` 表存通过率条目。分数、置信度与失败在观测时并入，因此前沿是对已存条目的纯排序，不依赖任何配置。

### 失败与恢复

存储启动前读取会抛错。未知技能与能力读作 `undefined` 而非抛错，因此前沿消费者在询问学什么之前永远不需要守卫。记录只覆盖该技能自己的评估或该能力自己的条目，一个技能的自视永远不会干扰另一个。

不发布不变量伴生文件，因为域表是本状态的唯一副本，没有第二个独立观测可与之核对。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [进化式 Harness 规范](../../../specs/evolutionary-harness-v11-deep-research.md) §42——本包实现的受控自模型——以及 §33——其最弱优先排序所回答的能力前沿。
- [进化包地图](../README.zh.md)——本组包及其仓库位置。
- [`dsh-evolution-optimizer`](../evolution-optimizer/README.zh.md)——其评估结果由本存储的观测记录的进化驱动器。
- [`dsh-evolution-stagnation`](../evolution-stagnation/README.zh.md)——其无改进运行数信号与本包最弱优先前沿互补的姊妹存储。

-----

<a id="model-experience"></a>
## 模型体验

无——本存储不注册任何模型面内容。

#### KV 缓存效果

此处没有任何内容进入模型请求，因此提供方缓存复用不受影响。将自模型事实渲染进提示词的消费者拥有该请求的前缀。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

以下限制界定本存储不适用的情形，是当前的包约束。

- **记录学什么而不教授**——前沿只指出最弱能力（§58.12：信任被记录而非强制）；安排或执行学习仍是操作者或调度器的职责。
- **整体视图 upsert**——`record` 替换整个评估列表；部分补丁与按字段历史未跟踪。
- **置信度数观测数而不数难度**——十次简单通过即得完全置信度；加权难题需要在观测上加难度信号。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

评估做整体视图 upsert，因此技能记录永远不会在读取时合并新旧列表。置信度与失败在观测时并入，因此 `gaps()` 与 `nextToLearn()` 直接对已存条目排序，不触及配置，改 caps 时保持稳定。

</details>
