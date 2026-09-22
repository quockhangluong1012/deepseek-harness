---
description: "基于生产失败的基准增长：带内容去重、污染状态、回归晋升，以及保留受保护留出的 §15 证据规则的持久化评估任务存储（ctx.evolutionBenchmark）。"
kind: "package-reference"
---

# @deepseek-ai/dsh-evolution-benchmark

[English](README.md) | 中文

## 概述

`dsh-evolution-benchmark` 从生产失败中长出持久且去重的评估任务。任务以 `fresh` 进入，随使用沿 `fresh → search → validation → holdout` 前进，可学习的任务可被拉偏到 `contaminated` 或 `retired`。内容地址（规范化任务文本的 sha256）在其孪生仍可学习时阻止重新接纳；而 `contaminated` 或 `retired` 任务不阻止重新接纳，因此修复后的任务可以重新进入管线。`ladderAdvance` 读取任务所属能力的暴露，并指出该证据挣得的档位，因此 §15 的留出划分是一项决策，而非手工操作。此处不调用任何模型；宿主命令 `command-evolution` 通过 `/benchmark` 读取它。

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

### 依据已记录证据推进阶梯（§15）

`transition` 把任务移到调用者所说的任何地方，这就让留出划分成为手工决策。`ladderAdvance(state, exposure)` 是那条纯规则，用引擎已记录的内容回答同一个问题；当证据挣不到任何档位时它返回 `undefined`。

```ts
// Exposure is the capability's recorded candidate evaluations.
const next = ladderAdvance('search', { runs: 4, passes: 1 })
// next === 'validation'
await ctx.evolutionBenchmark.transition(task.id, next)
```

| 任务状态 | 挣得档位的条件 | 为何是这条证据 |
|---|---|---|
| `fresh` → `search` | `runs > 0` | 有任何东西被评估过，因此该任务可以加入搜索所生成对照的集合 |
| `search` → `validation` | `passes > 0` | 有候选通过，因此该任务带着已知基线，能够区分而不只是失败 |
| `validation` → `holdout` | `runs >= HOLDOUT_AFTER_RUNS`（3） | 语料已越过该任务，因此保护它对搜索没有代价 |
| `holdout`、`contaminated`、`retired` | 永不 | 该划分止于受保护状态，且终态永不离场 |

暴露按能力而非按任务归属，因为没有任何存储把候选评估绑定到基准任务身份：调用者读取某任务所属能力的已记录暴露，并将其应用到该能力的可学习任务。导出 `HOLDOUT_AFTER_RUNS` 是为了让部署能直接陈述它所依赖的阈值，而不必重新发现它。

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

`ladderAdvance` 在该状态机之上叠加证据规则，而不是取代它：它先从 `nextLadder` 取得该状态唯一合法的前进一步，再判断证据是否挣得这一步，因此调用者总能 `transition` 到规则返回的状态而不会被存储拒绝。该规则把暴露当作数据读取（`runs`、`passes`），而不是自己去读 population 存储，这正是让 benchmark 包不必依赖引擎的 population 层的原因。

### 失败与恢复

未知 id 或非法流转响亮拒绝，因此任务永远不能跳过阶梯或逃离终态。存储启动前读取抛出异常。

本包不发布不变的伴生检查，因为域表是此状态的唯一副本，没有第二个独立观测可供比对。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [进化式 Harness 规范](../../../specs/evolutionary-harness-v11-deep-research.md) §14、§15 与 §35 — 本包实现的基准增长、受保护留出与污染控制机制族。
- [进化包地图](../README.zh.md) — 该组的包及其仓库位置。
- [`dsh-evolution-curriculum`](../evolution-curriculum/README.zh.md) — `/benchmark admit` 把其 open 提案晋升为 fresh 任务的产生方。
- [`dsh-evolution-actuator`](../evolution-actuator/README.zh.md) — 把已记录失败挖成任务、并依据已记录暴露推进它们的增长回路。
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
- **留出规则读取的是能力暴露，而不是任务暴露** —— 没有任何存储把候选评估绑定到基准任务身份，因此 `ladderAdvance` 无法得知*这个*任务是否被搜索过，只能得知该能力被评估了多少；这意味着一个被准入到充分评估过能力里的任务，会在搜索从未使用它的情况下到达 `holdout`。把评估绑定到任务身份需要一份 harness 尚不具备的记录。
- **该规则只作答，不行动** —— `ladderAdvance` 返回一个状态，此处没有任何东西代它调用 `transition`；已交付的调用者是 actuator 的增长回路。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

去重阻止集由逐状态检查构建，而非硬编码列表，因此日后新增状态只需 `blocksDuplicate` 为其作答。`tasks()` 列表中的状态顺序镜像阶梯；`contaminated` 与 `retired` 排在 `holdout` 之后。

`ladderAdvance` 与 `nextLadder` 并存而非取代它，因为两者回答不同的问题：`nextLadder` 是阶梯的形状，`/benchmark promote` 与 `transition` 早已强制它；而 `ladderAdvance` 是叠在其上的证据门。只想要下一档的调用者仍然拿得到它。`HOLDOUT_AFTER_RUNS` 是具名常量而非比较式里的字面量，好让 README、测试与任何就阈值推理的部署都引用同一个数字。

</details>