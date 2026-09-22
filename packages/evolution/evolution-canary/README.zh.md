---
description: "金丝雀（canary）部署追踪：暂存技能补丁的持久发布状态，含实测金丝雀证据，以及判定一次变更的风险类别准许哪一步的 §49 风险模型（ctx.evolutionCanary）。"
kind: "package-reference"
---

# @deepseek-ai/dsh-evolution-canary

[English](README.md) | 中文

## 概述

`dsh-evolution-canary` 让暂存技能补丁的部署变得审慎：每一次暂存的优化器写入都经由可选记录缝以 `shadow` 身份进入——只记录、绝不门控，不改变任何用户可见行为（§58.12）。运维者通过 `/canary` 把它推进到 `canary` 与 `promoted`，或让仍在暂存中的发布退出到 `rejected` 或 `rolled-back`；终态永不离场。每次部署都保留其实测 shadow 三元组，因此成本/质量证据伴随发布决策。同一包还承载 §49 的风险模型：`assessRisk` 把一次拟议变更（产物类别、证据强度、可逆性与留出覆盖）判为一个风险类别，以及该类别准许的步骤；actuator 的发布监控在推进任何事之前都会咨询它。此处不调用任何模型。

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

挂载插件并携带存储域即可。只要存储已挂载，部署就来自优化器的暂存写入；运维者推进或退出它们。

```ts
await ctx.evolutionCanary.enter({
  id: 'staged-0',
  skill: 'writer',
  triple: { pass: true, tokens: 3, wallTimeMs: 5 },
})
await ctx.evolutionCanary.advance('staged-0', 'canary')
await ctx.evolutionCanary.advance('staged-0', 'promoted')
```

`enter(input)` 以 `shadow` 身份记录一次部署；每次暂存写入只开启一次部署，因此重复 id 响亮拒绝。`advance(id, to)` 每次调用让部署沿阶梯推进一步（`shadow → canary → promoted`），允许每个暂存发布退出到 `rejected` 或 `rolled-back`，并对未知 id 与非法流转响亮拒绝。`deployments(state?, skill?)` 按阶梯顺序、最新在前列出记录，`summary(skill?)` 按状态计数且零从不省略。`/canary` 命令报告各状态、推进一次发布，或退出一次发布。

### 风险路由（§49）

`assessRisk(input)` 一次调用回答 §49 的两个问题：一次拟议变更有多危险，以及该风险准许哪一步。它读取关于该变更的四个事实，返回 `RiskClass` 及其 `RiskRoute`。

```ts
const { risk, route } = assessRisk({
  // What the change mutates: a skill body, or a scope-wide memory entry.
  artifact: 'skill',
  // How strong the recorded evidence is: 'strong' | 'partial' | 'none'.
  evidence: 'strong',
  // Whether a wrong bet can still be undone.
  reversible: true,
  // Whether §15's protected holdout covers the artifact's capability.
  holdout: true,
})
// risk: 'low', route: 'auto-promote'
```

| 风险类别 | 路由 | 达成条件 |
|---|---|---|
| `low` | `auto-promote` | 强证据、可逆变更、留出已覆盖——毫无加重项 |
| `medium` | `canary` | 恰好命中三个加重项之一 |
| `high` | `human-approval` | 命中两个或更多加重项，或变更无法撤销 |
| `uncertain` | `human-review` | 什么都没测量 |

三个加重项是：作用域级 `memory` 产物——该作用域内之后每个会话都会检索它，而技能正文只在会话选中该技能时才被读到；`partial` 证据——它证明了一个结果，却没有证明改进了什么；以及留出未覆盖——因为 §15 禁止把晋升建立在生成候选所用的数据集上。它们会叠加：任意两个即让变更成为高风险，而可逆性是底线而非抵消项，因此一个可逆却命中三个加重项的变更仍需审批。未测量会短路其余判断——什么都没测量的变更无论能否撤销都是 `uncertain`，因为根本没有任何证据可供推理。此处不执行任何路由：`auto-promote` 是给已经握有证据的调用者的许可，而 `human-approval` 与 `human-review` 指名的是既有的暂存写入审批所提供的那一步。

### 配置

无 —— 本存储不接受任何部署选项。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节 — 点击展开</summary>

### 设计概念

