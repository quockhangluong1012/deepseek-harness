---
description: "突变算子进化：带探索调整的下一算子排序的持久每算子突变统计，以及每个算子与产物类持有的候选突变指令及其判定（ctx.evolutionOperators）。"
kind: "package-reference"
---

# @deepseek-ai/dsh-evolution-operators

[English](README.md) | 中文

## 概述

`dsh-evolution-operators` 记录哪个突变算子跑在哪个产物类上、候选是否被接受，然后对规范算子组合排序，使引擎知道接下来该试哪个算子。每行累积尝试次数、接受次数、平均结果增量与回归率；排序把带 beta 先验平滑的接受率与随样本衰减的探索奖励结合，因此已被证明的算子领先，持续失败的算子让位于从未试过的算子。它为每个算子与产物类持有一条候选突变指令，连同赞成与反对的判定，使策略可以依证据修订，而不必停留在包里的一个字符串。此包不调用任何模型。

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

挂载插件并配合存储域。操作者通过存储记录每次突变的结果；排序回答某个技能下一次尝试该归谁，记录在案的指令则回答该算子应当怎么说。

```ts
await ctx.evolutionOperators.record({
  operator: 'rewrite',
  artifactClass: 'writer',
  accepted: true,
  delta: 1,
})
await ctx.evolutionOperators.recordInstruction({
  operator: 'rewrite',
  artifactClass: 'writer',
  instruction: 'Rewrite the body in the order the evidence supports.',
  reason: 'two runs regressed on rule order',
})
await ctx.evolutionOperators.judgeInstruction({
  operator: 'rewrite',
  artifactClass: 'writer',
  accepted: false,
  reason: 'the holdout failed twice on the reordered body',
})
const ranked = ctx.evolutionOperators.ranking('writer')
const next = ctx.evolutionOperators.recommend('writer')
const instruction = ctx.evolutionOperators.recommendedInstruction('writer')
```

`record(outcome)` 用实测的接受标志与通过增量，按产物类幂等更新该算子的统计；`stats(artifactClass?)` 按规范算子顺序列出各行；`ranking(artifactClass)` 按探索调整得分对组合排序——八个规范算子加上统计中可观察到的任何部署专属算子——未试过的算子也在其中，并按该产物类记录在案的指令判定微调；`recommend(artifactClass)` 返回排序首位——有证据时是被证明的领先者，全无记录时是规范首个算子。

指令那一半正是让突变策略得以演化（§9）的部分。`recordInstruction(input)` 存入某算子与产物类应当发送的指令行，连同促发它的证据；`judgeInstruction(verdict)` 记录该提案是否被接受及其原因，并拒绝针对尚未持有提案的配对给出的判定；`instruction(operator, artifactClass)` 读取一行；`instructions(artifactClass?)` 按规范算子顺序列出；`recommendedInstruction(artifactClass)` 返回排序领先者所持有的指令，当该领先者尚未持有提案时为 undefined。排序由 `instructionWeight × (接受 − 拒绝) / 判定数` 微调，幅度受该权重限制，因此被拒绝的指令会把其算子压到未试先验之下，被接受的则把它抬到之上。

### 配置

存储的两个部署选项，带默认值校验，因此未配置的挂载仍可运行。

| 键 | 默认值 | 含义 |
|---|---|---|
| `exploration` | `0.2` | 排序的探索奖励权重（0 到 1）。 |
| `instructionWeight` | `0.2` | 指令判定调整的权重（0 到 1）。 |

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

### 设计概念

记账是精确的。`updatedStats` 累积尝试与接受次数，把每次结果的增量折入滑动平均，并把回归率重算为新尝试次数上负增量的精确占比——从不使用衰减估计。打分是先验加探索：`scoreOf` 平滑 `(accepted + 1) / (attempts + 2)`——因此未试过的算子从自己的先验起步——再加上 `exploration × sqrt(1 / (attempts + 1))`，因此持续失败的算子让位于从未试过者，而一旦被证明的领先者有了几次接受，它就排在它们之上。`rankOperators` 始终返回整个组合——八个规范算子加上统计中观察到的任何部署专属算子——这使组合保持完整，并让 `recommend` 具备完全性：没有证据时即规范首个算子。

指令行是同一配对上的第二个、更慢的信号。它的身份是算子与产物类，因此重新提出的指令会替换上一条：`proposedInstruction` 计入又一次提案，文本不变时保留既有判定，文本改变时则让计数从头开始，因为证据判定的是旧文本而不是这个配对。提案在判定落地之前不带任何权重，这正是 `instructionAdjustment` 对没有判定的行什么都不返回的原因：提出提案很廉价，只有经判定的证据才移动排序。

