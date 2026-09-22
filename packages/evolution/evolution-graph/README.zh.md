---
description: "知识图谱记忆：按作用域持久化的实体与有向关系，配合有界遍历，以及一次把文本变成三元组的确定性提取（ctx.evolutionGraph）。"
kind: "package-reference"
---

# @deepseek-ai/dsh-evolution-graph

[English](README.md) | 中文

## 概述

`dsh-evolution-graph` 是单个作用域的知识图谱持久记忆：实体与有向关系，按连接而非相似度遍历，另有一层声明/证据层——每条被断言的事实都携带支持它与否证它的来源，以及由此推导出的信念。提取是一次 `temperature: 0` 调用，其 JSON 答案在写入任何内容之前先被校验；图谱只保留标签、种类与关系名，绝不保留它读自哪一句话。重复出现只提升某条边或某个证据来源的计数，绝不提升信念。可按具名关系作答、展开邻域、按标签查找实体，或查询仍然成立的声明。

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

挂载本插件，然后记录或读回关系。每个作用域各自持有一张图。

```ts
await ctx.evolutionGraph.observe(scope, [
  { from: 'Project X', relation: 'worked_on', to: 'Alice', toKind: 'person' },
])
ctx.evolutionGraph.answer(scope, 'Project X', 'worked_on')   // { subject, relation, objects }
ctx.evolutionGraph.expand(scope, 'Alice', 2)                  // neighbourhood, breadth-first
ctx.evolutionGraph.find(scope, 'project')                     // entities by label, most connected first
```

`observe` 合并三元组：首次出现则插入，重复出现则提升该关系的计数；当某一部分归一化后为空、或达到上限时，该三元组会被丢弃并计入 `skipped`，绝不抛出。`extract` 执行一次模型调用并合并其返回结果。

声明是同一条记录的另一半。`recordClaims` 连同证据记录断言；`claims` 在仍然成立的声明上作答，`claim` 按身份读取单条声明，无论其是否已退役。

```ts
await ctx.evolutionGraph.recordClaims(scope, [{
  statement: 'PostgreSQL holds the session facts',
  supportedBy: [
    { source: 'docs/adr-1.md', quality: 0.8, reliability: 0.5 },
    { source: 's1', quality: 1, reliability: 0.9 },
  ],
  observedIn: ['s1'],
  usedBy: ['skill:session-search'],
}])
ctx.evolutionGraph.claims(scope, 'postgres')                   // active claims, most believed first
ctx.evolutionGraph.claim(scope, 'PostgreSQL holds the facts')  // one claim, with retiredBy when it was replaced
```

与 `dsh-evolution-memory` 一起挂载时，这一层会自行填充：该存储本就在应用的决策批次——一条 `new` 候选、一次 `confirms`、一次 `contradicts`——会在落地时被折成声明，因此随包提供的评审器无需命令即可填充本图，且不增加任何模型调用。

来源由其 `source` 标识，因此重复记录同一份证据只提升该条目的 `count`，别无其他：`independentSupport` 统计的是彼此不同的来源，评审器的一条 `contradicts` 决策无论同一会话重复多少次都只算一个来源。`supersedes` 使其命名的声明退役——退役的声明保留其证据与记录中的位置，但不再回答任何查询——这正是"改正后的陈述取代旧陈述"而非原地改写旧陈述的方式。

`/graph` 命令是随包提供的消费者：`/graph "Project X"` 列出该实体的连接，`/graph "Project X" worked_on` 回答单个关系。多词实体需加引号；多出的未加引号词会报用法错误，而不是悄悄只取部分名称。

本插件同时也是图谱的生产者。与 `dsh-evolution-heartbeat` 一起挂载时，它会缓冲每个作用域内用户与助手消息的文本，并注册 `evolution-graph-extract` 任务：每经过 `intervalHours`，该任务会提取自上次运行以来累积了文本的每个作用域，并随之清空该作用域的缓冲。因此空闲的作用域不产生任何模型调用。`intervalHours` 本身并不决定何时运行：该任务不传自己的空闲阈值，所以还须先经过引擎全局的 `minIdleHours`（默认 2）；在此之外，除非配置了 `provider` 与 `model`，一次运行还需要该作用域中存在一个能报告请求路由的存活会话。若宿主从不空闲那么久，就什么也不会被提取，而其缓冲会持续丢弃最旧的文本以留在 `maxInputBytes` 之内。未挂载心跳引擎时，本包仍可观察、读取与按需提取；缺失的只是自动巡扫。

### 配置

上界、查询边界、提取路由，以及自动巡扫的节奏与作用域命名空间，都是可在 `cordis.yml` 中修改的、经过校验的 `Config` 成员。

