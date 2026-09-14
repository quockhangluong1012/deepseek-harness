---
description: "演进 harness 的宿主 Remote 控制器：作用域读写、暂存写入裁决、journey 时间线与按作用域推送的 follow 流（ctx.evolutionController）。"
kind: "package-reference"
---

# @deepseek-ai/dsh-evolution-controller

[English](README.md) | 中文

## 概述

`dsh-evolution-controller` 是演进 Web 面的宿主半边。它在持久化的按作用域记录之上发布 `evolution` Remote 命名空间，并复用 `/journey` 读模型而不是重述它。每个作用域动词都先解析 Workspace，未知者回答 `workspace/not-found`；`follow` 先发布携带全部已注册作用域的一份基线，然后每条持久记录变更推送一次 upsert。读写都不触碰会话日志，本包自身不拥有任何持久状态。

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

当 Web 客户端（或任何 Remote 消费者）必须读取并编辑某个作用域的演进状态、裁决其暂存写入并渲染其 journey 时，把它与 `dsh-evolution-memory` 及 workspace 注册表一起挂载。`dsh-command-evolution` 中的命令仍是 CLI 治理面；两者读取同一条记录。

### 配置

`profile` 为必填：部署方必须指明控制器所服务的作用域命名空间。作用域永不共享默认命名空间。

```yaml
- name: '@deepseek-ai/dsh-evolution-controller'
  config:
    profile: default
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `profile` | 必填 | workspace 键之前的作用域标识命名空间 |

### `evolution` 命名空间

| 动词 | 请求 | 结果 |
|---|---|---|
| `read` | `{ scopeId }` | 作用域的投影记录；没有记录时返回空投影。 |
| `setInstructions` | `{ scopeId, instructions }` | 替换用户撰写的规则并返回投影。 |
| `setLessons` | `{ scopeId, artifacts }` | 整体替换经验工件列表并返回投影；调用方未提供的工件会被丢弃，而不是与新工件并存。 |
| `setProfile` | `{ scopeId, profile }` | 手工替换用户画像文档并返回投影。 |
| `addContextItem` | `{ scopeId, kind, label, text }` 或 `{ scopeId, kind, label, path }` | 附加粘贴文本或 Workspace 内的真实文件。 |
| `removeContextItem` | `{ scopeId, itemId }` | 分离一条上下文条目。 |
| `rebuildMemory` | `{ scopeId }` | 经由已挂载的评审器重建经验。 |
| `listStaged` | `{ scopeId }` | 待裁决的暂存写入，最早的在前。 |
| `approveStaged` | `{ scopeId, stagedId }` | 应用一条暂存写入并丢弃它。 |
| `rejectStaged` | `{ scopeId, stagedId }` | 不应用而丢弃一条暂存写入。 |
| `timeline` | `{ scopeId, range }` | `today`、`7d`、`30d` 或 `all` 的 `/journey` 时间线。 |
| `follow` | 流 | 先一份携带全部已注册作用域的基线，然后每条变更记录一次 upsert。 |

`scopeId` 是该作用域所键的 Workspace 身份；控制器用配置的 `profile` 为其加命名空间，因此客户端从不自行给出 profile。

控制器不新增任何错误词汇：缺失 Workspace 是 `workspace/not-found`，畸形的上下文请求是 `gateway/bad-request`，未知时间线区间是 `gateway/bad-request`，重复裁决一条暂存项是 `evolution/staged-not-found`，未挂载评审器时的重建是 `evolution/extraction-failed`。

### 组合控制器

```yaml
- name: '@deepseek-ai/dsh-workspace'
- name: '@deepseek-ai/dsh-evolution-memory'
  config:
    capacityBytes: 131072
- name: '@deepseek-ai/dsh-evolution-reviewer'
- name: '@deepseek-ai/dsh-evolution-controller'
  config:
    profile: default
