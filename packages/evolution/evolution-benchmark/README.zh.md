---
description: "基于生产失败的基准增长：带内容去重、污染状态、回归晋升，以及保留受保护留出的 §15 证据规则的持久化评估任务存储（ctx.evolutionBenchmark）。"
kind: "package-reference"
---

# @deepseek-ai/dsh-evolution-benchmark

[English](README.md) | 中文

## 概述

`dsh-evolution-benchmark` 从生产失败中长出持久且去重的评估任务，并执行它们。任务以 `fresh` 进入，随使用沿 `fresh → search → validation → holdout` 前进，或被拉偏到 `contaminated` 或 `retired`；内容地址在其孪生仍可学习时阻止重新接纳，`ladderAdvance` 读取已记录的暴露来决定 §15 的留出划分。§5.3 数据集以任务定义夹具交付；运行 pass 通过 scorer 的回放接缝启动每个任务，并为每个任务记录一条持久结果——裁定、成本与 §13.5 事实——`/benchmark` 与 `ctx.evolutionMetrics` 读的正是它。

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

挂载插件并携带存储域即可。从任何产生方接纳候选任务——§5.3 数据集、curriculum 存储的 open 提案，或 actuator 挖出的失败——然后沿学习阶梯逐个推进任务。

```ts
const { admitted, duplicates } = await ctx.evolutionBenchmark.admit([{
  capability: 'writer',
  task: 'Recover from the recurring failure: boom',
  gists: ['boom'],
  sourceSessions: ['s1'],
  profile: null,          // the producer did not classify the task
  family: 'loop-recovery',
  stepSpan: null,         // no stated horizon
  acceptance: null,       // no stated observable
}])
for (const task of admitted) {
  await ctx.evolutionBenchmark.transition(task.id, 'search')
}
```

`admit(inputs)` 对每个仍可学习的任务去重，并把其余暂存为 `fresh`，每趟受 `maxAdmit` 封顶；它返回已接纳的任务与重复文本。`tasks(state?)` 列出全部任务，可学习状态按管线顺序在前、然后最新在前。`transition(id, to)` 每次推进一个阶梯，把任何可学习状态拉偏到 `contaminated` 或 `retired`，并对未知 id 与非法流转响亮拒绝。`/benchmark` 命令按状态列出、接纳 curriculum 存储的 open 提案，并推进或退役任务。

每个任务都陈述它为哪个 profile、哪个 §5.3 场景族编写，以及它应经历的步数跨度（`stepSpan`，产生方未设界时为 null）。这一分类由产生方陈述，而不留给存储：由已记录证据挖出的任务展开 `MINED_TASK`——loop/recovery 族、无 profile、无跨度、无可验收观测量——而 §5.3 数据集任务携带其夹具声明的 profile 与跨度。

### 基准数据集（§5.3、§13.5）

本包交付 `datasets/`，每个 §5.3 场景族一个 JSON 文件，文件以该族命名。文件声明 `runRequirement: 'live-model'` 并列出其任务定义；每个定义携带 `profile`、`stepSpan`、`capability`、`task` 与 `acceptance`。

```ts
const datasets = await loadDatasets(new URL('../datasets/', import.meta.url).pathname)
const { admitted } = await ctx.evolutionBenchmark.admit(datasetInputs(datasets))
```

`loadDatasets(root)` 按族名顺序枚举该根目录，并校验每个文件、其族名以及每个任务定义；任一校验失败即响亮拒绝。`datasetInputs(datasets)` 把定义映射为接纳输入；每个输入携带它被枚举时所处的族，且不含失败 gist 与来源会话，因为数据集任务是编写的而非挖出的。`horizonTier(stepSpan)` 与 `HORIZON_TIERS` 命名 §13.5 的跨度：步数界限在 100 及以上的任务位于 100+ 档，低于 10 步的跨度不达任何档。

| 族文件 | 所含 profile | 所达跨度 |
|---|---|---|
| `coding.json` | `coding` | 至多 10 步 |
| `research.json` | `research` | 至多 20 步 |
| `mentor-ict.json` | `mentor`、`ict` | 至多 25 步 |
| `long-horizon.json` | 每个 profile | 10、20、50 与 100+ 步 |
| `loop-recovery.json` | `coding`、`research`、`mentor` | 至多 12 步 |

数据集任务是定义而非运行：它不交付期望输出，也不交付录制的会话，因此其结果需要一次运行；编码任务要改动的工作区、mentor/ICT 任务要分析的案例材料都由调用方提供。`acceptance` 陈述的正是评判那次运行的观测量。

### 执行语料（§13）

