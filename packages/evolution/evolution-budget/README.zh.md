---
description: "进化预算：按候选类定价的每批预算分配，带支出结算与减半调度（ctx.evolutionBudget）。"
kind: "package-reference"
---

# @deepseek-ai/dsh-evolution-budget

[English](README.md) | 中文

## 摘要

`dsh-evolution-budget` 记录进化如何花费其算力，并按候选类定价。每个批次收到一个由基础上限构建的分配——高潜力候选获得两倍基础，新奇候选获得探索额度，低潜力候选获得廉价的早停筛选——每次支出都对照它结算，给出精确的剩余与超支边量。逐轮减半调度回答筛选过程如何逐轮缩小候选池。此包不调用任何模型。

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

挂载插件并配合存储域。操作者为每个批次分配预算并记录支出；存储把累计支出对照分配结算。

```ts
const allocation = await ctx.evolutionBudget.allocate({
  batchId: 'run-42',
  taskClass: 'writer',
  candidateClass: 'high-potential',
})
const settlement = await ctx.evolutionBudget.spend('run-42', {
  tokens: 30000,
  wallTimeMs: 900000,
  rollouts: 6,
})
const rounds = halvingRounds(100, 0.5, 3)
```

`allocate(input)` 按批次的基础上限为该批的候选类定价，并按批次标识幂等更新；`spend(batchId, input)` 记录一次支出并返回跨该批全部支出的累计结算；`batches(taskClass?)` 按批次标识顺序列出分配；`spends(batchId?)` 按最新优先列出支出记录；`withinBudget(batchId)` 报告累计支出是否仍在分配之内。纯助手 `multiplierFor`、`buildAllocation`、`settle`、`withinAllocation` 与 `halvingRounds` 已导出，供需要在存储之外使用这些算式的调用者。

### 配置

存储的部署基础上限，带默认值校验，因此未配置的挂载仍可运行。

| 键 | 默认值 | 含义 |
|---|---|---|
| `baseMaxTokens` | `20000` | 一个标准批次的基准 token 上限。 |
| `baseMaxWallTimeMs` | `600000` | 一个标准批次的基准墙钟时间上限，单位毫秒。 |

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

### 设计概念

定价是纯函数且精确。`multiplierFor` 把 §37 的四个候选类映射到预算乘数；`buildAllocation` 乘上基础上限并在原因里指名每一个数字；`settle` 累加该批的支出记录，在两个维度上报告取零下限的 `remaining` 与承载超支部分的 `exceeded`；`halvingRounds` 每轮按保留比例缩小被评估的候选池，且永不保留少于一个（§38）。

存储是双表域：`evolution_budget` 版本 1，一张按批次标识键控的 `allocations` 表存 `{ batchId, taskClass, candidateClass, maxTokens, maxWallTimeMs, reason, at }`，一张按批次标识加逐记录键键控的 `spends` 表存 `{ batchId, tokens, wallTimeMs, rollouts, at }`。结算在读取时由表推导，因此后落地的支出永不重写较早的支出记录。

### 失败与恢复

存储启动前读取会抛错。`spend` 大声拒绝未知批次标识，因此支出永远指向策略定价过的批次。`allocate` 按批次标识幂等更新，因此重新分配某批会就地重新定价。

不发布不变量伴生文件，因为域表是本状态的唯一副本，没有第二个独立观测可与之核对。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [进化式 Harness 规范](../../../specs/evolutionary-harness-v11-deep-research.md) §37 与 §38——本包实现的进化预算控制器与逐轮减半。
- [进化包地图](../README.zh.md)——本组包及其仓库位置。
- [`dsh-evolution-optimizer`](../evolution-optimizer/README.zh.md)——通过可选记录接缝记录每次暂存写入的分配与支出的消费者。
- [`dsh-evolution-sleeptime`](../evolution-sleeptime/README.zh.md)——为离线算力定价的姊妹包，而本包为在线搜索预算定价。

-----

<a id="model-experience"></a>
## 模型体验

无——本存储不注册任何模型面内容。

#### KV 缓存效果

此处没有任何内容进入模型请求，因此提供方缓存复用不受影响。将分配或结算渲染进提示词的消费者拥有该请求的前缀。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

以下限制界定本存储不适用的情形，是当前的包约束。

- **分配只是记录，不是强制**——存储定价并结算；它从不拦截运行，因此超出分配的支出会被报告，而不会被阻止（§58.12 记录而非强制）。
- **候选类来自调用者**——存储按调用者命名的任何类定价；它从不自己给候选分类，因此早停筛选需要调用者先评估潜力。
- **线性类定价**——乘数按类固定；从已结算结果学习乘数需要一个本存储没有的反馈回路。
- **无成本上限**——分配只约束 token 与墙钟时间；美元成本上限需要一个本包刻意不假设的定价来源。

<a id="dev-note"></a>
### 开发者注记

<details>
<summary>维护者工作上下文——点击展开</summary>

结算在读取时由支出表推导，因此一个批次累积支出记录，每次 `spend` 调用结算整个历史而无需重写较早记录。`spend` 拒绝未知批次，因此每次支出都指向定价过的分配。减半算式保持纯函数且离线于存储，因此筛选过程可以在不记录任何内容的情况下预览其轮次。

</details>