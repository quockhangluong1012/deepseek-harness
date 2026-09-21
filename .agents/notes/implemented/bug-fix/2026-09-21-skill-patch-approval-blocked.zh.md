# Agent Note: 分选的技能补丁永远无法被批准

Status: implemented

[English](2026-09-21-skill-patch-approval-blocked.md) | 中文

## Problem

`/curator optimize` 的结尾是把一个技能补丁分选出去，并告诉操作者如何落地它：`Optimized 'writer': staged skill patch <id>. Write the skill with skill_manage, then '/skills approve <id>' to drop the entry.` 这第二步永远不可能成功。`EvolutionMemoryStore.approveStaged` 把**所有** `kind` 为技能的分选条目都卡在捕获契约上，而优化器的 payload——`{ skill, body, operator, baseline, winner }`——并不携带契约。于是那次运行报称已分选的晋级，在任何部署上、对任何 id，都会一直返回 `Cannot approve '<id>' (evolution/staged-blocked): staged evolution write '<id>' is blocked: contract must be an object. The entry stays staged.`。

这道门对它最初的目的而言是对的。§58.1 第 12 行之所以引入它，是因为技能的**新建**曾仅凭程序性证据就被准入，而契约要求独立的验证证据——其模块文档称它为「技能提案的准入闸门」。`patch` 并不是一次能力提案：它修订的是目录已经准入的能力，而支持它的证据是优化器记录下来的基线与候选对比，本存储根本读不到。仅按 `kind` 设门把二者混为一谈，而由于没有任何产出方会带契约分选补丁，这种混淆让优化器的整条晋级通道无法走通——与[准入闸门笔记](../architecture/2026-09-21-candidate-admission-gate.zh.md)中修掉的那类缺陷同属一类：为一件无法落地的东西报了晋级。

## Decision

按操作而非按类别设门：`approveStaged` 只对 `op` 为 `create` 的技能条目要求有效契约，其余 `op` 的技能条目随人类批准即可丢弃。`skillContractIssues` 及其 JSDoc 随之调整（「Name the admission evidence a creation proposal is missing」），`approveStaged` 的契约也一并更新。

评审器的新建提案行为不变：它们仍会带着 `blockedReason: 'capture-contract'` 与 `neededEvidence` 留在暂存，直到有人补上契约——这正是 §58.1 第 12 行要防的缺陷。

## Alternatives considered

- **让优化器自己分选一份捕获契约**——拒绝：契约要求 `validationRefs` 与 `procedureRefs` 不相交。优化器可以把搜索场景作为程序引用，但它唯一不相交的验证证据是 holdout，而它默认为 `[]`。在默认配置下这等于又关上了这条通道，且原因是操作者看不见的；配了 holdout 则会让批准取决于一个连示例配置都没有设置的值。
- **让验证器接受「契约或已记录的度量」**——拒绝：验证器读的是 payload，不是台账，因此它只能信任提案方自报的数字。接受未经验证之主张的门不是门。
- **彻底去掉捕获契约这道门**——拒绝：新建提案会回到仅凭程序性证据即可准入，而那正是 §58.1 第 12 行与 `CaptureContract` 要阻止的事。
- **为补丁另立准入证据而不是豁免它**——暂不做：优化器自己的各道门已经会因已批准的下限、holdout、以及输掉的确认比较而拒绝优胜者，而被分选的正文在评分之前就已按落盘不变式检查过。给补丁再加一条准入规则，需要本存储并不拥有的证据。

## Consequences

- `/curator optimize` → `/skills approve <id>` 真正如其输出所描述那样可用。
- 修订由人类决策加上提案方已经执行过的各道门来准入；新的能力主张仍需要独立的验证证据。
- `/skills pending` 与阻塞条目路径未受影响，因此未能准入的新建提案仍会准确报出缺哪一项证据。
- 命令 README 与错误表改为写「新建提案」，因为补丁不再受此门约束。

## Deviations from the plan

- 无：改动就是那道门的范围、两处 JSDoc 契约、包与命令的 README，以及生成的子系统页面。

## Testing

- `packages/evolution/command-evolution/tests/command-evolution.spec.ts`：一个带优化器形状 payload 的分选 `patch` 批准成功并丢弃条目。改动之前，此处正是以上面那段 `evolution/staged-blocked` 原文失败；既有的新建提案测试继续断言阻塞与其缺失证据。
- `packages/evolution/evolution-memory/tests/store.spec.ts`：存储层的一对用例——`patch` 无契约即批准，`create` 不行。
- `evolution-memory` 与 `command-evolution` 套件全绿（291 tests）。

## Left alone

- **尚无任何命令可以补上契约。** `supplyStagedContract` 只到存储层，因此未能准入的新建提案仍然无法从聊天命令里被批准。这是缺少产出方，而不是门设错了：评审器无法凭空捏造独立验证证据，而编造一份恰恰就是这道门要防的缺陷。
- 优化器分选的补丁不携带捕获契约，因此作用域记录里的分选 payload 本身并不说明这次补丁凭什么被准入。它的 `gist` 点名了算子与优胜者三元组，台账行则保存了那次测量。
