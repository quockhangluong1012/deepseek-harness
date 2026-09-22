---
description: "Evolution memory brief injector with condition-driven nudges (agent pre-step), for hosts composing the self-learning harness."
kind: "package-reference"
---

# @deepseek-ai/dsh-evolution-memory-context

[English](README.md) | 中文

## 概述

`dsh-evolution-memory-context` 让同一作用域的每个会话都得到一条持久 `user/message` 简报，内容取自该作用域的指令、经验、画像与附加上下文，并拼接进 `agent/pre-step`——记录变化时替换简报，不变时什么也不加。简报声明 `supersedes`，因此模型读的是当前生效的这一条，而日志保留注入过的每一条；容量用量只在简报头部报告，所以一次记忆写入不会使请求的缓存前缀失效。当同一作用域的会话应共享知识、且不希望每个轮次都重读存储时，选择本包。`maxBytes` 为必填，并限制整条简报。

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

与记忆存储和 workspace 注册表一起挂载本插件。作用域按回合从 workspace 归属解析（注册表会话 id，退回规范化 `cwd` 匹配），归属到必填的 `profile` 之下；作用域之外的回合什么也不加。

### 配置

`maxBytes` 与 `profile` 必填：部署方必须选定简报可承担的成本，以及它服务的作用域命名空间。提示节奏与两个条件阈值可选，默认采用随附取值。

