# Agent Note: 受治理的技能优化（受保护 holdout、预算、逐次减半）

Status: implemented

[English](2026-09-16-governed-skill-optimization.md) | 中文

## Problem

`specs/evolutionary-harness-v11-deep-research.md` §15（受保护 holdout）、§37（预算控制器）与 §38（早停与逐次减半）是让进化循环既诚实又可控的 P0/P3 机制，而对 §51 的普查发现三者全部缺失：`EvolutionOptimizer.optimize` 恰好在调用方点名的那些场景上选出优胜者，对每个候选都在全部场景上评分，且对一次运行的成本没有任何上限。没有任何东西把候选据以写成的语料与据以裁决的语料分开，而一个有三个候选的运行即使其中一个在第一个场景上就明显更差，也会买下三次完整评估。

## Decision

四个治理机制都在 `dsh-evolution-optimizer` 内，且在同一次改动中完成，因为它们是同一份场景列表上的一条控制流：

1. **受保护 holdout。** `holdoutScenarios`（配置，默认 `[]`）点名搜索永不评分的语料场景。选出优胜者后，基线与优胜者都会在 holdout 集上评分，若基线在那里支配优胜者则拒绝：`status: 'holdout-rejected'`，记录 `holdout: { baseline, winner }`，不分选任何内容。holdout 属于配置，永不进入 `OptimizeRequest`：能点名 holdout 的调用方，也能丢掉自家候补没通过的场景。
2. **预算控制器。** `budgetTokens` / `budgetWallTimeMs`（配置，默认 `0` = 不设上限）限定候选评分可买下的量。循环在每次完整评估前检查上限，越过即停止并报告 `truncated: true`；随后在装得下的候选之间选择。在评分任何候选之前就花完预算的运行返回 `skipped`，而不是分选一个从未度量过的优胜者。
3. **逐次减半。** `screenScenarioCount`（配置，默认 `0` = 关闭）让每个候选先在前 N 个搜索场景上评分，按通过状态、再按 token、再按墙钟排序保留 `ceil(候选数 / 2)`（至少一个），只对幸存者做完整评分。无论是否设预算，筛选都会对每个候选执行，因此幸存者始终在同一子集上比较。
4. **切分校验。** 在任何模型调用之前，若某个场景名在任一列表内部重复，或在两份列表中同时出现，`optimize` 直接抛错。配置错误的切分会在最早的可行点失败，而不是悄悄削弱检查。

`OptimizeReport` 新增 `holdout: HoldoutCheck | null` 与 `truncated: boolean`，`status` 新增 `holdout-rejected`；`/curator optimize` 在报告带有 holdout 时打印该三元组。纯选择器在 `src/pareto.ts` 新增 `screenSurvivors`。

## Alternatives considered

**在语料自身声明 `train`/`validation`/`holdout` 切分**（每个场景文件一个 `split` 字段，由 `dsh-evolution-scorer` 拥有）：否决——这把晋级策略的决定塞进语料格式，为一个只有优化器执行的检查强制评分器改 schema，而且仍然需要请求级的重叠检查，而配置列表天然得到这个检查。

**把 holdout 场景放进请求，与搜索场景并列**：否决——请求属于调用方，而调用方正是候补被裁决的一方。调用方能改名、丢弃或误当搜索传进去的 holdout，不是 holdout。

**预算被截断时否决整次运行**：否决——已经评分的候选是真实度量，拒绝在它们之间选择等于扔掉已付的钱。改为在报告中带上 `truncated: true`，读者便能区分完整搜索与部分搜索。

**连筛选也纳入预算**：否决——筛选做到一半会让幸存者排在不同子集上，而筛选取存在的意义正是这种公平性。筛选按构造就很便宜（每个候选 `screenScenarioCount` 个场景）且不受预算管辖；只有完整评估受预算约束。

**永不允许从被截断的运行分选**：作为默认否决，因为那样小预算就等于完全不优化；但保留为退化情形的结果——预算在第一次完整评估之前就花完，此时没有任何已度量的东西可分选。

## Consequences

候选再也不能在它据以生成的语料上被晋级，无上限的花费现在由配置限定，而多候选运行的成本变为一次筛选加上至多一半的完整评估。代价写在包 README 中：切分的私密性只取决于运维的配置，筛选在可能不代表整份语料的子集上裁决幸存者，而 `truncated: true` 意味着优胜者是在装得下的候选之间选出的。

验证：43 个优化器测试（纯 pareto 加上在伪造接缝之上的服务编排：重叠与重名拒绝、筛选调用顺序与幸存者切分、token 与墙钟截断、预算在任何候选之前花完、holdout 在基线与优胜者两处分别的支持/拒绝/跳过）以及 `/curator optimize` 针对 holdout 行的 CLI 测试；`packages/evolution/evolution-optimizer/src` 的语句、分支、函数与行覆盖率均为 100%。
