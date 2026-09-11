---
description: "Durable per-workspace memory record with caps and capacity accounting (ctx.workspaceMemory), for hosts composing workspace memory."
kind: "package-reference"
---

# @deepseek-ai/dsh-workspace-memory

[English](README.md) | 中文

## 概述

`dsh-workspace-memory` 拥有 Workspace Memory 背后的持久化按 Workspace 文档：用户编写的描述与指令、模型维护并带来源记录的记忆文档、附加的文本与文件上下文条目，以及产出文件索引。Host 同步读取，并通过带上限的写入进行修改；注入器与提取器包消费它。当目录中每个会话都应继承共享知识、且不向项目内写入时，选择本包。

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

当同一 Workspace 中的会话应共享指令、记忆与上下文时挂载本插件。读取从已校验的内存同步进行；写入在进入写入链之前强制执行字节上限，并盖上 `updatedAt`。

### 配置

`capacityBytes` 为必填：部署方必须选定一个 Workspace 每次请求可承担的成本。其余字段都是可通过 `cordis.yml` 修改的、经过校验的 `Config` 成员。

```yaml
- name: '@deepseek-ai/dsh-workspace-memory'
  config:
    capacityBytes: 131072
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `capacityBytes` | 必填 | 容量条分母，也是已存字节的硬上限 |
| `maxDescriptionBytes` | `4096` | 描述上限 |
| `maxInstructionsBytes` | `65536` | 指令上限 |
| `maxMemoryBytes` | `65536` | 记忆文档上限 |
| `maxContextItemBytes` | `262144` | 单条目上限，也是文件条目观测大小的上限 |
| `maxContextItems` | `50` | 条目数量上限 |
| `maxOutputs` | `200` | 产出文件索引大小 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-workspace-memory)是每个受支持字段的穷尽真源。

### 容量与摘要

容量等于 `instructions` 与 `memory` 的 UTF-8 字节长度，加上 `contextItems[].sizeBytes` 之和。描述与产出不计入。摘要只覆盖指令、记忆与上下文条目；描述、产出与时间戳永远不会使注入的 brief 失效。不存在的记录读取为 `undefined`，占用零字节，摘要为 `'empty'`。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节——点击展开</summary>

### 设计理念

每个 Workspace 在存储域 `workspace_memory` 中有一条持久记录，版本 `1`，布局 `per-record`，表 `records`，以 `WorkspaceId` 为键。非法记录会让域打开失败并明确报错：指令由用户编写，不是可丢弃的派生数据。没有 global 槽位，也没有迁移设施。

### 源码地图

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`WorkspaceMemoryStore` 服务、上限、写入路径 |
| [`src/spec.ts`](src/spec.ts) | 域声明：记录 schema 与 `defineDomain` spec |
| [`src/types.ts`](src/types.ts) | 公开的记录、上下文条目、产出与来源类型 |
| [`src/digest.ts`](src/digest.ts) | 摘要、容量与字节长度辅助函数 |

### 失败与恢复

被拒绝的写入绝不修改记录。`addContextItem` 在超过条目数量或容量时以 `workspace-memory/capacity-exceeded` 拒绝，`removeContextItem` 对未知 id 以 `workspace-memory/item-not-found` 拒绝。字段上限以 `workspace-memory/too-large` 报告字段、观测字节数与上限。`recordOutputs` 在列表未变化时直接解析而不写入，因此幂等的轮次不会产生 `domain/changed` 抖动。

未发布不变式伴随包，因为域表是该状态的唯一副本，没有第二个独立观测可供核对。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Workspace Memory 规范](../../../specs/workspace-memory.md)——本包实现的行为约定。
- [Workspace 包地图](../README.zh.md)——本组的包及其仓库位置。
- [生成的配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-workspace-memory)——每个受支持的配置字段。

-----

<a id="model-experience"></a>
## 模型体验

间接地经由 `@deepseek-ai/dsh-workspace-memory-context`：该包把存储的指令、记忆与上下文渲染进注入的 brief。

#### KV Cache 影响

与实时请求无关：本包从不触及请求前缀，因此不会破坏提供方的缓存复用。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制界定了存储在何种情况下不适合使用。它们是本包当前的约束。

- **仅限机器本地**——记录存放在 `$DSH_HOME` 下，绝不写入项目目录。
- **每个 Workspace 一份文档**——没有按条目的来源记录、按条目的删除或记忆历史。
- **文件大小是快照**——文件磁盘内容变化时，文件条目记录的大小不会刷新。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
