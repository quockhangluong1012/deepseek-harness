# Agent Note：依赖感知的演进

Status: implemented

[English](2026-09-16-dependency-aware-evolution.md) | 中文

## Problem

`specs/evolutionary-harness-v11-deep-research.md` §34 指出产物是有依赖的——prompt、技能、检索配置、评估器——且每条评估结果都必须记录依赖版本，因为换评估器可能让历史度量失效，换检索可能让旧的使用度量不可比。实验台账记录了技能侧（正文摘要）、路由（provider 与模型）与条件（场景、尝试次数），唯独没有给评估器命名：`comparabilityKey` 按场景加路由加尝试次数匹配，`experimentKey` 按技能加证据加阵容加正文加路由匹配。评分语义一变，旧行仍会被当成新评估器下测得的一样匹配——批准含义已变的下限，跳过结论已不成立的实验。

## Decision

**一个版本常量加一个台账字段，不迁移，不加旋钮。**

- **`SCORER_VERSION` 是协议常量**（`evolution-scorer/src/index.ts`），不是配置：评分语义是代码的属性，不是部署选择，无可调之处。`EvolutionScorer.version` 以实例字段携带它，优化器每次运行读取挂载 scorer 的版本——挂载了另一个 scorer 的 host 盖自己的号，而不是继承本包的号。README 写明了提升义务：凡是改变「什么算通过、什么算计费、或中位数如何归约」的改动都要提号。
- **台账盖章并按它匹配。** `ExperimentRecord` 与 `ExperimentDraft` 携带 `scorerVersion`；运行记录挂载 scorer 的版本，`experimentKey` 包含它（旧结论永不跳过重测），`comparabilityKey` 包含它（旧批准下限永不拒绝新优胜者）。scorer 一换版，它测出的所有下限即退役，且不删除任何东西：旧行仍可读，只是不可比。
- **不迁移，沿用 novelty batch 的先例。** zod schema 上的新必填字段在 domain open 时对旧行大声失败——这正是该 domain 自己写明的契约——而不是默默重新解释来自未知评估器的度量。同样的先例也覆盖了不提 domain version：本 repo 给 schema 定版，不给数据定版，大声失败就是迁移信号。

## Alternatives considered

- **给每个 `ScoreOutcome` 盖章而不是给台账行盖章。** 否决：三元组只通过台账跨运行比较（下限、重复匹配）；一次运行内所有东西都由同一个 scorer 测出。给每个分数盖章要穿过 scorer 类型与每个调用方，为的却是一场从不发生的比较。
- **可空版本，null 表示「版本制之前的记录」。** 否决：null 需要自己的不可比规则（null 谁也不匹配，连 null 也不匹配——否则两条版本制之前的行会互相比），那是第二套机制，而必填字段加大声失败已经表达了它。
- **把 domain `version` 提到 2。** 否决：novelty batch 在 version 1 下加了三个必填字段而没有提号，且 domain 注释把大声失败写明为无效行的预期行为。提号会暗示一条并不存在的迁移路径。

## Consequences

§34 的循环在本 harness 真正拥有的依赖上闭合了：评估器。技能身份早已是摘要，路由与条件早已参与匹配——scorer 版本是缺的那条腿，现在两道闸门都按它设防。测试在单元与编排两层证明了两个方向的失效（重复匹配与下限）。§34 除此之外的要求——检索配置版本、prompt 血缘——在本 repo 没有可盖章的检索器或 prompt 版本面；有了之后，进的是同一两把 key。

## Verification

- `evolution-optimizer` 与 `evolution-scorer` 127 测试通过；两包 `src` 逐文件 100% statements、branches、functions、lines。
- 两包 `tsc -b` 干净；oxlint 0 warnings、0 errors。
- 新增：跨版本 unit key 失配、提版后编排重跑（LLM 重新付费、新行盖 v2）、提版后编排忽略下限（6-token 优胜者在已退役的 4-token 下限之下晋级）。
