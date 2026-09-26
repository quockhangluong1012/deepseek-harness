---
description: "睡眠时计算：由证据驱动的空闲预期，按离线成本经济策略预计算推理产物（ctx.evolutionSleeptime）。"
kind: "package-reference"
---

# @deepseek-ai/dsh-evolution-sleeptime

[English](README.md) | 中文

## 概述

`dsh-evolution-sleeptime` 在空闲时预期可能出现的未来任务，并为它们缓存预计算的推理产物：摘要、检索结构、候选计划。它不凭空捏造：心跳遍历读取路由存储与技能遥测存储已记录的复现，只预期窗口内复现足够频繁的任务类别。每个任务携带可能性、预期查询数与单查询节省；只有当可能性加权的节省超过离线成本时才值得付出，贪心计划把净收益最高的项装进离线预算，并把该决策记在它为之辩护的产物上。此后同一类别新记录的一轮会记一次命中与它记录在案的 token，并由游标跟踪。此包不调用任何模型。

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

挂载插件并配合存储域。当路由存储或技能遥测存储也已挂载时，心跳的空闲节拍会自行运行预期遍历；操作者也可以手工预期任务、预计算产物并驱动一次遍历。

```ts
// The automatic pass: what the source stores recorded is what it anticipates.
await ctx.evolutionSleeptime.anticipateAll()

// Or by hand, for a task the operator already knows is coming.
await ctx.evolutionSleeptime.anticipate({
  taskId: 'nightly-review',
  domain: 'writer',
  likelihood: 0.8,
  expectedQueries: 10,
  expectedSavingTokens: 500,
})
await ctx.evolutionSleeptime.precompute({
  artifactId: 'review-outline',
  taskId: 'nightly-review',
  kind: 'candidate-plan',
  summary: 'outline',
  offlineCostTokens: 200,
})
const planned = ctx.evolutionSleeptime.plan()
```

`anticipateAll(signal?)` 运行一次遍历：从已挂载的源推导复现，预期窗口 `recurrenceWindowHours` 内复现次数至少达到 `minRecurrences` 的每个类别，为它们预计算 `plan()` 所辩护的产物，并对消耗了已缓存产物的已记录轮次记账。`anticipate(input)` 按任务标识幂等更新，因此重复预期的任务会刷新其可能性与期望。`tasks(domain?)` 按可能性优先列出任务；`precompute(input)` 为一个预期任务缓存一份产物，对未知任务大声拒绝；`artifacts(taskId?)` 按最新优先列出产物；`hit(artifactId, occurrences)` 对产物所属类别中晚于其游标的每个已记录发生记账；`plan(estimatedCostTokens?, budgetTokens?)` 返回尚无缓存产物的任务上的贪心预算计划。

### 配置

存储的部署选项，默认值适用于较小的夜间空闲窗口；每个字段都带默认值校验，因此未配置的挂载仍可运行。

| 键 | 默认值 | 含义 |
|---|---|---|
| `defaultEstimatedCostTokens` | `2000` | 单次预计算的估计离线 token，调用者未指定时使用。 |
| `maxOfflineTokens` | `50000` | 单次计划的离线 token 总预算，调用者未指定时使用。 |
| `minRecurrences` | `3` | 类别在窗口内需要达到的发生次数，达到才计为复现。 |
| `recurrenceWindowHours` | `168` | 已记录发生仍计为复现的回溯小时数。 |
| `intervalHours` | `6` | 两次自动预期遍历之间的小时数。 |
| `maxPerPass` | `3` | 单次遍历可预期并预计算的类别数。 |

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

### 设计概念

经济学计算是纯函数。`expectedNet` 把单个任务的预期节省按可能性加权，再减去估计的离线成本，因此从未发生的任务仍要付出预计算成本。`decideWorth` 要求严格为正的净收益：恰好为零的净收益等于把空闲时间花在无用功上。`planFor` 只保留值得的决策，按净收益降序、任务标识升序打破平局，在累计估计成本仍能装进预算时贪心取用。`savingsOf` 从产物命中已省的 token 中减去其离线成本，在预计算回本前保持为负。`precompute(input)` 把计划的理由与产物存在一起，因此每份缓存产物都点明为它辩护的那次比较。

预期由推导得出，从不捏造。`recurrenceOf` 统计窗口内每个「源＋类别」的已记录发生并返回其平均 token；`anticipationOf` 保留发生次数至少 `minRecurrences` 的类别，把每个可能性设为它在复现发生中的占比，把 `expectedQueries` 记为该类别自身的复现次数、把 `expectedSavingTokens` 记为单次已记录发生的平均 token，并按可能性优先排序。`classKeyOf` 用源为类别加命名空间，因此读起来相似的技能与路由仍是两个候选。`artifactSummaryOf` 把已记录的复现写进产物内容，因此一次预计算缓存的内容点明的是它的证据，而不是模型撰写的任何东西。随后遍历读取已挂载路由存储的实测结果，并对每个被跟踪的技能读取加载过它的那些会话的学习轨迹行。未挂载的源不贡献任何东西，没有任何复现的遍历则什么都不记录。

