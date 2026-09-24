---
description: "持久化的 kernel 任务界面：每个 agent kernel 任务契约对应一个 Chat 节点，把 Kernel 自身的记录折叠为状态、计划、预算、验证、检查点与研究事实。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-kernel-task

[English](README.md) | 中文

## 概述

把 [agent kernel](../../runtime/agent-kernel/README.zh.md) 的任务记录渲染为一个 Chat 节点。该节点折叠 Kernel 自有的持久事件——状态迁移、计划修订、验证结果、检查点、未闭合动作、未解决失败与研究记录——因此读者无需打开会话日志，就能看到任务目标、进展到何处，以及完成闸门如何裁决。节点只是视图：它展示的每一项事实仍由 Kernel 与会话日志拥有。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

Web 应用把它作为一个客户端条目（`ui-kernel-task`）挂载，无需其它配置。节点出现在 profile 的 Kernel 写下 `task/created` 事件之处；当 profile 没有运行 Kernel 时，它保持缺席（而非空壳）。

| 折叠态 | 展开态 |
|---|---|
| 目标、状态圆点、状态文本、修订号、未闭合动作数与未解决失败数 | Agent 与 policy profile、预算上限、计划修订及其步骤、验证状态及各准则结果、最新检查点及其原因与覆盖序号、研究记录计数，以及每条断言的证据谱系 |

若任务在**已关闭**的 turn 或 step 内从未到达终态，节点会渲染为「已中断」：日志不再有后续事件，运行不可能仍在推进。这是对日志的解读，而非第二套状态机——位置仍处于打开状态时，它照常渲染为进行中。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内幕——点击展开</summary>

| 文件 | 作用 |
|---|---|
| [`src/client/task-definition.ts`](src/client/task-definition.ts) | Conversation Node 定义：认领哪些事件、折叠逻辑与投影出的渲染数据 |
| [`src/client/KernelTaskPanel.tsx`](src/client/KernelTaskPanel.tsx) | 按键分发的 Chat 渲染器 |
| [`src/client/locales.ts`](src/client/locales.ts) | `kernelTask` 词典对 |
| [`src/index.ts`](src/index.ts) | 宿主半边；功能完全在浏览器侧 |

定义以 `task/created` 作为起点，并认领此后所有通过事件 metadata 指向同一任务的 Kernel 记录。缺少该 metadata 的 Kernel 记录属于节点无法认领的前缀，因此会被忽略，而不会挂到错误的任务上。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Agent kernel](../../runtime/agent-kernel/README.zh.md)——本节点渲染的记录，以及裁决完成的闸门。
- [客户端分组映射](../README.zh.md)——所有浏览器端包。

-----

<a id="model-experience"></a>
## 模型体验

无，因为该节点渲染已持久化的 Kernel 事件，不新增任何提示内容。

#### KV Cache effect

无。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

- **只读。** 节点展示 Kernel 记录的内容；暂停、恢复或审批仍归拥有这些动作的界面。
- **不展示证据正文。** 展开视图会显示证据谱系——每条断言的陈述、状态、置信度，以及它引用的证据（种类、内容引用、可信度）——但被观测的内容本身位于会话日志与存储域，不在该节点内。
- **每个任务一个节点。** 若一个会话开启多个任务，每个任务各渲染一个节点，并锚定在各自的 `task/created`。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
