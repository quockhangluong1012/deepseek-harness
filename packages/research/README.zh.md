---
description: "research 分组的地图：在会话的 Kernel 任务之上运行研究质量控制循环、并为每次运行持久保留阶段状态的包，供需要可溯源答案的部署使用。"
kind: "package-group"
---

# research/ — 研究质量控制族

[English](README.md) | 中文

## 概述

`research/` 分组把会话提出的问题变成有来源支撑的答案，而不是没有依据的答案。`research-controller` 运行一条有序的质量控制循环：模型通过 `research_advance` 工具陈述问题、子问题、计划、论断与答案，已注册的提供方执行检索、来源分类与矛盾检索，而认识论评审会拒绝任何没有把每条已记录论断归入六个认识论桶之一的答案。每次运行的阶段状态都按会话持久保留，观测与论断则是 Agent Kernel 的记录。只有在内核任务类别为 `research` 时才会开始一次运行；仅挂载该包不会改变任何行为。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

-----

<a id="packages"></a>
## 包

`research-controller` 负责运行循环并注册它的两个面向模型的工具；`case-store` 持久保存 ICT 案例工件，且不注册任何面向模型的内容。两者都把记录存放在该分组并不拥有的存储中。

| 包 | 提供什么 |
|---|---|
| [`research-controller/`](research-controller/README.zh.md) | 带持久化分阶段状态的有序阶段循环、供部署执行某些阶段用的阶段提供方 seam、六桶答案约定，以及 `research_advance` 与 `research_state` 两个工具 |
| [`case-store/`](case-store/README.zh.md) | §21 的按学习者持久化的 ICT 案例研究工件——观察与解读分离、证据按内核标识引用，以及面向四类消费者各自的读取路径 |

-----

<a id="related-documentation"></a>
## 相关文档

- [Agent kernel 子系统参考](../../docs/subsystems/agent-kernel.zh.md) — 一次运行所归属的任务，以及循环引用而非复制的证据与论断记录。
- [Storage 子系统参考](../../docs/subsystems/storage.zh.md) — 承载 `research` runs 表的领域形式。

<a id="dev-note"></a>
## 开发备注

<details>
<summary>面向维护者的工作背景——点击展开</summary>

无。

</details>