发布是一个小而纯的状态机：`nextStage` 走 `shadow → canary → promoted` 并在每个终态停下，`transitionAllowed` 回答阶梯边与两个退出边（`shadow → rejected`、`canary → rolled-back`），终态永不离场。同状态调用无需写入即可解析。

`risk.ts` 是第二个纯模块：`assessRisk` 是作用在结构化 `RiskInput` 上的单一函数，因此 §49 的表格是单元测试的对象而不是宿主夹具。它累计加重项的数量而非为其排序——这正是让「两个或更多」成为单条规则而非组合表格的原因；它把「什么都没测量」当作独立类别（`uncertain`，而非 `high`），因为测量缺失并不是危险的强信号，而是任何信号的缺失，§49 将其路由到复核而不是审批。

存储是按记录粒度的域：`evolution_canary` 版本 1，含一张以暂存写入身份为键的 `deployments` 表，存放 `{ id, skill, state, triple, at, enteredAt, decidedAt }`。`decidedAt` 只在终态决策落地时盖章，因此发布中的部署始终回答「仍在生效」。

### 失败与恢复

未知 id 或非法流转响亮拒绝，因此部署永远不会跳过阶段或逃离终态；重复 id 永不静默重新进入 shadow。存储启动前读取抛出异常。优化器通过可选存储记录，因此未安装本包的部署看不到任何行为变化，失败存储路径记录一条警告，而不是让优化失败。

本包不发布不变的伴生检查，因为域表是此状态的唯一副本，没有第二个独立观测可供比对。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [进化式 Harness 规范](../../../specs/evolutionary-harness-v11-deep-research.md) §18 与 §49 — 本包实现的 shadow → canary → 渐进晋升发布，以及中风险 → canary 的人工介入规则；§58.12 说明只记录不强制边界。
- [进化包地图](../README.zh.md) — 该组的包及其仓库位置。
- [`dsh-evolution-optimizer`](../evolution-optimizer/README.zh.md) — 其暂存写入经可选记录缝以 shadow 身份进入的产生方。
- [`dsh-evolution-population`](../evolution-population/README.zh.md) — 把同一批暂存写入记录为竞争候选的姊妹存储。

-----

<a id="model-experience"></a>
## 模型体验

无，本存储不注册任何面向模型的东西。

#### KV 缓存影响

此处没有任何内容进入模型请求，因此不影响供应商缓存复用。把部署状态渲染进提示词的消费者拥有该请求的前缀。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与暂缓工作

这些限制定义了本存储在何种情况下不合适。它们是当前的包约束。

- **只是追踪，不是强制** —— 进入 shadow 与推进发布只改变已记录状态；没有任何东西把技能对模型的可见性门控起来（§58.12 有意为之），因此未追踪的补丁仍可经由其他写入路径到达模型。
- **shadow 测量即暂存三元组** —— 存储记录胜者的实测三元组，而不是对照生产基线的隐藏响应比较；这种基于重放的比较是暂缓的监控工作（§18 的对比步骤）。
- **宿主全局，不按作用域键控** —— 部署是全局的；按作用域的发布策略需要给域加作用域键。
- **风险模型只为被告知的内容定级** —— `assessRisk` 自身不指派任何风险类别：`reversible` 与 `holdout` 是调用者的断言，`evidence` 是调用者的评级，该函数只把 §49 的表格套用其上。若调用者为无法撤销的变更报告 `reversible: true`，就会得到比应得更低的风险类别；这正是 actuator 从已记录状态推导全部四个字段（`rolloutRisk`）而不是手写它们的原因。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

优化器通过可选存储记录，因此未安装金丝雀包的部署看不到任何行为变化；失败存储路径记录一条警告，而不是让优化失败。状态机放在纯 `stages` 模块中，日后新增状态只需 `TRANSITIONS` 与 `nextStage` 为其作答；`decidedAt` 用单一维度区分「发布中」与「已决定」，无需第二个状态维度。§49 的风险模型放在这里而不是 actuator，是因为发布阶梯正是变更获得可逆性的来源——`canary` 部署仍可退出到 `rolled-back`——所以风险类别与阶梯是同一段暂存写入生命周期的两种读法，而 actuator 始终只是其他包所拥有规则的执行者。

</details>