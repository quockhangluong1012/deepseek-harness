---
description: "知识图谱记忆：按作用域持久化的实体与有向关系，配合有界遍历，以及一次把文本变成三元组的确定性提取（ctx.evolutionGraph）。"
kind: "package-reference"
---

# @deepseek-ai/dsh-evolution-graph

[English](README.md) | 中文

## 概述

`dsh-evolution-graph` 是单个作用域的知识图谱持久记忆：实体与有向关系，按连接遍历而非按相似度匹配。提取是一次 `temperature: 0` 调用，其 JSON 答案在写入任何内容之前先被校验；图谱只保留标签、种类与关系名，绝不保留关系读自哪一句话。再次见到的实体保留首次标签并补上此前缺失的种类，再次见到某关系则提升其计数。可按具名关系作答、广度优先双向展开某实体的邻域，或按标签查找实体。

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
| `maxQueryLimit` | `20` | 单次作答、展开或查找可返回的结果数 |
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

### 上界

两个上界都在写入时而非读取时生效：一旦作用域已满，`observe` 会拒绝新的实体或关系并在 `skipped` 中报告，因此饱和的作用域仍能凭已有内容作答，而不是让调用方失败。查询上界限制的是单次遍历返回多少，而不是存储多少。

### 失败与恢复

无效记录会让域打开时大声失败：丢失关系计数会悄悄改变遍历认定哪条连接最强的结果。存储启动前的读取会抛错。半设置的提取路由在加载时失败。提取在该边界校验模型的答案——无法解析的 JSON、非对象、缺少数组，或失败与被中止的收尾，全部拒绝；被拒绝的提取不写入任何内容。自动巡扫在保持逐作用域隔离之后会作出报告：每个失败的作用域连同其原因被汇总进一个聚合错误，因此永久失败的路由会出现在心跳的记账里，而不是表现为一次悄悄丢弃了文本的运行。

不发布 invariant 伴生包：域表是这份状态的唯一副本，不存在可供核对的第二个独立观测。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [演进式 Harness 规范](../../../specs/evolutionary-harness.spec.md)——自学家族背后的行为契约。
- [evolution 包导览](../README.zh.md)——本分组的软件包及其仓库位置。
- [`dsh-evolution-reviewer`](../evolution-reviewer/README.zh.md)——从回合中提炼经验的同类提取。
- [生成的配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-evolution-graph)——每个可接受的配置字段。

-----

<a id="model-experience"></a>
## 模型体验

### 请求上下文与条件

#### 模型看到什么

一条用户消息，携带裁剪后的源文本，以及一段要求只输出 JSON 的固定系统提示：一个对象，内含 `triples` 数组，元素由 `from`、`relation`、`to` 与可选的种类构成。答案中出现工具调用会让该次提取被拒绝。

#### Token 影响

有上限：每次提取一次请求，受 `maxInputBytes` 的源文本与 `maxOutputTokens` 的补全约束；一次自动运行会为每个有缓冲文本的作用域发出一次这样的请求，空闲作用域则不发。遍历与所有读取都不调用模型。

#### KV Cache 影响

独立于在线请求：提取是一次独立的一次性调用，拥有自己的前缀，因此不会使会话上的 provider 缓存复用失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制界定了图谱不适合的场景。它们是当前包约束。

- **被缓冲的文本有三条丢失途径**——自动巡扫在提取该作用域的那一次运行中消耗其缓冲，因此若进程在此之前重启，自上次运行以来观察到的文本会丢失；缓冲区超过 `maxInputBytes` 时，最旧的消息会被丢弃以腾出空间；而单条消息若大于整个预算则会被整体拒绝而非截断，因此它根本不会被缓冲，后续运行也无从触及。窗口受空闲门控的巡扫间隔约束——见上文，即 `intervalHours` 加上引擎的 `minIdleHours`——并受字节上限约束。
- **关系不做语义去重**——`worked_on` 与 `workedOn` 会归一化成两个不同关系，也没有任何东西合并近义词。
- **关系永不被移除**——被后来的资料否证的边仍保留其计数；只有提高上限或新建作用域才能重新开始。
- **遍历是无向的**——`expand` 双向行走，因此会把入边当作出边报告，并且报的是关系名而非其反向名。
- **上限是硬性的**——作用域一旦达到 `maxNodes` 或 `maxEdges`，新实体会被丢弃，而不是淘汰连接最少的那些。
- **提取不是增量的**——`extract` 只读取交给它的文本，不与该图已有内容做对账。
- **仅存于本机**——图谱位于 `$DSH_HOME` 之下，绝不写入项目目录。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>面向维护者的工作上下文——点击展开</summary>

把 `extract` 接进评审器既有的确定性调用可以去掉第二条提取路径，代价是把那段提示的契约从"一份文档"扩大到"文档加三元组"。尚无设计负责人。

</details>
