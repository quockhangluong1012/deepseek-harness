---
description: "不确定性驱动学习：将持久化的不确定性信号聚合成高价值评估任务的优先级队列（ctx.evolutionUncertainty）。"
kind: "package-reference"
---

# @deepseek-ai/dsh-evolution-uncertainty

[English](README.md) | 中文

## 摘要

`dsh-evolution-uncertainty` 维护持久化的不确定性信号日志——评估器分歧、低置信度、跨种子不稳定、检索歧义、证据冲突——并将其聚合成高价值评估任务的优先级队列。共享同一技能与任务的信号相互佐证：首个不同种类之后的每种不同信号种类都会给任务优先级加上配置的加成并封顶于一，因此被多种信号标记的任务会排在更热的单信号任务之前。解决一个任务会丢弃其信号，队列随即由剩余信号重新推导。此包不调用任何模型。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)
- [开发者注记](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

挂载插件并配合存储域。只要生产者记录信号，信号就来自评估器、裁判与检索诊断；操作者读取队列，并在重新评估后解决任务。

```ts
await ctx.evolutionUncertainty.record({
  signalId: 'sig-0',
  skill: 'writer',
  taskId: 't1',
  kind: 'disagreement',
  score: 0.8,
  detail: 'contract approved, replay regressed',
})
const next = ctx.evolutionUncertainty.queue('writer')
if (next.length > 0) console.log(next[0]?.taskId, next[0]?.priority)
```

`record(input)` 给信号盖上当前时刻并按信号标识存储。`signals(skill?)` 按最新优先列出信号；`queue(skill?, limit?)` 把过滤后的信号聚合成评估任务，按优先级降序、再按技能、再按任务（技能级任务排最后）排序，并以调用者上限或配置的队列上限截断；`resolve(skill, taskId?)` 丢弃一个任务背后的信号——不给任务标识时只丢弃技能级信号——并返回移除计数。

### 配置

队列的部署选项，默认值适用于常规节奏；两者都带默认值校验，因此未配置的挂载仍可运行。

| 键 | 默认值 | 含义 |
|---|---|---|
| `queueLimit` | `50` | 调用者不传上限时 `queue` 返回的最大任务数。 |
| `corroborationBonus` | `0.15` | 一个任务内首个不同种类之后每种不同信号种类的优先级加成。 |

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

### 设计概念

聚合逻辑是纯函数。`priorityOf` 以最强信号为基数，按首个不同种类之后的不同种类数加上佐证加成——独立种类一致认为某任务不确定，比单个响亮信号更有分量——并把总分封顶于一。`queueFor` 按技能与任务标识分组信号，空任务标识自成技能级分组，把每个任务的不同种类按 §43 标准顺序列出，并按优先级降序、技能升序、任务标识（空最后，再按字典序）排序队列，因此顺序是确定的。

存储是按信号的域：`evolution_uncertainty` 版本 1，一张按信号标识键控的 `signals` 表，存 `{ signalId, skill, taskId, kind, score, detail, at }`。队列在读取时由完整信号历史推导，因此配置变更会重新排序优先级，而无需重写已记录信号。

### 失败与恢复

存储启动前读取会抛错。不给任务标识时 `resolve` 只丢弃该技能的技能级信号，因此解决技能级疑虑永远不会清除某任务的证据，解决一个任务也永远不会触及其他任务的信号。

不发布不变量伴生文件，因为域表是本状态的唯一副本，没有第二个独立观测可与之核对。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [进化式 Harness 规范](../../../specs/evolutionary-harness-v11-deep-research.md) §43 与 §44——本包实现的不确定性驱动学习循环与分歧搜索信号。
- [进化包地图](../README.zh.md)——本组包及其仓库位置。
- [`dsh-evolution-scorer`](../evolution-scorer/README.zh.md)——其按通道 `evaluatorDisagreement` 裁决向分歧种类供料的生产者；本包只聚合该信号，不重新计算它。
- [`dsh-evolution-evaluator-health`](../evolution-evaluator-health/README.zh.md)——其持久裁决账本记录分歧种类所源自的裁判意见的姊妹存储。

-----

<a id="model-experience"></a>
## 模型体验

无——本存储不注册任何模型面内容。

#### KV 缓存效果

此处没有任何内容进入模型请求，因此提供方缓存复用不受影响。将队列事实渲染进提示词的消费者拥有该请求的前缀。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

以下限制界定本存储不适用的情形，是当前的包约束。

- **记录队列而不运行评估**——本存储排出值得再看的内容的优先级（§43：主动学习循环）；调度与运行评估仍是操作者的职责。
- **分数是受信任的生产者输入**——信号强度的语义属于生产者（评估器、裁判、检索诊断）；本存储不做任何校准。
- **解决会丢弃整个任务分组**——`resolve` 移除一个任务背后的全部信号；作废其中某一种类的单个信号需要在域上加单信号删除。

<a id="dev-note"></a>
### 开发者注记

<details>
<summary>维护者工作上下文——点击展开</summary>

队列在读取时由信号历史推导，因此配置变更会重新排序优先级，而无需重写已记录信号。本存储只记录，不触及任何模型提示词；生产者只在挂载本包时经存储接缝记录。

</details>
