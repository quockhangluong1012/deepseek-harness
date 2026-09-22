---
description: "路由自优化：按任务类的路由结果与派生有效性，以及路由推荐（ctx.evolutionRouter）。"
kind: "package-reference"
---

# @deepseek-ai/dsh-evolution-router

[English](README.md) | 中文

## 概述

`dsh-evolution-router` 学习对某个任务类与进化角色该用哪条模型路由。每条结果记录该路由在某任务类上的通过、token 与墙钟时间；有效性在读取时用运行均值与通过率推导，推荐按样本置信度校正后的得分排序，使结果稀少的路由无法超过测量充分的路由。同一批结果也回答 §44：当一个任务类与角色的两条最分歧路由被测得差距足够大时，本存储把该分歧记录为不确定性信号，而不是猜测哪条才是对的。此包不调用任何模型。

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

挂载插件并配合存储域。调用者记录每次走路由的运行结果；推荐回答某个任务类与角色该用哪条路由。

```ts
await ctx.evolutionRouter.observe({
  taskClass: 'writer',
  role: 'evaluation',
  provider: 'deepseek',
  model: 'chat',
  pass: true,
  tokens: 1000,
  wallTimeMs: 2000,
})
const best = ctx.evolutionRouter.recommend('writer', 'evaluation')
const found = ctx.evolutionRouter.disagreements('writer', 'evaluation')
```

`observe(outcome)` 追加一条实测结果，逐记录键控；`outcomes(taskClass?, role?)` 按最新优先列出结果；`effectiveness(taskClass?, role?)` 在读取时推导带运行均值的每条路由有效性；`recommend(taskClass, role)` 返回拥有至少 `minimumSamples` 条实测结果的最佳排序路由，没有任何路由达到该门槛时返回 `undefined`。

随后 `observe` 检查它刚测量的任务类与角色：当两条最分歧的已测路由差距达到 `disagreementThreshold` 时，它通过可选的 `ctx.evolutionUncertainty` 接缝记录一条 `disagreement` 不确定性信号——它是由路由结果得出的搜索信号，无需第二次模型调用。`disagreements(taskClass?, role?)` 按最大差距优先返回当前强烈分歧，已测路由一致时返回空。分歧不会触发任何路由：它只是被记录下来，供排空队列者使用。

### 配置

存储的部署选项，带默认值校验，因此未配置的挂载仍可运行。

| 键 | 默认值 | 含义 |
|---|---|---|
| `minimumSamples` | `3` | 路由可被推荐前所需的实测结果数。 |
| `disagreementMinimumRuns` | `3` | 路由被分歧比较测量前所需的实测结果数。 |
| `disagreementThreshold` | `0.5` | 两条路由视为分歧的通过率差距。 |

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

### 设计概念

证据精确且由推导得出。`updatedEffectiveness` 累积样本与通过次数，并把每条结果的 token 与墙钟时间折入运行均值，因此 `passRate`、`meanTokens` 与 `meanWallTimeMs` 是结果流的精确函数。`scoreOf` 用贝塔先验平滑通过率，并按样本数距最小值的接近程度缩放——`(passes + 1) / (samples + 2) × min(1, samples / minimumSamples)`——因此单个样本上的一次侥幸通过无法超过测量充分的路由。`rankRoutes` 按该得分排序，以提供方/模型升序打破平局。

存储是单表域：`evolution_router` 版本 1，一张逐记录键控的 `outcomes` 表存 `{ taskClass, role, provider, model, pass, tokens, wallTimeMs, at }`。有效性在读取时由表推导，因此新结果永不重写较早结果。

### 作为搜索信号的分歧（§44）

`routeDisagreement` 取某任务类与角色下拥有至少 `disagreementMinimumRuns` 条结果的各路由中的最高与最低通过率，并在差距达到 `disagreementThreshold` 时报告二者；已测路由不足两条、或差距在阈值以内，都视为一致并不报告任何内容。每条信号的身份由任务类、角色与那两条路由推导得出，因此重复记录同一分歧只更新一条信号而不会堆积副本：排空队列的一轮与随后再次记录同一分歧的一轮会收敛，而不是无界增长。

### 失败与恢复

存储启动前读取会抛错。`observe` 把结果作为事件追加，因此结果流是只追加的，有效性视图始终是它的纯推导。

不发布不变量伴生文件，因为域表是本状态的唯一副本，没有第二个独立观测可与之核对。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [进化式 Harness 规范](../../../specs/evolutionary-harness-v11-deep-research.md) §28——本包泛化为按任务类自优化的自适应模型路由——以及 §44——把模型分歧作为搜索信号。
- [进化包地图](../README.zh.md)——本组包及其仓库位置。
- [`dsh-evolution-optimizer`](../evolution-optimizer/README.zh.md)——通过可选记录接缝记录每次暂存写入的评估路由与结果的消费者。
- [`dsh-evolution-model-routes`](../evolution-model-routes/README.zh.md)——持有按角色路由分配与证据的姊妹包，而本包按任务类学习路由有效性。
- [`dsh-evolution-uncertainty`](../evolution-uncertainty/README.zh.md)——接收强烈路由分歧为不确定性信号的 §44 接缝。
- [`dsh-evolution-actuator`](../evolution-actuator/README.zh.md)——把排队中的不确定性信号转成基准工作的排空循环。

-----

<a id="model-experience"></a>
## 模型体验

无——本存储不注册任何模型面内容。

#### KV 缓存效果

此处没有任何内容进入模型请求，因此提供方缓存复用不受影响。将路由有效性渲染进提示词的消费者拥有该请求的前缀。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

以下限制界定本存储不适用的情形，是当前的包约束。

- **结果只是记录，不是路由决策**——本包学习并推荐；它从不亲自走路由，因此推荐只与遵循它的调用者一样好（§58.12 记录而非强制）。
- **分歧比较的是已记录结果，而非实时模型**——该读数需要同一任务类与角色下已有两条路由被测量，因此它检测跨路由的结果分歧，而非逐样本的模型分歧：两条路由在某个任务类上通过比例相同就不会触发任何信号，即使它们通过的正是类中不同的任务；只有一条路由跑过的任务类也没有可发现的分歧。要在同一任务上做真正的双模型比较，需要本包刻意不做的第二次模型调用。
- **已记录的信号等待排空**——只要存储挂载，分歧信号就会写入 `ctx.evolutionUncertainty`，而此处不消费该队列；真正 admit 并 resolve 它的是驱动器的排空循环，且评分器出厂即禁用，因此已记录的信号在该循环挂载前可能一直未被读取。
- **今天每个存储只测一个角色**——优化器接缝只记录 `evaluation` 结果；其余四个 §28 角色等待它们自己的记录接缝。
- **任务类是透明键**——有效性按任务类孤立学习；跨类的相似性结构需要本存储没有的分类法。
- **无成本加权**——得分只按通过率与样本置信排序；按美元成本调整的得分需要一个本包刻意不假设的定价来源。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

有效性在读取时由结果表推导，因此结果流保持只追加，新结果永不重写较早结果。`observe` 逐记录独立键控，因此同一路由可被测量多次而不冲突。得分的样本置信因子意味着 `recommend` 除了配置的 `minimumSamples` 外无需单独的守卫。分歧检查在 `observe` 内运行，并把失败的不确定性存储吞成一条警告，因此损坏的队列永不使已记录结果失败；由于分组以任务类与角色唯一，其比较器只需差距与任务类。

</details>