```yaml
- name: '@deepseek-ai/dsh-evolution-graph'
  config:
    provider: deepseek
    model: deepseek-chat
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `maxNodes` | `500` | 每个作用域保留的节点数；超出的新实体会被拒绝 |
| `maxEdges` | `2000` | 每个作用域保留的关系数；超出的新关系会被拒绝 |
| `maxClaims` | `500` | 每个作用域保留的声明数；超出的新陈述会被拒绝 |
| `maxQueryLimit` | `20` | 单次作答、展开、查找或声明查询可返回的结果数 |
| `maxInputBytes` | `131072` | 单次提取调用的文本预算（UTF-8 字节） |
| `maxOutputTokens` | `1024` | 单次提取调用的输出 token 上限 |
| `timeoutMs` | `60000` | 单次提取调用的截止时间 |
| `intervalHours` | `6` | 两次自动提取运行之间相隔的小时数 |
| `profile` | `default` | 作用域身份命名空间；必须与读取本图的各消费者所用 profile 一致 |
| `provider` | 未设 | 提取路由；与 `model` 同时设置 |
| `model` | 未设 | 提取模型；设置 `provider` 时必需 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-evolution-graph)是每个可接受字段的详尽来源。

当 `provider` 与 `model` 均未设置时，自动运行会取该作用域被缓冲的会话中第一个能报告请求路由的会话所用的路由，与 `dsh-evolution-reviewer` 使用同一回退；两种来源都解析不出路由的作用域会保留其缓冲，留待下次运行。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部——点击展开</summary>

### 设计概念

每个作用域在存储域 `evolution_graph`（版本 `1`、布局 `per-record`、表 `records`）中占一条持久记录，以该作用域的存储键为键。身份即大小写折叠并去空白后的标签，因此 `Project X` 与 `project x` 是同一实体；出于同样原因，关系名被归一化为小写蛇形。边的键由源、关系与目标三者共同构成。

每个节点都由某个三元组创建，因此不存在引用缺失节点的边：遍历永远不必修复悬空的图。仍可能报告节点缺失的两处查找都加了守卫，并在覆盖率上以该不变量为名标记为不可达。

声明的身份就是其规范化后的陈述，因此同一事实只要拼写相同就是同一条声明，其 `statement` 在首次断言时即固定。改正后的陈述因此是第二条声明而非一次编辑——正因如此，`supersedes` 与 `derived_from` 和 `retiredBy` 一样按身份寻址声明。`observed_in → trace` 记录的是该声明被观察到的会话 id，也就是 `dsh-evolution-trace` 为轨迹建键所用的身份，因此两个存储指的是同一件事。声明字段是在记录已开始存储之后才加入的，因此它在记录 schema 中是一个带默认值的数组：在它之前写入的图会原样打开、不带任何声明，这次形变无需提升版本号。

### 信念

`confidence` 是推导出来的，绝不来自外部输入：代码存储分解后的六个字段（`evidenceQuality`、`sourceReliability`、`independentSupport`、`contradictionCount`、`recency`，以及推导出的 `confidence`），因此消费者能看到一条声明"为何"被相信，而不只是"有多"被相信。支持性证据贡献其最强的证据质量与最受信任的来源，乘以 `n / (n + 1)`（n 为互相独立的支持来源数），再除以 1 加上互相独立的矛盾来源数。饱和因子使后续独立来源的边际贡献递减、且任何单一计数都无法到达 `1`；除法使一次矛盾必定压低它所落到的那条声明的信念。`recency` 只被记录、不参与加权——仅因时间流逝而降低对某事实的信任，需要一个这个纯折叠所没有的时钟。

证据按来源合并：已在该声明上的来源只更新 `count` 与 `lastAt`，并保留它首次作证时的质量与可靠性。因此重复提取无法靠反复读取同一份文档、同一个会话或同一个模型来抬高信念，而正是这种反馈回路被规范的 §20 禁止。

### 上界

两个上界都在写入时而非读取时生效：一旦作用域已满，`observe` 会拒绝新的实体或关系并在 `skipped` 中报告，因此饱和的作用域仍能凭已有内容作答，而不是让调用方失败。`recordClaims` 以 `maxClaims` 套用同一规则，并且在上限处仍会更新作用域已持有的声明。查询上界限制的是单次遍历或声明查询返回多少，而不是存储多少。

### 失败与恢复

无效记录会让域打开时大声失败：丢失关系计数会悄悄改变遍历认定哪条连接最强的结果。存储启动前的读取会抛错。半设置的提取路由在加载时失败。提取在该边界校验模型的答案——无法解析的 JSON、非对象、缺少数组，或失败与被中止的收尾，全部拒绝；被拒绝的提取不写入任何内容。自动巡扫在保持逐作用域隔离之后会作出报告：每个失败的作用域连同其原因被汇总进一个聚合错误，因此永久失败的路由会出现在心跳的记账里，而不是表现为一次悄悄丢弃了文本的运行。

声明层的生产者是 `dsh-evolution-memory` 在决策批次已持久化之后发出的 `evolution/decisions-applied` 事件。此时经验已存好，因此声明写入失败只会被记录并丢弃，而不会抛回给发布它的那次记忆写入。声明是派生状态：丢掉一条的代价是一次折叠，而不是一个事实。

不发布 invariant 伴生包：域表是这份状态的唯一副本，不存在可供核对的第二个独立观测。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [演进式 Harness 子系统](../../../docs/subsystems/evolutionary-harness.zh.md)——自学家族背后的行为契约。
- [evolution 包导览](../README.zh.md)——本分组的软件包及其仓库位置。
- [`dsh-evolution-reviewer`](../evolution-reviewer/README.zh.md)——从回合中提炼经验的同类提取。
- [`dsh-evolution-memory`](../evolution-memory/README.zh.md)——经验存储；本包把它的决策批次折叠为声明。
- [生成的配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-evolution-graph)——每个可接受的配置字段。

-----

<a id="model-experience"></a>
## 模型体验

### 请求上下文与条件

#### 模型看到什么

一条用户消息，携带裁剪后的源文本，以及一段要求只输出 JSON 的固定系统提示：一个对象，内含 `triples` 数组，元素由 `from`、`relation`、`to` 与可选的种类构成。答案中出现工具调用会让该次提取被拒绝。

#### Token 影响

有上限：每次提取一次请求，受 `maxInputBytes` 的源文本与 `maxOutputTokens` 的补全约束；一次自动运行会为每个有缓冲文本的作用域发出一次这样的请求，空闲作用域则不发。遍历与所有读取都不调用模型。声明层不产生自己的请求：它折叠的是 `dsh-evolution-memory` 已经提取出的决策批次，因此填充它是免费的。

#### KV Cache 影响

独立于在线请求：提取是一次独立的一次性调用，拥有自己的前缀，因此不会使会话上的 provider 缓存复用失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制界定了图谱不适合的场景。它们是当前包约束。

- **被缓冲的文本有四条丢失途径**——自动巡扫在提取该作用域的那一次运行中消耗其缓冲，因此若进程在此之前重启，自上次运行以来观察到的文本会丢失；缓冲区超过 `maxInputBytes` 时，最旧的消息会被丢弃以腾出空间；单条消息若大于整个预算则会被整体拒绝而非截断，因此它根本不会被缓冲，后续运行也无从触及；而提取失败的调用会消耗其批次而非重试，因此模型未能提取的文本会在巡扫错误中报告并被丢弃，而非重新提取。窗口受空闲门控的巡扫间隔约束——见上文，即 `intervalHours` 加上引擎的 `minIdleHours`——并受字节上限约束。
- **关系不做语义去重**——`worked_on` 与 `workedOn` 会归一化成两个不同关系，也没有任何东西合并近义词。
- **关系边仍然只是计数**——后来的资料否证它时，边仍保留其计数，因为可被否证的是建立在它之上的声明，而不是"读到过这条关系"这一记录。否证与被取代发生在声明层：`contradicts` 压低声明的信念，`supersedes` 使其退役。没有任何声明去断言的关系，仍然只是频次。
- **信念是排序而非概率**——`confidence` 就是那份写在文档里的、作用于分解字段的公式，而 `recency` 只被记录、不参与加权，因此两个作用域的声明只能经由各自的证据相互比较。它给声明排序，并不估计某条声明为真的可能性。
- **声明层只折叠提取决策**——声明来自 `recordClaims` 与评审器的批次。手工写入的经验（控制器的 `setLessons`）、在界面里修补过的工件、或被衰减剪除的工件，都不会改动声明，因此声明可能比它来源的那条经验活得更久。
- **`usedBy` 在仓库内没有写入方**——当调用方知道哪项技能或策略在消费某条声明时，效用边经 `recordClaims` 记录；本仓库中尚无任何代码写入它，因此下游效用是本图能够表达、而非能够观测的一条连接。
- **被存储合并进同义表述的候选仍声明自己的陈述**——声明层按模型报告的陈述为 `new` 决策建键，而存储可能已把该候选折进一个相似的工件。此后被合并工件的声明只持有寻址到它自己的证据。
- **尚不存在的被取代目标不会被退役**——没有声明就没有可退役之物，而后来才创建的声明不会再去核对已记录的 `supersedes` 列表。
- **遍历是无向的**——`expand` 双向行走，因此会把入边当作出边报告，并且报的是关系名而非其反向名。
- **上限是硬性的**——作用域一旦达到 `maxNodes`、`maxEdges` 或 `maxClaims`，新实体或新陈述会被丢弃，而不是淘汰连接最少或信念最低的那些。
- **提取不是增量的**——`extract` 只读取交给它的文本，不与该图已有内容做对账。
- **仅存于本机**——图谱位于 `$DSH_HOME` 之下，绝不写入项目目录。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>面向维护者的工作上下文——点击展开</summary>

把 `extract` 接进评审器既有的确定性调用可以去掉第二条提取路径，代价是把那段提示的契约从"一份文档"扩大到"文档加三元组"。尚无设计负责人。

</details>
