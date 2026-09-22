---
description: "三阶段 dreaming 固化：以六信号加权综合分为已记录的失败打分，并把可溯源、过门限、去重后的叙事提升为按作用域持久化的 dreams（ctx.evolutionDreaming）。"
kind: "package-reference"
---

# @deepseek-ai/dsh-evolution-dreaming

[English](README.md) | 中文

## 概述

把某个作用域反复失败的教训固化为持久记忆，过程分三个仿照睡眠的阶段：Light 对它汇集到的失败与情景笔记按陈述去重，REM 把两者共享的主题写成叙事，Deep 用六信号复合分给候选打分，只接纳证据可溯源且通过全部阈值者。复述该作用域已持有叙事的候选并入其中；更正它的候选让其前任退役；每次提升都保留自己的前像，因此回滚能把它恢复。一条命令或空闲 heartbeat 就能跑完；`/dream <phase>` 单独跑一个阶段用于诊断。权重固定；阈值、节奏与保留量都可配置。提升结果是持久的，但尚未被读回模型上下文：挂载它是为了固化，而不是为了召回。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

把它挂载在反馈存储旁；要自动周期再挂载 heartbeat：

```yaml
- name: '@deepseek-ai/dsh-evolution-feedback'
- name: '@deepseek-ai/dsh-evolution-heartbeat'
- name: '@deepseek-ai/dsh-evolution-dreaming'
  config:
    minScore: 0.65
    minRecallCount: 3
    minUniqueQueries: 2
```

```ts
await ctx.evolutionDreaming.dream(scope, sessionIds)   // light → REM → deep
ctx.evolutionDreaming.read(scope)                      // narratives, promotions, ledger
ctx.evolutionDreaming.promotions(scope)                // only the narratives that still answer
ctx.evolutionDreaming.ledger(scope)                    // the passes a rollback can name
await ctx.evolutionDreaming.rollback(scope, entryId)   // restore what one pass replaced
```

`run(phase, scope, sessionIds, now?)` 运行单个阶段以便诊断；`dream(…)` 运行整个周期；`dreamAll()` 遍历注册表已知的每个工作区，heartbeat 任务调用的正是它。`promotions(scope)` 只回答未被更正退役的叙事，`rollback(scope, entryId)` 恢复账本条目 `entryId` 所替换的那份提升数组。

在提示符处，`/dream` 为当前作用域运行整个周期，`/dream <phase>` 运行单个阶段，二者都作用于该工作区拥有的会话。

### 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `minScore` | `0.65` | 候选被接纳所需达到的综合分 |
| `minRecallCount` | `3` | 候选所需的出现次数 |
| `minUniqueQueries` | `2` | 候选须出现的不同会话数 |
| `staleAfterDays` | `30` | 提升在未被再次观察到的情况下保持持久的天数 |
| `capacityTriggerRatio` | `0.8` | 超过 `maxPromotions` 的这一比例后，幸存者会被裁剪到硬上界 |
| `intervalHours` | `6` | 两次自动周期之间的小时数 |
| `maxNarratives` | `20` | 每个作用域保留的叙事数 |
| `maxPromotions` | `200` | 每个作用域保留的提升数 |
| `maxCandidates` | `500` | 单个周期评分的候选数 |
| `mergeOverlap` | `0.6` | 概念重合度达到此值时，候选复述了该作用域已持有的叙事 |
| `supersedeOverlap` | `0.3` | 更低的重合度门槛，达到此值即更正了同名工具的叙事 |
| `maxRestatements` | `5` | 单条叙事保留的、被并入其中的复述陈述数 |
| `maxLedgerEntries` | `10` | 每个作用域为回滚保留的提升轮数 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-evolution-dreaming)是每个可接受字段的详尽来源。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部——点击展开</summary>

### 六个信号

每个维度在加权之前先归一化到 `0..1`，因此没有任何信号能凭无界的原始计数占据主导：

| 信号 | 权重 | 归一化 |
|---|---|---|
| 相关性 | 0.30 | 与该作用域已持有文本的概念重合度 |
| 频率 | 0.24 | `count / (count + 3)`——在回放闸门处取半 |
| 查询多样性 | 0.15 | `sessions / (sessions + 2)`——在多样性闸门处取半 |
| 新近度 | 0.15 | 自最后观察起每 30 天减半 |
| 整合度 | 0.10 | 首次与最后观察之间的天数，一周即满 |
| 概念丰富度 | 0.06 | 不同词数，十二个即满 |

### 哪些证据可以提升

一个候选的观察来自两个来源，而其中只有一个能为它作保：

- **可溯源**——feedback 接缝对失败 `tool/result` 事件的聚合。调用及其结果被交付时harness 亲眼观察到了，因此记录下来的消息带着工具名与其所在会话，证据本身说明了出处。
- **不可溯源**——记忆存储日常日志中的情景笔记。该层只记录笔记文本、日期与时刻，没有任何能标识作者的字段：模型抽取、用户本人与系统提示读起来完全一样。仅靠这类观察的候选会被按名拒绝（`unattributed-provenance`），无论它得多少分，因为存储既不记录文本来源，就没有任何闸门能为它作保。

只要有一条被观察到的观察，就为它所并入的候选作保：因此复述某条已记录失败的情景笔记只会为那条失败增加证据，永远不能单凭自身获得提升。闸门的判定是一条纯规则，其输入会被记录在案：每条被接纳的叙事保留闸门所判定的来源与计数，每一轮报告它还按具名闸门拒绝了哪些候选。

