# Agent Note：暂存候选库、捕获契约、技能排序与行为评估

Status: implemented

[English](2026-09-20-deferred-evolution-mechanisms.md) | 中文

## Problem

`specs/evolutionary-harness-v11-deep-research.md` §58.1 第 9–12 行曾因缺少生产信号而延期四个机制，而信号如今已经到来：暂存的技能提案每次重复都会产生重复条目；被阻塞的审批一经拒绝便不留痕迹；技能审批接纳只有程序证据的材料；目录没有任何排序；评分器没有基线对候选的比较，也没有路由检查。

## Decision

四个机制，各自由已拥有其接缝的包实现：

1. **候选库**（`dsh-evolution-memory`）。`StagedWrite` 携带 `mergeKey`、`recurrence`（从 1 起）、`blockedReason` 与 `neededEvidence`；`StagedResolution` 携带条目的 `mergeKey` 与 `recurrence`。`stageWrite` 接受可选的 `mergeKey`：在同一 scope 内，已有待定条目携带相同键时再次暂存，会把该条目的 `recurrence` 加一，而不是追加重复条目，因此被反复提出的候选会被记住，而不是被悄悄重试。`blockStaged` 给待定条目标记原因与缺失的证据，条目保持待定；审批或拒绝会通过移除条目来清除阻塞标记。所有新增持久字段都有 zod 默认值，因此已提交的记录可原样打开。
2. **捕获契约**（`dsh-evolution-memory/src/capture-contract.ts`）。`validateCaptureContract` 仅在以下条件全满足时接纳契约：非空 `capability`、至少一个 `procedureRef`、至少一个与程序引用不相交的 `validationRef`，以及非空 `validationSummary` 与 `limitations`；每次拒绝都点名缺失的证据。没有有效契约的技能条目调用 `approveStaged` 时，条目留在暂存（`blockedReason: 'capture-contract'`），缺失项记入 `neededEvidence`，并以 `evolution/staged-blocked` 拒绝——与上限拒绝已有的「保留暂存并向上传播」形状一致。`supplyStagedContract` 给待定的技能提案附加一份完全有效的契约并解除阻塞；条目仍需一次显式审批。评审器用 `skillProposalMergeKey`（与 `skillCreationEvidence` 同一规范化、与顺序无关）暂存技能提案，因此在准入证据尚未补齐时，重复提案只会推高重复计数。`/skills approve` 与 `/journey` 会展示阻塞及其证据。
3. **技能排序**（`dsh-skill/src/rank.ts`）。`rankSkills` 在名称、描述与 `whenToUse` 上做 BM25 粗排（Robertson `k1`/`b` 默认值，unicode 分词）；调用方提供向量时按嵌入余弦相似度重排，提供信号（`SkillRankSignal`：信任状态加已记录失败率，由调用方从遥测映射，无需包依赖）时按下游效用重排。排序是纯同步函数——无 IO、无模型调用；它唯一的生产消费方是行为评估的路由门，而这正是该排序为之构建的离线选择器。不存在会变质的排序缓存：排序按调用方提供的修订键逐次计算，而注册表按 revision 键控的收集中缓存本来就会在技能演进时失效。每回合目录保持静态顺序，直到一次可度量的检索失败证明应当把排序接入面向模型的路径。
4. **行为评估**（`dsh-evolution-scorer/src/behavior.ts`，`EvolutionScorer.evaluateBehavior`）。三道门，按从廉价到昂贵的顺序：`checkBehaviorContract` 拒绝会破坏技能 frontmatter 的正文（与 `skill_manage edit` 同一不变式、同一实现）；`checkBehaviorRouting` 把肯定与否定触发查询送入真实的选择器，要求肯定查询把候选排进 `routingTopK`、否定查询把它挡在外面，所用目录为每个条目携带修订键，因此一份报告永不混入不同修订；`compareBehaviorReplay` 仅当候选没有退化基线已证明的任何场景时才批准——双方都失败的场景上的持平不是退化。廉价门一旦失败即以 `status: 'gated'` 返回，不再启动任何全新进程；回放组合被跳过则以 `status: 'skipped'` 返回；否则只有三道门全过，`approved` 才为真——唯有回放证据才能批准。

## Alternatives considered

