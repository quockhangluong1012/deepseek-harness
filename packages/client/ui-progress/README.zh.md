---
description: "dsh Web 客户端右侧 Sidebar 的进度 tab 类型：会话的常驻任务清单，以及它各轮次产出的每个文件，在首次出现进度时自行打开。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-progress

[English](README.md) | 中文

## 概述

右侧 Sidebar 的进度 tab 类型：先列会话的任务清单，再列它各轮次产出的文件。它是一个从引导页进入的页类型，不认领任何地址；同时在每个会话首次出现进度时自行打开一次——已有常驻清单或已产出文件——因此不必先找到入口就能看到进度。

## 目录

- [注册了什么](#what-it-registers)
- [面板](#the-panel)
- [何时打开](#when-it-opens)
- [模型体验](#model-experience)
- [已知限制与暂缓事项](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="what-it-registers"></a>
## 注册了什么

- **类型**：`ctx.sidebarRightTabs.register(...)`，kind 为 `progress`，id 为 `@deepseek-ai/dsh-client-ui-progress`，档位 `builtin`，没有 patterns，另有一个打开该类型的引导页入口（order 30，标题取自 `sidebarProgress` 命名空间）。
- **正文**：以该 id 为键的 `sidebar.right.pane.tab` 坑位；没有 store，也没有注入面：它画出的全部内容都经框架的会话 hook 到达。

`src/client/` 下六个源文件：`definition.ts`（类型是什么）、`progress.ts`（报告什么，以及如何推导）、`auto-open.ts`（何时自行打开）、`ProgressBody.tsx`（画什么）、`locales.ts`（说什么）、`index.ts`（接线）。

<a id="the-panel"></a>
## 面板

两个分区，各自只在有内容时渲染；两者皆空时，一行文字说明面板正在等待。

| 分区 | 来源 |
|---|---|
| 任务 | Host 计算的 `todos` 投影：常驻计划，下一轮次开始时清空。标题行按已完成数与总数计数，每一行以自身状态作为无障碍名称。 |
| 产出文件 | `ui-deliverables` 按轮次发布的 `deliverables` 轮次数据：成功 `write`、`edit` 与执行写操作的 `str_replace_editor` 调用的参数，而不是收尾正文。 |

一个产出路径只列一次，位置取它首次出现之处，因此先写后改的文件只有一行。行内显示路径的最后一段，完整路径保留为 title 与无障碍名称，点击经所在 tab 自己的 `openResource` 打开文件，落在承载该面板的格中。

<a id="when-it-opens"></a>
## 何时打开

面板不是右侧 Sidebar 的默认内容：该列默认收起并停在引导页，读者按需打开。唯一的例外是正在进行的工作：自动打开监听屏幕上的会话，并记住它是否在该会话显示期间运行过；一旦有过运行，该会话的首个进度——常驻清单或已产出文件——就会打开并展开面板。

只有进度是不够的。打开一个会话会加载它历史中的一切，因此只看进度会让旧会话的文件、以及每次重新加载都自行打开该列，与该列已记录的"重新加载后收起"默认相冲突。运行锁存正是用来区分正在进行的工作与已加载的记录，且只在会话显示期间有效：回到有历史的会话不会打开任何东西。

自动打开每个会话只发生一次，到此为止；之后到达的进度不会重新打开读者再次收起的面板。自动打开的状态只存在于内存中：重新加载后每个会话都是收起的，只有插件自身的生命周期持有「已打开过的会话」集合。

<a id="model-experience"></a>
## 模型体验

无，因为面板只读其他包发布的清单与轮次数据，不注册任何面向模型的内容。

#### KV Cache 影响

无；面板不组装请求，也不向提供方发送任何内容。

## 已知限制与暂缓事项

<a id="known-limitations-and-deferred-work"></a>
- **词汇范围即已加载的窗口。** 产出文件来自 Chat target 已加载的轮次，因此更早轮次的文件要等那段历史加载后才出现；任务清单来自 Host 投影，不受此限制。
- **仅限第一方写操作工具。** 终端命令写出的文件不会列出，因为产出文件的词汇属于 `ui-deliverables`，覆盖的是写操作工具自身的 `locations`。
- **没有 todo 工具就没有清单。** 未组合 `dsh-tool-todo` 的装配不会发布 `todos` 键，任务分区保持为空，面板只为产出文件打开。
- **只读且不过滤。** 除打开文件外没有其他行内操作，没有搜索，没有分组，两个分区也都不能折叠。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>

**运行时不变量：** 不发布 companion。面板唯一的内存值是「已自动打开过的会话」集合，另一处状态是它随自身 effect 释放的订阅；两者都没有第二个观测源可与之比对。
