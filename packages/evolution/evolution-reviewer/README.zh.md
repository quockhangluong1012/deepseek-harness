---
description: "Evolution background review with per-turn output indexing, gated lessons extraction, and on-demand rebuild (ctx.evolutionReviewer), for hosts composing the self-learning harness."
kind: "package-reference"
---

# @deepseek-ai/dsh-evolution-reviewer

[English](README.md) | 中文

## 概述

`dsh-evolution-reviewer` 从实时会话提炼演进经验且不阻塞轮次：它缓冲当前轮次的事件，在 `turn/end` 索引产出文件，把该作用域排序过的既往工作召回进简报，并排入一次受门控的提取——拿本轮次对照相关性受限的一片产物，回答 `confirms` / `contradicts` / `new`，直接应用，或在 `writeApproval` 下暂存。工具调用失败的轮次还会得到 §5 精炼环的 `critique`，点名被违背的期望、失败与更正，并记录它授权的修订。`rebuild` 从历史把发现折入同一批产物。当经验需要跟随某作用域会话的实际行为时选择本包；每次受门控的轮次花费一次模型调用。

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

与记忆存储和 workspace 注册表一起挂载本插件。作用域按回合从 workspace 归属解析（注册表会话 id，退回规范化 `cwd` 匹配），归属到配置的 `profile` 之下；作用域之外的回合既不索引也不提取。

### 配置