`run(request)` 把每个任务变成它自己的一次运行，并为每个任务记录一条持久结果。任务文本成为运行的输入脚本；各次尝试由 `evolution-scorer` 自己的 `scoreRun` 归约，因此裁定、计费 token 与墙钟时间与其它任何地方的含义完全一致；§13.5 事实则从每次尝试所收获的会话折叠而来。

```ts
const datasets = await loadDatasets(new URL('../datasets/', import.meta.url).pathname)
const { admitted } = await ctx.evolutionBenchmark.admit(datasetInputs(datasets))

const report = await ctx.evolutionBenchmark.run({
  tasks: admitted,
  options: { agent, mode: 'replay', fixtureFile, workspaceDir },  // RunOptions, @deepseek-ai/dsh-session-snapshot
  run: processScenarioRunner,                                     // the seam evolution-scorer scores through
  expected: task => captures.get(task.id),                        // the observable each task is judged against
  attempts: 1,
})

report.outcomes  // one outcome per executed task, in run order
report.scored    // outcomes that produced a verdict
report.passed    // executed tasks that passed
report.failed    // runs that failed before a verdict
report.deferred  // tasks the configured cap left unexecuted
```

每条结果都携带任务标识、profile、族与跨度层级、裁定、指标三元组、失败所点名的分歧路径，以及 §13.5 事实：步数、验证次数与通过的验证次数、关闭与完成的任务数、失败与已被回答的失败数、对照所报告窗口的峰值上下文占用，以及收获到的会话 id。`outcomes()` 按最新在前列出它们，`ctx.evolutionMetrics.longHorizon()` 正是按跨度层级聚合这些行，`benchmark-robustness` 也正是对它们求比。

失败的一次运行——runner 无法启动、夹具缺失——仍会记录为 `status: 'failed'` 的结果并附带原因，pass 继续处理下一个任务，因此一个无法运行的任务不会掩盖它前后任务的结果。失败结果不带裁定、也没有量出的三元组；只填入它所收获会话记录下来的那些事实。

runner 由调用方提供：传入 `processScenarioRunner`（或任何 `ScenarioRunner`）即走无密钥的回放层，由其接线点名夹具；传入以 `record` 模式启动组合的 runner 即走真实模型。本包自身从不调用模型，裁定始终是 scorer 拿调用方为该任务解析出的期望所做的 workspace 比对。

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
| `maxTasks` | `20` | 一趟运行最多执行的任务数；其余报告为 deferred |
| `attempts` | `1` | 每个任务的 fresh 进程尝试次数；取一让一趟语料运行保持可负担，调用方提高它即可把冷启动中位化掉 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-evolution-benchmark)是每个已接受字段的穷尽来源。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节 — 点击展开</summary>

### 设计概念

去重是纯函数且按内容寻址：`benchmarkHash` 是空白折叠任务文本的 sha256 十六进制，因此仅空白不同的两个输入是同一任务。`dedupe` 把候选拆成已接纳与重复，对照已可学习的哈希；存储通过按状态询问 `blocksDuplicate` 来构建该阻止集——因此 `contaminated` 与 `retired` 任务从不阻止重新接纳。

存储是按任务粒度的域：`evolution_benchmark` 版本 2，含一张以任务身份为键的 `tasks` 表，存放 `{ id, hash, capability, task, gists, sourceSessions, profile, family, stepSpan, acceptance, at, state }`。版本 1 不存放 profile、族与跨度；这些行以 `loop-recovery`、空 profile 打开，因为那一代的每个产生方都从已记录失败派生其任务。`transitionState` 是唯一的状态机：可学习性每次推进一步，任何可学习状态可拉偏到 `contaminated` 或 `retired`，终态永不离场，同状态调用无需写入即可解析。

`dataset.ts` 是语料的那一半：文件 schema、从文件名读取的族词表、基于 `HORIZON_TIERS` 的 `horizonTier`，以及到接纳输入的映射。从文件名读取族、而不在文件内重复它，让每个数据集只留下一处声明，夹具因此无法自相矛盾；多余的文件、未知的族名或不完整的任务定义在该边界处拒绝，而不会接纳一份残缺的语料。

`ladderAdvance` 在该状态机之上叠加证据规则，而不是取代它：它先从 `nextLadder` 取得该状态唯一合法的前进一步，再判断证据是否挣得这一步，因此调用者总能 `transition` 到规则返回的状态而不会被存储拒绝。该规则把暴露当作数据读取（`runs`、`passes`），而不是自己去读 population 存储，这正是让 benchmark 包不必依赖引擎的 population 层的原因。

