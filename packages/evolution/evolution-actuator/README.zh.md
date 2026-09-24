---
description: "演化驱动：七个心跳任务读取已记录的演化裁定或已记录的证据，并执行其所要求的下一步（经风险模型作出的发布决策、按计划迁移岛屿、停滞恢复、排空不确定性、准入课程、基准增长、对抗探针生成）。"
kind: "package-reference"
---

# @deepseek-ai/dsh-evolution-actuator

[English](README.md) | 中文

## 概述

`dsh-evolution-actuator` 在宿主空闲时，经由已经接受该步骤的存储，执行每条演化记录所要求的动作。本组其余包只记录然后停下，留下七个停滞的回路：发布决策、岛屿迁移、停滞恢复、不确定性排空、课程准入、基准生长与对抗探针生成。它为每个回路注册一个心跳任务，不开启自己的域、不调用模型、也不门控任何东西：它只移动已记录的状态，因此挂载它会改变引擎的下一步，而不改变任何会话所见。每一步都在其任务类所记录的 §37 预算下运行，因此某个批次已花尽的分配可以停下该类的工作。

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

在它所操作的存储被挂载之处挂载本插件。心跳是被注入的服务，因此调度器一旦存在插件就会应用；上下文拥有的注册注销函数会在销毁返回前排空活动任务。

```ts
import * as evolutionActuator from '@deepseek-ai/dsh-evolution-actuator'

await ctx.plugin(evolutionHeartbeat)
await ctx.plugin(evolutionActuator)
```

每个回路在其轮次运行时读取自己的存储，因此未挂载的存储只会让那一个回路成为空操作，其余六个照常工作。无内容可操作的回路不改变任何东西。通过心跳寻址单个回路的轮次与其簿记：

```ts
await ctx.evolutionHeartbeat.runTask('evolution-rollout-monitor')
ctx.evolutionHeartbeat.state('evolution-rollout-monitor')
```

### 配置

每个节奏与阈值都是可在 `cordis.yml` 中更改的、经校验的 `Config` 字段；心跳会拒绝小于一小时的间隔，本插件亦然。

