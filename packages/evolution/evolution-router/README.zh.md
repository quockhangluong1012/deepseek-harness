---
description: "路由自优化：按任务类的路由结果与派生有效性，以及路由推荐（ctx.evolutionRouter）。"
kind: "package-reference"
---

# @deepseek-ai/dsh-evolution-router

[English](README.md) | 中文

## 摘要

`dsh-evolution-router` 学习对某个任务类与进化角色该用哪条模型路由。每条结果记录该路由在某任务类上的通过、token 与墙钟时间；有效性在读取时用运行均值与通过率推导，推荐按样本置信调整的得分对路由排序，使结果稀少的路由无法超过测量充分的路由。此包不调用任何模型。

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
```

`observe(outcome)` 追加一条实测结果，逐记录键控；`outcomes(taskClass?, role?)` 按最新优先列出结果；`effectiveness(taskClass?, role?)` 在读取时推导带运行均值的每条路由有效性；`recommend(taskClass, role)` 返回拥有至少 `minimumSamples` 条实测结果的最佳排序路由，没有任何路由达到该门槛时返回 `undefined`。

### 配置

存储的单一部署选项，带默认值校验，因此未配置的挂载仍可运行。

| 键 | 默认值 | 含义 |
|---|---|---|
| `minimumSamples` | `3` | 路由可被推荐前所需的实测结果数。 |

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

### 设计概念

证据精确且由推导得出。`updatedEffectiveness` 累积样本与通过次数，并把每条结果的 token 与墙钟时间折入运行均值，因此 `passRate`、`meanTokens` 与 `meanWallTimeMs` 是结果流的精确函数。`scoreOf` 用贝塔先验平滑通过率，并按样本数距最小值的接近程度缩放——`(passes + 1) / (samples + 2) × min(1, samples / minimumSamples)`——因此单个样本上的一次侥幸通过无法超过测量充分的路由。`rankRoutes` 按该得分排序，以提供方/模型升序打破平局。

存储是单表域：`evolution_router` 版本 1，一张逐记录键控的 `outcomes` 表存 `{ taskClass, role, provider, model, pass, tokens, wallTimeMs, at }`。有效性在读取时由表推导，因此新结果永不重写较早结果。

### 失败与恢复

存储启动前读取会抛错。`observe` 把结果作为事件追加，因此结果流是只追加的，有效性视图始终是它的纯推导。

不发布不变量伴生文件，因为域表是本状态的唯一副本，没有第二个独立观测可与之核对。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [进化式 Harness 规范](../../../specs/evolutionary-harness-v11-deep-research.md) §28——本包泛化为按任务类自优化的自适应模型路由。
- [进化包地图](../README.zh.md)——本组包及其仓库位置。
- [`dsh-evolution-optimizer`](../evolution-optimizer/README.zh.md)——通过可选记录接缝记录每次暂存写入的评估路由与结果的消费者。
- [`dsh-evolution-model-routes`](../evolution-model-routes/README.zh.md)——持有按角色路由分配与证据的姊妹包，而本包按任务类学习路由有效性。

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
- **今天每个存储只测一个角色**——优化器接缝只记录 `evaluation` 结果；其余四个 §28 角色等待它们自己的记录接缝。
- **任务类是透明键**——有效性按任务类孤立学习；跨类的相似性结构需要本存储没有的分类法。
- **无成本加权**——得分只按通过率与样本置信排序；按美元成本调整的得分需要一个本包刻意不假设的定价来源。

<a id="dev-note"></a>
### 开发者注记

<details>
<summary>维护者工作上下文——点击展开</summary>

有效性在读取时由结果表推导，因此结果流保持只追加，新结果永不重写较早结果。`observe` 逐记录独立键控，因此同一路由可被测量多次而不冲突。得分的样本置信因子意味着 `recommend` 除了配置的 `minimumSamples` 外无需单独的守卫。

</details>