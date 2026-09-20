# Agent Note: 变异算子组合

Status: implemented

[English](2026-09-16-mutation-operator-portfolio.md) | 中文

## Problem

`specs/evolutionary-harness-v11-deep-research.md` §8（P1 第 13 项）警告不要让一个 LLM 提示词成为唯一的变异机制，而对 §51 的普查确认优化器恰恰只有一个：`mutationInstructions` 每次请求都以“You improve one skill package in a single rewrite pass”开头，因此 `maxCandidates` 只买到同一种改写风格的多个样本。一个失败原因是缺少前置条件的技能，或证据表明正文写得过于啰嗦的技能，与一个失败原因是不清晰顺序的技能，拿到的是同一条指令。

## Decision

`dsh-evolution-optimizer` 中一个具名的内置算子组合，每个算子为它所组织的请求头贡献一行指令：

- `rewrite`——清晰度与顺序，只改证据指向之处（历史指令，也是默认值）。
- `compress`——在仍能陈述证据显示重要的每条规则的前提下最短的正文。
- `guard`——证据指向的前置条件、拒绝或校验，别的都不动。
- `exemplify`——每条被证据指向的规则配一个实例，不丢弃任何已经可行的内容。
- `generalize`——把每条被指向的规则放宽到其失败类别，而不只是出故障的实例。
- `decompose`——把被指向的过程拆成可分别检查的步骤，保留每条规则。
- `compose`——把重复或重叠的被指向规则合并为一条。
- `reorder`——把被指向的检查前移，不改任何规则文本。
- `remove-step`——删除证据显示从不触发的步骤，其余保持字节一致。
- `change-tool`——把被指向的工具调用换成真正能回答问题的工具。
- `change-retrieval`——只改变正文检索的内容：查询、来源或查找顺序。
- `change-evaluator`——只改变正文自查结果的方式：阈值、断言或验证步骤。

规范中的两个成员被有意排除：`merge-two-candidates` 需要两个输入正文而帧只带一个，`adversarial-patch` 属于污染复审而非修复变异。选择指南写在 `mutate.ts` 的 `MUTATION_OPERATORS` 上，因为优化器 README 是另一个改动的工作区。

`operators`（配置，默认 `['rewrite']`）按请求顺序选择 id；`resolveOperators` 在插件解析配置时拒绝未知 id，因此拼写错误在加载时失败，而不是在一次变异调用之后。`distributeCandidates` 把 `maxCandidates` 在所选算子间均分，靠前的算子领余数，每个条目成为一次 `mutateOnce` 调用。`EvaluatedVariant` 带上产出它的 `operator`，分选载荷记录优胜者的算子，分选 gist 点名它。两个算子恰好返回相同正文时合并为一个候选，记在靠前的算子上。

## Alternatives considered

**默认使用完整组合。** 否决：候选预算属于部署方，十二个算子配默认的 `maxCandidates: 3` 会把一次变异调用变成三次，而运维并没有要求。默认 `['rewrite']` 保持今天的成本，让宽度成为明确的选择，与 `screenScenarioCount: 0`、`budgetTokens: 0` 同形。

**每个算子各给 `maxCandidates`。** 否决：它会悄悄把调用数与评估成本乘以组合大小，而且让 `maxCandidates` 的含义取决于另一个字段。

**框架式算子注册表**（第三方算子经 Cordis 服务注册）。否决，理由是先验性：十二个内置算子覆盖了本仓库证据实际呈现的形态，而一个只有一个调用方的包所拥有的注册表是没有消费者的机械结构。需要别的算子的部署，在其指令被定义的同一处修改内置列表。

**带按算子结果统计的算子归因**（哪个算子胜出多少次，持久保存以重新加权组合）。当时延期到各自的决定；该决定已随后落为[结构化反思与算子效果](2026-09-20-evolution-p0-operators-and-reflection.zh.md)：`operatorEffectiveness` 直接从本改动已记录的台账行按失败签名汇总尝试、采纳、平均 token 增量与回归率，不改变阵容排序。

## Consequences

一次运行现在可以从多个角度攻击同一个技能，分选证据说明是哪个角度产出了优胜者。代价明确且已文档化：每个选中的算子都是一次独立的模型调用，因此四算子组合配 `maxCandidates: 4` 是四次调用而不是一次；比 `maxCandidates` 更宽的组合会留下未被使用的尾部算子（`distributeCandidates` 会丢弃它们）。

验证：49 个优化器测试（组合解析、加载时拒绝未知 id、带余数的预算分配、按算子标记候选、跨算子重复合并，以及既有的评分与治理路径）以及 `packages/evolution/evolution-optimizer/src` 的语句、分支、函数与行覆盖率 100%。组合此后已扩至十二个算子：`mutate.spec.ts`（11 个测试）解析每个 id 且指令互不相同，`effectiveness.spec.ts`（3 个测试）覆盖按签名的效果汇总。