### 合并与取代

叙事的身份就是它规范化后的陈述，而陈述永不改变：更正后的陈述是第二条叙事，而不是一次原地改写。通过闸门的候选会与该作用域仍会作答的叙事相比——且只与同名工具的叙事相比，因为工具不同的两次失败无论措辞多像都是两个主题。由概念重合度——也就是相关性信号所读的同一套词面度量——决定它属于哪一种：

- 达到或超过 `mergeOverlap` 即认为它在复述该叙事，因此并入其中，被保留的措辞会列在该叙事上——持久记录不收集近似重复，而规范陈述、其提升时刻与证据都原位不动；
- 落在 `supersedeOverlap` 与 `mergeOverlap` 之间即认为它在更正该叙事：一条新叙事开始作答，前任被标记上取代它的叙事身份与时刻。前任保留自己的位置与证据，但不再回答任何查询，这正是声明图里已退役声明的行为。

记录本就作答的身份——规范陈述本身，或它已并入的某个措辞——则无需写入。每个候选都与同一轮已写入的叙事相比对，因此同时到达的两条复述只会产生一条叙事。

### 阶段分离

只有 deep 阶段写入持久记忆。light 与 REM 可以单独运行以供检视，而不改变该作用域已学到的东西；自动周期按顺序运行三个阶段。情景笔记在记忆保留窗口内会反复进入 light，因此笔记带着衰减后的新鲜度被重新打分，而不是被记作「已消费」。提升存放在本插件自己的域中，绝不写入由模型拥有的经验文档，因此不会出现两个写入方争用同一份文档。

### 账本与回滚

每一轮改变了提升集合的遍历都会写一条账本条目，条目同时持有这一轮替换掉的那份提升数组作为前像，以及它装入的内容。记录本身就是自己的 blob 存储，因此前像不可能在写入与读取它的回滚之间丢失；条目的 evidence 记录这一轮做了什么——新增、并入、退役、丢弃——以供审计。`rollback(scope, entryId)` 在写入任何东西之前先对未知身份大声失败，随后原样恢复前像，并把自身也记入账本，使回滚与被它撤销的那一轮同样可逆。账本由 `maxLedgerEntries` 限定，保留最新的若干条，因此长寿命作用域拥有的是一段回滚窗口，而不是它跑过的每一轮。

### 失败与恢复

无效记录让域打开时大声失败：丢失一条提升会让下一个周期悄悄重新提供同一个已固化的候选。缺失反馈或记忆接缝只会削弱对应阶段，而不会让周期失败；缺失 heartbeat 仅意味着没有自动计划。不发布 invariant 伴生包，因为域表是这份状态的唯一副本。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [`dsh-evolution-feedback`](../evolution-feedback/README.zh.md)——本周期所消费的已记录失败。
- [`dsh-evolution-heartbeat`](../evolution-heartbeat/README.zh.md)——驱动它的空闲触发调度器。
- [`dsh-evolution-curator`](../evolution-curator/README.zh.md)——本包所遵循的账本与回滚形态。
- [演进式 Harness 子系统](../../../docs/subsystems/evolutionary-harness.zh.md)——自学家族背后的行为契约。

-----

<a id="model-experience"></a>
## 模型体验

无：本周期不添加任何内容——它只对反馈接缝已记录的观察打分、设门、并入、退役并记账，其产出尚未进入任何提示词段落、工具模式或请求。提升路径上的任何规则都不调用模型。

#### KV Cache 影响

无：本周期不发起任何模型调用，因此不会使 provider 缓存复用失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **读取一半被延期**——没有任何东西把已提升的 dream 注入模型上下文。唯一把作用域记忆送到模型面前的消费方是 `dsh-evolution-memory-context`：它在自己的字节预算与摘要契约下，用记忆存储的若干精修家族拼出简报，而 dream 不属于这些家族——把它接进去会改变另一个包的提示面，并且被注入的文本需要一条可记录在日志里的会话事件。在它落地之前，`promotions(scope)` 就是消费方会调用的作答接缝，而它返回的陈述复述的是对话记录与经验家族本就携带的失败。
- **关系规则基于词面**——复述与更正都由共词判定，因此没有共享词汇的转述会被当作新叙事，而借用原陈述措辞的更正可能被并入。嵌入提供方，或由写入方声明的关系，才能把两者都判准。
- **相关性基于词面**——该信号按词比较概念。经嵌入提供方做语义比较，才能更严格地排序措辞不同的候选。
- **并入保留规范陈述而非更佳的措辞**——先提升的那条叙事为所有并入它的复述作答，即便后来的措辞把这次失败描述得更好。
- **并入不会重置衰减时钟**——`staleAfterDays` 从提升时刻起算，因此一条比窗口更旧的叙事可能并入一条复述，又在同一轮被丢弃。沉寂很久之后的合并，更可靠的做法是让失败重新进入暂存，从而提升出一条新叙事。
- **heartbeat 节奏按部署固定**——同一个 `intervalHours` 适用于所有作用域。
- **仅存于本机**——dreams 位于 `$DSH_HOME` 之下，绝不写入项目目录。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>面向维护者的工作上下文——点击展开</summary>

该服务渲染在「演进式 Harness」子系统页与 capability-seams 图上，并可由 `dsh-command-evolution` 中的 `/dream` 命令触达。

</details>
