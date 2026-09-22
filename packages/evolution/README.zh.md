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
| [`evolution-heartbeat`](evolution-heartbeat/README.zh.md) | 宿主级空闲触发的任务注册表：以单个定时器按各任务自己的节奏运行自治维护任务，并为每个任务持久记账 | `ctx.evolutionHeartbeat` |
| [`evolution-feedback`](evolution-feedback/README.zh.md) | 按会话记录失败观测：把失败的工具结果记录、去重、分级为决策信号，并汇总成学习回路可读的自然语言反馈 | `ctx.evolutionFeedback` |
| [`evolution-graph`](evolution-graph/README.zh.md) | 按作用域持久化的知识图谱：实体与有向关系、有界遍历，以及一次把文本变成三元组的确定性提取 | `ctx.evolutionGraph` |
| [`evolution-controller`](evolution-controller/README.zh.md) | 记忆记录之上的宿主 Remote 面：按作用域读写的动词、暂存写入裁决、时间线以及按作用域过滤的变更流 | `ctx.evolutionController` |
| [`evolution-trajectory`](evolution-trajectory/README.zh.md) | 为单个 Session 或某作用域的全部 Session 导出 ShareGPT 轨迹，写入宿主路径 | `ctx.evolutionTrajectory` |
| [`evolution-trace`](evolution-trace/README.zh.md) | 不可变会话轨迹投影：基于已提交的会话日志，产出带排序根因归因的结构化学习轨迹与压缩摘要 | `ctx.evolutionTrace` |
| [`evolution-curriculum`](evolution-curriculum/README.zh.md) | 自动课程：从 telemetry 与轨迹存储测量能力差距，并为每个差距暂存一条有依据的训练任务 | `ctx.evolutionCurriculum` |
| [`evolution-benchmark`](evolution-benchmark/README.zh.md) | 基于生产失败的基准增长：带内容去重与污染状态的持久化评估任务存储 | `ctx.evolutionBenchmark` |
| [`evolution-evaluator-health`](evolution-evaluator-health/README.zh.md) | 评估器集成健康：记录的行为评估裁决，含一致性、通过漂移与误报跟踪 | `ctx.evolutionEvaluatorHealth` |
| [`evolution-population`](evolution-population/README.zh.md) | 基于种群（population）的进化：每一次暂存的优化器写入都成为按技能组织的候选，含代数编号、父代谱系与 暂存 → 通过/拒绝 生命周期 | `ctx.evolutionPopulation` |
| [`evolution-model-routes`](evolution-model-routes/README.zh.md) | 自适应模型路由：面向进化角色拓扑、带实测证据与推荐的按角色路由指派 | `ctx.evolutionModelRoutes` |
| [`evolution-canary`](evolution-canary/README.zh.md) | 金丝雀（canary）部署追踪：暂存技能补丁的发布状态，含实测金丝雀证据 | `ctx.evolutionCanary` |
| [`evolution-novelty-search`](evolution-novelty-search/README.zh.md) | 新奇度搜索：按技能持久化的行为描述符档案，基于 Jaccard 的档案新奇度奖励有意义的差异候选 | `ctx.evolutionNovelty` |
| [`evolution-stagnation`](evolution-stagnation/README.zh.md) | 停滞检测：统计无有意义改进的评估运行次数，并在前沿停滞时给出下一个多样性策略 | `ctx.evolutionStagnation` |
| [`evolution-islands`](evolution-islands/README.zh.md) | 岛屿进化：带目标、岛屿间迁移记录与基于调度表的迁移到期检查的按技能进化轨道 | `ctx.evolutionIslands` |
| [`evolution-self-model`](evolution-self-model/README.zh.md) | 受控自我模型：持久的按技能能力记录，以及说明下一步该学什么的弱优先能力前沿 | `ctx.evolutionSelfModel` |
| [`evolution-uncertainty`](evolution-uncertainty/README.zh.md) | 不确定性驱动学习：将持久的不确定性信号聚合成高价值评估任务的优先级队列 | `ctx.evolutionUncertainty` |
| [`evolution-adversary`](evolution-adversary/README.zh.md) | 对抗进化：横跨八类弱点的持久对抗探针，外加评估器博弈防御清单 | `ctx.evolutionAdversary` |
| [`evolution-lineage`](evolution-lineage/README.zh.md) | 依赖感知进化：带依赖版本、可比性检查与消融归因的实验信封 | `ctx.evolutionLineage` |
| [`evolution-sleeptime`](evolution-sleeptime/README.zh.md) | 睡眠时间计算：在离线成本经济策略下，带预计算推理产物的预期未来任务 | `ctx.evolutionSleeptime` |
| [`evolution-scorer`](evolution-scorer/README.zh.md) | 为已录制语料的运行打分：工作区差异判定通过、计费 token 与 N 次中位墙钟时间 | `ctx.evolutionScorer` |
| [`evolution-dreaming`](evolution-dreaming/README.zh.md) | 对已记录失败的三阶段梦境归并：轻量观测、REM 反思，以及按心跳节奏沉淀的持久叙事 | `ctx.evolutionDreaming` |
| [`evolution-optimizer`](evolution-optimizer/README.zh.md) | 离线技能优化：经触发门控、以宿主 LLM 变异、隔离覆盖下的打分评估、Pareto 挑选并暂存技能补丁 | `ctx.evolutionOptimizer` |

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
