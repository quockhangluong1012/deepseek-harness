---
description: "主动的逐轮记忆搜索：在模型作答前，把语义相关的既往会话片段注入 agent pre-step，供组合自学习 harness 的宿主使用。"
kind: "package-reference"
---

# @deepseek-ai/dsh-active-memory-context

[English](README.md) | 中文

## 概述

`dsh-active-memory-context` 在模型作答前，用用户最新一条消息去搜索同一 workspace 下的其它会话，并把经过相关性过滤的结果拼接进 `agent/pre-step`——这是主动检索，而不必让用户开口说"搜索既往会话"。它与 `dsh-evolution-memory-context` 互补：后者注入的是静态的、按 scope 的简报，内容从不依赖用户刚问了什么；本包每一轮注入的内容都不同，取决于该轮自身的内容。若提供 `ctx.evolutionGraph`，第二条腿会从该轮次提到的实体出发沿图的连接检索。当一个 scope 里既往的会话应当自动浮现时，选择本包。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知局限与延后工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

挂载本插件时需要 workspace registry，以及一个向量通道已就绪的 session-query 后端（在 `dsh-session-query-sqlite` 之后挂载嵌入服务，例如 `dsh-embeddings-http`）。作用域按每轮从 workspace 成员关系解析（registry 中的 session id，回退到 canonical-path 的 `cwd` 匹配）；不属于任何 workspace 的轮次，或所在 workspace 没有其它会话的轮次，都不会注入任何内容。若挂载还提供 `ctx.evolutionGraph`，则会额外获得下文所述的图谱腿；没有它时，简报只承载向量腿自己的命中——每个会话一行，按融合顺序排列。

### 检索配置记录

当 `ctx.evolutionRetrieval` 已挂载时，注入器会在每个会话的首个步骤为该会话记录一次它所运行的检索配置：既有本挂载实际设定的 §39 维度（检索来源、图深度、活动记忆阈值），也有其余维度的已发布选择。这只是一条旁路记录——用 `ctx.get` 读取的结构化接缝、每个会话一次不被等待的写入、不调用模型、不改变提示词——因此挂载与否简报完全相同，而存储拒绝写入也只记一行 debug 日志。`dsh-evolution-retrieval` 把这些记录变成逐任务类别的推荐；不挂载它则不记录任何东西。它描述的是本挂载，而绝不是任务感知策略施加到某一轮上的推荐——后者记在简报自身，见下。

### 任务感知检索策略

开启 `taskAwarePolicy: true` 后，符合条件的轮次会按 `dsh-evolution-retrieval` 为该轮次任务类别推荐的 §39 配置检索，而不是按本挂载字段所写的配置。任务类别来自已记录的证据，而非对轮次文本的猜测：它是某条 usage 记录中列有本会话的技能名（`ctx.evolutionSkillTelemetry`），而这正是该存储给会话打分的同一任务类别轴。一个会话记录了多个技能就有多个类别；注入器按名字顺序逐个向存储询问，并运行其中已越过证据闸门的最高分推荐。

本注入器自己掌握的维度采用推荐值——检索通道（`graph` 变为 `graph-first`，`hybrid` 变为 `both`）、取 `workspace` 时的记忆范围、图深度，以及活动记忆阈值。它无法提供的每一个维度都会作为未施加项连同原因被记录，而不是被悄悄丢弃：`queryExpansion`、`weights`、`reranker` 与 `mmr` 在这里是已发布的选择，而 `vector` 的来源或 `session`/`global` 的范围则保留本挂载自己的通道与范围。

已施加的策略搭载在被注入简报自身的持久记录上——其 `active-memory` 来源的 `policy` 字段——因此会话日志可以重建该简报出自哪些维度；而回退的轮次不携带该字段。其余一切不变：关闭时（默认）简报与从未设置该字段的挂载逐字节相同；上文那条配置在案记录照旧写入；而未挂载遥测存储、存储无推荐越过其证据闸门、以及没有任何技能记录过的会话，都会回退到本挂载自己的配置，并记一行 debug 日志说明。该策略不调用模型。

### 配置

`maxBytes` 是必填项：部署方必须自行选择一份简报可以花费多少代价，这与 `dsh-evolution-memory-context` 对自己简报的要求一致。

