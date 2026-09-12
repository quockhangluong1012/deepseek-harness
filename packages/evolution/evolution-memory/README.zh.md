---
description: "Durable per-scope evolution memory record with lessons/profile writes, staged writes, and capacity accounting (ctx.evolutionMemory), for hosts composing the self-learning harness."
kind: "package-reference"
---

# @deepseek-ai/dsh-evolution-memory

[English](README.md) | 中文

## 概述

`dsh-evolution-memory` 拥有演进记忆背后的持久化按作用域文档：用户编写的指令、模型维护并带来源记录与分族时间戳的经验与用户画像文档、附加的文本与文件上下文条目、产出文件索引、等待审批的暂存写入，以及按最新优先排列的已决暂存条目日志。Host 同步读取，并通过带上限的写入进行修改；评审器与注入器包消费它。当同一作用域中的每个会话都应继承可在使用中不断改进的共享知识、且不向项目内写入时，选择本包。

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

当同一作用域中的会话应共享指令、经验、画像与上下文时挂载本插件。作用域标识是以 `EvolutionScopeId` 构造的不透明 `profile:workspaceId`（或 `profile:global`）键。JSON 后端经由 `storageKey()` 将每个作用域存于 `evolution_memory/records/<profile>--<workspaceId>.json`，因为 `:` 不是路径安全字符。读取从已校验的内存同步进行；写入在进入写入链之前强制执行字节上限，并盖上 `updatedAt`。

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
| `maxAgentBytes` | `65536` | 经验文档上限 |
| `maxUserBytes` | `32768` | 用户画像文档上限 |
| `maxContextItemBytes` | `262144` | 单条目上限，同时是文件条目观测大小的上确界 |
| `maxContextItems` | `50` | 条目数量上限 |
| `maxOutputs` | `200` | 产出文件索引规模 |
| `maxResolutions` | `200` | 每个作用域保留的已决暂存条目数 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-evolution-memory)是每个可接受字段的详尽来源。

### 容量与摘要

容量为 `instructions` 加 `agentLessons` 加 `userProfile` 的 UTF-8 字节长度，再加 `contextItems[].sizeBytes` 之和。产出索引与暂存写入不计入。摘要仅覆盖指令、经验、画像与上下文条目；产出、暂存与时间戳永不使已注入的简报失效。缺席记录读作 `undefined`、占用零字节、摘要为 `'empty'`。

### 经验、暂存写入与决策

`addLesson` 追加一条经验，完全重复时直接返回而不写入。`replaceLesson` 与 `removeLesson` 接受一个期望恰好出现一次的子串：未知子串以 `evolution/item-not-found` 拒绝，歧义子串以携带有限摘录的 `evolution/ambiguous-match` 拒绝。`stageWrite` 暂存一条记忆或技能提案而不触碰容量；`approveStaged` 先应用记忆操作（上限拒绝时保留条目），仅移除技能条目；`rejectStaged` 直接丢弃任一条目。

暂存载荷是一个 JSON 值，并在写入边界处校验：无法无损往返 JSON 的载荷会被大声拒绝，且不存储任何内容。

两种决策都会把一条决策记录——条目 id、kind、op、gist、决策、来源会话与时刻——追加到记录的 `resolutions` 日志（最新优先，受 `maxResolutions` 限制）。决策记录既不计入容量，也不进入摘要，因此决定一次写入永不重新注入简报。

每个记忆族各自盖自己的时间戳：`setInstructions` 盖 `instructionsUpdatedAt`，`setLessons` / `addLesson` / `replaceLesson` / `removeLesson` 这一族盖 `lessonsUpdatedAt`，`setUserProfile` 盖 `profileUpdatedAt`。暂存审批只为它改动的族盖章，重复追加经验则一个都不盖。`memoryUpdatedAt` 再保留一个版本，取经验与画像两个时间戳中的较晚者。每次被接受的写入都盖上 `updatedAt`。

被召回的上下文材料——评审器的排序召回——就是普通的上下文条目，其标签以导出的 `RECALL_LABEL_PREFIX` 开头，因此摘要覆盖它，简报也最先丢弃它。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部——点击展开</summary>

### 设计概念

存储域 `evolution_memory`（版本 `1`、布局 `per-record`、表 `records`）中每个作用域一条持久记录，以 `EvolutionScopeId` 为键。非法记录会导致域打开时大声失败：指令是用户编写的，不是可丢弃的派生数据。没有全局槽，也没有迁移机制。

### 源码导览

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`EvolutionMemoryStore` 服务、上限、写入路径、暂存审批 |
| [`src/spec.ts`](src/spec.ts) | 域声明：记录模式与 `defineDomain` 规范 |
| [`src/types.ts`](src/types.ts) | 公共记录、上下文条目、产出、来源与暂存写入类型 |
| [`src/digest.ts`](src/digest.ts) | 摘要、容量、字节长度与裁剪助手 |

### 失败与恢复

被拒绝的写入永不改变记录。`addContextItem` 在超过条目数量或容量时以 `evolution/capacity-exceeded` 拒绝；`removeContextItem` 遇到未知 id 以 `evolution/item-not-found` 拒绝。字段上限以 `evolution/too-large` 报告字段、观测字节与上限。歧义经验子串以 `evolution/ambiguous-match` 报告所查文本与至多五条摘录。未知暂存 id 在审批与驳回时均以 `evolution/staged-not-found` 报告。`recordOutputs` 在列表无变化时直接返回而不写入，因此幂等的回合不会产生 `domain/changed` 抖动。

不发布 invariant 伴生包，因为域表是该状态的唯一副本，不存在第二个可供核对的独立观测。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [演进式 Harness 规范](../../../specs/evolutionary-harness.spec.md)——本包实现的行为契约。
- [evolution 包导览](../README.zh.md)——本分组的软件包及其仓库位置。
- [生成的配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-evolution-memory)——每个可接受的配置字段。

-----

<a id="model-experience"></a>
## 模型体验

通过 `@deepseek-ai/dsh-evolution-memory-context` 间接呈现，由它把存储的指令、经验、画像与上下文渲染进注入的简报。

#### KV Cache 影响

与实时请求独立：本包永不触碰请求前缀，因此不会使 provider 缓存复用失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制界定了本存储不适用的场景。它们是当前包约束。

- **仅限本机**——记录位于 `$DSH_HOME` 之下，永不写入项目目录内。
- **每个作用域一份文档**——没有按条目的来源、按条目的删除或记忆历史。
- **文件大小是快照**——磁盘文件变化时，不刷新文件条目记录的大小。
- **暂存写入无上限**——暂存条目按设计不计入容量，未评审的积压会一直增长，直到被批准或驳回。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>面向维护者的工作上下文——点击展开</summary>

无。

</details>
