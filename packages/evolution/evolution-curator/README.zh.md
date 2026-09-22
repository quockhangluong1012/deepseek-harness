---
description: "Idle-triggered skill lifecycle curation: automatic active/suspect/stale/archived transitions on idleness and recorded evidence, with dry-run previews (ctx.evolutionCurator), for hosts curating skills during use."
kind: "package-reference"
---

# @deepseek-ai/dsh-evolution-curator

[English](README.md) | 中文

## 概述

不必亲自盯着技能生命周期：每个 host 挂载一次本插件，它就会按闲置时长与证据把技能在 `active → suspect → stale → archived` 之间移动，让最新一次加载回应了对其不利证据的 suspect 或 stale 技能回到 `active`，并用试运行预览每次通过。`consolidate` 让模型把 agent 创建的技能归并为伞技能；置顶、受保护、随包与 hub 来源的技能永不移动。它读取技能遥测，缺席时退化为簿记。真实通过会写快照，可整轮或按条目回滚。

挂载本身就是全部触发：`enabled: false` 不启动定时器，也不触碰记账。

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

Host 启动时挂载本插件一次。此后它自行拥有维护计划：自己观测 host 范围的 `session/event` 活动，运行一次启动时到期检查，并以 `unref()` 过的定时器每 `tickMinutes` 重复一次到期检查，定时器随插件处置。到期检查仅在 `lastRunAt` 起经过 `intervalHours`，且 `minIdleHours` 内没有会话事件到达时才运行一次通过；本进程观测到任何活动之前，host 视为闲置。首次检查只播种 `lastRunAt` 并递延一个周期，因此短命 CLI 运行只贡献其启动时刻，而不运行任何东西。`enabled: false` 不启动定时器，也不触碰记账。

调用 `maybeRun` 可自行运行同一次到期检查（闲置门控可用 `idleMs` 显式覆盖），调用 `run` 做无条件通过，以 `dryRun: true` 预览报告而不写入。一次通过检查每个被跟踪的技能：闲置时长从上次加载起算，从未加载则从播种起算。`active` 在超过 `staleAfterDays` 后进入 `stale`。证据驱动的移动比闲置驱动慢一档：每一次由证据触发的移动都落在 `suspect` 上，而 `suspect` 再按 `active` 所用的同一闲置阈值老化进入 `stale`。

### 漂移信号

一次通过会从档案本就持有的记录中读取 §22 的四个信号，其中任意一个都会把 `active` 技能移入 `suspect`。每个信号都以 `drift: <名称>` 的形式计入流转原因。`failureSpike` 是一次决定性分级——属于该技能某个会话的 `trigger_review` 失败信号——由该技能最近一次信任观察归因给它、没有任何更新的加载回应它，且发生在 `driftWindowDays` 之内。`conflictingEvidence` 是在该技能最近一次加载或修补之后为它记录的 `conflicting-evidence` 不确定性信号。`lowUtility` 是该技能已记录的干净结果占比减去同侪的占比，且不大于 `lowUtilityFloor`。`versionChange` 是一条已记录的谱系信封，其 `tool`、`model`、`prompt`、`retriever`、`evaluator` 或 `env` 版本与上一条信封不同，且记录于该技能最近一次使用或修补之后——技能自身的版本被跳过，因为发生变更的工件并不是它被验证时所处的环境。

在没有更新的加载回应它们的情况下，被归因的信任失败数达到 `staleTrustFailureFloor`，或在至少 `stageMinUses` 次加载上加载失败率超过 `stageFailureRate` 且最近一次加载是失败的，也会把 `active` 技能移入 `suspect`。最近一次加载成功、且新于其进入 `suspect` 那一刻的 `suspect` 技能回到 `active`，这就是"一次加载悄悄回应了证据"的方式；最近一次加载成功、仍在 stale 窗口以内、且新于其最近一次被归因失败的 `stale` 技能同样回到 `active`；超过 `archiveAfterDays` 时两者都改为归档——期限永远优先于复活。报告以理由列出每次移动，并给出置顶、受保护名称与被排除来源的跳过计数；写了快照时还携带通过标识与快照文件名。`lastRunAt` 读取上次通过时刻，供状态界面使用。

#### §22 点名但没有任何记录可达的信号

规范列出的两个来源在本档案中都不是按技能的，因此没有任何通过会读取它们。知识图中被否证的声明与记忆存储的 `refutationCount` 都按作用域、按工件计数，而没有任何存储字段把某个工件或声明连接到某个技能；它们只能经上面那些按技能的 `conflicting-evidence` 不确定性信号抵达阶梯。任务分布漂移需要技能使用上的任务类别轴，而这样的轴并不存在：技能使用记录的是加载它的会话，从来不是这些会话提出的任务；而 `evolution-meta` 的 `taskClass` 是被测优化器技能，而不是任务类别。

