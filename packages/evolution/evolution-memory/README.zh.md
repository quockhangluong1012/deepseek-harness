---
description: "Durable per-scope evolution memory record with lesson artifacts, profile writes, staged writes, capacity accounting and decay (ctx.evolutionMemory), for hosts composing the self-learning harness."
kind: "package-reference"
---

# @deepseek-ai/dsh-evolution-memory

[English](README.md) | 中文

## 概述

`dsh-evolution-memory` 拥有演进记忆背后的持久化按作用域文档：用户编写的指令、模型维护并带来源记录与分族时间戳的经验工件与用户画像文档、附加的文本与文件上下文条目、产出文件索引、支撑 §23 相关性反馈回路的召回台账、等待审批的暂存写入，以及按最新优先排列的已决暂存条目日志。Host 同步读取，并通过带上限的写入进行修改；评审器与注入器包消费它。当同一作用域中的每个会话都应继承可在使用中不断改进的共享知识、且不向项目内写入时，选择本包。

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

当同一作用域中的会话应共享指令、经验工件、画像与上下文时挂载本插件。作用域标识是以 `EvolutionScopeId` 构造的不透明 `profile:workspaceId`（或 `profile:global`）键。JSON 后端经由 `storageKey()` 将每个作用域存于 `evolution_memory/records/<profile>--<workspaceId>.json`，因为 `:` 不是路径安全字符。读取从已校验的内存同步进行；写入在进入写入链之前强制执行字节上限，并盖上 `updatedAt`。

### 配置

`capacityBytes` 为必填：部署方必须选定一个作用域每次请求可承担的成本。其余字段都是可通过 `cordis.yml` 修改的、经过校验的 `Config` 成员。

