---
description: "进化预算：按候选类定价的每批预算分配，覆盖 §37 的全部五个维度，带支出结算与精确余量、记录在案的候选池与减半调度，以及 §27 的资源目标（ctx.evolutionBudget）。"
kind: "package-reference"
---

# @deepseek-ai/dsh-evolution-budget

[English](README.md) | 中文

## 概述

`dsh-evolution-budget` 记录进化如何花费其算力，并按候选类定价。每个批次的分配来自基础上限（高潜力候选两倍基础，新奇候选一份探索额度，低潜力候选一次廉价的早停筛选），覆盖 §37 的全部五个维度；每次支出都按精确的剩余与超支边量结算。分配策略从该批次记录在案的候选池中判定候选的类别；逐轮减半调度则回答筛选过程每轮如何缩小该池。同一批记录还回答 §27 的目标：质量、可靠性、延迟、成本与后台算力可被测量；内存占用与上下文用量报告为未测量，并点名所缺失的记录。此包不调用任何模型。

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

挂载插件并配合存储域。调用者记录某批次筛选的候选，为每个候选按其证据赢得的类别分配预算，记录支出，并读取这些记录所回答的调度与目标。

```ts
await ctx.evolutionBudget.recordPool({
  batchId: 'run-42',
  taskClass: 'writer',
  candidates: [{ candidateId: 'c1', runs: 2, passes: 2, novelty: 0 }],
})
const allocation = await ctx.evolutionBudget.allocateForCandidate('run-42', 'c1')
const settlement = await ctx.evolutionBudget.spend('run-42', {
  tokens: 30000,
  wallTimeMs: 900000,
  rollouts: 6,
  cost: 4,
  parallelism: 3,
})
const schedule = ctx.evolutionBudget.schedule('run-42')
const objectives = ctx.evolutionBudget.objectives('run-42')
const rounds = halvingRounds(100, 0.5, 3)
```

`recordPool(input)` 按候选标识幂等更新该批的候选并返回该池；`allocateForCandidate(batchId, candidateId)` 按 §37 策略从该候选的记录证据判定的类别定价，并把所在分支写进分配的原因；`allocate(input)` 按调用者指定的类别定价；`spend(batchId, input)` 记录一次支出并返回跨该批全部支出的累计结算；`pool(batchId)` 按候选标识顺序列出记录在案的池；`schedule(batchId)` 由该池推导 §38 的各轮；`objectives(batchId)` 读取 §27 的目标；`batches(taskClass?)` 按批次标识顺序列出分配；`spends(batchId?)` 按最新优先列出支出记录；`withinBudget(batchId)` 报告累计支出是否仍在每个已测量的上限之内。纯助手 `multiplierFor`、`buildAllocation`、`dimensionCeilings`、`poolKey`、`recordedTotal`、`settle`、`withinAllocation`、`halvingRounds`、`screeningSchedule`、`policyFor` 与 `objectiveReadings` 已导出，供需要在存储之外使用这些算式的调用者。

### 配置

存储的部署上限、策略阈值与筛选日程，带默认值校验，因此未配置的挂载仍可运行。

| 键 | 默认值 | 含义 |
|---|---|---|
| `baseMaxTokens` | `20000` | 一个标准批次的基准 token 上限。 |
| `baseMaxWallTimeMs` | `600000` | 一个批次支出加总所对照的墙钟时间基准上限。 |
| `baseMaxCost` | `10` | 基准成本上限，单位为部署自己的成本单位。 |
| `pricePerMillionTokens` | *未设置* | 一百万 token 的价格，单位为部署自己的成本单位。设置后，未声明成本的每次花费都按 token 计费；未设置时，成本维度保持未计量。 |
| `baseTimeLimitMs` | `86400000` | 一个标准批次的基准截止期，自其分配时刻起算。 |
| `baseParallelism` | `4` | 一个标准批次的基准并发上限。 |
| `keepFraction` | `0.5` | 每轮筛选保留的被评估候选占比。 |
| `screeningRounds` | `3` | §38 调度推导的筛选轮数。 |
| `provenPasses` | `1` | 使候选成为已证明的高潜力的记录通过次数。 |
| `lowPotentialRuns` | `1` | 零通过候选被判定为低潜力所需的记录评估次数。 |
| `noveltyThreshold` | `0.5` | 使未证明候选赢得探索分支的新奇度。 |

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

### 设计概念

