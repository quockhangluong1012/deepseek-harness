---
description: "Durable per-skill use/view/patch telemetry with a creation record, pin, and lifecycle state (ctx.evolutionSkillTelemetry), for hosts curating skills during use."
kind: "package-reference"
---

# @deepseek-ai/dsh-evolution-skill-telemetry

[English](README.md) | 中文

## 概述

`dsh-evolution-skill-telemetry` 拥有技能整理背后的持久化按技能计数器：成功的模型加载、人工查看与管理变更，以及创建来源、置顶、生命周期状态、有证据支撑的信任、正文修订链，以及由已判定任务结果推出的 §40 效用读数。Host 同步读取、并通过显式标记修改；被动 `tools/post-execute` 观察器统计成功的 `skill` 工具加载，而 bundled 与 hub 技能被排除在一切写入之外。它还把重复产出的输出计为技能创建证据，并在合并规模运行扇出之前记录其成本。当整理工作（过期判断、合并、删除）应基于观测到的使用与结果而非猜测时，选择本包。

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

当技能整理需要持久化的使用证据时挂载本插件。记录以技能名作键；缺席记录读作 `undefined`，在首次标记时播种。读取从已校验的内存同步进行，并返回脱离副本。`markUsed`、`markViewed`、`markFailed` 与 `markPatched` 对随包附带与 `hub*` 来源直接返回 `undefined` 而不写入。`markAgentCreated` 记录模型作者身份——模型经由 `skill_manage` 写出该技能，之后以 `/curator adopt` 为其背书——已同时具备这两项事实时直接返回而不写入。`markAdopted` 把一个由模型写出的技能认领为用户主导，不重置时钟；缺席记录与无模型作者身份一律拒绝。`recordTrustObservation(name, outcome, sessionId, failure?)` 记录一次信任观测：带归因的失败会降级该技能并重设锚点；成功只在其会话比该锚点更新、且尚未计入时才计数。无论哪种结果，该会话的已判定结果都会存入记录，而 `utility(name)` 读取由这些结果推出的 §40 效用记录。`markRevised(name, content)` 对给定的正文求哈希并推进修订链；同样的字节再来一次是空操作。`drop` 遗忘一条记录，并报告是否删有所获。`setPinned` 置顶或取消置顶；置顶阻止自动流转与受管删除，但永不阻止补丁。`setState` 将一个技能推进 `active`、`stale` 与 `archived`：进入时盖上 `archivedAt`、离开时清除，`absorbedInto` 命名合并归属。一次成功的 `skill` 工具加载经 `markUsed` 计数并盖上 `lastOutcome: 'ok'`；一次失败的加载经 `markFailed` 计数，累加 `failureCount` 并盖上 `lastOutcome: 'failed'`。消费者按 `failureCount / (useCount + failureCount)` 计算失败率。

除计数器之外还有两个接口。`skillCreationEvidence(paths)` 统计重复产出的输出，按规范化路径分组（大小写折叠、`/` 与 `\` 等价、忽略结尾分隔符），在第三次重复时触发——这正是提议创建技能的被计数触发器；它从不读取或引用文件内容，也不采用任何供应方报告的重复数字。`skillProposalMergeKey(paths)` 以同样的规范化、按与顺序无关的方式为触发的路径构建候选合并键，因此在提案待定期间再次暂存只会推高其重复计数，而不会产生重复条目。`recordConsolidationCost(row)` 存储合并规模运行在其扇出之前记录的 `{ inputBytes, maxOutputTokens, provider, model, truncated }` 行，`readConsolidationCost()` 返回最新行的脱离副本，未记录任何行时返回 `undefined`。

### 生命周期状态

技能的 `state` 依次经历 `active → suspect → stale → archived`。`suspect` 正是 §22 要求的证据档位：当已记录的证据——失败尖峰、更新的冲突证据、实测效用偏低，或依赖版本变化——对技能提出质疑时，整理器的一趟会把技能移入该状态；而把技能从 `suspect` 移到 `stale` 的是闲置时长。进入 `suspect` 会盖上 `suspectAt` 时间戳，离开则会清除它，因此"复活"是相对提出质疑的那一刻来判定的，而不是相对任何更早的一次干净加载。`archivedAt` 同理。在该成员存在之前写下的记录不带 `state`，会以 `active` 打开。

### 信任与修订

信任取 `provisional` 或 `trusted`，由相互独立的观测而非流逝的时间推出。记录初始为 `trusted`，因为此时尚无对其不利的证据；只有模型写出的产物（`markAgentCreated`）或刚被编辑的产物（`markPatched`、`markRevised`）才把它降为 `provisional`，同时清空已计入的会话，并以当时见过的最新会话重新锚定。此后若有 `trustPromotionSessions` 个更新的会话，便重新升为 `trusted`。`trustFailures` 统计由证据导致的降级次数，`lastTrustFailure` 保存最近一次失败的 `mergeKey`/`message`/`at`。

修订链是线性的，以技能名为键：`revision` 从 0 起，`contentSha` 是当前 SKILL.md 正文的 sha256 十六进制值，`parentRevisionSha` 是其被替换掉的那一版的哈希。每一次经由 `markRevised` 的正文变更还会在持久化版本注册表中提交一行，`versions(name)` 按从旧到新列出已提交的修订——修订号、该修订提交的正文哈希、其替换的父哈希，以及记录时刻——因此无需重读文件即可查询谱系。同样的字节再来一次，对记录与注册表都是空操作；`drop` 连同记录一起清除历史；被排除的来源不保留任何行。

### 技能效用

§40 以最终价值来评判一个技能，而本存储保留它所能保留的证据：规范中的 `uses` 即加载计数器，`assisted_tasks` 即结果已被判定的会话数，`successful_tasks` 即其中没有可归因失败的会话数，`cost_overhead` 即 `uses / successful_tasks`——每次成功所花费的已记录加载数，绝不是估计值。

规范中的 `incremental_gain` 把技能与"不使用技能的基线"相比，而本框架不记录任何未使用技能的运行：这里的每个计数器都属于一个加载了技能的会话。因此 `incrementalGain` 是**库内相对成功优势**——该技能的干净结果占比减去其他已跟踪技能合并后的干净结果占比——它回答的是"这个技能是否优于库中其他技能"，而不是"它是否优于不用技能"。当任一侧占比缺失（没有已判定任务，或没有同样具备判定结果的同侪）时取 `null`；当没有任何已判定任务成功时 `costOverhead` 取 `null`。按会话的结果证据与信任一样，在正文变化时清空，因此被改写的正文绝不会被记上旧正文的成绩。

### 会话关联

`markUsed(name, source, sessionId)` 与 `markFailed(name, source, sessionId)` 会在计数器旁记下发起加载的会话——最新在前、去重，并以 `maxSessionIds` 为上界。加载失败也算该技能在发挥作用，因此只曾加载失败过的会话仍与该技能相关联。被动观察器会带上它所运行的会话，因此关联无需额外接线。正因如此，消费者才能取出某技能在发挥作用期间所记录的失败，而那正是合并裁决据以反思的证据。查看与变更不记录会话。

### 配置

两个字段都是可在 `cordis.yml` 中修改的、经过校验的 `Config` 成员。

```yaml
- name: '@deepseek-ai/dsh-evolution-skill-telemetry'
  config:
    maxSessionIds: 20
    trustPromotionSessions: 3
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `maxSessionIds` | `20` | 每个技能为失败关联保留的会话数，最新在前 |
| `trustPromotionSessions` | `2` | 把临时状态技能升为可信所需的独立成功观测数 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-evolution-skill-telemetry)是每个可接受字段的详尽来源。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部——点击展开</summary>

