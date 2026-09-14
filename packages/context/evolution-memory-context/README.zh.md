---
description: "Evolution memory brief injector with scope nudges (agent pre-step), for hosts composing the self-learning harness."
kind: "package-reference"
---

# @deepseek-ai/dsh-evolution-memory-context

[English](README.md) | 中文

## 概述

`dsh-evolution-memory-context` 把作用域的指令、经验、画像与附加上下文渲染成一条持久 `user/message` 简报，拼接到 `agent/pre-step`——记录摘要变化时替换简报，不变时什么也不加。它还在系统提示背后注册演进提示分节；容量用量只在简报头部报告，永不插值进系统提示，因此一次记忆写入无法使请求的缓存前缀失效。当同一作用域的每个会话都应看到该作用域的共享知识、且不希望每回合重读存储时，选择本包。

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

两个字段都必填：部署方必须选定简报可承担的成本，以及它服务的作用域命名空间。两个提示节奏区间可选，默认采用随附节奏。

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
| `memoryNudgeInterval` | `1` | 作用域收窄提示之间的回合数 |
| `skillNudgeInterval` | `10` | 经验转技能提示之间的回合数 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-evolution-memory-context)是每个可接受字段的详尽来源。

### 预算与摘要

空分节省略，全空记录不注入。压力之下先丢弃尾部上下文条目，再整体丢弃最弱的经验工件——按置信度从强到弱，置信度相同则以 id 升序定序，且经验永不从中间截断——然后在经验已清空的前提下截断画像，最后截断指令；一行通知列出每次丢弃与截断，文件字节在注入时重读，记录的大小保持快照。摘要仅覆盖指令、经验、画像与上下文，因此产出索引与暂存写入永不触发重注。

被召回的上下文材料——标签以存储的 `RECALL_LABEL_PREFIX` 开头的条目——渲染在用户附加的每个条目之后，因为渲染器最先丢弃尾部上下文，而被召回材料让位于用户附加的任何内容。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部——点击展开</summary>

### 设计概念

注入器把记录摘要与最新可见的 `evolution-memory` 简报比较：先查按会话的内存标记，再查已认领批次，再经由异步会话查询面查已记录表层。归属同样解析并按会话 id 缓存，在 `session/disposed` 时失效。按会话统计已观测 `turn/start` 事件的计数器门控提示节奏，并随同一生命周期清除。没有任何逻辑同步扫描会话历史，因此恢复后的会话贡献其被观测到的后缀，重启后经由查询面重新解析而不是重复简报。

### 源码导览

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：pre-step 注入、归属缓存、文件物化、分节接线 |
| [`src/render.ts`](src/render.ts) | 字节预算内的纯简报渲染 |
| [`src/sections.ts`](src/sections.ts) | 提示分节文本（静态——无插值）、技能工具可见性、回合间隔判定 |

### 失败与恢复

缺失或不可读的文件退化为一行 `Context "<label>" is unavailable (<path>).` 提示，步骤继续。表层读取失败退化为注入而不阻塞回合。畸形 `profile` 与非正数或非整数的提示间隔在插件加载时大声失败。监听器观察最终认领批次并展开下游决策，保留 `startsRequestSeries`。

不发布 invariant 伴生包，因为注入器不拥有自己的持久状态：简报在每次 pre-step 从存储记录派生，存储背后的域表是唯一的持久副本。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [演进式 Harness 规范](../../../specs/evolutionary-harness-spec-v10-complete.md)——本包实现的行为契约。
- [context 组地图](../README.zh.md)——相邻的请求上下文包；本包位于 `context/` 分组，与 workspace 对应物并列。
- [生成的配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-evolution-memory-context)——每个可接受的配置字段。

-----

<a id="model-experience"></a>
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

三个提示分节：`evolution-lessons-skills`、`evolution-memory-scope`、`evolution-session-search`——全部为固定文本，无插值。技能提示仅在可见的 `skill_manage` 工具旁、且回合数恰为 `skillNudgeInterval` 的整数倍时渲染；作用域提示仅在回合数为 `memoryNudgeInterval` 整数倍时渲染；会话搜索提示始终渲染。尚无已观测回合的会话按其第一回合计，因此间隔为 `1` 的作用域提示会在它之前渲染，而更宽的间隔要等到自己的倍数。

##### 本字段原文（如需）

```markdown
To recall earlier work in this scope, search past sessions before asking the user to repeat context.
```

#### Token 影响

按节奏有界：每次组装一条会话搜索提示、每 `memoryNudgeInterval` 回合一条作用域提示、在 `skill_manage` 可见时每 `skillNudgeInterval` 回合一条技能提示。

#### KV Cache effect

与记忆内容无关地保持前缀稳定：分节文本固定且不带任何按作用域的值，因此提示集合只在间隔回合变化，永不因一次记忆写入而变化。容量用量只在简报头部报告（见上），而它本就经由自身的摘要门控替换——一次记忆写入无法使本层级的缓存前缀失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制界定了注入器不适用的场景。它们是当前包约束。

- **提示节奏只计进程已观测的回合**——区间计数器从插件加载时起算、随会话释放清除，因此加载前或宿主重启前的回合不会被重放，恢复后的会话从其第一个已观测 `turn/start` 重新开始。
- **一次一条简报**——记录变化追加完整替换；被取代的简报累积，直到压缩将其遮蔽。
- **文件上下文每次刷新重读**——预算约束模型字节，不约束磁盘读取。
- **文件容量快照**——磁盘文件变化时，不刷新记录的大小。
- **无按会话文件读取器**——文件条目相对进程文件系统解析，而非 workspace 作用域读取器。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>面向维护者的工作上下文——点击展开</summary>

无。

</details>