```yaml
- name: '@deepseek-ai/dsh-evolution-memory'
  config:
    capacityBytes: 131072
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `capacityBytes` | 必填 | 容量条分母与存储字节硬上限 |
| `maxAgentBytes` | `65536` | 针对工件而非文档的上限：`agentLessons` 序列化后的字节总和 |
| `maxUserBytes` | `32768` | 用户画像文档上限 |
| `maxContextItemBytes` | `262144` | 单条目上限，同时是文件条目观测大小的上确界 |
| `maxContextItems` | `50` | 条目数量上限 |
| `maxOutputs` | `200` | 产出文件索引规模 |
| `maxResolutions` | `200` | 每个作用域保留的已决暂存条目数 |
| `maxRecalls` | `50` | 每个作用域召回台账中保留的召回数，保留最新的 |
| `mergeSimilarityFloor` | `0.87` | 与既有工件的相似度达到该值才值得合并，而不是另行存储 |
| `maintenanceIntervalHours` | `24` | 两次维护扫描每个已存作用域之间的小时数 |
| `refutationFloor` | `3` | 反驳数达到该值后，衰退无论存续时长都会剪除该工件 |
| `defaultTtlDays` | `30` | 候选未自带 ttl 时，新工件被赋予的 ttl 天数 |
| `episodicRetentionDays` | `7` | 情景笔记落地后可读的天数；追加路径会丢弃更早的笔记 |
| `maxEpisodicEntries` | `100` | 每个作用域在年龄裁剪之后保留的情景笔记数，保留最新的 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-evolution-memory)是每个可接受字段的详尽来源。

### 容量与摘要

容量为 `instructions` 加 `userProfile` 的 UTF-8 字节长度，再加各上下文条目大小之和，再加序列化后的工件数组——逐个工件计量，因为 JSON 数组不是 `Buffer.byteLength` 能整体度量的字符串——再加情景笔记的文本。产出索引与暂存写入不计入。摘要仅覆盖指令、经验、画像与上下文条目；产出、暂存、情景笔记与时间戳永不使已注入的简报失效：简报渲染的是已审定的快照，未经审定的固化原材料不得让一份完全相同的简报重新注入。缺席记录读作 `undefined`、占用零字节、摘要为 `'empty'`。

### 经验工件

一个工件就是一条持久化的提炼事实：`statement`、`source`（会话 id，或手工暂存条目的标签）、`conditions`、`evidence`（`fact` | `observation` | `inference`）、`[0, 1]` 区间内的 `confidence`、`validationCount`、`refutationCount`、`scope`（`user` | `project` | `global`）、可选的 `ttlDays`，以及 `createdAt` / `updatedAt` 时刻。

工件的身份就是其规范化后的 statement——转小写、内部空白折叠、首尾去空——该身份即是所有操作寻址的 `id`。同一记录内身份两两不同，因此 `addArtifact`、`updateArtifact` 与 `removeArtifact` 各自恰好命名一个工件，且这一命名在每次写入后都不变：身份、计数与时刻由存储赋予，永不来自调用方或模型。`updateArtifact` 只修补 `conditions`、`confidence`、`evidence` 与 `ttlDays`；statement 变了就是另一条事实，因此它以一次 remove 加一次 add 表达，而不是一次 patch。`validationCount` 与 `refutationCount` 只经决策批次移动——没有其他操作会触碰它们。

`addArtifact` 接收候选与合并策略（默认 `keep_both`），是唯一一种可以成功却不存储任何内容的操作：在 `keep_both` 下，若候选身份已存在，调用直接返回原记录，不进入写入链，也不盖任何分族时间戳。在 `overwrite` 或 `merge` 下，候选折入它匹配到的工件——先按身份匹配，否则匹配相似度达到 `mergeSimilarityFloor` 的最相似工件，相似度经由可选的 `ctx.embeddings` seam 度量。`merge` 合并两者的 `conditions` 并取较高置信度；`overwrite` 用候选的内容替换工件内容。两种情况中被匹配工件都保留其 id、statement、计数与创建时刻，只有 `updatedAt` 变化。没有 embeddings 服务时什么也不度量，因此只有完全相同的身份才能匹配，同义改写会另存为一个独立工件：改写检测能力降级，写入永不失败。

`replaceArtifacts` 是整表写入，而非兼容垫片：控制面的 `setLessons` Remote 调用以一次写入替换作用域的全部工件。每个候选都会被校验并获得全新的身份、计数与时刻，因此重复身份的列表会被拒绝而不是去重，且传入的列表成为整个数组——调用方省略的工件会被丢弃。

### 决策批次

`applyExtractionDecisions(id, decisions, extraction?)` 是评审器每次提取调用的一次写入，也是唯一移动那两个计数的路径。一批决策由 `LessonDecision` 条目组成：`confirms` 让所寻址工件的 `validationCount` 加一，`contradicts` 让其 `refutationCount` 加一，并替换该决策携带的 statement 与 confidence，`new` 则经与 `addArtifact` 相同的按义合并路径添加一个工件候选——因此一条只是重述已存工件的事实不会被另存在它旁边。更正保留工件的 `id`、`createdAt`、`validationCount` 以及该决策未提供的每一个字段，因此被更正的事实保留其血统与调用方寻址它所用的身份。

决策按提取报告它们的顺序折入，在写入时读到的记录之上，因此每条都作用于此前各条产生的结果。`confirms` 或 `contradicts` 若命名了记录已不再持有的工件，会被跳过而不是拒绝——该目标是在更早一次读取上解析的，其间可能发生一次剪除——批次其余部分照常应用。整批就是一次写入：它盖一次 `lessonsUpdatedAt`，没有任何改动的批次（空批次，或各条决策都被跳过的批次）一个分族时间戳都不盖，而一次什么都没找到的调用的来源仍会记录在 `lastExtraction` 上。

带有来源的批次在写入持久化之后还会被发布为一个 `evolution/decisions-applied` 事件，携带作用域、来源会话、决策，以及该作用域在写入*之前*的工件。派生状态的消费者把它折入自己的状态——图谱的声明层就是随包提供的那一个——而写入前的工件正是使其可行的原因：`contradicts` 决策替换 statement 时保留工件的 `id`，因此"一次更正所更正的那个陈述"只在写入之前可见。该事件把每条决策都归因到报告它的会话，因此没有来源就被应用的批次完全不会被发布：无法归因的证据比没有证据更糟。经暂存的 `applyDecisions` 审批以该条目的 `originSessionId` 发布。监听者既不会拖慢写入、也无法让写入失败：批次此时已经存好，因此抛出异常的监听者只会被记录并隔离，与 `domain/changed` 的观察者完全一致。

### 暂存写入与决策

`stageWrite` 暂存一条记忆或技能提案而不触碰容量。记忆类暂存载荷指明其操作：`setInstructions`、`setUserProfile` 与 `appendEpisodic` 携带 `{ text }`，`addArtifact` 携带 `{ candidate, strategy }`，`updateArtifact` 携带 `{ id, patch }`，`removeArtifact` 携带 `{ id }`，`replaceArtifacts` 携带 `{ candidates }`，`applyDecisions` 携带 `{ decisions, extraction? }`。`approveStaged` 先应用记忆操作（上限拒绝、或所寻址的工件不存在时保留条目），仅移除技能条目；`rejectStaged` 直接丢弃任一条目。审批一批 `applyDecisions` 会在审批时读到的记录上原子地应用整批，并在那时解析每个 `new` 候选的合并目标——与 `addArtifact` 的暂存路径相同的「先度量、再复核」拆分，而绝非暂存时拍下的快照。

暂存载荷是一个 JSON 值，并在写入边界处校验：无法无损往返 JSON 的载荷会被大声拒绝，且不存储任何内容。

暂存条目同时也是被记住的候选：它携带可空的 `mergeKey`、从 1 开始的 `recurrence` 计数、可空的 `blockedReason`，以及 `neededEvidence` 列表。`stageWrite` 接受可选的 `mergeKey`；在同一 scope 内，若已有待定条目携带相同的键，再次暂存会把该条目的 `recurrence` 加一，而不是追加重复条目，因此被反复提出的候选会被记住，而不是被悄悄重试。`blockStaged` 给待定条目标记原因与可将其解禁的证据，条目保持待定；审批或拒绝会通过移除条目来清除阻塞标记。

`create` 提案在审批前还需要一份捕获契约（capture contract）：`capability`、`procedureRefs`、`validationRefs`、`validationSummary` 与 `limitations`，且验证引用必须独立于程序引用——二者不相交。对缺少有效契约的**新建**提案调用 `approveStaged` 时，条目会留在暂存，其 `blockedReason` 为 `'capture-contract'`、`neededEvidence` 列出缺失的证据，并以 `evolution/staged-blocked` 拒绝。`patch` 不受此门约束：它修订的是目录已经准入的能力，而支持它的度量——基线与候选的对比——留在提案方手中，本存储读不到。`supplyStagedContract` 给待定的新建提案附加一份完全有效的契约并解除阻塞；条目仍需一次显式审批。评审器用产出路径派生的合并键暂存技能提案，因此在准入证据尚未补齐时，重复提案只会推高重复计数。

两种决策都会把一条决策记录——条目 id、kind、op、gist、决策、来源会话、时刻、合并键与重复计数——追加到记录的 `resolutions` 日志（最新优先，受 `maxResolutions` 限制）。决策记录既不计入容量，也不进入摘要，因此决定一次写入永不重新注入简报。

每个记忆族各自盖自己的时间戳：`setInstructions` 盖 `instructionsUpdatedAt`，`addArtifact` / `updateArtifact` / `removeArtifact` / `replaceArtifacts` / `applyDecisions` 这一族盖 `lessonsUpdatedAt`，`setUserProfile` 盖 `profileUpdatedAt`。暂存审批只为它改动的族盖章，因此不存储任何内容的经验追加或决策批次一个都不盖。`appendEpisodic` 不盖任何族：情景笔记是未经审批的固化输入，不是已审定的文档。`memoryUpdatedAt` 再保留一个版本，取经验与画像两个时间戳中的较晚者。每次被接受的写入都盖上 `updatedAt`。

### 召回台账

被召回的上下文材料——评审器的排序召回——就是普通的上下文条目，其标签以导出的 `RECALL_LABEL_PREFIX` 开头，因此摘要覆盖它，简报也最先丢弃它。同一个标签也是 §23 的 `retrieved` 环节：`addContextItem` 从标签中读出被召回记忆的身份，并向该作用域的召回台账追加一行——`recalls`，最新在前，受 `maxRecalls` 限制——每行携带它落地时对应的条目及其时刻。

另外两个环节由档案本就会写入的内容记录下来。带来源信息落地的决策批次——`applyExtractionDecisions(id, decisions, extraction)`——会把所有仍在等待决策的召回绑定到该批次，记下它的会话与时刻：该批次就是被召回材料在场上时的那次已记录决策。`recordRecallOutcome(id, recalledId, outcome, at?)` 把会话的分级结果记到该记忆最新一条仍在等待结果的召回上，若该记忆没有这样的召回则大声拒绝，因此在某个结果被记录之后再次被召回的记忆，会在它更新的那条召回上再次被分级。

§23 还有两个环节完全没有记录，台账也从不臆测它们：没有任何东西观测被注入的条目是否真的被**使用**，也没有任何东西标记某条被**引用**。`recalls()` 返回全部已记录行及其落地的作用域，`recallUtility()` 据此推导出 §24 的读数：`相关性 × 决策影响 × 结果增益`，其中相关性是该记忆已记录召回上的 `n / (n + 1)`——与知识图信念所用的同一饱和函数，因此没有任何记忆能仅凭检索触顶——决策影响是其中有已记录批次跟随的召回占比，结果增益是被分级为 `ok` 的召回占比。§24 的第四个因子**来源质量**，对于被召回的记忆没有任何记录来源，因此该乘积携带三个因子，而不是编造出来的第四个。

移除上下文条目不会移除召回：召回已经发生，把该条目从简报中丢掉并不等于没有检索过它。

### 情景笔记

记录在已审定各族之外的第三层是情景日志：按追加顺序排列的原始会话笔记，每条携带其 UTC 自然日。审批把笔记原文追加，随后做剪除——先丢弃超出 `episodicRetentionDays` 的，再丢弃超出 `maxEpisodicEntries` 的最旧者——因此这一层始终是短命的固化材料，而不是第二份经验文档。空白笔记会被拒绝，条目留在暂存。Dreaming 的 light 阶段把存活的笔记与 feedback 观察一起读作固化候选：一条笔记就是一次目击，不同自然日的目击就是 deep 阶段门限所要求的独立语境，而复述某条已记录失败的笔记会并入该失败的候选。笔记永不进入模型简报——简报是已审批的快照——但其文本计入容量。

### 衰退与维护

`sweep` 丢弃每一个被衰退判定的工件：`refutationCount` 达到 `refutationFloor` 的，或 `ttlDays` 自其 `updatedAt` 起已经过期的——该时刻是最后一次校验、反驳或编辑，永不来自读取或渲染出的简报。没有 `ttlDays` 的工件永远不会因存续时长过期，因此只有反驳下限能剪除它；未自带该值的候选在被存储接纳时会获得 `defaultTtlDays`，所以经普通路径写入的每个工件都带有 ttl。扫描只整件丢弃，永不编辑或截断某个工件，且无可丢弃时根本不进入写入链，既不移动 `updatedAt` 也不移动分族时间戳。

挂载 `ctx.evolutionHeartbeat` 时，存储注册 `evolution-memory-maintenance` 任务，每 `maintenanceIntervalHours` 小时扫描每个已存作用域；没有挂载时存储行为不变，由调用方自行驱动 `sweep`。`sweep` 报告 `pruned` 与 `refined`；`refined` 恒为 `0`——没有任何东西拆分迁移来的文档被接纳成的那一个粗粒度工件，因为提取是在它读到的工件旁边写入新工件，而不是精化它们；在那之前该粗粒度工件是正确且永久的兜底形态。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部——点击展开</summary>

### 设计概念

存储域 `evolution_memory`（版本 `2`、布局 `per-record`、表 `records`）中每个作用域一条持久记录，以 `EvolutionScopeId` 为键。版本 `2` 声明 `compatibleVersions: [1]`，因为按记录存储的后端会把版本戳不在接受集合内的文档读作缺席记录：单纯升版会让每个既有作用域被静默清空，而不是大声失败。指令是用户编写的，不是可丢弃的派生数据，因此本域有意不声明 `invalidRecords` 策略，未通过 schema 的记录仍然让域打开大声失败。记录 schema 接受 `agentLessons` 为版本 1 的 markdown 字符串或工件数组：旧字符串被接纳为一个粗粒度工件——`statement` 即该文档、`source: 'migration-pending'`、`evidence: 'inference'`、`confidence: 0.5`、`scope: 'project'`、两个计数均为 `0`、时刻为 epoch、无 ttl——因此旧记录能同步打开并读取，其首次写入盖上版本 `2`。没有全局槽，也没有可运行的迁移钩子：域设施不提供，且 `read()` 是同步的。

### 源码导览

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`EvolutionMemoryStore` 服务、上限、写入路径、暂存审批、维护注册与扫描 |
| [`src/capture-contract.ts`](src/capture-contract.ts) | 技能准入门：`CaptureContract` 校验及其 JSON 物化 |
| [`src/spec.ts`](src/spec.ts) | 域声明：记录模式、旧文档接纳与 `defineDomain` 规范 |
| [`src/types.ts`](src/types.ts) | 公共记录、上下文条目、产出、来源与暂存写入类型 |
| [`src/lesson-artifact.ts`](src/lesson-artifact.ts) | 工件类型与 schema、statement 身份，以及旧经验文档的接纳 |
| [`src/decisions.ts`](src/decisions.ts) | 决策词汇，以及作用于记录之上的纯 confirm/contradict/new 折入 |
| [`src/merge.ts`](src/merge.ts) | 余弦相似度、合并策略与合并目标选择 |
| [`src/recall.ts`](src/recall.ts) | 召回标签读取、台账折叠，以及纯 §24 效用推导 |
| [`src/maintenance.ts`](src/maintenance.ts) | 衰退判定与单次扫描结果的结构 |
| [`src/digest.ts`](src/digest.ts) | 摘要、容量、字节长度与裁剪助手 |

### 失败与恢复

被拒绝的写入永不改变记录。`addContextItem` 在超过条目数量或容量时以 `evolution/capacity-exceeded` 拒绝，任何字节已放不下的写入也以同样方式拒绝。序列化后的工件数组超过 `maxAgentBytes` 时则以 `evolution/too-large` 拒绝，并指明字段、观测字节与上限。`updateArtifact` 与 `removeArtifact` 遇到未知身份以 `evolution/item-not-found` 拒绝，暂存操作寻址缺失工件时同样如此。重复身份的候选列表与规范化后为空字符串的 statement 都被当作编程错误大声拒绝，且在任何持久化之前：前者无法区分两个工件，后者会持久化一个被工件 schema 拒绝的记录，而该域的下一次打开会拒绝整个存储。未知暂存 id 在审批与驳回时均以 `evolution/staged-not-found` 报告。`recordOutputs` 在列表无变化时直接返回而不写入，因此幂等的回合不会产生 `domain/changed` 抖动。

不发布 invariant 伴生包，因为域表是该状态的唯一副本，不存在第二个可供核对的独立观测。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [演进式 Harness 子系统](../../../docs/subsystems/evolutionary-harness.zh.md)——本包实现的行为契约。
- [evolution 包导览](../README.zh.md)——本分组的软件包及其仓库位置。
- [`dsh-evolution-graph`](../evolution-graph/README.zh.md)——本包决策批次的声明/证据消费者。
- [生成的配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-evolution-memory)——每个可接受的配置字段。

-----

<a id="model-experience"></a>
## 模型体验

通过 `@deepseek-ai/dsh-evolution-memory-context` 间接呈现，由它把存储的指令、经验工件、画像与上下文渲染进注入的简报。

#### KV Cache 影响

与实时请求独立：本包永不触碰请求前缀，因此不会使 provider 缓存复用失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制界定了本存储不适用的场景。它们是当前包约束。

- **仅限本机**——记录位于 `$DSH_HOME` 之下，永不写入项目目录内。
- **同义改写合并依赖 embeddings**——候选匹配所用的相似度来自可选的 `ctx.embeddings` seam；没有它时只有规范化后完全相同的 statement 才能匹配，改写过措辞的重复项会另存为一个独立工件。
- **迁移来的工件保持粗粒度**——旧经验文档打开时是一个覆盖整份文本的工件，目前还没有任何一趟流程拆分它；提取把决策折入它读到的工件，因此迁移来的作用域在简报里保留那一条很长的工件行，而新工件是加在它旁边，不是取代它。
- **衰退由写入与反驳驱动**——工件在最后一次触达它的写入之后 `defaultTtlDays` 天被剪除，使用工件从不计入，因此一条再无人讨论的事实即使仍然为真也会衰退。决策批次写入的计数正是作用域自身回合所提供的：`confirms` 刷新工件的 `updatedAt`，`contradicts` 计入 `refutationFloor`，而提取的相关性窗口从未向模型展示的工件两者都得不到。迁移来的粗粒度工件完全不携带 ttl，因为接纳时不会赋予该值，因此只有反驳下限可能剪除它。
- **文件大小是快照**——磁盘文件变化时，不刷新文件条目记录的大小。
- **召回台账只记录 §23 四个环节中的两个**——检索、以及随后的决策批次都有记录，结果由评分方提供；被注入条目是否被*使用*、是否被*引用*，全仓库都没有写入方，因此它们对记忆效用毫无贡献，而 §24 的第四个因子（来源质量）对被召回的记忆也没有记录来源。因此台账是效用的下限，而不是完整测量。
- **召回台账有上限，不是累计量**——`maxRecalls` 按作用域给它设限，因此被召回次数超过上限的记忆只保留最新几条召回，其计数是保留下来的召回数；读取方不应把 `recalls` 当作全时段总量。结果由调用方分级：没有任何东西自行判定某条被召回的记忆起了作用。
- **暂存写入无上限**——暂存条目按设计不计入容量，未评审的积压会一直增长，直到被批准或驳回。
- **决策批次不携带逐条来源**——整批的每条决策都归因到该批 `extraction` 所命名的那个会话，因此不带来源就应用批次的调用方不会向派生消费者发布任何东西，而同一会话对同一工件的两次确认，与"该会话重复了一次确认"无法区分。独立性的计数属于消费者：声明层按来源归并支持证据，并不允许同一来源为同一条声明作证两次。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>面向维护者的工作上下文——点击展开</summary>

无。

</details>