定价是纯函数且精确。`multiplierFor` 把 §37 的四个候选类映射到预算乘数；`buildAllocation` 乘上基准 token 与墙钟时间上限并在原因里指名每一个数字；`dimensionCeilings` 以同一乘数为 §37 的成本、截止期与并发的上限定价并追加自己的从句——一个批次始终保留一个工作槽，因此把基准减半不会把并发上限四舍五入掉；`settle` 累加该批的支出记录，在两个维度上报告取零下限的 `remaining` 与承载超支部分的 `exceeded`，并在其旁为成本、截止期与并发各给一个 `BudgetMargin`；`halvingRounds` 每轮按保留比例缩小被评估的候选池，且永不保留少于一个（§38）。

`buildAllocation`、`withinAllocation`、`settle` 与 `multiplierFor` 保持进化执行器所调用的签名：§37 新增的三个维度以记录上的可选字段到达，由 `dimensionCeilings` 定价，因此按冻结的四个函数编写的调用者构建出的分配与从前一致。

分配策略是作用于记录证据的一条纯规则（§37）。`policyFor` 按部署的阈值读取候选已记录的运行次数、通过与新奇度：有通过的候选触达增益预算分支并被定价为高潜力；否则已被测量且新奇度低于阈值的候选正是早停的对象；再否则新奇的候选保留探索额度，因为与已试过的一切都不相似者，其少量失败推不出任何结论；其余归为标准批次。已证明的候选优先于其记录中的其他一切，记录在案的分配会把该分支的句子带进自己的原因。

只有当两侧都被记录时，一个边量才被测量。`settle` 始终报告 token 与墙钟时间的边量，因为每次支出都会记录这两者；而成本、截止期与并发，只有当分配为该上限定价、且该批的每一次支出都记录了这一测量时才报告——部分加总会读作整批的数字，而只覆盖部分批次的峰值可能低于该批实际越过的上限。截止期是从分配时刻到最后一次记录支出的已流逝时间，因此没有任何记录活动的批次无从测量，而无法解析的时刻会让该维度保持未测量，而不是报告为零。`withinAllocation` 读取该结算，因此它所报告的每一个已定价且已记录的维度都是调用者可以据以设闸的维度——执行器的预算循环正是以此强制本包新增的维度，而自身无需改动。

§27 的目标是读取而来的，从不估算。`objectiveReadings` 把质量推导为池中评估的通过占比，把可靠性推导为被评估两次及以上的候选中每次都通过的占比——池所持有的唯一重复性读数——再把延迟推导为每个被评估 rollout 的平均墙钟时间，把成本推导为支出所记录的实际计费 token，把后台算力推导为支出归给该批的离线 token。内存占用与上下文用量读作 null 并点名所缺失的记录，因为 harness 中没有任何存储记录这两者。

存储是三表域：`evolution_budget` 版本 1，一张按批次标识键控的 `allocations` 表存 `{ batchId, taskClass, candidateClass, maxTokens, maxWallTimeMs, maxCost, timeLimitMs, parallelism, reason, at }`，一张按批次标识加逐记录键键控的 `spends` 表存 `{ batchId, tokens, wallTimeMs, rollouts, cost, parallelism, backgroundTokens, at }`，一张按批次标识加候选标识键控的 `pools` 表存 `{ batchId, candidateId, taskClass, runs, passes, novelty, at }`。结算与调度在读取时由表推导，因此后落地的支出永不重写较早的支出记录。§37 新增的维度与新表以可选字段、新增表的方式到达，因此在这些之前已提交的域可以原样打开——行模式把它们声明为可选而非带默认值，因为缺失的上限意味着没有任何东西为其定价，而不是一个为零的上限。

### 元演化层级（§26）

§26 的阶梯从产物（第 1 级）经工作流（第 2 级）、变异策略（第 3 级）、评估策略（第 4 级）攀升到资源分配（第 5 级）。本存储只覆盖第 5 级的记录那一半：

- **此处覆盖**——每个候选依据其记录证据所支持的类别赢得多少搜索预算，以及说明该批次实际花了多少的结算。
- **此处不覆盖**——第 3 级是 [`dsh-evolution-operators`](../evolution-operators/README.zh.md)，第 4 级是 [`dsh-evolution-evaluator-strategy`](../evolution-evaluator-strategy/README.zh.md)；第 1、2 级属于优化器自身。
- **在优化器以 `disabled: true` 发布期间不可达**——Web profile 以停用状态挂载 [`dsh-evolution-optimizer`](../evolution-optimizer/README.zh.md)，因此唯一会记录分配的生产者是一个并未运行的调用者。乘数与策略阈值仍由配置给出而非习得：习得它们需要来自已运行批次的已结算结果，而那是随优化器一同到来的。会消费减半调度的筛选器同样是优化器的——本包由记录在案的池推导调度并记录该池，到此为止。

