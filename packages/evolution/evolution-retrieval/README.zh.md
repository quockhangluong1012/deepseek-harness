---
description: "检索感知的进化：按会话记录检索配置，以下游任务成功而非检索精度评判，并给出每个任务类别的配置推荐（ctx.evolutionRetrieval）。"
kind: "package-reference"
---

# @deepseek-ai/dsh-evolution-retrieval

[English](README.md) | 中文

## 概述

`dsh-evolution-retrieval` 进化的是智能体检索到什么，而不只是它如何推理。它按会话记录生效中的检索配置——检索来源、查询扩展、通道权重、重排器、MMR、记忆作用域、图深度与活动记忆阈值——并以**下游任务成功**衡量每个配置：把这些会话与技能遥测、反馈存储已携带的已评级结果连接起来。逐任务类别的排名在积累到足够已评级会话后推荐实测成功率最好的配置，未达门槛则不报告任何内容。此处不调用任何模型。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与暂缓工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

挂载插件并携带存储域即可。[`dsh-active-memory-context`](../../context/active-memory-context/README.zh.md) 在本存储挂载于其旁边时，会按会话记录一次自己所运行的配置；其他任何召回实现都可用同一个调用记录自己的配置。

```ts
await ctx.evolutionRetrieval.record({
  configuration: {
    source: 'hybrid',
    queryExpansion: 'graph-entities',
    weights: { vector: 1, graph: 1 },
    reranker: 'none',
    mmr: { enabled: false, lambda: 1 },
    memoryScope: 'workspace',
    graphDepth: 1,
    threshold: 0.7,
  },
  sessionId: 'session-42',
})
const recommended = ctx.evolutionRetrieval.recommend('writer')
if (recommended !== undefined) {
  console.log(recommended.configKey, recommended.reason)
}
```

`record(input)` 按「配置 + 会话」连接为键，幂等更新一个会话在某个配置下的归属记录，因此同一会话记录两次仍只有一条归属。`attributions(configKey?)` 按最新在前列出已记录的归属。`effectiveness(taskClass?)` 由已评级会话推导出每个配置与任务类别一行。`recommend(taskClass)` 返回越过证据门槛的最佳配置，否则返回 `undefined`。

### 配置

证据门槛是可在 `cordis.yml` 中修改的已验证 `Config` 成员。

