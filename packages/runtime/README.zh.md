---
description: "runtime 分组的地图：拥有每会话一份持久任务契约、工具流水线上的动作账本与完成门禁的 Agent Kernel，供用户和维护者组合一个受治理的运行时。"
kind: "package-group"
---

# runtime/ — 控制平面运行时族

[English](README.md) | 中文

## 概述

`runtime/` 分组收纳那些治理既有执行基座行为、却不拥有其中任何部分的包。`agent-kernel` 从会话日志推导出每个会话一份持久任务契约，为每次工具调用记录一条提议与决策，把部署的权限文档与技术上沙箱、人类审批应答链组合起来，并且只在任务的必需验收标准通过时决定完成。它默认不挂载任何东西，也尚未进入任何 profile，因此部署按组合自行选择加入。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发笔记](#dev-note)

-----

<a id="packages"></a>
## 包

一个包覆盖控制平面。它的 README 说明何时挂载、如何读取它写下的记录，以及它有意不拥有什么。

| 包 | 提供什么 |
|---|---|
| [`agent-kernel/`](agent-kernel/README.zh.md) | 每个会话一份持久任务契约、工具流水线上的动作账本、与沙箱和审批应答链组合的能力权限引擎，以及完成门禁 |

-----

<a id="related-documentation"></a>
## 相关文档

先读 agent-kernel 子系统参考以了解词汇与生成的 Cordis API，再读 Kernel 观察而非替换的那些接缝。

- [Agent kernel 子系统参考](../../docs/subsystems/agent-kernel.zh.md) — 任务契约、动作账本、权限文档、完成门禁与持久事件族。
- [Tools 子系统参考](../../docs/subsystems/tools.zh.md) — 账本所依赖的 waterfall，以及 Kernel 交还给它们的决策。
- [架构地图](../../docs/architecture.zh.md) — Kernel 被禁止重复的所有权表。

<a id="dev-note"></a>
## 开发备注

<details>
<summary>面向维护者的工作背景——点击展开</summary>

无。

</details>
