---
description: "基于生产失败的基准增长：带内容去重、污染状态与回归晋升的持久化评估任务存储（ctx.evolutionBenchmark）。"
kind: "package-reference"
---

# @deepseek-ai/dsh-evolution-benchmark

[English](README.md) | 中文

## 摘要

`dsh-evolution-benchmark` 从生产失败中长出评估任务，并保持其持久且去重。任务以 `fresh` 进入，随使用沿 `fresh → search → validation → holdout` 前进，任何可学习状态都可被拉偏到 `contaminated` 或 `retired`。内容地址（规范化任务文本的 sha256）在其孪生仍可学习时阻止重新接纳；而 `contaminated` 或 `retired` 任务不阻止重新接纳，修复后的任务可以重新进入管线。此处不调用任何模型。宿主命令 `command-evolution` 通过 `/benchmark` 读取它。

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

挂载插件并携带存储域即可。从任何产生方接纳候选任务（交付的消费者是 curriculum 存储的 open 提案），然后沿学习阶梯逐个推进任务。

```ts
const { admitted, duplicates } = await ctx.evolutionBenchmark.admit([{
  capability: 'writer',
  task: 'Recover from the recurring failure: boom',
  gists: ['boom'],
  sourceSessions: ['s1'],
}])
for (const task of admitted) {
  await ctx.evolutionBenchmark.transition(task.id, 'search')
}
```

`admit(inputs)` 对每个仍可学习的任务去重，并把其余暂存为 `fresh`，每趟受 `maxAdmit` 封顶；它返回已接纳的任务与重复文本。`tasks(state?)` 列出全部任务，可学习状态按管线顺序在前、然后最新在前。`transition(id, to)` 每次推进一个阶梯，把任何可学习状态拉偏到 `contaminated` 或 `retired`，并对未知 id 与非法流转响亮拒绝。`/benchmark` 命令按状态列出、接纳 curriculum 存储的 open 提案，并推进或退役任务。

### 配置

接纳上限是可在 `cordis.yml` 中修改的已验证 `Config` 成员。

```yaml
- name: '@deepseek-ai/dsh-evolution-benchmark'
  config:
    maxAdmit: 20
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `maxAdmit` | `20` | 一趟接纳最多可暂存的可学习任务数 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-evolution-benchmark)是每个已接受字段的穷尽来源。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节 — 点击展开</summary>

### 设计概念

去重是纯函数且按内容寻址：`benchmarkHash` 是空白折叠任务文本的 sha256 十六进制，因此仅空白不同的两个输入是同一任务。`dedupe` 把候选拆成已接纳与重复，对照已可学习的哈希；存储通过按状态询问 `blocksDuplicate` 来构建该阻止集——因此 `contaminated` 与 `retired` 任务从不阻止重新接纳。

存储是按任务粒度的域：`evolution_benchmark` 版本 1，含一张以任务身份为键的 `tasks` 表，存放 `{ id, hash, capability, task, gists, sourceSessions, at, state }`。`transitionState` 是唯一的状态机：可学习性每次推进一步，任何可学习状态可拉偏到 `contaminated` 或 `retired`，终态永不离场，同状态调用无需写入即可解析。

### 失败与恢复

未知 id 或非法流转响亮拒绝，因此任务永远不能跳过阶梯或逃离终态。存储启动前读取抛出异常。

本包不发布不变的伴生检查，因为域表是此状态的唯一副本，没有第二个独立观测可供比对。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [进化式 Harness 规范](../../../specs/evolutionary-harness-v11-deep-research.md) §14 与 §35 — 本包实现的基准增长与污染控制机制族。
- [进化包地图](../README.zh.md) — 该组的包及其仓库位置。
- [`dsh-evolution-curriculum`](../evolution-curriculum/README.zh.md) — `/benchmark admit` 把其 open 提案晋升为 fresh 任务的产生方。
- [生成的配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-evolution-benchmark) — 每个已接受的配置字段。

-----

<a id="model-experience"></a>
## 模型体验

无，本存储不注册任何面向模型的东西。

#### KV 缓存影响

此处没有任何内容进入模型请求，因此不影响供应商缓存复用。把任务渲染进评估运行的消费者拥有该请求的前缀。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与暂缓工作

这些限制定义了本存储在何种情况下不合适。它们是当前的包约束。

- **没有执行器或裁判** —— 存储持有任务与状态；尚无人运行任务或给候选打分（optimizer 与 scorer 评估各自录制的语料，把它们接入基准状态是接下来的评估工作）。
- **宿主全局，不按作用域键控** —— 任务是全局的；按作用域的基准需要给域加作用域键。
- **污染是手动的** —— 只有有人流转它时，任务才会离开可学习阶梯；没有扫描会依据搜索暴露自动把任务标记为污染。

<a id="dev-note"></a>
### 开发者注记

<details>
<summary>维护者工作上下文 — 点击展开</summary>

去重阻止集由逐状态检查构建，而非硬编码列表，因此日后新增状态只需 `blocksDuplicate` 为其作答。`tasks()` 列表中的状态顺序镜像阶梯；`contaminated` 与 `retired` 排在 `holdout` 之后。

</details>