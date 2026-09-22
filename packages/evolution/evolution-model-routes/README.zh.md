---
description: "自适应模型路由：面向进化角色拓扑、带实测证据与推荐的持久化按角色路由指派（ctx.evolutionModelRoutes）。"
kind: "package-reference"
---

# @deepseek-ai/dsh-evolution-model-routes

[English](README.md) | 中文

## 摘要

`dsh-evolution-model-routes` 让 §28 自适应路由拓扑保持诚实：每个进化角色——任务执行、反思、候选生成、评估与最终晋升审查——都可以运行在不同的模型上，本存储持久记录每个角色用过哪个 provider/model、以及各路由测得如何。优化器通过可选存储缝记录每一次候选生成的路由与结果，运维者通过 `/routes` 固定指派，`recommend` 则回答某角色应该用哪条路由：存在固定指派时用固定指派，否则用实测证据最强的路由。此处不调用任何模型。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与暂缓工作](#known-limitations-and-deferred-work)
- [开发者注记](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

挂载插件并携带存储域即可。只要存储已挂载，证据就来自优化器的候选生成运行；运维者读取指派、固定路由并读取实测证据。

```ts
await ctx.evolutionModelRoutes.observe({
  role: 'candidate-generation',
  route: { provider: 'deepseek', model: 'deepseek-chat' },
  triple: { pass: true, tokens: 3, wallTimeMs: 5 },
})
await ctx.evolutionModelRoutes.pin('evaluation', 'deepseek', 'deepseek-reasoner')
const recommended = ctx.evolutionModelRoutes.recommend('candidate-generation')
```

`observe(input)` 记录一条实测结果，并把路由以 `observed` 身份 upsert（已固定路由保留其固定身份）。`pin(role, provider, model)` 为某角色固定一条路由；在 `recommend` 中固定指派胜过一切被观测路由。`routes(role?)` 把各角色的路由指派与其证据合并成摘要列出，`evidence(role?, route?)` 按最新在前列出原始结果。`/routes` 命令打印各角色指派及其推荐路由、固定一条路由，或读取证据。

### 配置

无 —— 本存储不接受任何部署选项。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节 — 点击展开</summary>

### 设计概念

聚合与推荐都是纯函数。`mergeEvidence` 把某角色的证据行折叠成按路由的摘要——运行次数、通过率、平均 token 与最新时刻——未测度路由按零报告。`bestRoute` 先推荐最新的固定指派，其次在至少有一条已记录运行的路由中挑通过率最高、平均 token 最少者，且仅当该角色没有固定指派时才这样做。

存储是按记录粒度的域：`evolution_model_routes` 版本 1，含一张以角色+路由为键的 `routes` 表与一张以证据身份为键的 `evidence` 表，分别存放 `{ role, provider, model, origin, at }` 与 `{ id, role, provider, model, pass, tokens, wallTimeMs, at }`。角色词汇表即 §28 拓扑的有序集合。

### 失败与恢复

存储启动前读取抛出异常；无指派且无证据的角色推荐为空，而不是编造一条路由。优化器通过可选存储记录，因此未安装本包的部署看不到任何行为变化，失败存储路径记录一条警告，而不是让优化失败。

本包不发布不变的伴生检查，因为域表是此状态的唯一副本，没有第二个独立观测可供比对。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [进化式 Harness 规范](../../../specs/evolutionary-harness-v11-deep-research.md) §28 — 本包实现的自适应模型路由拓扑，源自 AlphaEvolve 的更快/更广与更强/更深模型组合。
- [进化包地图](../README.zh.md) — 该组的包及其仓库位置。
- [`dsh-evolution-optimizer`](../evolution-optimizer/README.zh.md) — 其候选生成路由与结果经可选记录缝成为证据的产生方。
- [`dsh-evolution-population`](../evolution-population/README.zh.md) — 采用同一可选挂载模式的姊妹存储，其记录缝与之类似。

-----

<a id="model-experience"></a>
## 模型体验

无，本存储不注册任何面向模型的东西。

#### KV 缓存影响

此处没有任何内容进入模型请求，因此不影响供应商缓存复用。优化器自身的变异请求携带本存储推荐的路由；该请求的前缀属于优化器。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与暂缓工作

这些限制定义了本存储在何种情况下不合适。它们是当前的包约束。

- **推荐是建议性的，不强制** —— `recommend` 回答某角色应该用哪条路由，但今天只有优化器的候选生成角色记录证据，且优化器仍以其配置的路由为准；把其余角色的消费者接入并强制执行推荐路由是接下来的适配工作。
- **证据只来自优化器** —— 评估、反思与晋升审查路由在各自消费者开始观测之前没有已记录运行。
- **宿主全局，不按作用域键控** —— 路由是全局的；按作用域的路由策略需要给域加作用域键。

<a id="dev-note"></a>
### 开发者注记

<details>
<summary>维护者工作上下文 — 点击展开</summary>

优化器通过可选存储记录，因此未安装模型路由包的部署看不到任何行为变化；失败存储路径记录一条警告，而不是让优化失败。`RouteSummary` 携带自己的角色，让拓扑排序与推荐过滤始终按角色进行，且对无固定或无测度路由的角色，绝不为它猜测一条路由。

</details>