### 失败与恢复

存储启动前读取会抛错。`spend` 大声拒绝未知批次标识，因此支出永远指向策略定价过的批次；`allocateForCandidate` 拒绝该批的池未持有的候选；`objectives` 拒绝未知批次。`allocate` 按批次标识幂等更新，因此重新分配某批会就地重新定价；`recordPool` 按候选标识幂等更新，因此重新记录的候选会替换其证据、并让同批其他候选保持不变。对未记录任何池的批次，`schedule` 返回 undefined，而不是一个会读作“已筛选”的空调度。

不发布不变量伴生文件，因为域表是本状态的唯一副本，没有第二个独立观测可与之核对。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [进化式 Harness 规范](../../../specs/evolutionary-harness-v11-deep-research.md) §9、§26、§27、§37 与 §38——本包实现的变异策略阶梯、资源感知目标、进化预算控制器与逐轮减半。
- [进化包地图](../README.zh.md)——本组包及其仓库位置。
- [`dsh-evolution-optimizer`](../evolution-optimizer/README.zh.md)——通过可选记录接缝记录每次暂存写入的分配与支出的消费者，也是减半调度留给它的那个筛选器。
- [`dsh-evolution-operators`](../evolution-operators/README.zh.md)——第 3 级存储，其算子排序为这份预算所购买的搜索定价。
- [`dsh-evolution-metrics`](../evolution-metrics/README.zh.md)——读取这些支出的指标层，用于算力开销比，而不另加一套成本读数。
- [`dsh-evolution-sleeptime`](../evolution-sleeptime/README.zh.md)——为离线算力定价的姊妹包，而本包为在线搜索预算定价，并读取批次归给自身的后台 token。

-----

<a id="model-experience"></a>
## 模型体验

无——本存储不注册任何模型面内容。

#### KV 缓存效果

此处没有任何内容进入模型请求，因此提供方缓存复用不受影响。将分配或结算渲染进提示词的消费者拥有该请求的前缀。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

以下限制界定本存储不适用的情形，是当前的包约束。

- **分配只是记录，不是强制**——存储定价并结算；它自身从不阻断运行，而依结算设闸的闸门存在于读取它的调用者之中——即执行器的预算循环，它会让已花尽额度的类别的工作停下（§58.12 记录而非强制）。
- **已定价的维度在被部署记录之前是未测量的**——成本、截止期与并发需要分配的上限与该批每次支出的测量；在二者齐备之前，`withinBudget` 看不到该维度上的越界。
- **策略阈值是配置，不是习得**——§26 第 5 级通过从已结算结果中习得乘数与阈值来演化资源分配；本存储施加配置值，并记录每次分配由哪个分支产生。
- **轮次之间的筛选器属于优化器**——存储推导 §38 每轮评估并保留多少候选，并记录推导所依据的池；某一轮实际保留哪个候选是被停用优化器的决定，因此此处不记录任何存活判定。
- **截止期按日历走，而不是按工作量走**——它是从分配到最近一次记录支出的跨度，因此一个留得过久的批次即使几乎没干什么也会读作已花尽；而依 `withinBudget` 设闸的调用者（执行器的预算循环即是）会让该类别的工作停下，直到有更新的分配为其定价。当这不是「陈旧批次」应当的含义时，把 `baseTimeLimitMs` 调高到部署的回合节奏之上。
- **两种成本概念**——§27 的成本目标读取支出所记录的实际计费 token，这也正是 harness 其余部分用于比较的单位（发布监控的成本倍数、算力开销比）；而 `maxCost`/`cost` 在部署确有独立计费时承载部署自己的计费单位。以 token 计费的部署会让成本维度保持未记录。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

结算在读取时由支出表推导，因此一个批次累积支出记录，每次 `spend` 调用结算整个历史而无需重写较早记录。`spend` 拒绝未知批次，因此每次支出都指向定价过的分配；`allocateForCandidate` 拒绝池未持有的候选，因此由策略定价的类别始终可追溯到记录证据。减半算式保持纯函数且离线于存储，因此筛选过程可以在不记录任何内容的情况下预览其轮次；`screeningSchedule` 持有该池所需的唯一守卫：空池没有任何轮次，否则算式会从虚无中保留出一个候选。

</details>
