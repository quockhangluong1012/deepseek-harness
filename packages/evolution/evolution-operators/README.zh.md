---
description: "突变算子进化：带探索调整的下一算子排序的持久每算子突变统计（ctx.evolutionOperators）。"
kind: "package-reference"
---

# @deepseek-ai/dsh-evolution-operators

[English](README.md) | 中文

## 摘要

`dsh-evolution-operators` 记录哪个突变算子用在哪个产物类上、突变出的候选是否被接受，然后对规范算子组合排序，使进化引擎知道下一步该试哪个算子。每个算子的行累计尝试次数、接受次数、平均结果增量与回归率；排序把贝塔先验平滑的接受率与随样本数衰减的探索奖励混合，因此被证明的算子领先，而一再失败的算子让位于从未试过的算子。此包不调用任何模型。

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

挂载插件并配合存储域。操作者通过存储记录每次突变的结果；排序回答哪个算子值得在某个技能上获得下一次尝试。

```ts
await ctx.evolutionOperators.record({
  operator: 'rewrite',
  artifactClass: 'writer',
  accepted: true,
  delta: 1,
})
const ranked = ctx.evolutionOperators.ranking('writer')
const next = ctx.evolutionOperators.recommend('writer')
```

`record(outcome)` 用实测的接受标志与通过增量，按产物类幂等更新该算子的统计；`stats(artifactClass?)` 按规范算子顺序列出各行；`ranking(artifactClass)` 按探索调整得分对组合排序——八个规范算子加上统计中可观察到的任何部署专属算子——未试过的算子也在其中；`recommend(artifactClass)` 返回排序首位——有证据时是被证明的领先者，全无记录时是规范首个算子。

### 配置

存储的单一部署选项，带默认值校验，因此未配置的挂载仍可运行。

| 键 | 默认值 | 含义 |
|---|---|---|
| `exploration` | `0.2` | 排序的探索奖励权重（0 到 1）。 |

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

### 设计概念

记账是精确的。`updatedStats` 累积尝试与接受次数，把每次结果的增量折入运行均值，并把回归率重算为新尝试次数中负增量的精确占比——绝不用衰减估计。评分是贝塔先验加探索：`scoreOf` 平滑 `(accepted + 1) / (attempts + 2)`——因此未试过的算子从先验起步——再加上 `exploration × sqrt(1 / (attempts + 1))`，使失败的算子让位于从未试过的算子，而被证明的领先者在拥有几次被接受的尝试后就会超过它们。`rankOperators` 始终返回整个组合——八个规范算子加上统计中观察到的任何部署专属算子——保证组合完整，也使 `recommend` 成为全函数：无证据时返回规范首个算子。

存储是单表域：`evolution_operators` 版本 1，一张按算子与产物类连接键控的 `stats` 表，存 `{ operator, artifactClass, attempts, accepted, meanDelta, regressionRate, lastAt }`。排序在读取时由表推导，因此配置变更会重新排序，而无需重写已记录行。

### 失败与恢复

存储启动前读取会抛错。`record` 按算子与类幂等更新，因此同一算子对同一类的重复结果就地累积而非重复。

不发布不变量伴生文件，因为域表是本状态的唯一副本，没有第二个独立观测可与之核对。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [进化式 Harness 规范](../../../specs/evolutionary-harness-v11-deep-research.md) §8 与 §9——本包实现的算子组合与突变策略进化。
- [进化包地图](../README.zh.md)——本组包及其仓库位置。
- [`dsh-evolution-optimizer`](../evolution-optimizer/README.zh.md)——通过可选记录接缝记录每次暂存写入的算子与结果的消费者。
- [`dsh-evolution-lineage`](../evolution-lineage/README.zh.md)——记录哪个算子产出哪个实验的姊妹包，为同一按算子学习供料。

-----

<a id="model-experience"></a>
## 模型体验

无——本存储不注册任何模型面内容。

#### KV 缓存效果

此处没有任何内容进入模型请求，因此提供方缓存复用不受影响。将算子排序渲染进提示词的消费者拥有该请求的前缀。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

以下限制界定本存储不适用的情形，是当前的包约束。

- **今天的结果增量只有二值通过**——`record` 把通过增量（+1/0/−1）折入平均增量；更丰富的增量（得分增量、token 节省）需要调用者先定义，行形状才会扩展。
- **只记录的存储，不调用模型**——本包学习哪些算子有效；它从不自己提出突变指令或合成新算子。
- **仅按类隔离**——统计按产物类键控，从不跨类合并，因此数据稀少的类依赖先验而非相似类的经验。
- **无算子退役**——规范组合固定在八个 §8 算子；部署专属算子只能靠观察进入，移除算子需要域版本升级，而非存储开关。

<a id="dev-note"></a>
### 开发者注记

<details>
<summary>维护者工作上下文——点击展开</summary>

排序在读取时由表推导，因此配置变更会重新排序，无需重写已记录行；`record` 做幂等更新，因此同一算子对同一类的重复结果就地累积。贝塔先验加衰减探索的得分使 `recommend` 无需最小样本守卫即为全函数：无证据时是规范首个算子，一次被接受的尝试就超过所有未试先验，而失败的算子让位于从未试过的算子。

</details>