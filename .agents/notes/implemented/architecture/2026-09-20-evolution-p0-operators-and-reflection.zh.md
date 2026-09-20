# Agent Note: 完整算子组合、算子效果与结构化反思

Status: implemented

[English](2026-09-20-evolution-p0-operators-and-reflection.md) | 中文

## Problem

`specs/evolutionary-harness-v11-deep-research.md` 在 §58 决策切片之后留下三个 P0 相邻缺口。第一，§8 点名十四算子组合，而优化器只带四个（`rewrite`、`compress`、`guard`、`exemplify`），规范列出的多数修复形态没有可抽取的指令。第二，同节的 `operator_stats`（`attempts`、`accepted`、`mean_delta`、`regression_rate`）只存在于草图：台账按行记录了尝试与获胜，但没有读者把它们归约为按算子的效果。第三，§4.2 要求结构化反思——失败 → 解释 → 纠正启发 → 稍后检索——而反馈存储只有按会话条目与跨会话分级信号，没有地方放分析者的根因或纠正策略，也没有模式来区分测得事实与缺失分析。

## Decision

三个机制，各自由已拥有其接缝的包负责：

1. **完整算子组合**（`dsh-evolution-optimizer/src/mutate.ts`）。八个算子加入内置集合——`generalize`、`decompose`、`compose`、`reorder`、`remove-step`、`change-tool`、`change-retrieval`、`change-evaluator`——各贡献一行指令，经既有的 `resolveOperators` 单点解析，因此运行路径、预算切分与配置校验一处都不动。规范中的两个成员被有意排除：`merge-two-candidates` 需要两个输入正文而帧只带一个，`adversarial-patch` 属于污染复审而非修复变异。按算子的选择指南写在 `MUTATION_OPERATORS` 上，因为优化器 README 三件套是另一个改动的工作区。
2. **算子效果**（`dsh-evolution-optimizer/src/surface.ts`）。`operatorEffectiveness` 把某个作用域在同一个失败签名下的台账行归约为按算子的 `attempts`、`accepted`、`meanDelta`（获胜相对其基线的平均计费 token 节省，该算子从未在那里晋级时为 `null`——落败不带可测三元组）与 `regressionRate`（其产出候选的运行中以 `regressed` 收场的比例）。它是 `operatorRecords` 旁边的读模型，不是第二套排序：`orderPortfolio` 不动，因此其他读者依赖的阵容行为不变。
3. **结构化反思**（`dsh-evolution-feedback`）。`reflect` 把分级后的失败返回为 `StructuredReflection`：台账派生的 `failureId`、症状、违背的预期、报告会话、观测到的 `whatFailed` 计数与 `confidence`（调用从未被看见时 0.25，否则从 0.5 线性升至 `triggerReviewSessions` 个不同会话时的 1），合并分析者提供的 `rootCause`、`correctedStrategy`、`reusableWhen`、`antiPattern` 与 `candidateTest`——它们在被写下之前保持为空，因此缺失的分析绝不会被误认为测得事实。`recordReflection` 按合并键以字段为单位合并写入这份分析（空调用保留一切），新表 `reflections` 负责持久化：域版本 2 并 `compatibleVersions: [1]`，沿用记忆包先例，因此已担保的 v1 文档原样打开。

本切片被要求检查的回归/评估接线已经存在，只验证、不建造：成对的优胜者对基线确认与私有 holdout 池已提交在优化器运行路径中（`PromotionConfidence`、`HoldoutCheck`、`holdoutScenarios`），评分器 README 记录了行为门禁。无需改动。

## Alternatives considered

- **为 `merge-two-candidates` 组织双正文帧**——否决：`frameMutationInput` 只带一个当前正文，而双正文帧需要请求所没有的第二个技能来源；在有调用方能提供该对子之前，该算子暂不加入。
- **把效果汇总折进 `OperatorRecord`**——否决：该记录喂给 `orderPortfolio`，而它的 spec 文件是另一个改动的工作区；独立函数零干扰地加上统计。
- **在触发复审分级时自动记录反思骨架**——否决：存储一次只见一个会话、没有会话名册，无法在本地算出跨会话分级；骨架要么是错的，要么得由本就有名册的读者来写。
- **独立的反思域**——否决：反思与反馈记录共用失败标识，拆开需要域所不提供的跨表原子性；该表与 `records` 并排放在既有域里。
- **现在就把整理器或 dreaming 接到 `reflect` 上**——延期而非否决：两者今天读 `signals`/`summary`，切换它们的提示词材料是模型可见的改动，需要自己的一份快照覆盖；已记为反馈 README 的限制。

## Consequences

- 一次运行可经同一套配置、预算与台账路径抽取十二种修复角度；`MUTATION_OPERATORS` 上的指南告诉部署方哪个角度匹配它的证据。
- 按算子的效果可直接从已提交的台账行派生，无需新的持久状态：按失败签名的尝试、采纳、平均 token 节省与回归占比。
- 每个分级失败现在都有结构化形态并带明确的「空 vs 测得」契约，分析者的解读也有了以信号所报告的同一合并键为键的持久居所——而缺失的作者（dreaming REM、复审者提炼）被点名写在 README 里，而不是悄悄缺席。
- `evolution_feedback` 域原样打开 v1 文档；`reflections` 表在首次写入时空表到来。

## Deviations from the plan

- 八个算子，而非剩下的十个规范成员：`merge-two-candidates` 与 `adversarial-patch` 因上述理由被排除，并记在指南注释里，让未来的帧组织者知道是什么能解锁它们。
- 反思的分析字段可空且暂无模型作者；计划中的模式假定了一个回路尚没有的作者，因此存储先交付派生加持久写入路径，并点名预定的作者。
- 回归套件无代码：缺口分析以为缺失的置信对子与 holdout 池已提交且有覆盖，因此本切片只验证、不建造。

## Testing

- `mutate.spec.ts`（11 个测试）：十二个组合 id 全部可解析且指令互不相同，外加既有的组织/解析/调用路径。
- `effectiveness.spec.ts`（3 个测试）：同一签名下的尝试/采纳计数、增量平均与回归连带，以及无可测三元组的获胜与阵容之外的优胜者。
- `reflection.spec.ts`（3 个测试）：可归因、单会话与无归因失败的派生一半与 1 / 0.75 / 0.25 置信度；幽灵与重复会话标识；三次部分写入的分析合并与单字段首读；已存分析经 `reflect` 浮现。
- 四个被触 `src/` 文件（`feedback/src/index.ts`、`feedback/src/spec.ts`、`optimizer/src/mutate.ts`、`optimizer/src/surface.ts`）语句/分支/函数 100%，由受影响包覆盖率运行的 JSON 报告确认（131 个测试、12 个文件，全部通过）。
- `typecheck` 全仓库通过。`lint`、`verify-export-jsdoc`、`verify-persistence-catalog` 与文档预算只在既有条目上红（已验证无一来自本次改动）；`verify-translation-pairing` 与 `verify-package-readme-limitations` 在被触对子上通过。

## Left alone

- 整理器与 dreaming 仍读 `signals`/`summary`；切到 `reflect` 需要模型可见的快照覆盖，已记入反馈 README。
- 优化器 README 三件套是另一个改动的工作区；在该改动落地前，算子指南放在 `mutate.ts` JSDoc 里。
- P1–P3 机制家族（岛屿、课程、组合性、对抗、元）仍是未来的决定；本切片是 P0 失败记忆加 §8 组合余部。
- `packages/skill/skill/tests/skill.spec.ts` 的作用域层用例在该文件单独运行时失败；已在干净树上验证一致（与本次改动无关）。
