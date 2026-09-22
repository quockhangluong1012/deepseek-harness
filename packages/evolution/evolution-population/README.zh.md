---
description: "基于种群（population）的进化：每一次暂存的优化器写入都成为持久的、按技能组织的候选，含代数编号、父代谱系与 暂存 → 通过/拒绝 生命周期（ctx.evolutionPopulation）。"
kind: "package-reference"
---

# @deepseek-ai/dsh-evolution-population

[English](README.md) | 中文

## 概述

`dsh-evolution-population` 把优化器的暂存写入保存为跨运行的、按技能组织的种群：每个候选记录其代数、父代候选、产生它的变异算子、新颖度与测得的指标三元组，并带有一种身份——`staged`，之后进入 `approved` 或 `rejected`。精英排名（通过、然后更少 token、然后更快的墙钟时间）决定技能保留什么。优化器通过可选存储缝记录每一次暂存写入，宿主命令 `command-evolution` 通过 `/population` 检查种群。此处不调用任何模型。

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

挂载插件并携带存储域即可。只要存储已挂载，候选就来自优化器的暂存写入；运维者读取种群并决定候选身份。

```ts
await ctx.evolutionPopulation.record({
  skill: 'writer',
  candidateId: 'staged-0',
  operator: 'rewrite',
  novelty: 0.5,
  triple: { pass: true, tokens: 3, wallTimeMs: 5 },
  status: 'staged',
})
const elite = ctx.evolutionPopulation.elite('writer')
```

`record(input)` 自动接续谱系：同一技能的上一代头候选人成为父代，代数为该技能当前最高代数之后的一代。`candidates(skill?)` 按最新在前列出候选；`generation(skill)` 报告技能当前的代数；`lineage(skill, candidateId)` 从最老的祖先开始逐个回溯某个候选的祖先；`elite(skill)` 按通过、然后更少 token、然后更快的墙钟时间对已通过候选排名。`updateStatus(candidateId, status)` 把 `staged` 候选移到 `approved` 或 `rejected`；`approved` 与 `rejected` 是终态。`/population` 命令列出某技能的种群、回溯一条谱系，并批准或拒绝暂存候选。

### 配置

无 —— 本存储不接受任何部署选项。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节 — 点击展开</summary>

### 设计概念

谱系与排名都是纯函数。`nextGeneration` 是某技能当前最高代数之后的一代（无任何候选时为 1），且只基于完整行计算。`lineageChain` 从最老的祖先沿着 `parentCandidateId` 走到候选本身，容忍悬空父代与环。`rankElite` 按通过、然后 token、然后墙钟时间对已通过候选排序，未测度的候选排在一切已测度候选之下。头候选由 `headOf` 选出：代数最高者优先，`at` 最新者打破平局——因此同代行按 `at` 确定性地解析。

存储是按候选粒度的域：`evolution_population` 版本 1，含一张以候选身份为键的 `candidates` 表，存放 `{ candidateId, skill, parentCandidateId, operator, generation, novelty, triple, status, at }`。状态流转是一张小而固定的映射：`staged` → `approved` | `rejected`，终态永不离场，同状态调用无需写入即可解析。

### 失败与恢复

未知候选 id 或非法流转响亮拒绝；存储启动前读取抛出异常。候选 id 即优化器的暂存写入 id，因此 `/population` 的 id 永远指代一条真实存在的暂存写入。

本包不发布不变的伴生检查，因为域表是此状态的唯一副本，没有第二个独立观测可供比对。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [进化式 Harness 规范](../../../specs/evolutionary-harness-v11-deep-research.md) §51 — 本包实现的基于种群的进化机制族。
- [进化包地图](../README.zh.md) — 该组的包及其仓库位置。
- [`dsh-evolution-optimizer`](../evolution-optimizer/README.zh.md) — 其暂存写入经可选记录缝成为候选的产生方。
- [`dsh-evolution-evaluator-health`](../evolution-evaluator-health/README.zh.md) — 采用同一可选挂载模式的姊妹存储，其裁决记录缝与之类似。

-----

<a id="model-experience"></a>
## 模型体验

无，本存储不注册任何面向模型的东西。

#### KV 缓存影响

此处没有任何内容进入模型请求，因此不影响供应商缓存复用。把候选事实渲染进提示词的消费者拥有该请求的前缀。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与暂缓工作

这些限制定义了本存储在何种情况下不合适。它们是当前的包约束。

- **竞争是排名，不是管线** —— 精英只是已通过候选的有序视图；尚无任何机制反复把精英的技能正文送进评估循环来繁衍下一代。
- **代数只通过 `record` 推进** —— 候选永远是技能最高代数之后的一代，因此直接写域可能产生同代行，其头候选人改由 `at` 解析。
- **宿主全局，不按作用域键控** —— 候选是全局的；按作用域的种群需要给域加作用域键。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

优化器通过可选存储记录，因此未安装种群包的部署看不到任何行为变化；失败存储路径记录一条警告，而不是让优化失败。谱系辅助函数按构造容忍畸形链，因此损坏的父代链接退化为更短的谱系，而不会无限走环。

</details>