- 在暂存写入之外另建候选表——否决：提案本来就住在暂存写入里；另建一张表需要域设施并不提供的跨表原子性；合并键、重复计数与阻塞字段直接长在条目自身。
- 在暂存时就要求契约——否决：评审器无法凭空捏造独立验证证据，因此门设在审批处，配以阻塞—补给回路；而缺失的证据清单正好告诉审批人应当附加什么。
- 以嵌入重排为唯一的第二阶段——否决：pre-step 处没有查询时嵌入预算，因此默认按效用重排，嵌入只作为离线门可提供的可选透传。
- 带 `invalidate()` 的记忆化排序器——否决：不存在驱动失效的生产调用方，因此排序保持纯函数，以调用方手中的修订键为失效规则。
- 把路由门放在整理器——否决：整理器既无语料也无三元组比较；评分器两者都有，还有让不可比的行彼此隔离的 `SCORER_VERSION` 戳记。
- 新跨包引用走包根导入——对 `behavior.ts` 否决：在 vitest 下，即使完整构建后包根依然不提供新导出，而深层 `src/` 导入立即可用（整理器已有先例）；包根重导出保留，作为构建后宿主的公共 API。

## Consequences

- 被反复提出的技能是一条待定条目加不断增长的 `recurrence`，而不是 N 条重复；被阻塞的提案点名其缺失的证据，而不是在拒绝时悄悄消失。
- 没有技能提案能仅凭程序证据获批：重叠或缺失的验证引用会带着确切的问题清单被阻塞，`/skills approve` 原样报告。
- 目录有了可离线使用的真实选择器，且不改变任何面向模型的顺序；路由门证明候选赢得自己的触发查询，而不劫持无关查询。
- 优化器之下有了可晋级证据：契约加路由加无退化回放；廉价门让昂贵的回放早停，被跳过的组合拒绝在缺失的证据上做选择。
- `gen-cordis-catalog` 把两个新的服务级类型（`BehaviorEvalRequest`、`BehaviorEvaluation`）归入评分器 README 名下；api-catalog 镜像记录了新的暂存写入接口。

## Deviations from the plan

- 规范第 11 行写的是 BM25 到嵌入的重排；实际交付 BM25 到效用，嵌入作为调用方可提供的可选阶段，因为查询时没有挂载嵌入提供方，而延期行自身的条件（约 10 个技能之后可度量的检索失败）同样尚未满足。
- 没有独立的 `EvolutionCandidate` 表：暂存写入本身就是候选，在待定期间以 `mergeKey` 为键；`blockStaged`/`supplyStagedContract` 之所以存在，正是因为规范只点了字段名，却没有设置它们的操作。
- 有效补给会清除阻塞；规范草图里没有解禁路径，因为在此变更之前，被阻塞的条目从未落在任何持久处。

## Testing

- `evolution-memory`：候选去重／重复计数／作用域隔离、旧结构默认值、阻塞／补给／审批门路径（含标量／null／列表载荷与重叠引用）；新增 `capture-contract.spec.ts` 覆盖每种校验拒绝与 JSON 物化。
- `evolution-skill-telemetry`：合并键与顺序无关、与证据计数器共享规范化、空列表大声拒绝。
- `evolution-reviewer`：暂存提案携带合并键；第二次触发只推高重复计数，不产生重复条目。
- `command-evolution`：`/skills approve` 放行带契约的提案，报告被阻塞提案及其证据；journey 展示被阻塞的待定行。
- `dsh-skill/rank`：排序、kebab／unicode 匹配、空查询回退、信任／失败降级、向量偏好与各种无支撑形状、完全持平的确定性顺序。
- `evolution-scorer/behavior`：契约／路由／回放单元门（含两种 topK 拒绝），以及服务级运行证明的早停（零进程启动）、两种跳过路径、一次批准与一次点名退化。
- 受影响包覆盖率运行中，每个被触及的 `src/` 文件均为 100% 语句／分支／函数／行；`typecheck`、`constraints`、`verify-cordis-config`、两个目录生成器与翻译配对记录均通过。全仓库 `lint` 与 `verify-translation-pairing` 仍红，但经 diff 确认全是既有条目，无一来自本变更。

## Left alone

- 每回合目录保持静态优先级顺序；把 `rankSkills` 接入面向模型的路径需要一次可度量的检索失败加 snapshot 覆盖，已记为 skill README 的限制。
- 信任依然不决定任何可见性：它只作为效用信号的输入，从不决定加载。
- `/skills approve` 尚无契约编辑流；`supplyStagedContract` 暂为存储层接口，待某个命令来接线。
- `packages/skill/skill/tests/skill.spec.ts` 的 scope-layer 用例在单文件运行时失败；已在干净树上验证完全一致（与本变更无关）。