存储是双表域：`evolution_operators` 版本 1，一张以算子与产物类拼接键控的 `stats` 表存 `{ operator, artifactClass, attempts, accepted, meanDelta, regressionRate, lastAt }`，一张以同样方式键控的 `instructions` 表存 `{ operator, artifactClass, instruction, reason, proposals, accepted, rejected, lastVerdict, at, decidedAt }`。排序在读取时由表推导，因此配置变更无需重写已记录的行即可重新排序；而指令表是新增表而非改动表，因此在其之前已提交的域可以原样打开。

### 元演化层级（§26）

§26 的阶梯从产物（第 1 级）经工作流（第 2 级）、变异策略（第 3 级）、评估策略（第 4 级）攀升到资源分配（第 5 级）。本存储只覆盖第 3 级的记录那一半：

- **此处覆盖**——某个产物类的证据支持哪个突变算子，以及该算子提出的指令与判定它的那些证据。
- **此处不覆盖**——第 4 级是 [`dsh-evolution-evaluator-strategy`](../evolution-evaluator-strategy/README.zh.md)，第 5 级是 [`dsh-evolution-budget`](../evolution-budget/README.zh.md)；第 1、2 级属于优化器自身。
- **在优化器以 `disabled: true` 发布期间不可达**——Web profile 以停用状态挂载 [`dsh-evolution-optimizer`](../evolution-optimizer/README.zh.md)，因此唯一会记录算子结果或指令判定的生产者是一个并未运行的调用者。突变请求实际发送的指令行仍硬编码在该包的算子目录中：本存储记录提案并推荐它，此处不会改写优化器的任何指令。

### 失败与恢复

存储启动前读取会抛错。`record` 按算子与类幂等更新，因此同一算子在同一类上的重复结果会就地累积而非产生重复行；`judgeInstruction` 拒绝尚未持有提案的配对，因此证据永远指向一条确实被提出过的指令。重新提出文本会替换该行而非追加，这也是本记录的上限：该配对更早文本及其判定的历史不被保留。

不发布不变量伴生文件，因为域表是本状态的唯一副本，没有第二个独立观测可与之核对。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [进化式 Harness 规范](../../../specs/evolutionary-harness-v11-deep-research.md) §8、§9 与 §26——本包实现的算子组合、变异策略演化与元演化阶梯。
- [进化包地图](../README.zh.md)——本组包及其仓库位置。
- [`dsh-evolution-optimizer`](../evolution-optimizer/README.zh.md)——通过可选记录接缝记录每次暂存写入的算子与结果的消费者，也是本存储只对其提出提案而不改写的指令目录所在。
- [`dsh-evolution-actuator`](../evolution-actuator/README.zh.md)——当停滞恢复抵达 §32 的新算子档位时读取推荐指令的循环。
- [`dsh-evolution-budget`](../evolution-budget/README.zh.md)——为这些算子所驱动的搜索定价的第 5 级存储。
- [`dsh-evolution-lineage`](../evolution-lineage/README.zh.md)——记录哪个算子产出了哪个实验的姊妹包，喂养同一套逐算子学习。

-----

<a id="model-experience"></a>
## 模型体验

无——本存储不注册任何模型面内容。

#### KV 缓存效果

此处没有任何内容进入模型请求，因此提供方缓存复用不受影响。将算子排序或推荐指令渲染进提示词的消费者拥有该请求的前缀。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

以下限制界定本存储不适用的情形，是当前的包约束。

- **结果增量目前是二元通过**——`record` 把通过增量（+1/0/−1）折入平均增量；更丰富的增量（分数增量、token 节省）需要调用者先定义它们，行形状才会增长。
- **推荐不等于改写**——存储记录某算子与类提出的指令及其赢得的判定；它从不改写被停用优化器所发送的指令目录，因此施加提案是部署的决定。
- **每个配对只有一条指令，且只有其当前判定**——重新提出的文本会让计数从头开始，因此更早文本的记录被丢弃而非归档，而且当产物类在其下发生变化时，判定计数不会衰减。
- **仅按类隔离**——统计与指令按产物类键控，从不跨类汇聚，因此数据稀少的类依赖先验而非相似类。
- **无算子退役**——规范组合固定为 §8 的八个算子；部署专属算子只能靠观察进入，移除算子需要一次域版本升级，而不是一个存储开关。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

排序在读取时由表推导，因此配置变更无需重写已记录的行即可重新排序；`record` 采用幂等更新，因此同一算子在同一类上的重复结果就地累积。带 beta 先验加衰减探索的得分让 `recommend` 无需最小样本守卫即具备完全性：没有证据即规范首个算子，一次被接受的尝试胜过所有未试先验，而持续失败的算子让位于从未试过者。指令调整的幅度受其权重限制，并叠加在该得分之上而非取代它，因此提案可以重排被结果证据判为平手的算子，而不会推翻一个已被证明的领先者。

</details>