运行 pass 是同一个存储的另一半：`evolution_benchmark` 保存任务，`evolution_benchmark_runs` 为每个已执行任务保存一行，因此结果是一条持久证据，而不是某条命令打印过一次的数字。一行里既有 scorer 的裁定与三元组，也有从这次运行自己收获的会话折叠出的事实——内核自己的计数器给出步数、验证、关闭、失败与恢复，token 计费器自己的上下文压力投影给出占用——因此后来的读者无需再打开会话日志，就能回答一次运行花了多少、离上下文上限有多近。pass 借用评估机制而不是重新实现它：本包新增的只有输入脚本，各次尝试由 scorer 导出的 `scoreRun` 归约。

### 失败与恢复

未知 id 或非法流转响亮拒绝，因此任务永远不能跳过阶梯或逃离终态。存储启动前读取抛出异常。

runner 抛错的那次运行是唯一不向上传播的失败：它被记录为带原因的失败结果，因为同一趟运行里其它任务的结果才是报告所需的证据，中止会用一个错误信息换掉它们。这一行把失败运行自己的坏消息同时留在两处——行上的原因字符串，以及 §13.5 报告窗口里的 `failed` 计数——因此一个从未运行过的任务永远不会被读成「未通过」的任务。

本包不发布不变的伴生检查，因为域表是此状态的唯一副本，没有第二个独立观测可供比对。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [进化式 Harness 规范](../../../specs/evolutionary-harness-v11-deep-research.md) §14、§15 与 §35 — 本包实现的基准增长、受保护留出与污染控制机制族。
- [DeepSeek Harness 2.0 规范](../../../specs/deepseek-harness-2.0-evolution-spec.md) §5.3 与 §13.5 — `datasets/` 与 `HORIZON_TIERS` 覆盖的基线数据集与步数跨度。
- [进化包地图](../README.zh.md) — 该组的包及其仓库位置。
- [`dsh-evolution-curriculum`](../evolution-curriculum/README.zh.md) — `/benchmark admit` 把其 open 提案晋升为 fresh 任务的产生方。
- [`dsh-evolution-actuator`](../evolution-actuator/README.zh.md) — 把已记录失败挖成任务、并依据已记录暴露推进它们的增长回路。
- [`dsh-evolution-scorer`](../evolution-scorer/README.zh.md) — 运行 pass 启动每个任务所用的 fresh 进程 runner 接缝与 `scoreRun` 归约。
- [`dsh-evolution-metrics`](../evolution-metrics/README.zh.md) — 读取运行 pass 所记录结果的 `benchmark-robustness` 与 §13.5 长跨度报告。
- [生成的配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-evolution-benchmark) — 每个已接受的配置字段。

-----

<a id="model-experience"></a>
## 模型体验

无，本存储不注册任何面向模型的东西：任务、结果与阶梯状态都不会进入提示词、工具结果或会话事件。

#### KV 缓存影响

此处没有任何内容进入模型请求，因此不影响供应商缓存复用。运行 pass 把任务渲染进它所启动进程的提示词，而那正是该次运行自己的请求：其前缀复用属于调用方启动的组合，不属于本存储。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与暂缓工作

这些限制定义了本存储在何种情况下不合适。它们是当前的包约束。

- **裁定是 workspace 比对，不是验收陈述** —— 任务的 `acceptance` 是散文，运行 pass 评判一次运行的方式，是把 workspace 与调用方为该任务解析出的期望做比对。观测量不是 workspace 状态的任务（mentor 的解释、研究的答案）需要调用方提供期望，或由本包之外的裁判来评判。
- **没有任何记录保存数据集夹具的期望 workspace** —— §5.3 数据集交付的是定义而非期望，因此一趟语料运行的可复现程度只取决于部署自己的捕获。一个都不提供时，每个任务都对照它自己的初始 workspace 评分，只有什么都没改的运行才会通过；`/benchmark` 读取并接纳语料，执行它是部署自己的决定。
- **一次运行的会话不会被复制进宿主会话存储** —— §13.5 事实在结果被记录时从该次尝试收获的日志折叠而来。`ctx.evolutionMetrics.coding()` 读的是宿主自己记录的会话，因此基准运行不会出现在那个窗口里，两者覆盖的是不同的总体。
- **`stepSpan` 是下限，不是测量值** —— 它声明任务应经历的最小步数；一次运行是否落在其跨度内，从该运行自己的 trace 读取，永远不来自本存储。记录下来的 `steps` 才是这次运行实际走的步数，这也是两者同处一行结果的原因。
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

一条结果只从第一次尝试的日志折叠它的 §13.5 事实，因此一行永远不会把三次运行之和与一次运行的中位数混在一起；行内的字段文档会说明每个事实描述的是哪次尝试。事实只在运行被记录时折叠一次，因为收获到的日志是那份证据唯一的副本——这次运行启动的进程，其会话宿主自己的存储从未见过。

</details>
