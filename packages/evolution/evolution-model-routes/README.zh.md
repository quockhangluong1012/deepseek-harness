---
description: "自适应模型路由：面向进化角色拓扑、带实测证据与推荐的持久化按角色路由指派，以及按运行的职责分离检查（ctx.evolutionModelRoutes）。"
kind: "package-reference"
---

# @deepseek-ai/dsh-evolution-model-routes

[English](README.md) | 中文

## 概述

`dsh-evolution-model-routes` 记录每个进化角色——任务执行、反思、候选生成、评估、晋升审查——用过哪个 provider/model、以及各路由测得如何，使 §28 的自适应路由保持诚实。优化器的结果经可选存储缝进入，运维者通过 `/routes` 固定路由，`recommend` 返回固定指派或证据最强的一条，`conflicts` 则点名既产出工作又评判工作的路由。本包还记录某次运行各角色由谁担任，并据此回答 §53 的职责分离：由生成候选的那个身份签署的晋升或裁决会被拒绝，并点名两个角色。此处不调用任何模型。

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

挂载插件并携带存储域即可。只要存储已挂载，证据就来自优化器的候选生成运行；运维者读取指派、固定路由并读取实测证据。承担晋升或裁决的调用者先记录该次运行各角色由谁填充，再在做出决定之前读取职责分离检查。

```ts
await ctx.evolutionModelRoutes.observe({
  role: 'candidate-generation',
  route: { provider: 'deepseek', model: 'deepseek-chat' },
  triple: { pass: true, tokens: 3, wallTimeMs: 5 },
})
await ctx.evolutionModelRoutes.pin('evaluation', 'deepseek', 'deepseek-reasoner')
const recommended = ctx.evolutionModelRoutes.recommend('candidate-generation')
const conflicts = ctx.evolutionModelRoutes.conflicts()

await ctx.evolutionModelRoutes.recordDuty({ runId: stagedId, role: 'candidate-generation', identity: 'session-42' })
await ctx.evolutionModelRoutes.recordDuty({ runId: stagedId, role: 'promotion-review', identity: 'operator' })
const separation = ctx.evolutionModelRoutes.checkDuties(stagedId, 'promotion')
// { allowed: true }, or a refusal whose reason names both roles.
```

`observe(input)` 记录一条实测结果，并把路由以 `observed` 身份 upsert（已固定路由保留其固定身份）。`pin(role, provider, model)` 为某角色固定一条路由；在 `recommend` 中固定指派胜过一切被观测路由。`routes(role?)` 把各角色的路由指派与其证据合并成摘要列出，`evidence(role?, route?)` 按最新在前列出原始结果。`conflicts()` 点名每条同时被指派给产出角色——任务执行、反思、候选生成——与评判角色——评估、晋升审查——的路由，其中 `pinned` 记录该指派是否由运维者显式设定。`/routes` 命令打印各角色指派及其推荐路由、固定一条路由，或读取证据。

`recordDuty({ runId, role, identity })` 记录某一次运行中某个进化角色由哪个身份填充，同一次运行中重复记录同一角色会替换其身份；`duties(runId)` 按角色拓扑顺序列出该次运行的全部填充。`checkDuties(runId, decision)` 回答 §53 的职责分离：`promotion`——候选生成对晋升审查——或 `verdict`——候选生成对评估：两个已记录身份不同时返回 `{ allowed: true }`，否则返回一条拒绝——`same-identity` 点名两个角色以及填充它们的那个身份，`unknown-identity` 点名没有记录身份的角色，因为未记录的角色绝不被假定为不同。`dsh-command-evolution` 是晋升这一半的随包调用方：`/curator optimize <skill> <scenario...>` 把暂存该候选的会话记录为 `candidate-generation`，而 `/canary promote <id>` 把发起晋升的会话记录为 `promotion-review`，并在检查拒绝时报告该拒绝，而不是推进部署。

### 配置

无 —— 本存储不接受任何部署选项。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节 — 点击展开</summary>

### 设计概念

聚合与推荐都是纯函数。`mergeEvidence` 把某角色的证据行折叠成按路由的摘要——运行次数、通过率、平均 token 与最新时刻——未测度路由按零报告。`bestRoute` 先推荐最新的固定指派，其次在至少有一条已记录运行的路由中挑通过率最高、平均 token 最少者，且仅当该角色没有固定指派时才这样做。§53 的规则同样是纯函数：`separationOfDuties` 读取某决策所分离的角色对，并比对两个已记录身份。