记账以游标为界。`hit(artifactId, occurrences)` 取该产物自身类别中严格晚于 `servedThroughAt` 的已记录发生——在产物从未被服务时该游标是它自己的预计算时刻，因此在产物存在之前跑过的轮次永远不会被算作它的消费者——每次各记一次命中与那次发生记录在案的 token，并把游标推进到最新的一次。找不到更新发生的遍历不会改动产物，这正是重复遍历安全的原因。

存储是双表域：`evolution_sleeptime` 版本 2，一张按任务标识键控的 `tasks` 表存 `{ taskId, domain, scope, likelihood, expectedQueries, expectedSavingTokens, at }`，一张按产物标识键控的 `artifacts` 表存 `{ artifactId, taskId, kind, summary, offlineCostTokens, decisionReason, hits, savedTokens, servedThroughAt, at }`。版本 1 存下的产物没有后两个记账字段；两者默认均为 null，而 null 游标从产物自身时刻起算，因此被担保的 v1 行可原样打开。计划在读取时由当前表推导，因此配置变更会重新排序计划，而无需重写已记录行。

### 失败与恢复

存储启动前读取会抛错。`precompute` 拒绝未知任务标识，`hit` 拒绝未知产物标识，因此产物永远指向真实的预期任务，记账永远落在真实的缓存产物上。`anticipate` 按任务标识幂等更新，因此重复预期的任务就地刷新而非重复；一次失败的遍历由心跳记在该任务名下，且不会中断同一节拍中的其它任务。

不发布不变量伴生文件，因为域表是本状态的唯一副本，没有第二个独立观测可与之核对。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [进化式 Harness 规范](../../../specs/evolutionary-harness-v11-deep-research.md) §25——本包实现的睡眠时计算。
- [进化包地图](../README.zh.md)——本组包及其仓库位置。
- [`dsh-evolution-heartbeat`](../evolution-heartbeat/README.zh.md)——其安静节拍触发预期遍历的空闲驱动者。
- [`dsh-evolution-model-routes`](../evolution-model-routes/README.zh.md) 与 [`dsh-evolution-skill-telemetry`](../../skill/evolution-skill-telemetry/README.zh.md)——遍历据其已记录复现做预期的两个存储。
- [`dsh-evolution-dreaming`](../evolution-dreaming/README.zh.md)——把过往观察固化为持久记忆的姊妹包，而睡眠时计算为可能的未来做预计算。

-----

<a id="model-experience"></a>
## 模型体验

无——本存储不注册任何模型面内容。

#### KV 缓存效果

此处没有任何内容进入模型请求，因此提供方缓存复用不受影响。将预期任务或缓存产物渲染进提示词的消费者拥有该请求的前缀。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

以下限制界定本存储不适用的情形，是当前的包约束。

- **每个预期类别一种产物类型**——遍历为它准入的每个类别预计算一份 `summary`；检索索引与候选计划两种类型是操作者或未来遍历发起的 `precompute` 调用。
- **记账按预期键匹配**——产物只与「源＋类别」键等于其 `taskId` 的发生记账，因此标识为裸名的、由操作者预计算的产物永远不会被自动记账。
- **复现按次数而非权重计**——一个类别无论其单次发生多么昂贵都只计一次；按成本加权的复现需要源存储并不记录的逐次成本。
- **每次计划一种估计成本**——`plan` 把每次预计算都按同一估计成本计价；按种类的成本估计需要在预计算种类上加成本模型。
- **无产物淘汰**——缓存产物会累积；保留或价值衰减剪除需要在域上加生命周期逻辑。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

计划在读取时由表推导，因此配置变更会重新排序计划，无需重写已记录行；`anticipate` 做幂等更新，因此对同一任务的重复空闲观察会刷新其期望。遍历自己产出的产物以 `classKeyOf` 为键，这正是 `hit` 能找到其消费者的原因；对于调用者命名的产物，存储不会去推导该键。遍历在唯一一处无界等待——逐个被跟踪技能读取轨迹——处观察中止信号，因为其余每个阶段都由 `maxPerPass` 界定且只读取本地存储。心跳只在初始化时解析一次，因此挂载本存储的主机必须先挂载心跳；而源存储则是在每次遍历时解析，其挂载顺序不成约束。

</details>