```yaml
- name: '@deepseek-ai/dsh-evolution-reviewer'
  config:
    profile: default
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `enabled` | `true` | 完成的回合触发提取；产出索引始终运行 |
| `profile` | `default` | 作用域标识命名空间，置于 workspace 键之前 |
| `minTurnTextBytes` | `200` | 承认文本低于此字节数的琐碎回合跳过提取 |
| `cooldownMs` | `60000` | 同一作用域两次提取的最小间隔 |
| `defer` | `auto` | `auto` 把受门控的回合排队稍后提取；`never` 在回合结束时立即提取 |
| `deferMaxAgeMs` | `1800000` | 排队回合的年龄上限，从该会话的第一份快照起算 |
| `maxInputBytes` | `131072` | 每次调用的笔录预算，优先丢弃最旧 |
| `maxOutputTokens` | `2048` | 每次调用的输出 token 上限，按一个回合产生约十条决策来定 |
| `relevantArtifactLimit` | `20` | 一次调用向模型展示的工件数上限，按相关性从高到低 |
| `timeoutMs` | `60000` | 调用截止时间 |
| `rebuildSessionLimit` | `20` | 重建扫描的会话数 |
| `recallLimit` | `20` | 每次搜索选出的排序召回结果数（会话与事件各一档） |
| `recallQueryChars` | `160` | 由回合最新人类消息导出的召回查询长度上限 |
| `outputTools` | `write,edit,str_replace_editor` | 计为产出的成功工具调用 |
| `provider`/`model` | 未设 | 路由覆盖；要么成对出现，否则沿用会话路由 |
| `writeApproval` | `false` | 后台提取暂存待批而不直接写入 |

`maxOutputTokens` 是按一批决策而非一份文档来定的：每个 `new` 候选携带完整工件，而每个 `confirms` 或 `contradicts` 只有几个 token，因此 `2048` 足以覆盖一个产生约十条决策的回合。更繁忙的作用域应调高它。

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-evolution-reviewer)是每个可接受字段的详尽来源。

### 结构化决策

一次提取调用向模型展示作用域中最相关的那 `relevantArtifactLimit` 个工件（从 1 开始编号），与本回合的笔录并列，并期待一个 JSON 决策数组：

| 动作 | 含义 |
|---|---|
| `confirms` | 该下标列出的工件被本回合支持——`validationCount` 加一 |
| `contradicts` | 该下标列出的工件被本回合反驳——`refutationCount` 加一，可选携带更正后的 statement 与 confidence |
| `new` | 列出的工件都未覆盖的一条事实——完整的候选字段，其 `source` 取自提取会话 |
| `critique` | 对本回合的批评——被违背的期望、失败本身与更正，外加该修订的 confidence 与 scope。仅当笔录记录了工具调用失败时才允许 |

空数组表示模型认为无内容可报，这是很常见的回答。模型按下标而非 id 寻址工件；评审器从它自己发出的那份列表把每个下标解析回真实工件 id，因此任何基于下标的取值都不会进入暂存载荷或存储。下标落在所发列表范围之外的决策会被丢弃并告警，而无法解读的回答只告警，已存工件保持原样。

整个回合的一批决策就是一次写入。`applyExtractionDecisions` 在写入时读到的记录上按决策顺序折入，存储对这一个结果检查经验上限：超出上限的批次先丢弃最长的一条 `new` statement 并重试，再丢弃各条 `contradicts` 的替换 statement 而保留其计数递增，直到无可再丢时把拒绝向上传播。

### 自我精炼批评

工具调用失败的回合就是一份值得批评的草稿，因此提取调用同时承载 §5 的 `草稿 → 批评 → 修订` 环的两半：

| 环的阶段 | 内容 |
|---|---|
| 草稿 | 本回合的笔录：它一向携带的人类与助手行，外加每个失败工具结果一行 `tool`，形如 `<工具名>: <记录到的结果文本>` |
| 批评 | 模型给出的 `critique` 决策，作为作用域上下文条目记录，标签为 `Critique: <sessionId>`，并指明被违背的期望、失败与更正 |
| 修订 | 该批评授权的更正，作为一条 `new` 经验工件记录：以更正为 statement、以失败为 `conditions`、以 `inference` 为 evidence，并采用模型自己给出的 confidence 与 scope |

两半都出自受门控回合本就发出的那一次调用——没有第二次模型调用、没有第二份提示，也没有任何会话日志中本不存在的新提示输入。该批评与任何上下文条目一样经简报抵达后续回合，而存储摘要涵盖上下文条目，因此该注入可从会话日志重建。

该流程只读取批评所需的内容，不拓宽任何东西：本回合的承认行与它自己记录到的失败工具结果、作用域中相关性受限的工件 statement，以及召回与重建路径本就在用的 `sessionQuery` seam。它不发起任何工具调用、不读取别的存储，而且因为它缓冲的工具结果本就用于产出索引，它没有为此新增任何 seam。失败调用只贡献其名称与记录到的结果，其参数完全不读。

两道闸门决定一条批评是否被记录：该次调用发出的笔录必须含有一行 `tool`，且该批评必须把期望、失败与更正三者都写明。任一闸门不过的批评会被丢弃并告警，而它旁边的每条决策仍然生效，因此无据的批评只牺牲自己、绝不牵连整批。即便 `writeApproval` 把旁边的决策暂存待批，批评条目也直接写入：它像召回条目一样，是评审器对已记录回合自身的解读，而不是对已存工件的变更提案。该条目被存储拒绝时只告警，修订仍然保留。

### 写入与审批

`writeApproval` 开启时，回合提取把每次调用的一批决策暂存为一条 `applyDecisions` 条目，因此 `/memory approve <id>` 在审批时读到的记录上原子地应用整批。受污染的内容始终暂存：当 prompt-injection 守卫为该会话记录了 `tainted: true` 的 `security/scan` 时，批次中每条 `new` 候选都携带 `trust: 'untrusted'`，且无论 `writeApproval` 如何设置，整批都会被暂存——因为污点只能经过审批进入长期记忆。重建（来源 `rebuild`）始终直接写入，没有待批内容的批次也一样。失败的提取告警并保留已存工件；teardown 与会话释放会中止在途调用。

### 相关性窗口

每次提取调用都拿作用域的工件与回合文本排序，只向模型展示最相关的 `relevantArtifactLimit` 个。挂载 `ctx.embeddings` 时，回合文本与每个工件的 statement 在一次批调用中一并嵌入，按余弦相似度排序；没有挂载、批调用抛错，或回答中缺少查询向量时，排序回退为最近更新优先。排序永远不会让提取失败。

该窗口让成本与所需输出与作用域规模无关，代价是完整性：本回合文本未能带进窗口的工件不会被本次调用确认，因此它会按存储的 `defaultTtlDays` 老化，除非之后的回合把它重新排进来。

### 排序召回

后台评审开启时，每个被观测的回合都会由其最新人类消息导出召回查询，向按目录限定范围的排序搜索 seam 请求候选会话，并跳过提问会话自身。候选会被解析为其事件，并通过与笔录相同的承认规则，因此注入的简报与指令消息永不会被召回回来。最强的被承认命中会作为该作用域唯一的上下文条目落地，标签为 `Recall: <sessionId>`——内容变化时替换，未变化时不动——而简报把它渲染在最后，因此在压力下最先被丢弃。没有搜索 seam 就没有召回条目。

### 召回评分

挂载可选内核时，一次 `verification/result` 事件会为本会话自身提取所绑定的那条召回结算 §23 的「帮助结果」环节：`pass` 记为 `ok`，`fail` 记为 `failed`，`unknown` 不评分——它本就不是决定性信号。只有其决策批次是从被验证会话提取出来的召回才会被评分，因此结果永远不会落到其他会话的回合遗留下的待评分召回上；`applyExtractionDecisions` 正是把这一绑定记为 `decidedInSessionId` 的地方。存储拒绝——召回在读取与写入之间已被评分或移除——只告警，不做其他结算。未挂载内核，或会话尚未得到编译后的验证结果时，召回保持未评分：§24 对它的效用读数只计入检索与决策链接，从不计入结果。

### 重建与延迟

重建以同样的方式选取材料：作用域最新观测到的人类请求驱动一次按目录限定范围的排序 `searchSessions`，每个排序会话的事件再经 `searchEvents` 取回，每个被选事件在组帧前都要通过共享的承认规则。行按最不相关优先累积，因此笔录字节上限丢弃的是召回而非最强命中。seam 缺席或不完整、排序结果为空、搜索失败，或作用域尚无被观测回合时，都回退到精确的 `readSurface` 扫描。重建随后把它产出的一批决策折入已存工件，与实时回合完全一样，而不是替换它们。

在默认的 `defer: auto` 下，受门控的回合不再于 `turn/end` 立即提取，而是进入按会话的内存队列。刷出之前结束的回合会合并：新快照替换已排队的快照，而第一份快照的 `deferMaxAgeMs` 截止时间与计时器保持不变，因此繁忙会话无法无限推迟自己的提取。会话释放与 teardown 会丢弃排队回合而不提取；`defer: never` 恢复回合结束时的即时提取。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部——点击展开</summary>

### 设计概念

评审器观察 `session/event`，按会话缓冲当前回合的承认行与工具结果，在 `turn/end` 刷出缓冲。没有任何逻辑同步扫描会话历史：恢复后的会话贡献其被观测到的后缀，而重建经 `sessionQuery` 的排序搜索选取材料，排序 seam 缺席或为空时回退到精确的 `readSurface` 扫描。同一作用域永不并发两次提取：即时路径、到期的延迟刷出，以及显式的 `rebuild` 调用都排入同一条按作用域的 promise 链，回合重叠时该链丢弃被取代的条目。排在一次进行中的实时提取之后的重建，仍会把自己的成功或失败原样报给调用方——链路本身永不拒绝，因此排队中某一项的失败永不阻塞下一项。延迟队列本身按会话各持一份合并后的快照，以该会话第一份快照的截止时间为准。

`admittedRow` 是唯一的承认规则：即时缓冲、精确重建扫描与每一个排序召回候选都经过它，因此注入的简报或指令消息永不会成为笔录或召回材料。

### 源码导览

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`EvolutionReviewer` 服务、回合缓冲、门控、排序召回、重建、下标解析、批量写入 |
| [`src/protocol.ts`](src/protocol.ts) | 提取系统提示、带下标工件列表的请求组帧、决策 schema 与解析器 |
| [`src/relevance.ts`](src/relevance.ts) | 相关性受限的选择：经可选 embeddings seam 的相似度排序，回退为最近优先 |

### 失败与恢复

提取路由来自配置的 pair，否则取会话最近请求头；两者皆无的回合告警并跳过，无路由的重建直接拒绝。`error` 与 `aborted` 收尾抛入告警路径；`max-tokens` 以 `truncated` 容忍；工具调用块与其他收尾一律拒绝。模型调用使用 `temperature: 0` 与 `purpose: 'evolution-review'`，因此推理保持关闭，用量归属评审任务。召回失败、批评条目被存储拒绝，以及召回条目被存储拒绝时都只告警，不让回合失败，原上下文保持不动。

不发布 invariant 伴生包，因为评审器不拥有自己的持久状态：缓冲与链是内存中的调度，存储的域表是唯一的持久副本。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [演进式 Harness 子系统](../../../docs/subsystems/evolutionary-harness.zh.md)——本包实现的行为契约。
- [evolution 包导览](../README.zh.md)——本分组的软件包及其仓库位置。
- [生成的配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-evolution-reviewer)——每个可接受的配置字段。

-----

<a id="model-experience"></a>
## 模型体验

### 请求上下文与条件

#### 模型所见

提取调用只发一条辅助用户消息，其中是本回合笔录的 JSON 与各相关工件 statement 的编号列表，并配以经验系统提示。失败的工具结果在该笔录中表现为一行 `tool`，写明工具名与它记录到的结果；回答则可在常规决策之外，为每个被记录的失败追加一条 `critique`。

##### 本字段原文（如需）

```markdown
You distill durable lessons for an agent scope from one turn of conversation.
```

#### Token 影响

带上限：每个受门控的回合一次辅助请求，受 `maxInputBytes` 笔录（含失败的工具结果）加 `relevantArtifactLimit` 个工件 statement、`maxOutputTokens` 补全约束。批评只是在同一份回答里多出几个 token，而不占一次请求。召回为每个被观测回合增加一次索引搜索，并至多向作用域记录添加一个上下文条目；其材料只经下一份简报抵达模型，被记录下来的批评也以同样方式——作为多出的一个上下文条目——抵达。

#### KV Cache effect

与实时请求独立：提取是拥有独立前缀的一次性调用，不会使会话的 provider 缓存复用失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制界定了评审器不适用的场景。它们是当前包约束。

- **仅经验**——提取写入 `agentLessons`；用户画像保持手工维护，直到控制面切片到来。
- **无 subagent 评审分支**——提取在按作用域链上进程内运行；带工具白名单的委派后台 agent 延期。
- **排队回合只在内存中**——在 `deferMaxAgeMs` 截止之前发生重启或 teardown 会丢弃排队回合，而不持久化快照。
- **挂载时正在进行的回合**——评审器加载时已在进行中的回合，只从其被观测到的后缀提取。
- **召回需要排序面**——没有 `sessionQuery` 时，重建直接拒绝；缺少其排序读取能力时，召回不写入任何内容，重建回退到精确表层扫描。
- **每个作用域一个召回条目**——命中变化时替换旧条目并改变记录摘要，因此下一份简报是全新的；命中未变化时什么都不重写。
- **召回查询是字面短语**——搜索后端把导出的查询当作数据匹配，因此从未在已索引会话中逐字出现的查询不会返回候选。
- **窗口不等于整个存储**——落在相关性窗口之外的工件对该次调用不可见，因此一条仍然为真、却始终没被窗口排入的事实会按 `defaultTtlDays` 衰退，再没有任何东西来确认它。
- **一批决策整体审批**——每次提取调用只产生一条暂存条目，意味着评审者无法接受同一回合中的 `confirms` 而拒绝其中的 `contradicts`：选项是整批全收或全不收。
- **被反驳的事实保留其身份**——一次反驳可以替换工件的 statement，但工件保留所有调用方寻址它所用的 id，因此该 id 不再拼出它现持的 statement。
- **批评只跟随被记录的工具失败**——出错却没有失败工具结果的回合不会得到批评，而笔录字节上限丢弃掉的失败对该次调用不可见，因此它的批评要留待仍携带它的后续回合。
- **失败行与工具结果等长**——该行原样携带记录到的结果文本，受工具自身的输出上限与笔录字节预算约束；评审器不再另外裁剪，而失败调用的参数完全不读。
- **每条批评都占一个上下文条目**——被记录的批评与任何附加条目一样占用作用域上下文名册与容量，因此在已填满 `maxContextItems` 的作用域上，修订会被记录，而它的批评条目只告警并被丢弃。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>面向维护者的工作上下文——点击展开</summary>

无。

</details>