```yaml
- name: '@deepseek-ai/dsh-active-memory-context'
  config:
    maxBytes: 4096
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `maxBytes` | 必填 | 含框架在内、完整输出文本的上限 |
| `topK` | `5` | 每次搜索在应用相关性阈值前排序的候选结果数 |
| `relevanceThreshold` | `0.7` | 命中要值得注入所需达到的最低余弦相似度 |
| `turnInterval` | `1` | 两次 active-memory 搜索之间间隔的轮数 |
| `escalation` | `both` | 每个符合条件轮次运行哪些腿：`both` 每轮同时运行向量腿与图谱腿；`graph-first` 先运行本地图谱腿，仅在图谱腿一无所获时才花费向量腿的嵌入调用 |
| `profile` | `default` | 图谱腿读取的作用域身份命名空间；必须与该 scope 图谱被提取时所用的 profile 一致 |
| `graphDepth` | `1` | 图谱腿自命中实体向外展开的跳数 |
| `graphLimit` | `5` | 尝试实体扫描的轮次前导词数、一次 `expand` 可返回的实体数，以及展开后可用于播种搜索的标签数 |
| `taskAwarePolicy` | `false` | 按该轮次已记录的任务类别采纳 `ctx.evolutionRetrieval` 推荐的 §39 配置，并运行本注入器自己掌握的维度；关闭时每轮都运行本挂载字段所写的配置 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-active-memory-context)是每个可接受字段的详尽来源。

### 为什么用相关性阈值，而不只是结果数量

最近邻向量搜索总会给出"最接近"的候选，无论它们实际有多远——余弦相似度本身并没有"无匹配"这种情形。只靠 `topK` 会悄悄把一个偏题轮次"最接近"的记忆当作相关内容注入。`relevanceThreshold` 正是规范所要求的质量闸门：命中只有在达到阈值后才会浮现，阈值与已挂载嵌入模型自身产出的 0–1 余弦量纲一致。切换嵌入提供方或模型后请重新校准该阈值，因为这个量纲只在单一模型自己的向量空间内有意义。

### 成本与节奏

每个符合条件的轮次都会运行一次语义搜索（为查询做一次嵌入调用，加上向量存储尚未持有的文档——参见 `dsh-session-query-sqlite` 的惰性嵌入设计）。图谱腿不增加嵌入调用，也不增加模型调用：它只是对本地图谱做标签查找，外加至多 `graphLimit` 次落在该轮次本就搜索的语料上的文本搜索。那条词法通道与向量腿所需的是同一个开关：两个随包组合都以 `openAt: never` 挂载 `dsh-session-query-sqlite`，此时每次标签搜索都会抛出 `SESSION_QUERY_SEARCH_DISABLED`，在启用内容搜索之前图谱腿不贡献任何内容。`turnInterval` 用与 `dsh-evolution-memory-context` 的提示间隔相同的方式限制这部分成本：尚未观察到 `turn/start` 的会话计为第 0 轮，读作其第一轮，因此 `turnInterval: 1` 会在第一轮就搜索。同一个已观察轮次内的重试步骤永不重新搜索：注入器记得自己上一次为哪一轮搜索过。

### 升级通道

`escalation: graph-first` 先运行廉价的本地图谱腿，只要图谱腿已经把该轮次连接到至少一个会话，就跳过向量腿——省掉它的查询嵌入调用。未挂载、不适用或结果为空的图谱腿返回空，于是向量腿与未升级时完全一样地运行。代价不只是成本，更是召回形态：被跳过的向量腿不可能浮现只有相似度才能找到的会话，因此简报只承载图谱腿的连接。默认值 `both` 保留每轮同时运行两条腿的历史行为。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节——点击展开</summary>

### 设计理念

在每次 `agent/pre-step`，注入器读取本次提议步骤自身消息的文本（而非某个更早的监听器已经追加的内容，因此搜索绝不会把别的包注入的简报当成自己的查询词），解析该会话所属的 workspace，并且——除非搜索不在节奏上，或已经为该已观察轮次搜索过——调用 `ctx.sessionQuery.searchSessionsSemantic`，把范围限定在该 workspace 的其它会话上（当前会话总是被排除，因此一个会话永远不会把自己刚提交的消息当作自己的"相关记忆"浮现出来）。低于 `relevanceThreshold` 的命中被丢弃；幸存的命中渲染成一条带框架的 `user/message` 并追加到该步骤上，受 `maxBytes` 约束，预算紧张时最先丢弃最弱的命中。在 `escalation: graph-first` 下，下文的图谱腿改为先运行，仅在其一无所获时才发生这次向量调用。

向量通道失败（`SESSION_QUERY_SEMANTIC_UNAVAILABLE`、`SESSION_QUERY_SEARCH_DISABLED`）会降级为不注入，而不是阻塞该轮次；其它任何失败都会向上传播,因为那意味着真正的缺陷,而非预期中的部署状态。

开启 `taskAwarePolicy` 时，会在两条腿运行之前查得该轮次已记录的任务类别，并由它命名的推荐只在这一轮替换本挂载的通道、图深度与阈值；纯函数 `applyRetrievalPolicy` 决定这包括哪些维度、以及哪些维度必须记为未施加。步骤的其余部分一无所变：同样的节奏、同样的范围、同样的融合、同样的渲染，只是已施加的策略由被注入消息的来源携带。

当挂载提供 `ctx.evolutionGraph` 时，第二条腿按连接而非相似度检索。图谱按标签匹配，所以整轮文本不是可用的查询：该腿扫描该轮次自己的前若干个词——至多 `graphLimit` 个——取其中第一个作用域图谱认识的词，向外展开 `graphDepth` 跳，并按每个到达的标签在同一会话语料上各做一次文本搜索，标签数受 `graphLimit` 约束。这些命中不携带分数，因为它们的相关性是连接而不是距离，因此简报用 `via graph connections` 标注，而不是编造一个相似度。两条腿按倒数排名融合：两条腿都找到的会话排在其一单独找到的会话之前；又因为融合按会话 id 归并，当一个会话有两份文档都达到阈值时，简报只为其保留一行。图谱通过 `ctx.get('evolutionGraph')` 获取，因此未挂载、版本较旧或失败的图谱会让简报只承载向量腿自己的命中——同样的会话，每个一行，按融合顺序排列。图谱腿仅凭 registry 成员关系解析其作用域，因此只被向量腿通过 canonical-path `cwd` 回退匹配到的会话不会获得图谱腿。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：pre-step 搜索、workspace 成员关系、轮次节奏、相关性过滤、图谱腿、排名融合、检索配置记录，以及策略所依据的任务类别查找 |
| [`src/policy.ts`](src/policy.ts) | 纯任务感知策略：某条推荐可施加哪些 §39 维度、本注入器又把哪些记为未施加 |
| [`src/render.ts`](src/render.ts) | 在字节预算内的纯简报渲染 |

### 失败与恢复

缺失或无法解析的 workspace 成员关系、空查询、不在节奏上的轮次、低于阈值的结果集、未挂载或对该 profile 无内容的图谱，以及放不进 `maxBytes` 的简报，都会降级为不注入——或仅保留向量腿的命中——而不是让该步骤失败。未挂载的 `ctx.evolutionRetrieval`，或拒绝该配置记录的存储，既不改变搜索也不改变简报：该记录只是旁路写入，失败时记一行 debug 日志。任务感知策略找不到可施加之物的每一种情形同样如此——没有遥测存储、存储没有 `recommend`、没有任何技能记录过该会话、类别没有越过证据闸门的推荐——而且每一种都会记 debug 日志，因为运维看不见的回退与从未运行的策略无从区分。没有发布运行时不变式伴生入口,因为注入器不拥有任何自己的持久状态:成员关系与轮次计数器都是进程本地缓存,从 `ctx.workspaceRegistry` 与已观察到的会话事件重建,从不是权威来源。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [演进式 Harness 子系统](../../../docs/subsystems/evolutionary-harness.zh.md)——自学习 harness 的参考词汇与行为契约；本包的 Active Memory 子代理即属于该 harness。
- [dsh-session-query](../../session-query/session-query/README.zh.md)——本包调用的搜索服务；参见其向量通道章节了解相关性分数如何产生。
- [dsh-evolution-memory-context](../evolution-memory-context/README.zh.md)——同级的静态按-scope 简报注入器;两者都读一遍就能看出为什么它们是两个包而非一个。
- [dsh-evolution-graph](../../evolution/evolution-graph/README.zh.md)——为第二条搜索腿播种的知识图谱。
- [dsh-evolution-retrieval](../../evolution/evolution-retrieval/README.zh.md)——可选的检索配置记录所写入的存储，以及它按任务类别推导出的推荐，也正是任务感知策略所采纳的推荐。
- [Session Query 子系统参考](../../../docs/subsystems/session-query.zh.md)——完整的类型级搜索契约。

-----

<a id="model-experience"></a>
## 模型体验

### 请求上下文与条件

#### 模型看到什么

每个符合条件的轮次,若有相关命中在过滤后幸存,就有一条 `user/message`:一个带框架的文本块,列出每个幸存会话、其命中时间戳,以及匹配文本的片段;每行标注该命中的余弦相似度,或对经图谱到达、无分数的命中标注 `via graph connections`。

##### 该字段的逐字文本(如需要)

```markdown
<system-reminder>
Relevant memory found in earlier sessions in this scope:
1. [session <id> @ <timestamp>, similarity <score>] <snippet>
2. [session <id> @ <timestamp>, via graph connections] <snippet>
</system-reminder>
```

#### Token 影响

受 `maxBytes` 约束;当没有命中达到 `relevanceThreshold`、该轮次不在节奏上,或该会话没有可解析的 workspace 时为零。

#### KV Cache 影响

按设计随该轮次自身内容变化:这是键定于用户刚问了什么的主动检索,而非按摘要门控的静态简报。它追加在该轮次自身消息之后,因此从不打扰更早轮次留下的稳定前缀。

## 已知局限与延后工作

<a id="known-limitations-and-deferred-work"></a>

- **轮次节奏只计进程内观察到的轮次**——间隔计数器在插件加载时开始计数,并在会话释放时清空,因此一个恢复的会话会从其观察到的第一个 `turn/start` 重新开始计数,这与 `dsh-evolution-memory-context` 为自己的提示节奏记录的局限相同。
- **每个符合条件的轮次一次嵌入调用**——成本随 `turnInterval` 缩放;没有跨轮次的结果缓存,因为按设计每轮查询都不同。`escalation: graph-first` 会在图谱腿已作答的轮次跳过该调用,代价是这些轮次失去纯相似度召回。
- **仅限 workspace 范围**——不属于任何 workspace 的会话,或所在 workspace 里唯一的会话,永远不会收到 active memory。
- **该策略需要有已记录的任务类别**——它只对某个技能的 usage 记录列出的会话、且只在搜索到期的轮次上运行；没有加载任何技能的会话会运行本挂载的配置。若某条推荐改变了 `queryExpansion`、`weights`、`reranker` 或 `mmr`，只有本注入器拥有该维度时才施加，其余记为未施加，而不是近似处理。
- **归属记录保留的是本挂载的配置，而不是那条推荐**——每个会话一次的记录描述的是本挂载字段所写的配置，因此一个同时按推荐配置运行过的会话只被归属到本挂载的配置。要拆分它就需要跨轮次、且任务类别可能在会话中途改变的逐轮归属，而该存储「每会话一个配置」的模型并没有这种归属；已施加的配置记在每条简报上。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作背景——点击展开</summary>

`escapeFrameBody` 会改写片段中字面出现的 `</system-reminder>`，因为既往会话的文本不受仓库控制，本包注入的记忆绝不能闭合界定它自己的那个框架——`dsh-evolution-memory-context` 对自己的框架施加的是同一道防御。图谱腿会跳过短于三个字符的查询词，因为 `graph.find` 是子串匹配：用 `in` 或 `is` 播种会把整个标签预算花在恰好包含这些字母、连接最多的标签上。字节预算靠「从最优优先的前缀重建整段带框架文本、丢弃最弱的末尾命中」来满足，绝不截断某一行；而连一条命中都放不下的简报是 `undefined`，调用方读作不注入，而不是一条空消息。

</details>