```yaml
- name: '@deepseek-ai/dsh-evolution-actuator'
  config:
    loops: ['rollout', 'growth']
    rolloutCostFactor: 2
    growthIntervalHours: 12
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `loops` | 全部回路 | 要驱动的回路：`rollout`、`migration`、`recovery`、`drain`、`admission`、`growth`、`adversary` |
| `rolloutIntervalHours` | `6` | 两次发布监视轮次之间的小时数 |
| `rolloutCostFactor` | `1.5` | 相对在任者三元组、使发布失败的倍数 |
| `migrationIntervalHours` | `24` | 两次按计划岛屿迁移轮次之间的小时数 |
| `recoveryIntervalHours` | `24` | 两次停滞恢复轮次之间的小时数 |
| `drainIntervalHours` | `12` | 两次不确定性排空轮次之间的小时数 |
| `admissionIntervalHours` | `24` | 两次课程准入轮次之间的小时数 |
| `growthIntervalHours` | `24` | 两次基准增长轮次之间的小时数 |
| `adversaryIntervalHours` | `24` | 两次对抗生成轮次之间的小时数 |
| `maxPerPass` | `5` | 每个回路每轮操作的条目数，最强或最新在前 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-evolution-actuator)是每个可接受字段的穷尽来源。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部——点击展开</summary>

### 设计概念

一个回路就是一个已记录信号加一个步骤：

| 回路 | 读取 | 执行 |
|---|---|---|
| `rollout` | `evolutionCanary` 中处于 `canary` 的部署、`evolutionBenchmark` 的 holdout 任务、§49 的风险模型 | `advance` 到 `promoted` 或 `rolled-back` |
| `migration` | `evolutionIslands` 中 `due` 的排程行 | `migrate` 该技能的精英到下一条泳道，理由为 `schedule` |
| `recovery` | `evolutionStagnation` 中每个有运行的技能状态、`evolutionOperators` 为该技能工件类给出的推荐 | 阶梯 `diversity`：把精英迁移到新颖泳道；阶梯 `newOperators`：报告算子存储推荐的指令；阶梯 `newTasks`：暂存由实测缺口导出的任务 |
| `drain` | `evolutionUncertainty` 队列 | `benchmark.admit` 该任务，随后 `resolve` 其背后的信号 |
| `admission` | `evolutionCurriculum` 中开放的提案 | `benchmark.admit` 它们 |
| `growth` | `evolutionCurator` 的开放债务、`evolutionFeedback` 的分级信号、`evolutionPopulation` 的已记录候选、`evolutionBenchmark` 的任务 | `benchmark.admit` 推导出的任务，随后在其能力所记录暴露挣得时把任务 `transition` 一个阶梯 |
| `adversary` | `evolutionUncertainty` 的信号、`evolutionCurator` 的开放债务、`evolutionBenchmark` 的任务能力 | `evolutionAdversary.probe` 生成的探针，随后把瞄准基准形态能力者 `benchmark.admit` |

每个决策都位于纯模块中——`rolloutDecision`、`rolloutRisk`、`routeAllows`、`migrationTarget`、`recoveryStep`、`benchmarkInput`、`signalProbe`、`debtProbe`、`probeTask`、`governingAllocation`、`failureInputs`、`debtInputs`、`exposureOf`，以及 §15 的 `ladderAdvance`——因此规则无需宿主即可阅读与测试，而回路只执行规则所指名的调用。

发布监视器结束一次已经在线的发布，而从不开启一次：§49 把中风险步骤（补丁进入在线比例）交给运维者。它在做出任何决定之前先咨询 §49 的风险模型。已实测的回归总是离开阶梯，因为回滚是把在任者恢复回来而不是装上新补丁；而提升需要 `auto-promote` 路由，因此其能力没有受保护留出覆盖的补丁——§15 禁止把提升建立在生成候选所用的数据集上——会保持在线，等待其路由所指名的那一步。语料未通过的补丁永不提升；通过但按引擎自身的精英序——先计费 token，再在 token 相同时比墙钟时间——比在任者更贵的补丁则回滚。

### 增长回路挖取什么（§14、§15）

该回路不需要模型，也不依赖任何被禁用的存储。它的四个来源，以及各自推导出的确切任务：

| 来源 | 推导 |
|---|---|
| `evolutionFeedback.signals(sessions, maxPerPass)` | 存储评为 `trigger_review` 的每个信号产生一个任务，即在 `triggerReviewSessions` 个不同会话中被报告的失败。能力是失败的工具，任务文本为 `Recover from the recurring failure: '<message>' — <tool> was in play.`。只排序或只观察的信号不产生任何东西；工具调用从未被观察到的信号亦然，因为缺少工具就没有可归因的能力。用于读取信号的会话列表来自 `evolutionSkillTelemetry.entries()` 的 `usage.sessionIds`，与课程测量其缺口所用的同一条缝。 |
| `evolutionCurator.debt()` | 每条开放债务产生一个任务，以债务的技能作为能力，任务文本同样由其失败消息构造。 |
| `evolutionPopulation.candidates(capability)` | 为阶梯规则提供暴露，而非任务：测得三元组的候选评估数量，以及其中通过的数量。未测量的候选两边都不计入。 |
| `evolutionBenchmark.tasks()` | 阶梯规则要推进的可学习任务，以及（对发布回路而言）`holdout` 任务所保护的能力。 |

`ladderAdvance(state, exposure)` 是 §15 的决策规则，每一档都要求各自的已记录证据：`fresh` 任务在能力有一次已记录的候选评估后加入搜索集；`search` 任务在有候选通过后变为 validation（由此它带着已知基线，能够区分而不只是失败）；`validation` 任务在能力有 `HOLDOUT_AFTER_RUNS` 次评估后保留为 `holdout`，此时语料已越过它，保护它对搜索不再有代价。暴露按能力而非按任务归属，因为没有任何存储把候选评估绑定到基准任务身份——见下方限制。

每个回路在构造上都是幂等的，这正是让心跳节奏安全的原因。已决的发布会离开 `canary`，因此下一轮无法再次决定它。已记录的迁移会重置其泳道的到期标记。课程存储会跳过任务已开放的缺口，基准存储按任务内容去重——正是这一点阻止增长回路反复准入反馈存储每轮都评为 `trigger_review` 的失败，因为推导出的任务文本不含观察计数，因而重新哈希到已经准入的那个任务。不确定性排空会丢弃它所操作的信号，因此队列会排空而不是反复准入。阶梯规则是单调的，且 `transition` 只在状态变化时写入，因此无法推进的任务完全不会被写入。对抗回路会留下存储已持有完全相同文本的探针，这正是已修复的探针保持已修复、而重复读到的弱点不会在它旁边变成第二个探针的原因。

### 对抗回路生成什么（§45、§14）

该回路把已记录的证据变成对抗探针，每个已记录弱点一支，因此探针绝不是凭空写出的文本。弱点族来自存储那份封闭的 §45 词表，观察内容则是逐字记录的原文：

| 已记录的证据 | 族 | 为何是该族 |
|---|---|---|
| 一条种类为 `disagreement` 的 `evolutionUncertainty` 信号 | `evaluator-gaming` | 分歧来自某个评估器，因此探针所考的是评估器自身的判断（§46）。 |
| `low-confidence` | `ambiguous-instruction` | 自信的错误答案，正是指令未说清时会产生的产物。 |
| `instability` | `edge-case` | 不稳定意味着同一输入下结果会漂移，而用例边界正是暴露它的地方。 |
| `retrieval-ambiguity` | `retrieval-trap` | §43 记录了检索无法区分；探针就考这个陷阱。 |
| `conflicting-evidence` | `contradictory-evidence` | 两份记录对同一事实互相矛盾。 |
| 一条 `evolutionCurator` 的开放回归债务 | `tool-failure` | 债务的合并键就是一个工具加一条消息：这条已记录失败本身就是一次失败的工具调用。 |

探针文本为 `Probe <skill> for the recorded <family> weakness: '<observation>'.`，其身份是技能、族与文本三者的 sha256，因此一个已记录弱点无论经历多少轮都只是一支探针，而已修复的探针不会被反复看到它的那一轮重新打开。该轮只记录探针，从不运行它：要在候选上执行探针，需要随包 profile 并未提供存储的运行器与语料，因此 `foundWeakness` 保持 `false`，而不去报告一次从未发生的运行——暴露弱点的是已记录证据，探针是留给实际执行者的已记录挑战。§45 的这一半仍属运维侧。

瞄准基准形态能力的探针还会作为 §14 对抗样例被准入，走的是其他回路共用的同一条 `benchmark.admit` 路径，并由同一个内容哈希去重，因此对抗样例进入评估集，而不是死在探针日志里。「基准形态」指的是基准存储中已有任务点名该能力：某个全新能力首次失败只产生探针而不产生任务，因为此时还没有该样例可加入的评估集——为那个能力创建首个任务的课程提案才会把它带入范围，随后的一轮便会准入该样例。

### 预算闸门做什么（§37、§38）

这些回路是唯一被启用的运行者，因此已记录的分配真正能停下工作的地方就在这里。每一步之前，该轮会读取预算存储为那个技能或能力记录的分配并取最新一条，然后向 `evolution-budget` 自己的 `withinAllocation` 询问该批次的已记录花费。批次已花尽的类会被搁置，跳过会写入日志——什么都没发生，因此不向任何域写入——而实际运行过的类会向同一个批次结算，记录这次工作耗掉的墙钟时间。这正是闭环之处：某个批次记录的额度会在同一类的下一轮之前被读到。

- **挂载了预算存储就限制工作，未挂载则不限制。** 未挂载 `evolutionBudget` 时，每个回路都完全照旧运行，不计量。没有任何批次定价的类同样不计量地运行：未定价的类没有额度，而不是零额度。
- **执行者是 `withinAllocation`，因此闸门覆盖 `evolution-budget` 定价的每个 §37 维度**——token、墙钟时间、成本、截止时间与并行度——也包括在它们之前写入的记录所缺省的维度，而缺省即不设限。
- **回路只花墙钟时间，不花 token。** 它们不调用模型，因此一轮报告 `tokens: 0` 以及它耗掉的墙钟时间；token、成本与 rollout 额度是由优化器自己记录的花费推动的，而不是由这道闸门。

### 失败与恢复

未挂载的存储会静默结束其回路；其余回路继续运行。拒绝某个动作的存储——例如某人先推进了同一次发布导致非法流转——会让该任务的那次尝试失败，心跳将其记入 `lastError` 并按间隔重试，该轮其余部分不受影响。注册在内存中，持久簿记属于心跳，因此重启会按已存储的排程继续。

不发布不变式伴随包：本插件不拥有自己的状态，它所操作的每个值都属于记录它的那个存储。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [演化 Harness 规格](../../../specs/evolutionary-harness-v11-deep-research.md) —— §7（按计划迁移岛屿）、§10（课程）、§14（基准增长、回归晋升，以及对抗样例生成器）、§15（受保护留出，以及保留它所需的阶梯证据）、§18 与 §49（shadow → canary → 提升、§49 的风险表，以及人在回路规则）、§32（策略阶梯）、§35（污染控制）、§37 与 §38（预算控制器与逐次减半）、§43（不确定性驱动的学习）、§45 与 §46（对抗演化与评估器博弈防御）、§53（提案 → 基准 → 金丝雀 → 提升链），以及 §58.12 中本包始终身处其内的“只记录、不强制”边界。
- [演化包地图](../README.zh.md) —— 本组的各个包及其在仓库中的位置。
- [`dsh-evolution-adversary`](../evolution-adversary/README.zh.md) —— 对抗回路所写入的探针存储、它的八个 §45 族，以及 §46 防御清单。
- [`dsh-evolution-budget`](../evolution-budget/README.zh.md) —— 预算闸门所读取的分配与结算，以及 §37 的候选类定价。
- [`dsh-evolution-canary`](../evolution-canary/README.zh.md) —— 发布阶梯，以及 `rolloutRisk` 所喂入的 §49 风险模型。
- [`dsh-evolution-benchmark`](../evolution-benchmark/README.zh.md) —— 排空、准入与增长回路所准入的存储，以及它们所推进的阶梯规则。
- [`dsh-evolution-heartbeat`](../evolution-heartbeat/README.zh.md) —— 拥有节奏、空闲门与簿记的调度器。
- [`dsh-evolution-metrics`](../evolution-metrics/README.zh.md) —— 同一批存储的读取侧：度量层报告这些回路移动了什么。
- [`dsh-evolution-optimizer`](../evolution-optimizer/README.zh.md) —— 写入侧：其暂存写入进入这些回路所操作存储的生产者。

-----

<a id="model-experience"></a>
## 模型体验

无，因为本插件不注册任何面向模型的内容。

#### KV 缓存效果

此处没有任何内容进入模型请求，因此提供方缓存复用不受影响。回路执行的任务可能改变后续请求的内容——被提升的技能、被准入的基准任务——该请求的属主负责其前缀。

## 已知限制与暂缓工作

<a id="known-limitations-and-deferred-work"></a>

这些限制界定了本包不适用的情况。它们是当前的包约束。

- **两个阶梯档位没有可写目标** —— §32 从多样性爬升，经新变异算子、新任务、新评估器，直到切换模型。此处有三个档位会行动。`newOperators` 以**读取**的方式行动：`evolution-operators` 拥有算子组合并提出下一步该试的指令，因此本回路报告该存储为该技能的工件类推荐的指令——而当该存储未挂载、或该类下没有提案时，该轮把此档位记为 `unactionable` 并点名究竟是哪一种。这里不写入组合，因为优化器才是同一份推荐的消费者。另外两个各点名了必须先接受该切换的存储：`newEvaluators` 需要 `evolution-evaluator-strategy` 接受按任务类提出的评估器集合（它只记录判决与真值对），`newModel` 需要 `evolution-model-routes` 接受某个角色的固定切换——配置好的路由不是模型切换，因此不会用它来近似。在这两个存储接受切换之前，`recoveryStep` 将该档位报告为 `unactionable`，而不是让本插件发明一项策略，由拥有该组合或路由表的包来决定它。
- **生成的探针只被记录，从不被执行** —— §45 的另一半是执行：对候选运行探针，并判定它是否暴露了弱点。这需要随包 profile 并未提供存储的运行器与语料，因此本回路记录的每支探针都带 `foundWeakness: false`，判定权留在运维者手中，运维者通过 `/adversary probe` 重新记录该探针并将其标记为已修复。
- **对抗样例需要其能力先成为基准形态** —— `adversary` 回路只有在基准存储已持有点名该能力的任务时，才把探针准入为 §14 评估任务。因此某个全新能力的首次失败只产生探针，不产生任务，直到某份课程提案为该能力创建首个基准任务。
- **八个弱点族中有六个有已记录来源，两个没有** —— 该映射覆盖每一种 §43 不确定性种类（`evaluator-gaming`、`ambiguous-instruction`、`edge-case`、`retrieval-trap`、`contradictory-evidence`）以及策展器的回归债务（`tool-failure`）。`prompt-injection` 由 agent kernel 在会话账本上分类，到不了本回路所读的任何存储——反馈存储聚合的是失败的**工具结果**，因此一次抵达工具的注入在这里读起来就是一次工具失败。`stale-memory` 有写入方（记忆存储清扫衰减工件，图让被取代的声明退役），但两者都无法在宿主范围内读取：它们都是按作用域的记录，且没有任何存储暴露作用域迭代。两者都不会被默认归入其他族：没有可读记录作为根据的弱点不产生探针，这两个族仍由运维者经 `/adversary probe` 记录。
- **不确定性任务文本就是信号注记** —— 没有任何存储为不确定性信号保存生成的任务，因此被准入的基准任务携带的是所观察到的注记，而非合成的提示词。
- **发布证据是暂存三元组** —— 监视器把每个补丁已记录的 pass/tokens/墙钟三元组与在任者的相比，而不是对生产基线做隐藏响应重放。
- **发布仍由人工开启** —— `shadow → canary` 仍是运维者的决策，因此满是 shadow 的存储不会产生自动提升。
- **提升如今需要受保护的留出** —— 风险模型把未被覆盖的能力评为至多 `medium`，因此在基准中没有该技能 `holdout` 任务的宿主上，监视器仍会回滚回归，但把提升留给运维者。这是 §15 的规则而非偶然：基准存储正是留出被记录之处，没有它的宿主就没有可供提升的受保护数据集。
- **阶梯的暴露按能力而非按任务归属** —— 没有任何存储把候选评估绑定到基准任务身份，因此 `ladderAdvance` 读取任务所属能力的已记录暴露，并将其应用到该能力的每个可学习任务。同属一个能力的两个任务会一起推进；而评估历史丰富的能力会把其最新任务提升到 `holdout`，哪怕该任务从未被搜索过。
- **各轮次顺序执行** —— 心跳按注册顺序依次等待每个任务，因此缓慢的存储会拖慢该轮中排在它之后的回路。
- **全宿主范围，非按作用域** —— 每个回路作用于整个宿主；按作用域的发布或迁移策略需要在域上添加作用域键。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>面向维护者的工作上下文——点击展开</summary>

七个回路共用一个包，是因为它们共用一份契约——读取已记录的裁定，经由接受它的存储执行该裁定所许可的步骤——也因为宿主会一并启用它们：七个包意味着在一个已经承载三十行演化配置的 profile 中再加七行。度量层以同样的可选缝模式读取同一批存储，因此本组现在有一个负责读的包、一个负责写的包，以及这个负责行动的包。

决策规则是纯模块而非内联分支，因此规则变更是一次单元测试，而不是一份宿主夹具。`rolloutDecision` 遵循引擎的精英序——先 pass，再计费 token，最后墙钟时间——这与 `evolution-stagnation` 的 `betterThan` 所用优先级相同，因此发布与停滞运行以同一方式评判补丁。`rolloutRisk` 从已记录状态推导 §49 的输入，而不是手写它们；正因如此，风险类别是对决策所用同一三元组、加上基准存储留出覆盖的一次读取。

`growth` 是唯一从证据而非从某个存储正等待其被处置的裁定出发的回路，也因此是唯一有两个阶段的回路：先准入由已记录失败推导出的任务，再推进由已记录暴露挣得的阶梯。它的来源在交付的 profile 中全部是活的——会话失败、curator 债务、候选评估——这与元演化各行所读的三个存储不同，后者在禁用的优化器运行之前一直为空。它完全不读 `evolutionStagnation`，而 `admission` 恰恰以此为门。

`adversary` 的构造与 `growth` 相同、并刻意沿用同一形状：每个已记录来源一个纯映射（`signalProbe`、`debtProbe`），一个映射到存储自身写接口的映射（`probeTask`），并由存储的词表而非本包的词表决定某个弱点属于哪一族。它的两条限制正是 §45 中需要本仓库尚未交付之物的两半——执行运行器，以及老能力中的基准语料——因此运行的是已记录的那一半，README 点名其余部分而不是把它们发明出来。

预算闸门（`underBudget`）位于「规则决定行动」与「规则所指名的存储调用」之间，因此每个回路都用同一份实现强制 §37。它以分配器已经在用的任务类——技能或能力——为键，并且询问 `evolution-budget` 自己的 `withinAllocation`，而不是重新推导算术；这正是该包新增一个 §37 维度时闸门仍然正确的原因。它只对回路设闸：优化器自身的筛选保留其运行内预算检查，本闸门也不改变任何未挂载预算存储的宿主所运行的内容。

`inject = ['evolutionHeartbeat']` 正是让挂载顺序无关紧要的原因：插件等待调度器，而不是在 apply 时读取一次 `ctx.get('evolutionHeartbeat')` 之后再也不复查。存储保持为可选缝，因此宿主可以在它们之前或之后挂载本包。
</details>
