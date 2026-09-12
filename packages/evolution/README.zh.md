---
description: "evolution 分组导览：从用户行为中学习、整理有界记忆并在使用中改进技能的自学习 harness 家族。"
kind: "package-group"
---

# packages/evolution

[English](README.md) | 中文

## 概述

evolution 家族在 harness 之上叠加闭环学习，且不触碰任何特权核心：按作用域持久化的记忆记录与暂存写入、后台回合评审、定时技能整理，以及长程安全护栏。每一次习得性写入都有上限、有日志、可回滚；移除相应配置行即恢复字节一致的旧行为。当会话需要越用越好时，选择本家族。在专用子系统参考文档落地之前，行为契约以[演进式 Harness 规范](../../specs/evolutionary-harness.spec.md)为准。

## 目录

- [软件包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

-----

<a id="packages"></a>
## 软件包

| 软件包 | 职责 | ctx key |
|---|---|---|
| [`evolution-memory`](evolution-memory/README.zh.md) | 提供按作用域持久化的演进记忆记录、经验/画像写入、暂存写入与容量核算 | `ctx.evolutionMemory` |
| [`evolution-reviewer`](evolution-reviewer/README.zh.md) | 缓冲回合、索引产出文件、按门控提取经验、按需重建 | `ctx.evolutionReviewer` |
| [`evolution-curator`](evolution-curator/README.zh.md) | 宿主级间隔与闲置维护：自动技能生命周期流转、在整包规则下可选启用的 LLM 归并、备份、账本与回滚 | `ctx.evolutionCurator` |
| [`evolution-controller`](evolution-controller/README.zh.md) | 记忆记录之上的宿主 Remote 面：按作用域读写的动词、暂存写入裁决、时间线以及按作用域过滤的变更流 | `ctx.evolutionController` |
| [`evolution-trajectory`](evolution-trajectory/README.zh.md) | 为单个 Session 或某作用域的全部 Session 导出 ShareGPT 轨迹，写入宿主路径 | `ctx.evolutionTrajectory` |
| [`evolution-scorer`](evolution-scorer/README.zh.md) | 为已录制语料的运行打分：工作区差异判定通过、计费 token 与 N 次中位墙钟时间 | `ctx.evolutionScorer` |
| [`command-evolution`](command-evolution/README.zh.md) | 人类治理命令：暂存的记忆与技能写入、作用域时间线、整理状态、按需重建、轨迹导出、学习回合与蓝图建议 | 在 `ctx.commands` 上注册 |

-----

<a id="related-documentation"></a>
## 相关文档

- [演进式 Harness 规范](../../specs/evolutionary-harness.spec.md)——本家族实现的行为契约。
- [演进式 Harness 子系统](../../docs/subsystems/evolutionary-harness.zh.md)——本家族的参考词汇与生成的 API。
- [Workspace 子系统](../../docs/subsystems/workspace.zh.md)——本家族参照的按目录记忆设计。

-----

<a id="dev-note"></a>
## 开发备注

<details>
<summary>面向维护者的工作上下文——点击展开</summary>

无。

</details>
