---
description: "元进化：在其配置下运行的持久引擎运行，以及下一次配置推荐（ctx.evolutionMeta）。"
kind: "package-reference"
---

# @deepseek-ai/dsh-evolution-meta

[English](README.md) | 中文

## 摘要

`dsh-evolution-meta` 进化进化引擎本身。每次引擎运行都在其选择产出的引擎配置下记录——突变算子组合、评估器、预算标识与路由——摘要按任务类推导每个配置的通过率与平均 token。推荐按样本置信调整的得分对配置排序，因此引擎会学习某个任务类下一次该用哪个配置，而不是始终使用同一个。此包不调用任何模型。

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

挂载插件并配合存储域。调用者记录每次引擎运行及其所用配置；推荐回答某个任务类的下一次运行该用哪个配置。

```ts
await ctx.evolutionMeta.record({
  runId: 'run-42',
  taskClass: 'writer',
  config: {
    operators: 'portfolio-v1',
    evaluator: 'scorer-v1',
    budget: 'balanced-v1',
    routing: 'deepseek/chat',
  },
  pass: true,
  tokens: 5000,
  wallTimeMs: 60000,
})
const next = ctx.evolutionMeta.recommend('writer')
```

`record(input)` 追加一次引擎运行，用默认选择补全不完整的配置；`runs(taskClass?)` 按最新优先列出运行；`summaries(taskClass?)` 在读取时推导每个配置的通过率与平均 token；`recommend(taskClass)` 返回拥有至少 `minimumSamples` 次运行的最佳得分配置，没有任何配置达到该门槛时返回 `undefined`。

### 配置

存储的部署选项，带默认值校验，因此未配置的挂载仍可运行。

| 键 | 默认值 | 含义 |
|---|---|---|
| `minimumSamples` | `3` | 配置可被推荐前所需的运行次数。 |
| `defaultConfig` | `portfolio-v1 / scorer-v1 / balanced-v1 / evidence-v1` | 记录运行未指名任何选择时使用的引擎配置。 |

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

### 设计概念

身份确定且证据由推导得出。`configIdOf` 按固定顺序连接四个选择，因此相等的配置永远共享同一身份，调用者对象的字段顺序永远无关紧要。`summarize` 按任务类与配置身份对运行分组，并折叠运行中的通过率与平均 token；`scoreOf` 用贝塔先验平滑通过率，并按样本数距最小值的接近程度缩放——`(passes + 1) / (samples + 2) × min(1, samples / minimumSamples)`——因此一次侥幸运行的配置无法超过测量充分的配置。

存储是单表域：`evolution_meta` 版本 1，一张按运行标识键控的 `runs` 表存 `{ runId, taskClass, config, pass, tokens, wallTimeMs, at }`。摘要由表在读取时推导，因此新运行永不重写较早运行。

### 失败与恢复

存储启动前读取会抛错。`record` 把运行作为事件追加，因此运行流是只追加的，摘要视图始终是它的纯推导，不完整的配置由配置的默认值补全。

不发布不变量伴生文件，因为域表是本状态的唯一副本，没有第二个独立观测可与之核对。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [进化式 Harness 规范](../../../specs/evolutionary-harness-v11-deep-research.md) §9——本包实现的自指进化，元进化的基础。
- [进化包地图](../README.zh.md)——本组包及其仓库位置。
- [`dsh-evolution-optimizer`](../evolution-optimizer/README.zh.md)——通过可选记录接缝记录每次暂存写入的引擎运行的消费者。
- [`dsh-evolution-operators`](../evolution-operators/README.zh.md)、[`dsh-evolution-evaluator-strategy`](../evolution-evaluator-strategy/README.zh.md)、[`dsh-evolution-budget`](../evolution-budget/README.zh.md) 与 [`dsh-evolution-router`](../evolution-router/README.zh.md)——本包组合成单一引擎配置的四个组件学习者。

-----

<a id="model-experience"></a>
## 模型体验

无——本存储不注册任何模型面内容。

#### KV 缓存效果

此处没有任何内容进入模型请求，因此提供方缓存复用不受影响。将摘要渲染进提示词的消费者拥有该请求的前缀。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

以下限制界定本存储不适用的情形，是当前的包约束。

- **推荐只是记录，不是引擎策略**——本包学习并推荐；它从不亲自实例化引擎配置，因此推荐只与遵循它的调用者一样好（§58.12 记录而非强制）。
- **配置是透明键**——每个组件选择都是不透明字符串；没有组件注册表，存储无法知道 `portfolio-v2` 与 `portfolio-v1` 在哪个具体方面不同。
- **每种学习模型一个任务类**——摘要按任务类孤立学习；跨相似类的引擎合并先验需要本存储没有的分类法。
- **无跨组件归因**——两个配置之间两个组件都不同时，存储无法说出哪个造成了通过率变化；隔离消融需要搭配 lineage 存储。

<a id="dev-note"></a>
### 开发者注记

<details>
<summary>维护者工作上下文——点击展开</summary>

摘要由运行表在读取时推导，因此运行流保持只追加，新运行永不重写较早运行。`record` 用默认选择补全不完整的配置，因此只了解部分组件的调用者永不丢失其余选择。得分的样本置信因子意味着 `recommend` 除了配置的 `minimumSamples` 外无需单独的守卫。

</details>