```yaml
- name: '@deepseek-ai/dsh-evolution-memory-context'
  config:
    maxBytes: 16384
    profile: default
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `maxBytes` | 必填 | 完整输出文本（含框架）的上限 |
| `profile` | 必填 | 作用域标识命名空间，置于 workspace 键之前 |
| `memoryNudgeInterval` | `1` | 记忆域提示的节奏上限：某条件触发后，在这么多回合内保持沉默 |
| `skillNudgeInterval` | `10` | 技能域提示的节奏上限：某条件触发后，在这么多回合内保持沉默 |
| `stagedWriteWaitMinutes` | `1440` | 暂存写入等待多久后，记忆提示才会点名它 |
| `failureSignalScanLimit` | `20` | 单次提示评估所评级的失败信号条数 |
| `capacityWarnPct` | `0.8` | 用量达到或超过该比例时简报头警告进行合并 |

`memoryNudgeInterval` 与 `skillNudgeInterval` 曾是触发器——在每个整数倍回合渲染提示。现在它们是记录条件（`conditions.ts`）之上的节奏上限，这正是 §53 的升级：证据成立时提示触发、无证据时保持沉默，区间只限制一个持续成立的条件重复的频率。已设置这两个字段的宿主保留原数值，并获得新语义。

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-evolution-memory-context)是每个可接受字段的详尽来源。

### 预算与摘要
空分节省略，全空记录不注入。压力之下先丢弃尾部上下文条目，再整体丢弃最弱的经验工件——按置信度从强到弱，置信度相同则以 id 升序定序，且经验永不从中间截断——然后在经验已清空的前提下截断画像，最后截断指令；一行通知列出每次丢弃与截断，文件字节在注入时重读，记录的大小保持快照。摘要仅覆盖指令、经验、画像与上下文，因此产出索引与暂存写入永不触发重注。用量达到 `capacityWarnPct` 后，头部会携带接近容量警告，要求模型合并而非新增，早于存满时的硬拒绝。

被召回的上下文材料——标签以存储的 `RECALL_LABEL_PREFIX` 开头的条目——渲染在用户附加的每个条目之后，因为渲染器最先丢弃尾部上下文，而被召回材料让位于用户附加的任何内容。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部——点击展开</summary>

### 设计概念

注入器把记录摘要与最新可见的 `evolution-memory` 简报比较：先查按会话的内存标记，再查已认领批次，再经由异步会话查询面查已记录表层。归属同样解析并按会话 id 缓存，在 `session/disposed` 时失效。按会话统计已观测 `turn/start` 事件的计数器提供提示节奏所测量的回合数，而每个条件最后一次触发的回合按会话与条件分别记录；两者随同一生命周期清除。没有任何逻辑同步扫描会话历史，因此恢复后的会话贡献其被观测到的后缀，重启后经由查询面重新解析而不是重复简报。

### 源码导览

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：pre-step 注入、归属缓存、文件物化、存储读取与分节接线 |
| [`src/render.ts`](src/render.ts) | 字节预算内的纯简报渲染 |
| [`src/sections.ts`](src/sections.ts) | 提示分节注册、技能工具门控与节奏判定 |
| [`src/conditions.ts`](src/conditions.ts) | 记录条件、其后端为存储的评估器，以及各条件的行渲染 |

### 失败与恢复

缺失或不可读的文件退化为一行 `Context "<label>" is unavailable (<path>).` 提示，步骤继续。表层读取失败退化为注入而不阻塞回合。畸形 `profile`、非正数或非整数的提示间隔、非整数或为零的 `failureSignalScanLimit`、以及负数 `stagedWriteWaitMinutes` 在插件加载时大声失败。未挂载的演化存储会让它自己的条件变为不可评估，而不是静默判定为成立或静默缺席，其渲染的行会点名该存储。监听器观察最终认领批次并展开下游决策，保留 `startsRequestSeries`。

不发布 invariant 伴生包，因为注入器不拥有自己的持久状态：简报在每次 pre-step 从存储记录派生，存储背后的域表是唯一的持久副本。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [演进式 Harness 子系统](../../../docs/subsystems/evolutionary-harness.zh.md)——本包实现的行为契约。
- [context 组地图](../README.zh.md)——相邻的请求上下文包；本包位于 `context/` 分组，与 workspace 对应物并列。
- [生成的配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-evolution-memory-context)——每个可接受的配置字段。

-----

<a id="model-experience"></a>
### 记录条件

| 条件 | 所读证据 | 成立时的行 |
|---|---|---|
| `staged-writes` | `ctx.evolutionMemory.read(scope).staged`——该作用域待决的暂存写入，最旧在前 | 存在早于 `stagedWriteWaitMinutes` 的待决写入；`run /memory pending` |
| `contradicted-claims` | `ctx.evolutionGraph.claims(scope)`——活跃主张，证据最强在前 | 带有相反证据的活跃主张；`run /claims` |
| `skill-trust` | `ctx.evolutionSkillTelemetry.entries()`——每个受跟踪技能一条记录 | 在记录到一次降级后仍停留在 provisional 信任的技能；`run /curator status` |
| `failure-signals` | `ctx.evolutionFeedback.signals(workspace 会话 id, failureSignalScanLimit)` | 由存储自身评为 `trigger_review` 的信号；用 `skill_manage` 记录可持久经验 |
| `holdout-gaps` | `ctx.evolutionBenchmark.tasks()`——每个任务及其状态 | 处于评估中却没有 holdout 任务的能力；`run /benchmark` |

`memoryNudgeInterval` 与 `skillNudgeInterval` 是节奏上限而非触发器：已触发的条件在观测到这么多后续回合之前保持沉默，而条件触发的回合按会话与条件分别记录，因此同一回合内的多次组装结果一致。存储未挂载的条件属于不可评估，而非成立或静默缺席，其行会点名该存储（`<subject> cannot be checked: the <store> store is not mounted.`）。不属于任何 workspace 的会话没有作用域，因此两个作用域绑定的条件在此保持沉默，而全局条件仍然渲染。

## 模型体验

### 请求上下文与条件

#### 模型所见

一条持久 `user/message` 承载组帧后的简报：作用域标题、目录、`Memory usage: used/cap (pct%)` 头，以及非空的 `Instructions`、`Lessons`、`User profile` 与逐条 `Context: label` 分节；有丢弃或截断时附一行预算通知。`Lessons` 分节为每个存储的工件渲染一行——`- <statement> (confidence: 0.82)`——按强度从强到弱：置信度降序，置信度相同则以 `id` 升序定序，因此同一记录总是渲染出同一顺序。预算压力下最弱的工件整体丢弃；连一个都放不下时该分节被整体省略，而不是发出一条被截断的 statement。

##### 本字段原文（如需）

```markdown
<system-reminder>
```

#### Token 影响

带上限：每次摘要变化至多一条简报，受含框架的 `maxBytes` 约束；记录不变时零 token。

#### KV Cache effect

前缀稳定：记录不变时简报追加在认领批次之后，重复的相同简报保留可复用前缀；记录变化则替换，并从该点起使复用失效。

### 提示分节

#### 模型所见

三个提示分节：`evolution-memory-scope`、`evolution-lessons-skills`、`evolution-session-search`。前两者承载 §53 的记录条件而非固定文本：每行点名触发的条件、其计数，以及可据以行动的界面；当分节没有任何条件成立时，它什么也不渲染。技能分节仅在可见的 `skill_manage` 工具旁渲染，因为其中一行要求模型用该工具记录经验。

##### 本字段原文（如需）

```markdown
To recall earlier work in this scope, search past sessions before asking the user to repeat context.
```

#### Token 影响

受节奏上限约束：每个条件在每 `memoryNudgeInterval` / `skillNudgeInterval` 回合内至多一行，外加每次组装一条会话搜索提示。每行是一句话，点名计数、条件，以及可据以行动的界面——触发的条件列于上表，且都不引用记忆文本。

#### KV Cache effect

在条件状态不变时保持稳定：各行只携带计数、时刻与存储标识，因此单独一次记忆写入不会改变本层级，条件既未开始也未停止成立时同样不变。条件开始或停止成立会从该点起改变本层级，这正是“一则言之有物的提示”应付出的代价。容量用量只在简报头部报告（见上），而它本就经由自身的摘要门控替换。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制界定了注入器不适用的场景。它们是当前包约束。

- **提示节奏只计进程已观测的回合**——回合计数器从插件加载时起算、随会话释放清除，因此加载前或宿主重启前的回合不会被重放，恢复后的会话从其第一个已观测 `turn/start` 重新开始，且重启后的第一个回合可能重复上一个进程已经报告过的条件。
- **表层一条简报，日志保留每一条**——记录变化会提交完整替换，循环在表层取代该作用域此前的简报，而被取代者作为可持久日志记录保留，transcript 与重放仍能看到。在简报声明 `supersedes` 之前已经累积了重复简报的会话，会一直保留到压缩将其遮蔽；新回合不会再增加。
- **文件上下文每次刷新重读**——预算约束模型字节，不约束磁盘读取。
- **文件容量快照**——磁盘文件变化时，不刷新记录的大小。
- **无按会话文件读取器**——文件条目相对进程文件系统解析，而非 workspace 作用域读取器。
- **没有报告就没有提示**——始终生效的“经验转技能”提示已按设计移除：没有失败信号、没有降级技能、没有 holdout 缺口时，技能分节保持为空；没有等待超期的暂存写入、没有主张被反驳时，记忆分节同样为空。想要旧有常驻提示的部署需要把该文本放进自己的分节。
- **未挂载的存储会占用一行提示**——点名缺失存储的提示会按节奏上限重复，直到该存储被挂载；只读取 `evolution-memory` 的部署每个区间会看到四行这样的提示，代替它无法评估的那些条件。
- **作用域绑定的条件需要 workspace**——不属于任何已注册 workspace 的会话没有作用域，因此即便该作用域中确实存在暂存写入与被反驳的主张，也不会向它报告。
- **条件证据在组装时读取**——同一回合两次组装之间的一次存储写入可以改变第二次的分节文本，且所有读取都是同步的：只提供异步答案的存储（目前这五个都不属于此列）无法作为条件。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>面向维护者的工作上下文——点击展开</summary>

无。

</details>
