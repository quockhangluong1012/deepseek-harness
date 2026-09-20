# Agent Note：产物血缘与因果归属

Status: implemented

[English](2026-09-16-artifact-lineage.md) | 中文

## Problem

`specs/evolutionary-harness-v11-deep-research.md` §36 要求性能变好时，记录说清是哪个改动导致的：candidate、parents、mutation operator、changed components、benchmark delta。台账五项已记其四——优胜者摘要（candidate）、起始正文摘要（parent）、产出算子、基线对优胜者的三元组（delta）——唯独没说这次编辑到底动了什么。一处 `+40/-2` 的改写和一处 `+1/-1` 的规则微调并排分选，后人看不出晋级奖励的是哪种改动。

## Decision

**台账加两个数字，渲染加一个后缀；不存正文，不存派生 delta。**

- **`diffLineCounts` 是纯函数**（`evolution-optimizer/src/lineage.ts`）：起始正文与优胜者之间新增与删除的行数，即两正文减去它们的最长公共子序列。按设计对顺序敏感——纯重排也算改动——因为血缘问的是什么动了，新颖度问的是什么是新东西；两个度量故意回答不同问题。memo 递归保持平方复杂度，SKILL.md 体量下足够。正文按既有决定不进台账；改动有多大由计数说，是哪两份文本由摘要说。
- **落盘时用内存里已有的正文计算**（`record()` 把计数铺进行）：不动 draft，不加 I/O，没晋级的运行记 0。新必填 schema 字段让旧行在 domain open 时大声失败，与 scorer 版本 batch 同一先例——来源不明的度量不值得重新解释。
- **`/curator experiments` 在晋级的行上渲染 `+added/-removed`**，无改动的行不显示。守卫读 `> 0` 而不是 truthiness，因此早于该字段的行（以及没写它的测试替身）照旧渲染，不会打出 `undefined`。
- **benchmark delta 故意不存。** 优胜者三元组减基线三元组是读者会做的减法；再存一行就是第三个可能与来源自相矛盾的数字。parents 保持单数（`bodySha`）：本优化器没有合并算子，每个候选按构造恰有一个 parent。

## Alternatives considered

- **存 unified diff。** 否决：diff 能还原正文内容，等于从后门推翻「正文本身不落盘」的既有决定。计数加摘要保持了隐私形状。
- **多重集（顺序不敏感）差分。** 写 helper 时否决：纯重排会报 `0/0`，歪曲了产物。它还会复用新颖度 helper 的归一化，模糊两个必须分开的度量。
- **隔离消融运行（A-only/B-only/A+B）。** 不建：每个候选本来就是一个算子的隔离变体，优胜者挑选把每个幸存者都放在同一重评基线下比较——§36 要的单改动纪律，按构造就有，不用加跑。
- **给算子记功。** 已有（`winnerOperator` 分选晋级，失败面计数获胜）；计数补的是缺的那轴——获胜编辑有多大——不是第二本功劳簿。

## Consequences

§36 的记录不加新状态即完整：candidate、parent、算子、变更组成计数、三元组对全在行上，`/curator experiments` 把每次晋级的体量摆到做决定的面前。计数说不出的——哪条规则变了、改动是不是原因——继续诚实地不说：体量之外的归属仍属于算子记录与 benchmark delta，不是两个整数的事。

## Verification

- `evolution-optimizer` 107 测试通过（diff 5 个单元测试，编排 1 个断言回归行上的计数）；逐文件 100% statements、branches、functions、lines。`command-evolution` 渲染两边都覆盖（有计数的晋级行、无字段的行照旧）；它那 12 行未覆盖与本 batch 无关（stash baseline 验证过，一字不差）。
- 两包 `tsc -b` 干净；oxlint 在我碰的行上 0 错误（`command-evolution` 24 个既有，不是我）。