```yaml
- name: '@deepseek-ai/dsh-evolution-retrieval'
  config:
    minimumSessions: 5
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `minimumSessions` | `5` | 某个配置在某个任务类别上被推荐前所需的已评级会话数 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-evolution-retrieval)是每个已接受字段的穷尽来源。

### 推荐需要多少证据，以及为什么

一次推荐需要该**确切的配置与任务类别**上有 `minimumSessions` 个已评级会话——每个会话一个评级，绝不跨类别合并，因为类别正是推荐的对象。默认取五，原因有三，且相互叠加：

- **一个评级来自另一个存储的一次二值判断。** 此处不测量每次调用的检索质量：唯一信号是该配置所服务的会话在被评级的存储里是否干净收场。因此单个会话只是关于整个配置的一个数据点，能诚实设门槛的只有它们的数量。
- **门槛卡在数量上，而不是分数上。** `scoreOf` 用 beta 先验平滑成功率乘以 `min(1, samples / minimumSessions)`，置信因子恰在门槛处饱和——但它只缩放分数，`recommendConfiguration` 会跳过已评级会话不足的配置，无论其分数多高。四战四胜的分数可以高于一个测量充分的落败者，而它仍然只是某天下午的一批证据。
- **五正是先验不再主导估计的位置。** 平滑成功率带有价值两个伪会话的「一胜一负」先验：三个评级时占 5 分之 2，五个评级时占 7 分之 2。到了五，决定排名的是实测会话而非先验。

在其地方对会话评级——第二个结果存储，或会话成本很低的类别——的部署可下调该门槛；类别只积累到少量已评级会话的部署则应上调。门槛之下 `recommend` 回答 `undefined`，其行为由下文的失败一节说明：部分挂载的证据存储会如何收窄连接。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节 — 点击展开</summary>

### 设计概念

归属记录是 `evolution_retrieval` 域（v1，一张以「配置键 + 会话 id」连接为键的 `attributions` 表）中的持久逐条行：`{ configKey, configuration, sessionId, at }`。配置键是 §39 全部维度按固定顺序的取值，因此以不同字段顺序构造同一配置的两个调用方记录的是同一个配置；同一会话记录两次会幂等更新其行并保留首次的时刻。

有效性在读取时推导，永不落库。`gradesOf(sessions, skills, failed)` 连接两个已经对会话评级的证据存储：技能遥测存储给出会话服务过的任务类别与其已评级结果，反馈存储则在某个信号评级为 `complete`（归因到具体工具的失败，而非仅被观察到的失败）时，把该会话在其加载过的类别上评为失败。`effectivenessRows` 把这些评级折叠为每个配置与类别一行，`rankConfigurations` 用 `scoreOf` 为每行打分——与 `dsh-evolution-model-routes` 给路由打分相同的、按样本置信度缩放的 beta 先验平滑成功率。因此配置由它服务过的会话达成了什么来评判：一个提升了相似度分数、但其会话却失败的检索改动，排名会低于没有这样做的配置。

本包不测量检索精度，也不以它排名：相似度是召回实现选择的输入，配置的名次取决于它的会话达成了什么。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：持久存储、对证据存储的读取连接，以及推荐 |
| [`src/retrieval.ts`](src/retrieval.ts) | 纯函数的配置键、会话评级连接、有效性折叠、排名与推荐 |
| [`src/spec.ts`](src/spec.ts) | `evolution_retrieval` 域及其 zod 行模式 |

### 失败与恢复

未挂载或形态不符的证据存储只会让该来源没有评级，而不会让读取失败：没有遥测就没有任务类别，没有反馈则会话只保留其遥测评级。在没有任何配置达到门槛时，`recommend` 回答 `undefined`。存储启动前读取抛出异常。

本包不发布不变的伴生检查，因为归属表是此状态的唯一副本，没有第二个独立观测可供比对。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [进化式 Harness 规范](../../../specs/evolutionary-harness-v11-deep-research.md) §39 — 本包实现的检索感知进化机制；§23 与 §24 是相关性反馈与记忆效用的框架，用下游效用取代单看相似度。
- [进化包地图](../README.zh.md) — 该组的包及其仓库位置。
- [`dsh-active-memory-context`](../../context/active-memory-context/README.zh.md) — 产生方：它为每个它所简报的会话记录生效中的检索配置。
- [`dsh-evolution-skill-telemetry`](../../skill/evolution-skill-telemetry/README.zh.md) 与 [`dsh-evolution-feedback`](../evolution-feedback/README.zh.md) — 本包所连接的两个已评级会话证据来源。
- [`dsh-evolution-model-routes`](../evolution-model-routes/README.zh.md) — 使用相同打分形态、从实测结果学习路由的同族包。

-----

<a id="model-experience"></a>
## 模型体验

无，本存储不注册任何面向模型的东西。

#### KV 缓存影响

此处没有任何内容进入模型请求，因此不影响供应商缓存复用。产生方在回合旁边记录而非写入回合内容，而把推荐渲染进提示词的消费者拥有该请求的前缀。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与暂缓工作

这些限制定义了本存储在何种情况下不合适。它们是当前的包约束。

- **评级属于会话而非配置** —— 一个在两个配置下运行过的会话会把结果同时计入两者；把一次结果分摊到服务过它的多个配置，需要这些存储并未记录的逐回合归属。
- **只有已评级的会话才计入** —— 两个存储都未评级的会话不贡献任何东西，因此从未被评级的类别永远不会给出推荐。
- **有效性是宿主全局的，不按作用域键控** —— 归属是全局行；按工作区的视角需要给域加作用域键。
- **记录的配置是注入器的投影** —— 八个维度记录的是挂载实际设定的内容，因此部署在此无法变动的维度（权重、重排器、MMR、查询扩展）记录为已发布的选择，而不是逐备选方案的实测值。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

产生方接缝在两侧都是可选的：`dsh-active-memory-context` 通过结构化的 `RetrievalLedger` 写入并只标记会话一次，因此未挂载本包的部署不记录任何内容，存储拒绝写入也只记一行 debug 日志。没有任何代码等待这次写入，回合自身的消息也未被触碰，这正是挂载与未挂载本存储时简报逐字节相同的原因。

两个证据接缝都通过 `ctx.get` 读取并做结构化守卫，因此本包不依赖遥测包或反馈包；缺失某个存储只会收窄连接，而不会让读取失败。

</details>
