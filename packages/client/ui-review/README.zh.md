---
description: "审查结果面板：每份已记录的审查报告对应一个 Chat 节点，显示独立审查者的摘要，以及按严重程度分组的所有问题。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-review

[English](README.md) | 中文

## 概述

把独立审查者的报告渲染为一个 Chat 节点，而不是纯文本命令输出。该节点渲染 `/review` 或 `/security-review` 写下的持久记录：是哪一种审查、审查了什么、审查者自己的摘要，以及每条问题的文件、行号或区间、严重程度与说明，按高、中、低分组。在同时挂载审查命令的组合中挂载它；没有这些命令时不会出现任何节点。命令与会话日志仍是它所展示的每一项事实的拥有者。

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

Web 应用把它作为一个客户端条目（`ui-review`）挂载，无需其它配置。profile 的审查命令每记录一次审查——默认是 `/review` 与 `/security-review`——就出现一个节点；组合中省略该条目时，它保持缺席（而非空壳）。

面板头部显示审查种类与审查目标，随后是审查者自己的摘要，以及每条问题的严重程度、位置（`file`，或 `file:line`）与说明。问题按高、中、低分组，与审查者给出的顺序无关；无问题的审查保留摘要并说明没有可报告的内容。

命令从未记录下来的审查——审查者未完成，或完成后没有有效报告——不会渲染任何节点。该失败由命令本身以命令文本给出。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内幕——点击展开</summary>

| 文件 | 作用 |
|---|---|
| [`src/client/review-definition.ts`](src/client/review-definition.ts) | Conversation Node 定义：认领哪条记录、如何解析载荷，以及投影出的渲染数据 |
| [`src/client/ReviewPanel.tsx`](src/client/ReviewPanel.tsx) | 按键分发的 Chat 渲染器：种类、目标、摘要，以及按严重程度分组的问题 |
| [`src/client/locales.ts`](src/client/locales.ts) | `review` 词典对 |
| [`src/index.ts`](src/index.ts) | 宿主半边；功能完全在浏览器侧 |

定义以每条 `review/report` 记录作为起点，并以产生它的命令身份为键，因此一次调用只渲染一个节点；审查一次性完整写入，因此不会有更新事件并入。该记录来自本客户端并未写入的会话日志，因此会先按载荷模式解析一次：畸形记录不渲染节点，而不是渲染出损坏的面板。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [审查命令](../../subagent/command-review/README.zh.md)——写下本面板所渲染报告的两个命令。
- [客户端分组映射](../README.zh.md)——所有浏览器端包。

-----

<a id="model-experience"></a>
## 模型体验

无，因为该面板渲染仅写入日志的审查记录，不改变模型上下文。

#### KV Cache effect

无。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

这些限制界定了面板能展示什么；它们是当前包约束。

- **只读。** 面板展示审查者报告的内容。忽略某条问题、采纳它，或重新发起审查，仍归命令与输入框。
- **不做行内差异标注。** 问题只给出文件与可选的行号或区间；面板既不拉取差异，也不把问题放在对应 hunk 旁，因为记录只包含审查者写下的内容。
- **每次审查一个节点。** 会话中跑过多次审查时，每次各渲染一个节点并锚定在各自的记录上；面板没有跨审查的列表、筛选或导出。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