存储是按记录粒度的域：`evolution_model_routes` 版本 1，含一张以角色+路由为键的 `routes` 表、一张以证据身份为键的 `evidence` 表，以及一张以运行+角色为键的 `duties` 表，分别存放 `{ role, provider, model, origin, at }`、`{ id, role, provider, model, pass, tokens, wallTimeMs, at }` 与 `{ runId, role, identity, at }`。角色词汇表即 §28 拓扑的有序集合。职责键用角色都不含的分隔符连接运行与角色，从而在运行与角色上保持单射，且对按记录布局是路径安全的。

### 拓扑冲突（§28）

`roleConflicts` 按路由对指派集分组，报告每条同时出现在 §28 拓扑两侧——一个产出角色与一个评判角色——的路由，按拓扑顺序给出，并用 `pinned` 记录它是否由运维者显式设定。一条路由出现在两侧，意味着评判者与被评判者跑在同一模型上，于是裁决就是候选自己的输出；该读数只记录、绝不强制，`recommend` 仍然完全按已记录的指派作答。

### 职责分离（§53）

晋升是关于某个候选的决定，§53 要求审查它的身份不同于生成它的身份；裁决则是同一问题在评估上的问法。`SEPARATED_DUTIES` 给出每个决策所分离的角色对——`promotion` 把候选生成与晋升审查配对，`verdict` 把候选生成与评估配对——`separationOfDuties` 在该次运行记录了两种身份时返回 `allowed`，否则返回一条拒绝：`same-identity` 点名两个角色与填充它们的那个身份，`unknown-identity` 点名没有记录身份的角色。缺失的行与空身份都被读作未记录，因此该检查失败即关闭，而不会把缺失的记录读作不同身份；身份就是调用者记录的内容，因为本包不观测任何会话或运维者。

### 失败与恢复

存储启动前读取抛出异常；无指派且无证据的角色推荐为空，而不是编造一条路由。优化器通过可选存储记录，因此未安装本包的部署看不到任何行为变化，失败存储路径记录一条警告，而不是让优化失败。

本包不发布不变的伴生检查，因为域表是此状态的唯一副本，没有第二个独立观测可供比对。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [进化式 Harness 规范](../../../specs/evolutionary-harness-v11-deep-research.md) §28 — 本包实现的自适应模型路由拓扑，源自 AlphaEvolve 的更快/更广与更强/更深模型组合 —— 以及 §53：其 Multi-Agent 升级就是 `duties` 表所记录的职责分离。
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
- **冲突是警告，不是阻断** —— `conflicts` 点名一条既产出又评判的路由，而没有任何机制拒绝该指派：运维者的固定指派按设计优先于拓扑，因此该读数的意义是让冲突可见，而不是覆盖它。
- **拒绝在运维者晋升路径上强制，而不在监视器上** —— `dsh-command-evolution` 的 `/canary promote <id>` 会查询 `checkDuties`：该命令把自身会话记录为审查身份，并在该次运行记录的提案者就是同一身份时拒绝晋升，部署留在原处。执行器的发布监视器按 §49 的 `auto-promote` 路由晋升，而该决定由心跳在完全没有会话身份的情况下做出，因此那条自动路径不记录也不检查任何职责；决策词汇中的 `verdict` 一半没有消费者，因为没有任何东西记录 `evaluation` 身份。
- **职责只记录，绝不推断** —— 存储保存调用者给出的身份，并在某角色没有身份时拒绝；它不观测会话、代理或运维者，因此从不调用 `recordDuty` 的部署对每一次运行都会得到 `unknown-identity`，而不是被猜测的裁决。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

优化器通过可选存储记录，因此未安装模型路由包的部署看不到任何行为变化；失败存储路径记录一条警告，而不是让优化失败。`RouteSummary` 携带自己的角色，让拓扑排序与推荐过滤始终按角色进行，且对无固定或无测度路由的角色，绝不为它猜测一条路由。`separationOfDuties` 把已记录的职责作为参数，因此 §53 的规则是单元测试的对象而不是宿主夹具，而存储的 `checkDuties` 就是同一规则作用在自己的行上。

</details>