### 设计概念

存储域 `evolution_skill_usage`（版本 `2`、布局 `per-record`、表 `records`）中每个技能名一条持久记录；以版本 `1` 写下的记录可直接打开，因为此后新增的字段都带默认值。来源排除是与 manage 包经由 `isExcludedSkillSource` 共享的写入时决策：随包技能随产品发布，hub 技能来自共享，因此二者都不属于本地整理。观察器先委托工具链、再计数，因此遥测永不改变加载结果；技能提供方失败时回退到 `custom` 来源，而不是丢失计数。

### 源码导览

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`EvolutionSkillTelemetry` 服务、标记、会话关联与 `tools/post-execute` 观察器 |
| [`src/utility.ts`](src/utility.ts) | 纯 §40 效用推导：uses、assisted 与 successful 任务数、库内相对优势、每次成功的已记录成本 |
| [`src/spec.ts`](src/spec.ts) | 域声明：记录模式与 `defineDomain` 规范 |
| [`src/types.ts`](src/types.ts) | 公共 `SkillUsageRecord`、生命周期状态、来源、信任状态与失败、按会话结果、重复输出证据与合并成本行类型 |

### 失败与恢复

失败的写入向调用方传播，观察器内部除外——它只记日志并保留工具结果。标记在首次触碰时播种记录，无变化时直接返回而不写入。存储启动前 `read` 与 `entries` 抛错；其余方法同样需要已打开的表。

不发布 invariant 伴生包，因为域表是该状态的唯一副本，不存在第二个可供核对的独立观测。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [演进式 Harness 子系统](../../../docs/subsystems/evolutionary-harness.zh.md)——本包实现的行为契约。
- [skill 包导览](../README.zh.md)——本分组的软件包及其仓库位置。

-----

<a id="model-experience"></a>
## 模型体验

通过 `@deepseek-ai/dsh-evolution-skill-manage` 间接呈现，其 `skill_manage` 工具在此报告每次变更，并拒绝删除被置顶的技能。

#### KV Cache 影响

与实时请求独立：本包永不触碰请求前缀，因此不会使 provider 缓存复用失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制界定了本遥测不适用的场景。它们是当前包约束。

- **仅限本机**——记录位于 `$DSH_HOME` 之下，永不写入项目目录内。
- **只统计流入的计数**——`skill_manage` 之外的直接文件编辑与 `skill` 工具之外的加载永不到达计数器。
- **关联有界且仅限加载**——每个技能只保留最近 `maxSessionIds` 个会话，且只有 `skill` 工具的加载会参与；查看与变更不记录会话。
- **随包与 hub 技能不可见**——被排除的来源永不播种记录，因此整理只能看到本地拥有的技能。
- **信任随消费者的节拍推进**——整理器每趟记录一次观测，因此升级需要彼此独立的会话，而不是同一会话内的反复回合。
- **信任只被记录，不被强制**——该状态会进入观测与状态行，但不会左右技能对模型是否可见。
- **效用缺少无技能对照组**——`incrementalGain` 把技能与库中其他已跟踪技能相比，因为没有任何记录保存"任务在完全不加载技能时会得多少分"；真正的 §40 `incremental_gain` 需要那一对照组，而本框架中没有任何存储具备它。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>面向维护者的工作上下文——点击展开</summary>

无。

</details>
