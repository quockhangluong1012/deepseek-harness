---
description: "只读的模型面向工具：报告某一轮次记录的 workspace 变更，并从记录而非重跑中读取某个已列出文件的 diff。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-changes

[English](README.md) | 中文

## 概述

`dsh-tool-changes` 让模型读取某一轮次对 workspace 做了哪些变更，而无需重跑造成变更的操作。`turn_changes` 列出该轮次变更的文件及其新增与删除行数；`turn_diff` 读取某个已列出文件记录的 hunks。两者都从调用方 Session 自身的 `workspace/changes` 事件解析轮次，并通过 `ctx.workspaceChanges` 读取摘要，因此本包不存储任何内容，也不重新执行任何操作。请与 `dsh-workspace-changes` 一同挂载。没有记录任何变更的轮次，以及本 Host 进程已不再提供服务的记录，都会以失败报出，而不是给出空答案。

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

凡是编码 Agent 需要依据记录的轮次而非重读文件或重跑命令来复查此前工作的组合，都挂载本包。

### 何时选用

当部署已用 `dsh-workspace-changes` 记录轮次，且模型需要该记录时选用：例如扫描、修复或汇报其他轮次所改文件的 Agent，包括普通 `git diff` 看不到的路径——被 git 忽略的文件、仓库之外的文件，以及工作目录之外的文件。若模型应当查看当前内容，则不要选用：普通文件工具负责此事，进行中工作的 diff 就是当前工作树所持有的内容。

### 配置

本包不接受任何 `Config` 字段。所有界限都由产出该记录的记录器拥有：限制 `files` 的文件数上限、比较所拒绝的字节上限，以及使比较退化为整文件替换的时间界限。

### 模型能做什么

| 工具 | 模型获得的内容 |
|---|---|
| `turn_changes` | 某一轮次变更的文件，按显示顺序排列，每个都带新增与删除行数；当记录器的文件数上限省略了部分文件时，另带完整的变更文件计数 |
| `turn_diff` | 某个已列出文件的统一 hunks，带三行上下文；或说明该文件为二进制或超出比较大小上限 |

两个工具都接受轮次编号，省略时表示最近记录的那一轮。`turn_diff` 接受 `turn_changes` 列出的文件路径，也接受该文件的持久路径。

### 失败与恢复

没有任何工具调用会重跑产出方命令，因此失败总是关于记录本身。未记录任何轮次变更的 Session、被指名却未记录任何变更的轮次，以及本 Host 进程已不再提供服务的摘要或比较——例如恢复的 Session，或此后已被释放的 Session——都会以指明该情形的消息失败。工具绝不会用空的变更列表回答不可用的记录。比较的快照读取失败时，会传播记录器的错误。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释工具背后的设计决策；可观察行为已由[使用本包](#use-this-package)完整覆盖。

### 设计理念

本包是一个只读适配器，建立在三条承诺之上：

- **每个事实只有一个归属方。** 记录器拥有快照、捕获、摘要与比较；本包只拥有解析与渲染，不声明任何存储、缓存或索引。
- **按引用寻址，绝不重新执行。** 轮次由其自身的 `workspace/changes` 序列寻址；文件由其在记录摘要中的索引寻址。没有任何工具调用会读取工作树或运行命令。
- **失败而非编造。** 记录不可用时以指明情形的错误失败，因为空列表在模型看来意味着「该轮次没有变更任何内容」。

### 源码导览

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`inject`、轮次解析、两个工具的注册 |
| [`src/render.ts`](src/render.ts) | 两种规范值的纯模型面向渲染 |
| [`src/types.ts`](src/types.ts) | 两个工具返回的规范值 |
| — | 未发布运行时不变式伴生入口；本包不拥有可变状态或事件序列，而它所服务的记录由记录器自身的伴生入口覆盖。 |

### 轮次解析

调用方 Session 的日志即索引：`latestTurn` 遍历 `session.snapshotEvents()` 找到最后一个 `workspace/changes` 事件，`announcementSeq` 再遍历一次找到被指名轮次的最后一次公告。最后一次公告胜出，是因为同一轮次较晚的公告会取代较早的公告，其中也包括那条撤回记录的空公告——该轮次结束前文件被还原时会发出此公告。随后该序列寻址 `ctx.workspaceChanges.summary`，而 `turn_diff` 会在请求比较之前先在该摘要内解析文件的索引，因此摘要未列出的路径会在任何读取开始前被拒绝。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [dsh-workspace-changes](../workspace-changes/README.zh.md)——拥有这些工具所读记录的记录器。
- [生成的工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-changes)——模型实际收到的 schema。
- [交付包组地图](../README.zh.md)——本组的三个包及各自职责。
- [dsh-command-rewind](../command-rewind/README.zh.md)——面向人类、基于同一批记录的 `/rewind` 命令。

-----

<a id="model-experience"></a>
## 模型体验

### 工具 schema

#### 模型看到的内容

模型看到生成的 [`turn_changes` 与 `turn_diff` schema](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-changes)。两者都带可选的轮次编号，`turn_diff` 另带必填的文件路径。

#### Token 影响

插件挂载期间，每个请求都发送两个固定的只读 schema。

#### KV Cache 影响

在工具可见性与定义不变期间保持前缀稳定。

### 工具结果

#### 模型看到的内容

每次成功调用发出一个纯文本块：`turn_changes` 输出一个指明轮次、计数与工作目录的表头，随后每个已列出文件一行；`turn_diff` 输出一个指明轮次与文件的表头，随后是带 `+`、`-` 与空格前缀行的 `@@` hunk 头。被拒绝的比较以二进制或超出上限的说明取代行内容。通用溢出策略可用其预览、locator 与检索提示替换过大的内联结果。

#### Token 影响

结果取决于数据，并留在已记录的工具历史中直至压缩；记录器的文件数上限界定所列文件，其字节上限界定单次比较。

#### KV Cache 影响

追加的结果文本跟在可复用的请求前缀之后，不会使更早的缓存条目失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **轮次只有停止后才可报告**——记录器在轮次结束时记录，因此运行中的轮次内发起的调用只能看到最近已完成的那一轮，绝看不到当前轮次的变更。
- **记录只存在于记录它的进程内**——Host 重启后恢复的 Session，或由其他进程记录的 Session，虽有 `workspace/changes` 事件却没有摘要；两个工具对它都会失败。
- **子 Agent 的 Session 从不被记录**——记录器只记录顶层轮次，因此子 Agent 自身的变更不在这份记录中。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
