---
description: "睡眠时计算：按离线成本经济策略为预期未来任务预计算推理产物（ctx.evolutionSleeptime）。"
kind: "package-reference"
---

# @deepseek-ai/dsh-evolution-sleeptime

[English](README.md) | 中文

## 摘要

`dsh-evolution-sleeptime` 在空闲时间为可能出现的未来任务做预期，并为其缓存预计算的推理产物——摘要、检索结构、候选计划。每个任务携带其可能性、预期查询数与单查询节省；只有当可能性加权的节省超过离线成本时，预计算才值得，贪心计划把净收益最高的项装进离线预算。被命中的产物记录命中数与已省 token，使实现中的节省相对离线支出始终可见。此包不调用任何模型。

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

挂载插件并配合存储域。每当预期出现空闲时间，操作者就预期可能出现的未来任务；预计算为每个预期任务缓存一份推理产物；每次被命中的查询都记录一次命中，使产物的实现节省始终可见。

```ts
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

`anticipate(input)` 按任务标识幂等更新，因此重复预期的任务会刷新其可能性与期望。`tasks(domain?)` 按可能性优先列出任务；`precompute(input)` 为一个预期任务缓存一份产物，对未知任务大声拒绝；`artifacts(taskId?)` 按最新优先列出产物；`hit(artifactId, savedTokens)` 记录一次被命中的查询；`plan(estimatedCostTokens?, budgetTokens?)` 返回尚无缓存产物的任务上的贪心预算计划。

### 配置

存储的部署选项，默认值适用于较小的夜间空闲窗口；两者都带默认值校验，因此未配置的挂载仍可运行。

| 键 | 默认值 | 含义 |
|---|---|---|
| `defaultEstimatedCostTokens` | `2000` | 单次预计算的估计离线 token，调用者未指定时使用。 |
| `maxOfflineTokens` | `50000` | 单次计划的离线 token 总预算，调用者未指定时使用。 |

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

### 设计概念

经济学计算是纯函数。`expectedNet` 把单个任务的预期节省按可能性加权，再减去估计的离线成本，因此从未发生的任务仍要付出预计算成本。`decideWorth` 要求严格为正的净收益：恰好为零的净收益等于把空闲时间花在无用功上。`planFor` 只保留值得的决策，按净收益降序、任务标识升序打破平局，在累计估计成本仍能装进预算时贪心取用。`savingsOf` 从产物命中已省的 token 中减去其离线成本，在预计算回本前保持为负。

存储是双表域：`evolution_sleeptime` 版本 1，一张按任务标识键控的 `tasks` 表存 `{ taskId, domain, scope, likelihood, expectedQueries, expectedSavingTokens, at }`，一张按产物标识键控的 `artifacts` 表存 `{ artifactId, taskId, kind, summary, offlineCostTokens, hits, savedTokens, at }`。计划在读取时由当前表推导，因此配置变更会重新排序计划，而无需重写已记录行。

### 失败与恢复

存储启动前读取会抛错。`precompute` 拒绝未知任务标识，`hit` 拒绝未知产物标识，因此产物永远指向真实的预期任务，命中永远落在真实的缓存产物上。`anticipate` 按任务标识幂等更新，因此重复预期的任务就地刷新而非重复。

不发布不变量伴生文件，因为域表是本状态的唯一副本，没有第二个独立观测可与之核对。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [进化式 Harness 规范](../../../specs/evolutionary-harness-v11-deep-research.md) §25——本包实现的睡眠时计算。
- [进化包地图](../README.zh.md)——本组包及其仓库位置。
- [`dsh-evolution-heartbeat`](../evolution-heartbeat/README.zh.md)——未来的空闲驱动者，接线完成后其安静节拍将触发预期与预计算。
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

- **心跳接线延后**——今天的预期与预计算由操作者驱动；心跳的空闲节拍尚未触发它们，因此空闲时间是被计划的，还不是自动的。
- **只记录的存储，不调用模型**——本包缓存操作者提供的推理产物；它从不自己生成摘要、索引或计划。
- **每次计划一种估计成本**——`plan` 把每次预计算都按同一估计成本计价；按种类的成本估计需要在预计算种类上加成本模型。
- **无产物淘汰**——缓存产物会累积；保留或价值衰减剪除需要在域上加生命周期逻辑。

<a id="dev-note"></a>
### 开发者注记

<details>
<summary>维护者工作上下文——点击展开</summary>

计划在读取时由表推导，因此配置变更会重新排序计划，无需重写已记录行；`anticipate` 做幂等更新，因此对同一任务的重复空闲观察会刷新其期望。产物标识由调用者选定，未来的心跳驱动者可从任务与种类推导稳定标识。

</details>