```

在 Remote 边界上评审器是可选的：没有它时除 `rebuildMemory` 外的每个动词仍可工作，而重建会报告缺失的 seam，而不是不透明地失败。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释控制器背后的设计决策；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计理念

- **一条记录，两个界面。** 控制器读写 CLI 命令所治理、注入器所渲染的同一份持久记录；它既不缓存也不分叉状态，因此存储仍是唯一权威。
- **读模型只存在一处。** `scopeTimeline` 从 `dsh-command-evolution` 导入，因此 `/journey` 文本与时间线动词绝不可能对同一个桶给出不同说法。
- **始终作用域优先。** 每个动词在触碰存储前先经由注册表解析 Workspace，因此未知作用域以 `workspace/not-found` 失败，而不会写入一个凭空构造的键。暂存裁决还额外证明该条目属于已解析的作用域：另一个作用域的 id 会被报告为不存在，绝不裁决。
- **每次流调用一代。** `follow` 产出完整基线，然后是增量；传输中断即结束该代，由 `RemoteStream` 带自己的新基线开启下一代。此处不承担任何重连簿记。
- **投影是分离的。** 每个结果都是全新结构，因此消费者无法通过持有返回值改动持久记录。

### 作用域解析与 follow 流

作用域键是 `profile:workspaceId`。feed 订阅 `domain/changed`，只保留 `evolution_memory.records` 的写入，忽略墓碑，通过重新计算该 Workspace 的存储键把记录键映射回已注册的 Workspace（因此其他 profile 的记录、以及 profile 级的 `global` 记录都会被忽略），并为每个 follower 推送一次 upsert。follower 由所属 context 的拆除关闭，进行中的代也随之结束。

### 文件上下文条目

`file` 上下文条目在存储前先被解析：相对路径相对 Workspace 根解析，两侧都规范化，目标必须是 Workspace 内的常规文件，并记录观测到的尺寸。此后对该条目的读取是注入器的事；控制器从不重读文件。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 服务入口：`evolution` Remote 动词、作用域解析、follow feed 与文件解析 |
| [`src/types.ts`](src/types.ts) | Remote 请求、结果与流词汇，并再导出存储的记录类型 |
| — | 不发布运行时不变式伴随条目：该服务自身不持有任何状态，存储拥有唯一的持久域表，feed 只投影它观察到的写入。 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。

- [演进式 Harness 规范](../../../specs/evolutionary-harness.spec.md)——Remote 命名空间背后的行为契约。
- [evolution 组地图](../README.zh.md)——本分组的包及其仓库位置。
- [演进记忆存储](../evolution-memory/README.zh.md)——每个动词所读写的持久记录。
- [演进命令](../command-evolution/README.zh.md)——CLI 治理面与共享的 `/journey` 读模型。
- [改进路线图](../../../specs/improvement.spec.md)——本包落地的 Phase 6 控制器切片。

-----

<a id="model-experience"></a>
## 模型体验

### 演进控制器（人类界面）

#### 模型看到的内容

并不直接看到：`evolution` 命名空间服务于人类与 Web 消费者，模型可见的演进简报由 `dsh-evolution-memory-context` 从本控制器所编辑的记录渲染。一次 `setLessons` 或 `setProfile` 写入会像直接存储写入一样改变下一份简报。

#### Token 影响

该命名空间不增加模型 token。请求只携带人类界面提供的字段。

#### KV Cache 影响

自身无影响。已批准或手工编辑的文档会从下一份注入简报起使复用失效，与直接存储写入完全一致。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制说明控制器何时不合适；它们是当前包约束。

- **没有调度或触发器**——控制器只提供读取、写入、裁决与时间线；后台评审、重建调度与技能整理各有其拥有者。
- **每个动词一个作用域**——除 `follow` 外每个动词只针对一个 Workspace 的作用域；`follow` 是唯一的跨作用域读取。
- **重连是传输层的职责**——一次 `follow` 调用就是一代。`RemoteStream` 以全新基线重开；本包不做任何重试。
- **附加文件的尺寸是观测值而非保证**——文件条目记录附加时看到的尺寸，且永不刷新，与存储一致。
- **评审器是独立挂载项**——未组合评审器时 `rebuildMemory` 回答 `evolution/extraction-failed`，而不是退化为部分重建。
- **Web 界面是独立包**——本包只交付宿主面；journey 页面及其由 locale 拥有的文案位于客户端包中。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文，明确不具权威性；已交付行为以上文、包代码与所链接的 Agent Note 为准。

- **读模型跨包导入是有意为之**——`scopeTimeline` 位于 `dsh-command-evolution`，因为 CLI 先交付。如果出现第三个消费者，该模型就值得拥有自己的包；在那之前，一次导入胜过两份副本。
- **客户端 Remote 面不在此处**——`RemoteStream` 与页面动词属于消费该命名空间的 Web 客户端包。

</details>
