---
description: "元进化：持久记录各配置与工作流下的引擎运行，并推荐下一次工作流（ctx.evolutionMeta）。"
kind: "package-reference"
---

# @deepseek-ai/dsh-evolution-meta

[English](README.md) | 中文

## 概述

`dsh-evolution-meta` 让演化引擎演化自身。每次引擎运行都按其选择所产生的配置——变异算子组合、评估器、预算身份、路由——连同这次运行实际执行的阶段序列一起记录，因此工作流是被记录的，而不是由组成部分反推出来的。摘要按任务类别推导每个「配置＋工作流」的通过率与平均 token，推荐再按样本置信度校正后的得分排序，于是引擎学到的是在某个任务类别上下一步该运行哪套配置、以何种顺序运行，而不是永远复用同一套。此包不调用模型，也不改变引擎运行的任何内容。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [§26 层级地图](#the-26-level-map)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

挂载插件并配合存储域。调用者按实际使用的配置与工作流记录每次引擎运行；推荐回答的是某任务类别下一次该用哪套配置、哪种序列。

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
  workflow: [
    { component: 'operators', choice: 'portfolio-v1' },
    { component: 'evaluator', choice: 'scorer-v1' },
    { component: 'budget', choice: 'balanced-v1' },
    { component: 'routing', choice: 'deepseek/chat' },
  ],
  pass: true,
  tokens: 5000,
  wallTimeMs: 60000,
})
const next = ctx.evolutionMeta.recommend('writer')
```

`record(input)` 追加一次引擎运行，用默认选择补全不完整的配置，并原样存放工作流——工作流缺失即记录调用者未观察到序列，而不是编造一种顺序。`runs(taskClass?)` 按最新优先列出运行；`summaries(taskClass?)` 在读取时推导每个「配置＋工作流」的通过率与平均 token；`recommend(taskClass)` 返回拥有至少 `minimumSamples` 次运行的最佳得分配置与工作流，没有任何配置达到该门槛时返回 `undefined`。

### 配置

存储的部署选项，带默认值校验，因此未配置的挂载仍可运行。

| 键 | 默认值 | 含义 |
|---|---|---|
| `minimumSamples` | `3` | 配置可被推荐前所需的运行次数。 |
| `defaultConfig` | `portfolio-v1 / scorer-v1 / balanced-v1 / evidence-v1` | 所记录运行未指定任何选择时使用的引擎配置。 |

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

### 设计概念

身份确定且证据由推导得出。`configIdOf(config, workflow)` 按固定顺序连接四个选择，再以 `workflowIdOf(workflow)` 收尾，因此以相同顺序运行的相等配置永远共享同一身份，而相同组件以不同顺序运行是两个身份——这正是让推荐给出的是一种序列而非一个标量的原因。`summarize` 按任务类与该身份对运行分组，并折叠运行中的通过率与平均 token；`scoreOf` 用贝塔先验平滑通过率，并按样本数距最小值的接近程度缩放——`(passes + 1) / (samples + 2) × min(1, samples / minimumSamples)`——因此一次侥幸运行的配置无法超过测量充分的配置。

工作流是被记录的，不是合成的。每个阶段点明它所调用的组件与所用的选择，并处在运行执行它的那个位置上；存储原样接受该序列，从不从配置反推，因为相同组件的两种顺序正是第 2 层存在的意义所在。运行未记录序列的摘要会在理由中写明 `workflowUnrecorded`，而不会把一个标量选择当成工作流呈现。

存储是单表域：`evolution_meta` 版本 2，一张按运行标识键控的 `runs` 表存 `{ runId, taskClass, config, workflow, pass, tokens, wallTimeMs, at }`。版本 1 存下的运行没有它们执行过的序列；该字段默认空工作流，因此被担保的 v1 运行可原样打开。摘要由表在读取时推导，因此新运行永不重写较早运行。

### 失败与恢复

存储启动前读取会抛错。`record` 以事件方式追加运行，因此运行流只增不改，摘要视图始终是它的纯推导；不完整的配置由配置的默认值补全，未记录的工作流以空序列存放。

不发布不变量伴生文件，因为域表是本状态的唯一副本，没有第二个独立观测可与之核对。

</details>

-----

<a id="the-26-level-map"></a>
## §26 层级地图

规范的 §26 阶梯共五层，本包族以五个「记录＋推荐」的存储来实现。每一层的存储都存在、都能推导出自己的读数、都能通过自己的命令作答；但它们无一会自己填充内容，因为记录一次运行的那一行引擎——`evolution-optimizer`——以 `disabled: true` 出厂，因此出厂的主机不运行任何演化，五者在某个 profile 或 `--patch` 覆盖层启用它之前一律读为空。

| 层级 | 演化对象 | 覆盖它的存储 | 状态 |
|---|---|---|---|
| 1——产物 | 被暂存的产物本身：一份 SKILL.md 正文、一个提示词、一份配置 | `evolution-optimizer`，并由 `evolution-population`、`evolution-canary`、`evolution-lineage` 保存其候选、发布与信封 | 已实现，但在优化器被禁用期间**不可达**：没有任何运行会暂存写入，因此任何层级都没有记录 |
| 2——工作流 | 引擎运行的序列：哪个算子、哪个评估器、哪一档预算，以何顺序 | `evolution-meta`（本存储）——每次运行、摘要与推荐上都带 `workflow` 与 `workflowId` | 已实现且可检视；在有运行记录序列之前**不可达**，因为优化器的记录接缝是唯一写入者 |
| 3——变异策略 | 哪种变异算子对哪类产物有效 | `evolution-operators`——按产物类别排序的算子组合 | 同一门槛；第 3–5 层只是记录，不是策略（§26 的治理上限） |
| 4——评估策略 | 哪个评估器能抓住回归，以及多大的基准才够 | `evolution-evaluator-strategy`，其证据由 `evolution-evaluator-health` 与 `evolution-benchmark` 提供 | 同一门槛 |
| 5——资源分配 | 分配多少搜索预算、何时利用何时探索、走哪条路由 | `evolution-budget` 与 `evolution-model-routes` | 同一门槛 |

由此有两点结论，各包 README 直接写明而不是遮掩：

- **写入者被禁用不等于该层已实现。** 第 2 层的轴线是真实存在的——工作流被记录、被赋予身份、被分组、被打分并被推荐——但出厂主机不记录任何运行，因此在出厂 profile 中对 `ctx.evolutionMeta.summaries()` 诚实的读法是「尚未记录任何引擎运行」，而不是「工作流不工作」。同一句话适用于第 3–5 层：它们的存储已挂载，命令会作答。
- **任何层级都不改变引擎运行的内容。** 这五个存储一律是记录加推荐。采纳推荐是 §26 推迟到「强治理存在之后」的决定，且没有任何出厂路径会这样做：`/meta recommend`、`/operators`、`/evaluator-strategy`、`/budget` 与 `/router` 只报告存储学到的东西。

-----

<a id="further-exploration"></a>
## 进一步探索

- [进化式 Harness 规范](../../../specs/evolutionary-harness-v11-deep-research.md) §26——本包实现其第 2 层的元演化阶梯，建立在 §9 的基础上。
- [进化包地图](../README.zh.md)——本组包及其仓库位置。
- [`dsh-evolution-optimizer`](../evolution-optimizer/README.zh.md)——通过可选记录接缝记录每次暂存写入的引擎运行与工作流的消费者，也是出厂即禁用的一行。
- [`dsh-evolution-operators`](../evolution-operators/README.zh.md)、[`dsh-evolution-evaluator-strategy`](../evolution-evaluator-strategy/README.zh.md)、[`dsh-evolution-budget`](../evolution-budget/README.zh.md) 与 [`dsh-evolution-model-routes`](../evolution-model-routes/README.zh.md)——本包组合成单一引擎配置的四个组件学习器。

-----

<a id="model-experience"></a>
## 模型体验

无——本存储不注册任何模型面内容。

#### KV 缓存效果

此处没有任何内容进入模型请求，因此提供方缓存复用不受影响。将摘要渲染进提示词的消费者拥有该请求的前缀。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

以下限制界定本存储不适用的情形，是当前的包约束。

- **推荐是记录而非引擎策略**——存储负责学习与推荐，自己从不实例化引擎配置或工作流，因此推荐的好坏取决于是否有人采纳（§58.12 记录而非强制）。
- **工作流的完整度取决于调用者的报告**——未记录序列的运行会与同一配置下所有其它未报告运行分到一组，存储无法区分「引擎跳过了某阶段」与「引擎没有报告」。
- **配置是不透明的键**——每个组件选择都是不透明字符串；没有组件注册表，存储无从知道 `portfolio-v2` 与 `portfolio-v1` 具体差在哪里。
- **每个任务类别各学一套**——摘要在单个任务类别内孤立学习；跨相似类别的汇聚先验需要本存储没有的分类体系。
- **无跨组件归因**——当两套配置有多个组件不同时，存储说不出是哪个组件导致了通过率变化；孤立消融需要同时使用谱系存储。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

摘要由运行表在读取时推导，因此运行流只增不改，新运行永不重写较早运行。`record` 用默认选择补全不完整的配置，因此只知道部分组件的调用者不会丢掉其余部分；它又原样存放工作流，因此调用者后来读回的身份正是它自己那次运行产生的身份。得分的样本置信因子意味着 `recommend` 除配置中的 `minimumSamples` 外不需要额外的门槛判断。

</details>
