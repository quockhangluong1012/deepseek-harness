# Agent Note：基于生产失败的基准增长

状态：已实现

[English](2026-09-21-benchmark-growth.md) | 中文

## 问题

`specs/evolutionary-harness-v11-deep-research.md` §51 将「基准生成器」列为 P1 #17（§14、§35）：生产失败应当自动催生评估基准，经去重与污染控制，而不是让固定语料逐步过时。Harness 已有录制的语料（scorer 场景）与回归债务（curator），但没有任何持久的东西持有基准状态——fresh/search/validation/holdout/contaminated/retired——这些状态会阻止一个曾被用于变异的任务永远被当作干净的测试。

## 决策

新增一个包 `dsh-evolution-benchmark`，持有带生命周期的评估任务：

1. **去重按内容寻址。** `benchmarkHash` 是空白折叠任务文本的 sha256 十六进制；`dedupe` 对照仍可学习的哈希把候选拆成已接纳与重复。`contaminated` 与 `retired` 任务从不阻止重新接纳，因此修复后的任务可以重新进入管线。
2. **状态机即污染控制。** 任务以 `fresh` 进入，每次调用沿 `fresh → search → validation → holdout` 推进一步；任何可学习状态可拉偏到 `contaminated` 或 `retired`，终态永不离场。非法流转与未知 id 响亮拒绝。
3. **一个持久域，一个命令面。** `evolution_benchmark` 域（v1）含一张以任务 id 为键的 `tasks` 表。`/benchmark` 按状态列出，`admit` 把 curriculum 存储的 open 提案晋升为 fresh 任务（交付的产生方→基准管线），`promote`/`retire` 行走阶梯。本包挂载进 web-app profile（只写自己的域，不触及任何模型提示词）。

## 备选方案

- 复用 scorer 的录制场景夹具作为基准——否决：夹具是只读文件，不是有状态任务；基准需要 §35 规定的污染生命周期（用于搜索的任务不能一直停留 `fresh`）。
- 给 curriculum 包加状态——否决：curriculum 从差距提出任务；benchmark 用生命周期策展评估任务；一包一生命周期让每个状态机小而可测。
- 按能力+任务文本对去重——否决：仅基于任务文本的内容地址就能阻止相同任务的重复，无论能力如何，这正是规范所要的重复定义。

## 后果

- 生产失败可自动催生基准：`/benchmark admit` 把 curriculum 的失败依据提案变成 `fresh` 评估任务。
- 污染是显式的：任务只在被推进时前进，其当前状态始终回答「它可曾被用于搜索？」。
- 重新接纳可用：已污染或已退役的重复不会阻止其修复后的孪生重新进入。

## 与计划的偏差

除常规外没有。`promote` 命令在未指名状态时自动选择下一个阶梯（`nextLadder`），因此运维者无需记住阶梯顺序。

## 途中修复

命令 spec 的 benchmark stub 起初把重复报告为计数；命令读取 `duplicates.length`（真实存储返回文本），因此 stub 改为返回文本。

## 测试

去重：内容寻址规范化、已接纳/重复拆分含趟内去重、阻止状态分类、阶梯流转与拉偏、`nextLadder`。存储：带哈希与重复报告的接纳、污染/退役后重新接纳、`maxAdmit` 上限、列表排序与过滤且副本脱离、合法/非法/同状态/终态流转、未知 id、启动前读取。`/benchmark`：未挂载、用法、状态列出、从 open curriculum 提案接纳（含缺存储错误）、自动与显式推进、holdout 无可推进、未知 id、退役、流转失败映射、注册与销毁。11 个基准测试与 144 个命令测试通过；包内语句/分支/函数/行 100%。

## 顺带不动

存储持有状态，但没有任何东西运行任务或据此给候选打分——把 optimizer/scorer 接入基准状态是接下来的评估工作（包内 Known Limitations 有说明）。基准是宿主全局而非按作用域键控；按作用域键控推迟。