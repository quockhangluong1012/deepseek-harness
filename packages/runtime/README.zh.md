---
description: "runtime 分组的地图：拥有每会话一份持久任务契约、工具流水线上的动作账本与完成门禁的 Agent Kernel，供用户和维护者组合一个受治理的运行时。"
kind: "package-group"
---

# runtime/ — 控制平面运行时族

[English](README.md) | 中文

## 概述

`runtime/` 分组收纳那些治理既有执行基座行为、却不拥有其中任何部分的包。`agent-kernel` 为每个会话派生一份持久任务契约，为每次工具调用记录一条提议与决策，把权限文档与沙箱、人类审批应答链组合起来，并以必需验收标准作为完成门禁。`agent-context` 把每条组装出的提示词贡献与每条持久任务事实包装成来源信封，记录每一步的放置摘要，丢弃超出 token 上限的可压缩来源，并挡下某个被配置的层级，直到调用方放行它。这些包默认都不挂载。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发笔记](#dev-note)

-----

<a id="packages"></a>
## 包

三个包分别覆盖控制平面、它编译的上下文与它治理的工具。它们的 README 说明何时挂载、如何读取它们写下的记录，以及它们有意不拥有什么。

| 包 | 提供什么 |
|---|---|
| [`agent-kernel/`](agent-kernel/README.zh.md) | 每个会话一份持久任务契约、工具流水线上的动作账本、与沙箱和审批应答链组合的能力权限引擎、求交进每个子级动作的委派回执，以及完成门禁 |
| [`agent-kernel-builtins/`](agent-kernel-builtins/README.zh.md) | 每个已发布产品工具一份能力声明，以任意挂载顺序向 Kernel 注册，让 enforce 模式治理真实流量 |
| [`agent-context/`](agent-context/README.zh.md) | 组装出的提示词贡献与持久任务事实之上的来源信封、全序放置顺序、冲突报告、token 预算拟合，以及按模型步骤记录的、可重放的放置摘要 |

-----

<a id="related-documentation"></a>
## 相关文档

先读 agent-kernel 子系统参考以了解词汇与生成的 Cordis API，再读 Kernel 观察而非替换的那些接缝。

- [Agent kernel 子系统参考](../../docs/subsystems/agent-kernel.zh.md) — 任务契约、动作账本、权限文档、完成门禁与持久事件族。
- [上下文编译器子系统参考](../../docs/subsystems/agent-context.zh.md) — 来源信封、放置记录，以及排序、计价与摘要契约。
- [Tools 子系统参考](../../docs/subsystems/tools.zh.md) — 账本所依赖的 waterfall，以及 Kernel 交还给它们的决策。
- [架构地图](../../docs/architecture.zh.md) — Kernel 被禁止重复的所有权表。

<a id="dev-note"></a>
## 开发备注

<details>
<summary>面向维护者的工作背景——点击展开</summary>

无。

</details>