`consolidate: true` 时，该通过随后对 agent 创建的技能运行一次 LLM 归并（见[归并](#consolidation)）。

### 分选

每次通过还会分选出那些已记录结果表明不再好用的技能。当遥测记录中至少有 `stageMinUses` 次加载，且失败占比超过 `stageFailureRate` 时分选该技能，其中占比为 `failureCount / (useCount + failureCount)`——正是遥测记录所记录的公式。分选是证据，不是移动：它为每个技能追加一条 `stage` 台账条目，既不写入技能，也不写入遥测，因此置顶技能仍会被分选。置顶保护的是技能不被移动，而不是不被查看；随包附带、hub 与 `protectedNames` 技能留在外面，因为它们本就完全在整理范围之外。

条目里的计数就是去重键，因此在台账上已有计数的技能不会被重复追加——只有该技能再次被使用时台账才会增长。`staged` 读取每个技能的最新条目，失败率最差在前，同率按名称升序；通过报告会列出本次分选了哪些。`backup.enabled` 像管住本包其它每次台账写入一样管住这次写入。

### 回归债

每次通过还会为每个技能的每个决定性失败维护一条未结债务，存放在 `evolution_curator` 域（版本 2）的 `debt` 表中。新合并键的 `trigger_review` 信号会开启一条债务，并开始累计连续通过次数；再次目击会加深它（`passes`、最新消息、最多上报会话数）；修订会关闭旧债务并开启一条新的，因为新正文尚未回应旧失败；某失败不再出现时，即便另一条仍在，它的债务也会关闭。`debt()` 列出每条未结债务——通过次数最多者在前，其次是上报会话数，再次是名称与合并键——通过报告也携带同一份列表。试运行不写入任何内容。债务是循环尚未回应的回归积压：它列出的是失败，而不是裁决，因此归并与未来的基准扩展读到的是该瞄准什么，而不是已经决定了什么。

### 配置

周期、阈值、保留期与归并路由是可通过 `cordis.yml` 修改的、经过校验的 `Config` 成员。归档阈值低于过期阈值时大声失败；`provider`/`model` 只设一半，或开启归并却缺少二者，同样大声失败。

```yaml
- name: '@deepseek-ai/dsh-evolution-curator'
  config:
    staleAfterDays: 30
    consolidate: true
    provider: deepseek
    model: deepseek-chat
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `enabled` | `true` | 总开关；关闭时跳过一切通过、不启动定时器、不触碰记账 |
| `intervalHours` | `168` | 两次通过之间的最小小时数 |
| `minIdleHours` | `2` | 通过运行前所需的最小观测闲置小时数 |
| `tickMinutes` | `15` | host 范围到期检查之间的小时数 |
| `staleAfterDays` | `30` | `active` 进入 `stale` 的闲置天数 |
| `archiveAfterDays` | `90` | `stale` 进入 `archived` 的闲置天数 |
| `staleTrustFailureFloor` | `3` | 在没有更新的加载回应的情况下，使 `active` 进入 `suspect` 的被归因信任失败数 |
| `driftWindowDays` | `14` | 决定性分级失败在多长时间内仍算新鲜，供 §22 的失败尖峰信号使用（单位：天） |
| `lowUtilityFloor` | `0` | 实测效用差值不大于该值时 §22 认定效用偏低；零即同侪合并基线 |
| `protectedNames` | `[]` | 豁免自动流转的技能名，如计划引用 |
| `pruneBuiltins` | `true` | 从通过中剪除随包内置技能；hub 来源始终豁免 |
| `backup.enabled` | `true` | 快照与台账写入的总开关 |
| `backup.keep` | `5` | 修剪后保留的快照 tarball 数 |
| `archiveTtlDays` | `0` | 归档技能等待清理的闲置天数；零表示永不清理 |
| `consolidate` | `false` | 可选的、对 agent 创建技能的 LLM 归并 |
| `provider` | 未设 | 归并的 provider 路由；与 `model` 一同设置 |
| `model` | 未设 | 归并的模型 id；开启 `consolidate` 时必需 |
| `maxInputBytes` | `65536` | 归并调查框定的字节预算 |
| `maxOutputTokens` | `2048` | 每次归并请求的输出 token 上限 |
| `maxSteps` | `4` | 有界工具循环可花费的归并请求数 |
| `maxCandidateFailures` | `5` | 每个调查候选携带的已记录失败，作为反思证据 |
| `timeoutMs` | `60000` | 一次归并运行的截止时间 |
| `stageMinUses` | `20` | 失败率据以分选技能前所需的已记录加载次数 |
| `stageFailureRate` | `0.3` | 技能被分选必须超过的失败占比 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-evolution-curator)是每个可接受字段的详尽来源。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部——点击展开</summary>

### 设计概念

存储域 `evolution_curator`（版本 `1`、布局 `per-record`、表 `meta`）中单个键 `state` 下的一行记账。流转经由 `ctx.get` 通过技能遥测应用，因此存储未挂载时整理退化为记账而不是失败；目录中未知的名称记入 `custom` 来源，而不是逃出整理。时钟与闲置观测以 `run`/`maybeRun` 的调用参数到达，而挂载后的插件补上 host 范围的部分：一个保存最新活动时刻的 `session/event` 监听、一次被 await 的启动时到期检查，以及一个经 `ctx.effect` 处置的 `unref()` 定时器。规格用假定时器驱动到期与闲置转换，因此插件不携带任何仅测试用的时钟接缝。

<a id="consolidation"></a>
### 归并

`consolidate` 默认关闭，且产生真实模型调用。开启时，真实通过调查处于 `active` 或 `stale` 状态的 agent 创建技能，在 `maxInputBytes` 内框定它们，并在 fork 启动前追加一条 `cost` 台账行 `{inputBytes, maxOutputTokens, provider, model, truncated}`。每个候选都携带加载过它的那些会话里记录的失败——至多 `maxCandidateFailures` 条，在反馈存储已挂载时读取——因此裁决反映的是真正坏在哪里，而不是技能作者的意图。fork 是 `ctx.llm` 之上的有界进程内工具循环，白名单只有两个工具：`skill_view` 读取一个候选包，`skill_apply` 为每个候选记录一条裁决（`keep`、`patch`、`consolidate`、`archive`）。循环至多花 `maxSteps` 次请求，并在首个纯文本回答处结束；请求失败会抛出，运行的截止时间在 `timeoutMs` 处中止它，插件处置时同样中止。

所有写入都由整理器执行，因此无论模型要求什么，整包规则都成立。`patch` 正文在提交前先通过验证器优先的阶梯（见 [`dsh-evolution-verifiers`](../evolution-verifiers/README.zh.md)）：第 0、1 级确定性地判定 `skill_manage edit` 强制的 frontmatter 不变式，以及名称与指令不变式；在任何一级失败的正文被跳过，其拒绝层级与理由记入 `refusals`；通过确定性层级的正文通过就地重写 `SKILL.md` 被提交——阶梯的更高层级在 host 挂载其接缝时才会被咨询，而本路径不挂载任何接缝。被替换的原文本先按内容寻址存为 blob。`consolidate` 裁决把候选的整个目录搬到伞技能之下（`<umbrella>/<name>/`），把被搬移树中每一处 `${DSH_SKILL_DIR}` 引用改写为新的相对根，并向伞技能的 `SKILL.md` 追加一条引用——随包携带 `references/`、`templates/`、`scripts/` 或 `assets/` 的包绝不会被压平成只剩 `SKILL.md`。`archive` 裁决把整个目录搬入技能旁边的 `.archive/`。伞技能缺失、不可写，或已占用同名目录时，包原地不动，该裁决计入跳过。归并记一条携带两端点的 `move` 台账条目；生命周期移动与自动通过走同一套快照、`pass` 与 `transition` 机制；`rollbackPass` 把每个被搬移的包搬回并恢复生命周期状态。

host 插件无法无头 fork subagent 接缝——进程内 provider 从活跃的父会话继承路由，而整理器没有会话——因此循环在进程内运行。

### 通过安全

有移动的真实通过在整理器家目录下写一个 tarball（`snapshots/pass-<时间戳>-<id>.tar.gz`，修剪到 `backup.keep`）：暂存的前后记录对、可解析的技能目录与清单。不可解析的名称进入通过证据，而不是失败。一条 `pass` 台账条目加每次移动一条 `transition` 条目追加到只增 JSONL 台账，前后记录 blob 按内容寻址存储。`rollbackPass` 恢复生命周期状态、被搬移的包，以及该趟补丁过的 SKILL.md 正文；`rollbackEntry` 恢复单条生命周期条目。两者都先验证全部记录、blob 与已记录的搬移——正文前像缺失时回滚失败关闭——先快照当前记录使每次回滚可逆，并为每个技能、每次反向搬移或每份被恢复的正文记一条 `rollback` 条目。在正文开始留前像之前写下的补丁行没有前像，直接跳过。未知标识、缺失 blob、未跟踪技能、记录路径已消失或原始路径已被占用的被搬移包，以及缺失存储，都在一切写入之前失败。归并在运行后的布局上对包做快照，因此其 `move` 条目就是运行前路径的记录。台账整份读取：某行不是合法 JSON 时，读取以台账路径与该行行号失败，让操作者修复证据，而不是读着越过损坏处。

### 认领与清理

`adopt` 经由遥测 `markAdopted` 写入，把一个 agent 创建的技能认领为用户主导，并记一条操作者台账条目；无模型作者身份一律拒绝，且该移动单向。`purge` 删除超过 `archiveTtlDays` 的归档技能：先删技能目录（不可解析时仅删记录），再遗忘记录，再为每个技能记一条操作者台账条目。置顶技能保留，零 TTL 什么都不删，`dryRun` 只预览删除名单而不写入。`passes` 按新到旧列出已记录的通过，供状态界面与回滚选择使用。`surveyCandidates` 列出由模型写出的技能及其裁决证据——路由、状态、闲置时长、使用计数、关联会话的分级失败信号，以及该技能的信任与修订——按名称排序，不写入；保留/补丁/归并的裁决另行到来。

### 源码导览

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`EvolutionCurator` 服务、通过逻辑、host 范围触发、回滚与记账 |
| [`src/drift.ts`](src/drift.ts) | 纯 §22 漂移信号：失败尖峰、更新的冲突证据、实测效用偏低、依赖版本变化 |
| [`src/consolidate.ts`](src/consolidate.ts) | 归并 fork：调查框定、有界工具循环、经验证器把关的补丁准入与整包规则应用器 |
| [`src/safety.ts`](src/safety.ts) | 快照、台账、blob、修剪、包搬移与回滚读取路径 |
| [`src/spec.ts`](src/spec.ts) | 域声明：记账模式与 `defineDomain` 规范 |
| [`src/types.ts`](src/types.ts) | 公共运行选项、流转、报告、回滚与通过类型 |

### 失败与恢复

失败的流转向上传播并停止本次通过：此前的移动有效，报告丢弃，记账保持未盖戳，因此下次通过重新检查每个技能。计划触发的失败被捕获并告警，定时器与记账保持完好以便下次滴答。非法记账会导致域打开时大声失败：丢失的 `lastRunAt` 会重跑首次递延并推移整个计划。启动前读取抛错。处置时会中止进行中的归并运行。

不发布 invariant 伴生包，因为域表是该状态的唯一副本，不存在第二个可供核对的独立观测。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [演进式 Harness 子系统](../../../docs/subsystems/evolutionary-harness.zh.md)——本包实现的行为契约。
- [evolution 包导览](../README.zh.md)——本分组的软件包及其仓库位置。
- [`dsh-evolution-verifiers`](../evolution-verifiers/README.zh.md)——本包归并补丁准入所运行的验证器优先阶梯。
- [生成的配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-evolution-curator)——每个可接受的配置字段。

-----

<a id="model-experience"></a>
## 模型体验

### 归并 fork

#### 模型看到什么

只有可选的归并会调用模型；自动流转不注册任何面向模型的内容。每次请求携带一条辅助 user 消息，内含固定指令加 JSON 候选调查；随后是 assistant 工具调用与整理器的工具结果。请求恰好声明两个工具：

##### 工具白名单

```markdown
skill_view(name, file?)                 — read one candidate package
skill_apply(name, action, into?, body?) — record one verdict
```

#### Token 影响

有上限：每次运行至多 `maxSteps` 次请求，每次受 `maxInputBytes` 的框定调查加上先前工具结果，以及 `maxOutputTokens` 的补全约束。

#### KV Cache 影响

与活跃请求无关：归并是带自有前缀的独立一次性交换，因此不会使会话上的 provider 缓存复用失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制界定了本整理器不适用的场景。它们是当前包约束。

- **归档包会搬文件，处置生命周期状态不会**——自动的 `stale → archived` 流转只是遥测，而归并的 `archive` 裁决会把整个目录搬入 `.archive/`。
- **信任只被记录，不被强制**——技能的状态会进入观测与状态行，但不会限制模型可以加载什么。
- **归并在进程内运行**——host 插件无法无头 fork subagent 接缝，因此工具循环跑在 `ctx.llm` 上而非子 agent 上。
- **归并改写目录引用，不改写计划条目**——归并改写被搬移包内的 `${DSH_SKILL_DIR}` 路径；目前没有任何计划条目引用技能，因此 `protectedNames` 仍是计划引用的护栏。
- **认领单向**——被认领的技能保持用户主导来源；没有任何操作能将其送回 agent 创建。
- **§22 的两个来源并非按技能**——知识图中被否证的声明与记忆存储按工件计数的 `refutationCount`，只能以 `conflicting-evidence` 不确定性信号的形式抵达阶梯，因为没有任何存储字段把工件或声明连接到技能；技能使用上同样没有任务类别轴，因此任务分布漂移根本不会被推导。
- **清理默认关闭**——`archiveTtlDays` 默认为零，因此归档技能会一直累积，直到选定 TTL。
- **受保护名称是显式的**——计划引用经由 `protectedNames` 进入，直到出现计划到技能的接缝将其自动接线。
- **仅限本机**——记账位于 `$DSH_HOME` 之下，永不写入项目目录内。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>面向维护者的工作上下文——点击展开</summary>

无。

</details>
