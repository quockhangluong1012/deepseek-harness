# Agent Note：评估污染控制

Status: implemented

[English](2026-09-16-evaluation-contamination.md) | 中文

## Problem

`specs/evolutionary-harness-v11-deep-research.md` §35 禁止演进过程默默地在自己的评估答案上训练：拿做过变异的任务，永远不能再当干净的测试。优化器已经保证单次运行内搜索与 holdout 不相交（重叠大声拒绝），也记录每次运行检查了哪些 holdout 场景——但跨运行的两边从没连起来过。host 可以在 run 1 搜索 `s1`，改配置把 `s1` 列进 `holdoutScenarios`，run 2 就会在选出过它祖先的同一任务上「验证」优胜者。污染是静默的，离一次改配置只有一步之遥。

## Decision

**一个纯函数加一道大声守卫，不加状态，不加旋钮。**

- **`contaminatedHoldout` 是纯函数**（`evolution-optimizer/src/contamination.ts`）：给定该技能已记录的运行，点名台账里已记为*搜索*的 holdout 场景，按 holdout 顺序。只有已记录的搜索列表算数——只被当 holdout 检查过的场景什么都没训练过——而跨运行复用场景做搜索永远不算污染，因为在同一任务上加两次选择压力是常规做法，不是污染。
- **`execute` 在任何模型调用之前抛错**，与重叠检查、重名检查并列：该技能搜过的名字出现在 holdout 里，就带名大声失败，在最早能确定的点。配置错误大声失败是本 repo 的规矩，而这就是配置错误——一个不干净的 holdout。
- **按技能匹配，不按作用域。** 选出过技能 A 正文的场景从没塑造过技能 B 的候选：B 的变异输入只有失败计数，从没有场景答案。按作用域匹配会在常规的多技能切分上误报（`s1` 搜 A、验 B）。
- **不加新状态，因为台账本身就是暴露记录。** 行里的 `scenarios` 列表在本 repo 就是 benchmark provenance：每次搜索暴露都是一行记录，守卫经现成的 `experiments()` 读它。另建一套 benchmark 状态存储，等于复制台账再去对账。

## Alternatives considered

- **六态分类（fresh/search/validation/holdout/contaminated/retired）。** 否决：这六个态把单次运行的角色（search、holdout、validation）和跨运行的历史（fresh、contaminated、retired）混在一起，而台账两边都记了——角色在每行里，历史在行与行之间。加状态列等于把两个列表已说的话再说一遍，再配一台没人操作的转移机。
- **每行记录语料 provenance。** 否决：一个 host 只对一个 `corpusDir` 评分，台账不出 host，所以场景名加 scorer 版本加尝试次数已能定位一次度量。 provenance 字段盖的是个常量。
- **按作用域匹配。** 设计 helper 时否决：它拦掉合法的多技能切分，白拦——暴露经技能自己的选择传播，不经作用域。
- **警告放行而不是抛错。** 否决：兄弟重叠检查就是抛错，污染过的 holdout 是同一类错误——一场无法验证的验证。带着一行日志继续跑，是静默训练加一行日志。

## Consequences

§35 的循环在本 harness 真正造得出的暴露上闭合了：技能内的搜索转 holdout。§35 点名的其余项在这里按构造就不会发生——变异输入只有遥测计数、没有场景夹具，评估答案经记忆暴露没有路径；筛选子集是单次运行内的成本裁剪，不是第二套 benchmark。记在 README 的 holdout 条、校验段与私密性限制里（现在它说的是实话：私密靠配置，但改配置洗不白）。

## Verification

- `evolution-optimizer` 102 测试通过（helper 3 个单元测试，编排 1 个证明抛错，重复/重叠守卫原样通过）；逐文件 100% statements、branches、functions、lines。
- `tsc -b` 干净；oxlint 0 warnings、0 errors。
- 新增：搜过再验则带名抛错；只验没搜的历史保持干净；跨运行复用搜索仍是 skip 而不是拒绝（既有重复测试覆盖）。
