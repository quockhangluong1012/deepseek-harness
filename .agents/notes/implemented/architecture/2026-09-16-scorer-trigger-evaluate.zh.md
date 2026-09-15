# Agent Note：评分器获得触发器与单技能评估

Status: implemented

[English](2026-09-16-scorer-trigger-evaluate.md) | 中文

## Problem

Review-v6 Batch 5 要求两样东西：`shouldOptimize` 触发器（§4.4 步骤 2）与作为评估步骤接入的评分器（步骤 3），不要优化器。它还说每个技能的场景语料应从 trajectory 导出构建。读代码后发现最后一条指示无法按字面执行。

评分器的一个场景是两个作者型 artifact：`input.json`（手写的 ACP 驱动：`waitForInboxMessage`、`cancel`、权限应答）与 `session*.jsonl`（replay 查阅的已录制模型脚本）。两者都无法从已完成的会话推导出来。Trajectory 导出的是 ShareGPT——按 turn 的 `human`/`gpt`/`tool` 纯文本——那是外循环学习的训练数据格式，不是 replay 夹具。把文本反写回可 replay 的会话是编造，不是 replay。因此 Batch 5 只接触发器与基于调用方给定场景的评估；语料挖掘（会话到夹具加手写驱动）仍是 Batch 6 要对着 session-snapshot 契约做的设计题。

## Decision

**触发器。**新建 `src/trigger.ts` 放 `shouldOptimize`：样本门 `useCount + failureCount >= minUses`（默认 20），再看比率 `failureCount / (useCount + failureCount) > failureRate`（默认 0.3）。这刻意不同于 review 的伪代码（`failureCount / useCount`）：Batch 3 已把含分母公式写进遥测字段文档，Batch 4 也已沿用；再用第二个公式，分选 flag 的技能触发器会无视，反之亦然。阈值是评分器的 Config（`triggerMinUses`、`triggerFailureRate`）——数字与整理器的分选阈值相同，但是不同的决定（优化 vs 复核），因此每个接缝各持一份。

**评估。**服务上的 `evaluateSkill({ skill, scenarios, agent, run })` 复用已有的 `score()` 逐个场景评分，再聚合成 Batch 6 要做选择的 Pareto 三元组：仅当每个场景都通过时 `pass` 才成立，token 与耗时取各场景中位数之和，各场景记录随行。一个场景被跳过则整个评估随之跳过并附上理由，因为基于不完整的评估做优化等于在不存在的证据上做选择；空场景名单同样跳过，因为什么都不评却称之为通过是撒谎。

**接依赖走了两步不明显的路。**触发器读取 `SkillUsageRecord`，因此评分器需要在 `peerDependencies` 加遥测包并在 `devDependencies` 镜像，刷新 lockfile；而且因为即便是纯类型导入也会扩大编译器检查的程序，还要在评分器的 `tsconfig.json` 里加 project reference——整理器早就有了。没有它，`tsc -b` 会报来自本次改动从未触碰的包的 `rootDir` 错误。

## Alternatives considered

**复用已有的指标来源，而不是测量全新进程。**已拒绝：三元组必须描述被测的那个正文，而现有记录里没有任何东西能做到这点。`score()` 测量一次运行——计费 token 取自该次运行的会话日志、经 `ctx.tokenMeter` 读出，耗时是围绕 `run` 的时钟——而遥测存储持有的是触发器所读的加载与结果计数。从遥测里读出三元组，报告的会是现网技能的流量，而不是这个候补的行为，而这正是 Pareto 选择唯一用不上的数字。

**让触发器与整理器分选过滤器共用一个阈值常量。**未采用：今天两处数字一致（20 次记录结果、0.3 失败占比），但决定不同——整理器做复核，优化器做重写——因此每个接缝各持一份 Config，任一侧可以调整而不至于静默改变另一侧的标定。

## Consequences

评分器如今回答了 §4.4 向它提出的两个问题。`shouldOptimize` 是对单条 `SkillUsageRecord` 的纯读取——不碰存储、不取时钟——因此任何已持有遥测的调用方都能用它设门，而且它读的正是整理器分选过滤器所读的那个已文档化的比率公式。`evaluateSkill` 把一个技能的场景名单变成 Batch 6 要做选择的三元组：仅当每个场景都通过时 `pass` 才成立，token 与耗时为各场景中位数之和，各场景记录随行；有场景被跳过或名单为空时，返回的是带理由的 `skipped`，而不是一个没人能信的数字。

代价是：评分器包现在依赖遥测包（`peerDependencies`、`devDependencies` 镜像与 lockfile 条目），并带着一个 `tsconfig.json` project reference，因为即便纯类型导入也会扩大 `tsc -b` 检查的程序——没有该引用，它会报来自本次改动从未触碰的包的 `rootDir` 错误。评估还会为每个场景运行一次调用方的 runner，而它的全有或全无跳过规则意味着：只要有一个场景的驱动或录制坏了，整个技能在该场景修好之前都无法评估。

## Testing

触发器边界（恰好等于阈值的比率不触发、样本不足永不触发、缺席的 `failureCount` 读作零），基于磁盘语料的评估聚合（全过三元组、一个分歧场景让技能失败但评估仍成立、一个缺席场景跳过一切、空名单跳过），以及 Config 默认值。语句、分支、函数与行覆盖率均为 100%。

## Deferred

每个技能的语料挖掘（Batch 6 的评估数据集：持久化会话日志作夹具加手写 ACP 驱动——需要对着快照运行器契约单独设计）；变异循环、Pareto 选择与分阶段部署（Batch 6，目前该三元组的唯一消费者）。
