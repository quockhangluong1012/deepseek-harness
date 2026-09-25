---
description: "面向人类的 /memory、/skills、/journey、/curator、/refine、/trajectory、/learn、/suggestions 与 /frontier 命令，治理暂存的演进写入、作用域活动、会话导出与技能整理（ctx.commands），供治理自学习 harness 的宿主使用。"
kind: "package-reference"
---

# @deepseek-ai/dsh-command-evolution

[English](README.md) | 中文

## 概述

`dsh-command-evolution` 把演进 harness 的人类治理带进聊天 UI：`/memory` 与 `/skills` 批准或拒绝暂存写入，`/journey` 显示该作用域已记录的活动，`/curator` 显示整理台账、运行一次维护通过并列出为复核而暂存的技能，`/refine` 重建该作用域的经验，`/trajectory` 导出会话或作用域，`/dream` 把已记录的失败固化为记忆，`/frontier` 按实测证据把能力从最弱到最强排序，`/suggestions` 列出带 blueprint 的技能而不调度它们。除 `/learn` 外的命令都直接作答；`/learn` 排队一个普通轮次。当人类必须治理后台评审的提议、让它在落地前可见时，选择本包。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

当后台评审为当前 workspace 作用域暂存了提案时，在聊天 UI 输入 `/memory` 或 `/refine`。作用域按注入器的方式解析——先查注册表会话归属，回退到规范 `cwd` 匹配——使用必填的 `profile`；作用域之外的会话得到 `This session is outside any workspace scope.`，而不是一个猜测。

### 配置

`profile` 为必填：部署方必须指明命令治理的作用域命名空间。作用域永不共享默认命名空间。

```yaml
- name: '@deepseek-ai/dsh-command-evolution'
  config:
    profile: default
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `profile` | 必填 | workspace 键之前的作用域标识命名空间 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-command-evolution)是每个可接受字段的详尽来源。

### 使用命令

| 输入 | 结果 |
|---|---|
| `/memory`、`/memory pending` | 以 `- <id> [<kind>:<op>] <gist> (session '<origin>', <instant>)` 列出作用域的暂存条目；无待审批项时返回 `No pending writes.`。`applyDecisions` 条目之下还会为每个决策各列一行缩进明细。裸 `/memory` 报告同一列表。 |
| `/memory approve <id>` | 应用一条记忆类条目并报告 `Approved staged <op> (<gist>).`；未知 id 报告 `No staged write '<id>'.`；技能类 id 会被重定向到 `/skills approve`。 |
| `/memory reject <id>` | 不应用而丢弃一条并报告 `Rejected staged write '<id>'.`。 |
| `/memory <anything-else>` | `Usage: /memory pending \| approve <id> \| reject <id>`——文法固定。 |
| `/skills`、`/skills pending` | 列出作用域的暂存技能条目，或给出指明提案来源的空状态。裸 `/skills` 报告同一列表。 |
| `/skills approve <id>` | 丢弃技能写入已落地的暂存技能条目，并在批准时附带该提醒；不是暂存技能的 id 报告 `No staged skill '<id>'.`。缺少有效捕获契约的**新建**提案保持暂存，并报告缺失的证据；`patch` 仅凭批准即可通过。 |
| `/skills <anything-else>` | `Usage: /skills pending \| approve <id>`。 |
| `/journey [today\|7d\|30d\|all]` | 渲染作用域时间线：窗口标题、每个活跃日一行、容量与摘要，以及暂存计数。裸 `/journey` 报告 `7d`。 |
| `/journey export [today\|7d\|30d\|all] [--out <path>]` | 把时间线加当前会话日志打包为 zip 归档并报告 `Journey exported to <path>`；路径默认为 `$DSH_HOME/exports/journey-<scope>-<range>.zip`。解析器拒绝的文法会报告 `Usage: /journey export [today \| 7d \| 30d \| all] [--out <path>]`。 |
| `/journey <anything-else>` | `Usage: /journey [today \| 7d \| 30d \| all]`。 |
| `/curator status` | 渲染上次通过的时刻、按生命周期状态（含置顶）与信任状态统计的被跟踪技能计数、来自用量台账的今日缓存命中率、来自遥测的技能失败率汇总、待复核分选数及最差失败率，以及最新记录的通过。任一比率在其来源未挂载时具名说明。 |
| `/curator run` | 立即运行一次维护通过：报告移动、跳过计数与快照 id。 |
| `/curator run --dry-run` | 同一通过只预览不写入；快照行显示 `Snapshot: none`。 |
| `/curator staged` | 列出台账为复核而分选的技能，失败率最差在前，并附选择各项的证据与分选时刻。 |
| `/curator optimize <skill> <scenario...>` | 在具名语料场景上运行一次离线优化，报告分选技能补丁 id 或未分选的原因。成功分选的运行还会把调用会话记录为该补丁在 §53 中的 `candidate-generation` 身份，因此之后晋升它需要另一个会话。需要优化器已挂载且位于工作区作用域内。 |
| `/curator experiments [skill]` | 按最新优先打印该作用域的优化台账——时间、技能、结果、产出候选的算子、分选 id 及其产出算子、晋级行上的 `+added/-removed` 行数、置信度计数与原因——让第二次运行从已试过的东西出发。需要优化器已挂载且会话在某个工作区作用域内。 |
| `/curator adopt <name>` | 把由模型写出的技能认领为用户主导，并报告 `Adopted '<name>' (state: <state>)`；无模型作者身份一律拒绝。 |
| `/curator purge [--dry-run]` | 删除超过 TTL 的归档技能，并报告按目录或按记录的删除与因置顶而跳过者；`--dry-run` 只预览名单而不写入。 |
| `/curator rollback --id <id>` | 回滚一次已记录的通过：先报告被恢复的生命周期状态，若 SKILL.md 正文由其前像恢复，再输出 `Restored bodies: <names>`。 |
| `/curator ledger` | 按新到旧列出已记录的通过及其流转计数。 |
| `/curator pending` | 列出 `requireConsolidationReview` 扣下的归并通过，按新到旧排列，附带记录的提案身份与裁决数；无待复核项时报告 `No pending consolidations.` |
| `/curator apply <passId>` | 以调用会话的身份作为复核者，提交一次待复核的归并。§53 的职责分离在身份与该通过记录的提案者相同、或模型路由存储未挂载时拒绝。 |
| `/curator pin <name>` / `/curator unpin <name>` | 置顶或取消置顶一个被跟踪技能，并报告 `Pinned '<name>'` / `Unpinned '<name>'`。 |
| `/curator history <name>` | 按由旧到新列出单个技能已提交的正文修订：`<n> revision(s) for '<name>':`，随后 `- r<n> <sha8>[ ← r<n-1> <parentSha8>] (<instant>)`；无记录时报告 `No recorded revisions for '<name>'.` pin、unpin 与 history 只读遥测：未挂载时报告 `Skill telemetry is not mounted. Pin, unpin, and history require the telemetry store.` |
| `/curator <anything-else>` | `Usage: /curator status \| run [--dry-run] \| staged \| pending \| apply <passId> \| adopt <name> \| purge [--dry-run] \| rollback --id <id> \| ledger \| pin <name> \| unpin <name> \| history <name> \| optimize <skill> <scenario...> \| experiments [skill]`. |
| `/refine` | 经由评审器重建作用域经验并报告 `Memory rebuild complete.`。 |
| `/refine <anything>` | `Usage: /refine (no arguments)`——命令不接受参数。 |
| `/trajectory` | 经轨迹服务导出调用会话并报告 `Trajectory written to <path> (<n> conversations, <n> bytes).`。 |
| `/dream [light\|rem\|deep]` | 把该作用域已记录的失败固化为持久记忆，或运行单个阶段；报告各阶段扫描、暂存、提升与剪除的数量。 |
| `/trajectory --out <path>` | 同一导出写入指定路径。 |
| `/trajectory --all` | 导出调用会话所在 workspace 作用域的全部会话，而不是当前会话。 |
| `/trajectory <anything-else>` | `Usage: /trajectory [--out <path>] [--all]`。 |
| `/learn <anything>` | 构建调研并保存的提示词，作为一个普通回合排队：`Started a learning turn for '<topic>'. The skill lands only through the gated skill_manage write.` |
| `/learn` | `Usage: /learn <anything>`——命令需要一个主题。 |
| `/suggestions` | 列出 frontmatter 声明了 blueprint 的技能，格式为 `- <name>: <description> (schedule <schedule>, deliver <session\|file>)`，并附上不会调度任何内容的提醒。 |
| `/suggestions <anything>` | `Usage: /suggestions (no arguments)`。 |
| `/frontier` | 按实测证据把该作用域的技能从最弱到最强排序，格式为 `- <name>: <score> [<wins>/<runs>] [· <n> failures [(top: '<message>')]] · <loads> loads in <sessions> sessions[: <description>]`，末尾附排序规则。 |
| `/frontier <anything>` | `Usage: /frontier (no arguments)`。 |
| `/budget` | 按各自的配额结算每一条已记录的批次，格式为 `- <batchId> (<candidateClass>, <taskClass>): <spent>/<maxTokens> tokens, <spentMs>/<maxWallTimeMs>ms`，并给出精确的剩余余量；超出时改为 `EXCEEDED by <tokens> tokens, <ms>ms`。若该配额为 §37 的后续维度定价，则续接 `· cost <spent>/<ceiling> — <left> left, time <spentMs>/<ceiling>ms, parallelism <spent>/<ceiling>`；已定价但无记录的维度显示为 `unmeasured (ceiling <n>)`，而不是它无法证明的零；未定价的维度不渲染。裸 `/budget` 列出全部批次。 |
| `/budget spends [<batchId>]` | 列出已记录的开销，格式为 `- <batchId>: <tokens> tokens, <wallTimeMs>ms, <n> rollouts at <instant>`。 |
| `/budget <anything-else>` | `Usage: /budget [spends [<batchId>]]`。 |
| `/meta` | 列出在任意任务类别上记录的引擎配置，按得分从高到低，格式为 `- <configId> (<taskClass>): <pct>% pass over <n> runs, <tokens> mean tokens, score <score>`。 |
| `/meta runs [<taskClass>]` | 列出已记录的引擎运行，格式为 `- <runId> (<taskClass>) pass\|fail, <tokens> tokens, <wallTimeMs>ms at <instant>`。 |
| `/meta recommend <taskClass>` | 给出该任务类别下存储推荐的配置，连同其算子、评估器、预算与路由选择、它所执行的工作流（`workflow: <component>=<choice>>…`，或 `workflow: unrecorded`）以及排名依据的数字；证据不足的类别则如实说明。 |
| `/meta <anything-else>` | `Usage: /meta [summaries [<taskClass>] \| runs [<taskClass>] \| recommend <taskClass>]`。 |
| `/operators <artifactClass>` | 将该产物类别的变异算子从优到劣排序，格式为 `- <operator>: <n> attempts, <pct>% accepted, mean delta <delta>, <pct>% regressions, score <score>`。接受率与得分来自排名，回归率则从该类别的统计行合并。 |
| `/operators` | 统计并列出有记录的产物类别，不做排序。 |
| `/operators <anything-else>` | `Usage: /operators <artifactClass>`。 |
| `/router` | 列出实测的路由行，格式为 `- <provider>/<model> (<role>, <taskClass>): <pct>% pass over <n>, <tokens> mean tokens, <ms>ms mean`。 |
| `/router effectiveness [<taskClass>] [<role>]` | 同样的列表，收窄到给定任务类别与 §28 角色；不可用的角色会报告用法。 |
| `/router recommend <taskClass> <role>` | 给出该组合下存储推荐的路由及排名依据的数字，或说明尚无路由积累到足够结果。 |
| `/router <anything-else>` | `Usage: /router [effectiveness [<taskClass>] [<role>] \| recommend <taskClass> <role>]`。 |
| `/evaluator-strategy` | 列出已记录的评估器信任行，格式为 `- <evaluator> (<taskClass>): <n>/<m> independent corroborations over <n> verdicts, weight <weight> at <instant>`。 |
| `/evaluator-strategy rank <taskClass>` | 将该类别的评估器按可信度从高到低排序，并附每个排名背后的印证次数与权重。 |
| `/evaluator-strategy <anything-else>` | `Usage: /evaluator-strategy [strategies [<taskClass>] \| rank <taskClass>]`。 |
| `/metrics [<taskClass>]` | 基于已记录的引擎运行报告北极星指标与支撑指标集，格式为 `- <id>: <value> — <caveat>` 并附每个值的来源存储，或 `- <id>: not measured — <reason>` 并点名所缺失的记录。 |
| `/graph <entity>` | 列出该实体的直接连接：先给 `<label>:`，再为每一跳可达的邻居各列一行 `- <path> → <label>`；本作用域图谱中不存在的实体会报告 `No entity matching '<entity>' in this scope's graph.`。未挂载图谱时报告 `The knowledge graph is not mounted.` |
| `/graph <entity> <relation>` | 沿一条关系向外遍历并渲染 `<subject> —<relation>→ <object>, <object>`；主体没有该关系时报告 `<subject> has no '<relation>' relation.`，实体不存在时给同样的 `No entity matching` 消息。双引号参数会保留其中的空格。 |
| `/graph <anything-else>` | `Usage: /graph <entity> [relation]` |
| `/claims [query]` | 按可信度从高到低列出作用域的活跃主张：`<n> active claim(s):`，随后每行 `- <statement> [confidence <x.xx>, <n> supporting / <n> contradicting source(s), evidence <x.xx>, source <x.xx>, newest <instant>]`；查询无匹配时报告 `No active claim matching '<query>' in this scope.`，已退役的主张永不出现。 |
| `/claims <anything-else>` | `Usage: /claims [query]`——只接受一个查询词，含空格时加引号。 |
| `/reflection [limit]` | 按最新优先列出本作用域会话已存的反思：`<n> reflection(s) (newest first):`，随后每行一块：`- <symptom> (confidence <x.xx>)`、`  expected: <…>`，以及记录在案的 `  cause:`、`  avoid:`、`  instead:`、`  check:`。上限默认为 5；无记录时报告 `No reflections stored for this scope.`。未挂载反馈存储时报告 `The evolution feedback store is not mounted.` |
| `/reflection <anything-else>` | `Usage: /reflection [limit]`——上限为不小于 1 的整数。 |
| `/trace <sessionId>` | 把该会话的已提交日志投影为结构化学习轨迹：`Trace of <id>: <n> turn(s)`，随后是 `, updated <instant>`（或 ` (no events)`），再按回合各列一行 `Turn <n> [<outcome>]` 及其请求、按工具调用各列 `  · <tool> ok` 或 `  · <tool> failed: <message>`、按排序后的根因各列 `    ← <cause>`。未知会话报告 `No trace for session '<id>'.`。未挂载轨迹存储时报告 `The evolution trace store is not mounted.` |
| `/trace <anything-else>` | `Usage: /trace <sessionId>`——恰好一个会话 id。 |
| `/curriculum` | 度量当前能力缺口，为每个缺口暂存一个落地的任务，并列出开放提案：`Staged <n> new task(s).` 或 `No new tasks staged from the measured gaps.`，随后是 `No open curriculum tasks.` 或每个提案一行 `- <id> <capability>: <task>`。未挂载课程存储时报告 `The evolution curriculum store is not mounted.` |
| `/curriculum retire <id>` | 退役一条暂存提案并报告 `Retired curriculum task '<id>' (<capability>).` |
| `/curriculum <anything-else>` | `Usage: /curriculum [retire <id>]` |
| `/benchmark` | 按状态汇总存储：`Benchmark: <n> fresh, <n> search, <n> validation, <n> holdout, <n> contaminated, <n> retired.`，并至多列出十个 fresh 任务 `- <id> <capability>: <task>`。未挂载基准存储时报告 `The evolution benchmark store is not mounted.` |
| `/benchmark admit` | 把课程中开放的提案收为 fresh 任务并报告 `Admitted <n> benchmark task(s), <n> duplicate(s) skipped.`；未挂载课程存储时报告 `The evolution curriculum store is not mounted; admit needs open proposals.` |
| `/benchmark promote <id> [state]` | 把一个任务沿学习阶梯上移一级（或移到具名状态）并报告 `Promoted '<id>' to '<state>'.`；已在阶梯顶端时报告 `No promotion from '<state>' for '<id>'`，未知 id 报告 `evolution-benchmark: unknown task '<id>'`。 |
| `/benchmark retire <id>` | 退役一个任务并报告 `Retired '<id>'.` |
| `/benchmark <anything-else>` | `Usage: /benchmark [admit \| promote <id> [state] \| retire <id>]` |
| `/evaluators` | 汇总评估器集成健康度：`Evaluator health: <n> verdict(s), approved <pct>% (recent <pct>%, drift ±<n> points), unanimous <pct>%, false positives <pct>% of approvals.` 与 `Channels: <channel> <pct>%, …`。未挂载存储时报告 `The evaluator-health store is not mounted.` |
| `/evaluators runs [<skill>]` | 按最新优先列出十条已记录判定：`<n> verdict(s):`，随后 `- <id8> <skill>: <status>[ approved][ unanimous\| (split: <evaluators>)] at <instant>`；无记录时报告 `No recorded evaluator verdicts.` |
| `/evaluators <anything-else>` | `Usage: /evaluators [runs [<skill>]]`——至多一个技能。 |
| `/population <skill>` | 列出候选种群：`Population '<skill>': generation <n>, <n> candidate(s).`，随后每行 `- g<n> <id8> [<status>] <operator>:` 接 `<pass> pass, <tokens> tokens, <ms>ms`，三元组缺失时为 `unmeasured`，并以 ` · root` 或 ` ← <parent8>` 结尾；最后是 `Elite: <id8> (g<n>), …` 或 `Elite: none approved yet.`。该技能无候选时报告 `No candidates recorded for '<skill>'.`。未挂载种群存储时报告 `The evolution population store is not mounted.` |
| `/population <skill> lineage <id>` | 从 `Lineage of '<id>' in '<skill>':` 起由旧到新走一条候选血缘，最新的标记 `← newest`；未知 id 报告 `No candidate '<id>' for skill '<skill>'.` |
| `/population <skill> approve <id>` / `/population <skill> reject <id>` | 移动一条暂存候选的地位并报告 `Marked candidate '<id8>' (g<n> <skill>) as '<approved\|rejected>'.` |
| `/population <anything-else>` | `Usage: /population <skill> [lineage <id> \| approve <id> \| reject <id>]` |
| `/routes` | 列出每个角色已记录的路由：`Routes:`，随后 `<role>: <provider>/<model>[ (pinned)]: <n> run(s), <pct>% pass, <n> tokens avg · …[ → recommended <provider>/<model>]`；无记录时报告 `No route assignments yet. The optimizer records candidate-generation routes; pin the rest.`。未挂载存储时报告 `The evolution model-routes store is not mounted.` |
| `/routes pin <role> <provider> <model>` | 为某个 §28 角色固定一条路由并报告 `Pinned '<role>' to <provider>/<model>.`；角色不可用或 provider、model 为空时报用法。 |
| `/routes evidence [<role>]` | 按最新优先列出十条证据行：`<n> evidence row(s):`，随后 `- <id8> <role>: <provider>/<model> <pass> pass, <tokens> tokens at <instant>`；无记录时报告 `No recorded route evidence.` |
| `/routes <anything-else>` | `Usage: /routes [pin <role> <provider> <model> \| evidence [<role>]]` |
| `/canary` | 汇总部署状态：`Canary: <n> shadow, <n> canary, <n> promoted, <n> rolled-back, <n> rejected.`，并至多列出十条 `- <id8> <skill>: <state>[ → next <stage>][ (<pass>, <tokens> tokens)]`；尚无部署时报告 `No deployments yet. The optimizer records staged writes as shadow.`。未挂载存储时报告 `The evolution canary store is not mounted.` |
| `/canary status [<skill>]` | 同一部署列表收窄到单个技能；该技能无部署时报告 `No deployments for '<skill>'.` |
| `/canary rollout <id>` | 把一个 shadow 部署移到 canary，并报告 `Deployment '<id8>' (<skill>) moved to '<state>'.` |
| `/canary promote <id>` | 把一个 canary 部署提升为 promoted，报告同一条消息。§53 的职责分离把守这次晋升：调用会话被记录为审查身份，若晋升者就是提案该候选的身份——或该候选的提案身份从未被记录——则报告 `Promotion of '<id>' refused: <reason>`，部署留在原处。 |
| `/canary reject <id>` | 让一次分阶段发布以 rejected 退出，报告同一条消息。当血缘存储已挂载且记录过该 ID 时，其结果会被改为 `'regressed'`，附上点名此次退出的原因，使已记录的 `'improved'` 结论不会活得比这次拒绝更久；改写失败只记警告，不会让报告本身失败。 |
| `/canary rollback <id>` | 让一次分阶段发布以 rolled-back 退出，报告同一条消息，并做同样的血缘改写。 |
| `/canary <anything-else>` | `Usage: /canary [status [<skill>] \| rollout <id> \| promote <id> \| reject <id> \| rollback <id>]` |
| `/novelty` | 汇总新颖性档案：`Novelty archive: <n> entry(ies) across <n> skill(s).`，随后按技能名排序的 `- <skill>: <n> entry(ies), mean novelty <x.xx>`；无记录时报告 `No recorded novelty archive entries. The optimizer records staged writes as descriptors.`。未挂载存储时报告 `The evolution novelty-search store is not mounted.` |
| `/novelty <skill>` | 列出单个技能的行为描述符：`Novelty archive '<skill>': <n> entry(ies), mean <x.xx>.`，随后至多十条 `- <id8>: <n> features, novelty <x.xx> at <instant>`；该技能无记录时报告 `No recorded novelty archive entries for '<skill>'.` |
| `/novelty <anything-else>` | `Usage: /novelty [<skill>]` |
| `/stagnation` | 汇总每个有记录的技能：`Stagnation:`，随后 `- <skill>: <n>/<threshold> generations since improvement`，再接 ` — STAGNANT → <strategy>` 或 ` — ok`；无记录时报告 `No recorded stagnation runs. The optimizer records staged writes as runs.`。未挂载存储时报告 `The evolution stagnation store is not mounted.` |
| `/stagnation status <skill>` | 用三行渲染单个技能：`Stagnation '<skill>': <n> run(s), best <pass> pass, <tokens> tokens, <ms>ms.`（尚无最佳值时是 `best no best yet.`）、`<n> generation(s) since improvement, threshold <threshold>.`，以及 `STAGNANT → strategy: <strategy>` 或 `Not stagnant — continue <strategy>.` |
| `/stagnation runs [<skill>]` | 按最新优先列出十条运行：`<n> run(s):`，随后 `- g<n> <id8> <skill>: <pass> pass, <tokens> tokens, <ms>ms[ improved] at <instant>`；无记录时报告 `No recorded stagnation runs.` |
| `/stagnation reset <skill>` | 清空该技能的历史并报告 `Reset stagnation history of '<skill>': dropped <n> run(s).` |
| `/stagnation <anything-else>` | `Usage: /stagnation [status <skill> \| runs [<skill>] \| reset <skill>]` |
| `/islands` | 列出各泳道：`Islands:`，随后 `- <island> '<name>' [<objective>] <skill> g<n>[ · migration due]`；无注册时报告 `No islands registered.` 并指向 `/islands register <island> <name> <objective> <skill>` 形式。未挂载存储时报告 `The evolution islands store is not mounted.` |
| `/islands list [<skill>]` | 同一排期列表收窄到单个技能，标题为 `Islands '<skill>':`。 |
| `/islands register <island> <name> <objective> <skill>` | 注册一条泳道并报告 `Registered island '<island>' '<name>' [<objective>] for '<skill>'.`；目标不在注册集合内时报用法。 |
| `/islands migrate <from> <to> <candidate> [<reason>]` | 记录一次候选迁移并报告 `Migrated candidate '<id8>' <from> → <to> (<reason>).`；原因取 `schedule`（默认）、`elite` 或 `diversity`。 |
| `/islands migrations [<skill>]` | 按最新优先列出十条日志：`<n> migration(s):`，随后 `- <id8> <candidate8> <from> → <to> (<reason>) at <instant>`；无记录时报告 `No recorded island migrations.` |
| `/islands <anything-else>` | `Usage: /islands [list [<skill>] \| register <island> <name> <objective> <skill> \| migrate <from> <to> <candidate> [<reason>] \| migrations [<skill>]]` |
| `/selfmodel` | 按最弱优先渲染能力前沿：`Capability frontier (weakest first): <n>`，随后 `- <capability>: score <x.xx>, confidence <x.xx>, <n> skill(s), <n> observations` 与 `Next to learn: <capability>`；尚无度量时报告 `No measured capabilities yet. The optimizer records capability observations as it stages writes.`。未挂载存储时报告 `The evolution self-model store is not mounted.` |
| `/selfmodel <skill>` | 渲染一份已记录的自我评估：`Self-model '<skill>' (revision <n>, confidence <x.xx>):`，随后是非空的 `strengths`、`weaknesses`、`uncertain areas`、`failure modes`、`preferred tools` 与 `evaluator blindspots` 列表；未记录的技能报告 `No self-assessment recorded for '<skill>'.` |
| `/selfmodel <anything-else>` | `Usage: /selfmodel [<skill>]` |
| `/uncertainty [<skill>]` | 渲染队列：`Evaluation queue[ '<skill>']: <n>`，随后 `- <skill> (skill-wide)` 或 `task <taskId>`，再接 `: priority <x.xx>, [<kinds>], <n> signals`；无信号时报告 `No uncertainty signals. The scorer records evaluator disagreement as signals.`。未挂载存储时报告 `The evolution uncertainty store is not mounted.` |
| `/uncertainty <anything-else>` | `Usage: /uncertainty [<skill>]` |
| `/adversary` | 列出已记录探针：`Adversarial probes[ '<skill>']: <n>`，随后 `- <id8> [<category>] <skill>: weakness found` 或 `no weakness`，另加 ` · repaired`；无记录时报告 `No adversarial probes recorded.` 并指向 `/adversary probe <skill> <category> <probe>` 形式。未挂载存储时报告 `The evolution adversary store is not mounted.` |
| `/adversary list [<skill>]` | 同一探针列表收窄到单个技能。 |
| `/adversary probe <skill> <category> <probe>` | 记录一条探针（类别之后的所有词都算作探针文本）并报告 `Recorded a '<category>' probe for '<skill>'. Mark it repaired with /adversary repair <id> once the weakness is fixed.`；类别不在注册集合内时报用法。 |
| `/adversary repair <probeId>` | 把一条探针标记为已修复并报告 `Marked probe '<id8>' repaired.` |
| `/adversary challenge <skill>` | 给出下一个应跑的探针：`Next adversarial probe for '<category>' (<n> recorded): <reason>` |
| `/adversary defenses` | 列出评估器博弈防线清单：`Evaluator-gaming defenses:`，随后 `- <defense>: satisfied` 或 `- <defense>: open`；无记录时报告 `No evaluator-gaming defenses recorded.` |
| `/adversary defense <name> <satisfied>` | 用 `true` 或 `false` 设置一条防线并报告 `Set defense '<name>' to satisfied.` 或 `Set defense '<name>' to open.` |
| `/adversary <anything-else>` | `Usage: /adversary [list [<skill>] \| probe <skill> <category> <probe> \| repair <probeId> \| challenge <skill> \| defenses \| defense <name> <satisfied>]` |
| `/lineage` | 按最新优先列出实验信封：`Experiments[ '<skill>'] (newest first): <n>`，随后 `- <id8> <skill> <outcome> by <operator>`（未记录时为 `?`）：`: <pass> pass, <tokens> tokens, <ms>ms`；无记录时报告 `No experiment envelopes recorded. The optimizer records staged writes as envelopes.`。未挂载存储时报告 `The evolution lineage store is not mounted.` |
| `/lineage list [<skill>]` | 同一信封列表收窄到单个技能。 |
| `/lineage compare <idA> <idB>` | 证明两个信封可比：`'<a8>' vs '<b8>': comparable — no compared dependency changed.` 或 `'<a8>' vs '<b8>': incomparable — changed dependencies: <names>.`；未知 id 报告 `Unknown experiment id in /lineage compare.` |
| `/lineage replay <id>` | 渲染一条信封的记录：`Experiment <id> (<skill>, <outcome> by <operator>):`、`- pass <bool>, <tokens> tokens, <ms>ms`、`- dependencies: <key=value, …>` 或 `- dependencies: none`、`- seeds: <ids>` 或 `- seeds: not recorded`；未知 id 报告 `Unknown experiment '<id8>'.` |
| `/lineage <anything-else>` | `Usage: /lineage [list [<skill>] \| compare <idA> <idB> \| replay <id>]` |
| `/sleeptime` | 按可能性从高到低列出预期任务：`Anticipated tasks[ '<domain>'] (likelihood first): <n>`，随后 `- <taskId> (<domain>): <pct>%, <n> expected queries, <n> tokens each`；无预期任务时报告 `No anticipated tasks. Anticipate likely future tasks to seed sleep-time compute.`。未挂载存储时报告 `The evolution sleeptime store is not mounted.` |
| `/sleeptime tasks [<domain>]` | 同一任务列表收窄到单个领域。 |
| `/sleeptime artifacts [<taskId>]` | 列出预计算工件：`Precomputed artifacts[ '<taskId>']: <n>`，随后 `- <id8> [<kind>] for <taskId>: <n> hits, <n> tokens saved, cost <n>`；无记录时报告 `No precomputed artifacts recorded.` |
| `/sleeptime plan` | 展示离线成本计划：`Sleep-time plan:`，随后 `- <taskId> (<domain>): net <n> tokens — <reason>`；没有值得构建的东西时报告 `Nothing worth precomputing now. Anticipate tasks to seed the plan.` |
| `/sleeptime <anything-else>` | `Usage: /sleeptime [tasks [<domain>] \| artifacts [<taskId>] \| plan]` |

`applyDecisions` 条目在 gist 里给出一批决策的计数——confirms、contradicts 与 new 各多少条——并在该行之下为每个决策各列一行缩进明细：`new '<statement>'`、`confirms '<current statement>'` 或 `contradicts '<current statement>'`，而当该条反驳携带了更正后的 statement 时则是 `contradicts '<current statement>' → '<replacement>'`。`confirms` 或 `contradicts` 的目标渲染为记录当前为该工件持有的 statement；记录已不再持有时则渲染为该工件的 id——该 id 正是工件创建时所用的规范化 statement，因此读起来仍是文本。其他操作只打印自己的 gist 行；渲染器读不懂其载荷的 `applyDecisions` 条目同样如此：读不懂的暂存载荷不渲染任何明细行，而不是让整张列表失败。

### 你会看到什么

命令会把每个预期失败转换为可直接展示的稳定消息；左列的情形产生右列的消息。

| 情形 | 你看到的消息 |
|---|---|
| 会话不在任何 workspace 内（作用域命令） | `This session is outside any workspace scope.` |
| 经由 `/memory` 批准技能类条目 | `Staged skill '<id>' (<op>) is decided by '/skills approve <id>': write the skill with skill_manage first, then approve there to drop the entry.`——条目保持暂存。 |
| 批准时触发上限或子串拒绝 | `Cannot approve '<id>' (<code>): <detail>. The entry stays staged.` |
| 批准缺少准入证据的新建提案 | `Cannot approve '<id>' (evolution/staged-blocked): staged evolution write '<id>' is blocked: <needed evidence>. The entry stays staged.` |
| 批准或拒绝未知 id | `No staged write '<id>'.` |
| `/skills approve` 的 id 不是暂存技能 | `No staged skill '<id>'.` |
| 未挂载评审器时 `/refine` | `The evolution reviewer is not mounted.` |
| 未挂载整理器时 `/curator status` | `The evolution curator is not mounted.` |
| 重建被拒绝 | `Memory rebuild failed (<code>): <detail>.` |
| 未挂载导出器时 `/trajectory` | `The evolution trajectory exporter is not mounted.` |
| 在任何 workspace 作用域之外使用 `--all` | `This session is outside any workspace scope.` |
| 导出被拒绝 | `Trajectory export failed (<code>): <detail>.` |
| 未挂载技能注册表时 `/suggestions` | `The skill registry is not mounted.` |
| 未挂载优化器时 `/frontier` | `The evolution optimizer is not mounted.` |
| 未挂载遥测时 `/frontier` | `Skill telemetry is not mounted. The frontier needs the telemetry store.` |
| 没有任何技能时 `/frontier` | `No measured capabilities yet.` |
| 没有任何带 blueprint 的技能时 `/suggestions` | `No blueprint-backed skills. A skill appears here when its frontmatter declares a blueprint; this command never installs the schedule it names.` |
| 由提案该补丁的身份发起晋升 | `Promotion of '<id>' refused: identity '<identity>' filled both candidate-generation and promotion-review for run '<id>'` —— 部署留在原处。 |
| 晋升一个提案身份从未被记录的补丁 | `Promotion of '<id>' refused: run '<id>' records no candidate-generation identity, so candidate-generation and promotion-review cannot be shown to be separate identities` —— 部署留在原处。 |
| 由提案该待复核归并的身份发起应用 | `evolution-curator: consolidation '<passId>' refused: identity '<identity>' filled both candidate-generation and promotion-review for run '<passId>'` —— 该通过仍留在待复核状态。 |
| 模型路由存储未挂载时应用一次待复核的归并 | `evolution-curator: the evolution model-routes store is not mounted, so the reviewing identity cannot be verified` |

取消 `/refine` 即停止等待：注册表以中止原因结算调用，与 `/compact` 的取消约定一致。除上述预期情形外的失败会以错误形式呈现，而不会被静默转换。

### 组合命令

挂载命令注册表、workspace 注册表与演进记忆存储；`/refine` 需要评审器，而 `/curator` 在整理器与技能遥测挂载时读取它们：

```yaml
- name: '@deepseek-ai/dsh-commands'
- name: '@deepseek-ai/dsh-workspace'
- name: '@deepseek-ai/dsh-evolution-memory'
  config:
    capacityBytes: 131072
- name: '@deepseek-ai/dsh-evolution-reviewer'
- name: '@deepseek-ai/dsh-command-evolution'
  config:
    profile: default
```

没有 `ctx.commands` 的界面无法调用它们；暂存写入转而等待已挂载的命令适配器或控制器。`/curator status` 是宿主级的，能从任何会话工作，包括不在任何 workspace 作用域内的会话；整理器、遥测、轨迹导出器、评审器、技能注册表与模型路由存储都是通过 `ctx.get` 读取的可选服务，因此即使部署中没有它们，该命令依然可用，并给出诚实的简短回答——而没有模型路由存储时，晋升不记录任何职责，§53 的拒绝也就无从施加。

### 对话会发生什么

批准经由存储自身的写入链应用暂存的记忆操作，因此上限与子串拒绝会像直接存储调用一样保留条目；拒绝丢弃任一类别。一批暂存的 `applyDecisions` 是一次写入：批准会在审批时读到的记录上应用整批，因此上限拒绝会让它的每一条决策一起留在暂存。命令生命周期记入会话日志，永不进入模型历史。`/learn` 是唯一会开启回合的命令：它把一段由提示词构建器撰写的消息作为自己回合的唯一普通消息排队，模型随后用已有工具收集材料，并经由受提案门控的 `skill_manage` 写入器提议一个技能。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释命令背后的设计决策；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计理念

该命令建立在五项承诺之上：

- **治理不新增持久状态。** 插件不拥有任何域：待审批列表与时间线读取作用域记录（整理器则经由整理器服务读取自己的台账），变更委托 `approveStaged` / `rejectStaged`，重建把作用域加信号转发给 `evolutionReviewer.rebuild`，导出把会话或作用域转发给轨迹服务，建议读取技能目录。存储仍是唯一权威。
- **批准者先执行技能写入。** 批准技能类条目在存储中只会丢弃它，因此 `/skills approve` 也这么说：人类先写入技能（经由 `skill_manage`），再批准以丢弃条目，而 `/memory approve` 会把技能类 id 重定向到那里。没有任何内容被静默丢弃或静默应用。
- **读取只报告记录能证明的内容。** `/journey` 按仪表盘的 UTC+7 日历，为记录携带的每项事实各输出一个增量——每个文档族都来自它自己的写入时间戳、每个上下文条目、每个已索引产出、每条暂存条目——并在裁决落地当天计入该裁决；它绝不猜测一次无法解释的 `updatedAt` 移动的是哪个字段。
- **排队不等于写入。** `/learn` 构建提示词并排队一个普通回合；命令自身不写任何内容，因此唯一的保存路径是受提案门控的 `skill_manage`。`/suggestions` 只读取 blueprint，不调度任何内容。
- **完全停稳的拆除。** 生命周期 effect 先注销这些命令，再排空已开始的处理器，因此根拆除不会越过一次进行中的重建——正如 `/compact` 不会越过一次中止的压缩。

### 归属与作用域

作用域解析复制注入器的归属规则但不带缓存——命令是一次性的，因此每次调用都执行注册表会话归属加规范 `cwd` 回退，不保留任何状态；`/curator status` 是宿主级的，完全不解析作用域。`profile` 门控与注入器一致：空的或含 `:` 的命名空间在插件加载时大声失败。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：命令注册、作用域解析、暂存与导出失败映射、`/learn` 提示词构建器、blueprint 解析、生命周期排空 |
| [`src/journey.ts`](src/journey.ts) | 纯 `/journey` 读模型：按文档族与上下文/产出/暂存的增量、已裁决条目计数、按天桶、累计核算、渲染 |
| — | 不发布运行时不变式伴随条目；该命令适配器不拥有任何状态或事件流；演进记忆存储拥有唯一的持久域表，命令注册表拥有注册与分发生命周期。 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面；它们从命令逐步进入存储、评审器与设计决策。

- [演进式 Harness 子系统](../../../docs/subsystems/evolutionary-harness.zh.md)——这些命令治理的行为契约。
- [evolution 组地图](../README.zh.md)——本分组的包及其仓库位置。
- [命令包](../../interaction/commands/README.zh.md)——聊天命令背后的注册表与分发约定。
- [Usage ledger](../../session/usage-ledger/README.zh.md)——时间线分桶所用的 UTC+7 日历与窗口辅助函数。
- [演进式 Harness 子系统](../../../docs/subsystems/evolutionary-harness.zh.md)——本家族的行为在此描述，包括这些命令落地的 CLI 切片（`/suggestions` 仍在计划中）。

-----

<a id="model-experience"></a>
## 模型体验

### 人类治理命令

#### 模型看到的内容

斜杠输入与直接结果（例如 `No pending writes.`）绝不会进入模型请求。已批准的记忆写入随后作为注入的演进简报的一部分到达模型；重建改写下一份简报渲染的已存经验。`/learn` 是有意的例外：它由提示词构建器产出的内容作为普通 user 角色回合排队，因此模型看到的正是该命令构建的调研并保存指令——包括 `skill_manage` 写入受提案门控的提醒。

#### Token 影响

命令生命周期不会增加模型 token；结果只是面向人类的命令文本。`/learn` 会开启一个回合，因此它花费的 token 与该提示词上任何其他回合相同。

#### KV Cache 影响

命令发现与簿记不会影响缓存。已批准的经验变更会从下一份注入简报起使复用失效，与直接存储写入完全一致。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制说明该命令何时不合适；它们是当前包约束。

- **不应用技能写入**——`/skills approve` 丢弃暂存技能条目；技能文件由 `skill_manage` 写入，命令本身从不写技能文件。`/canary reject`/`rollback` 会改写匹配的血缘结果，使记录的结论贴合现实，但没有任何 `/canary` 动词会对照暂存正文核验实际技能文件，也没有一个会写入它：这两者任一都会推翻这一刻意的人工写入把关，以及这个包里每个姊妹存储都记录在案的、组级的 §58.12「只记录、不强制」边界——不是一条命令能单独改动的事。
- **`/learn` 依赖受门控的写入器**——命令只排队一个回合；如果组合出的 agent 没有 `skill_manage`（或没有收集工具），该回合无法保存任何内容，提示词也会如实说明，而不是假装技能已落地。
- **`/suggestions` 只是建议**——它读取 blueprint 且不调度任何内容；安装 blueprint 所命名的 cron 条目仍是人类单独且审慎的行动。
- **blueprint 读取兼容两种表面**——技能的 blueprint 从解析后的 frontmatter 字段读取，或从它被解析自的 frontmatter 袋读取，因为发现层只发布其中一种；未被接受的形状只是不被建议。
- **导出需要导出器**——组合中缺少轨迹导出器时 `/trajectory` 报告 `The evolution trajectory exporter is not mounted.`，文件布局由导出本身拥有。
- **每次调用只治理一个作用域**——作用域命令只治理调用会话所在的作用域；没有跨作用域视图（只有 `/curator status` 与 `/suggestions` 是宿主级的）。
- **仅限命令适配器**——没有 `ctx.commands` 的界面无法调用它们；暂存写入转而等待已挂载的适配器或 `evolutionController` Remote 命名空间。
- **晋升需要已记录的提案者**——除非该候选的提案身份已在模型路由的职责表中，否则 `/canary promote` 拒绝执行，而只有 `/curator optimize` 会记录它。宿主直接调用 `ctx.evolutionOptimizer.optimize` 暂存的补丁没有提案填充，因此其晋升会以 `unknown-identity` 被拒绝，直到该身份被记录；模型路由存储也必须已挂载，因为没有它时晋升根本不记录职责。
- **归并复核是可选项**——`/curator apply` 只用来提交 `requireConsolidationReview` 扣下的通过；该整理器配置项关闭时（默认如此），归并仍会一次性提交自己的裁决，`/curator apply` 对任何 id 都报告 `evolution-curator: no pending consolidation '<passId>'`。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文，明确不具权威性；已交付行为以上文、包代码与所链接的 Agent Note 为准。

- **注入器归属收敛，尚未决定**——作用域解析复制了注入器的归属规则但不带缓存。抽取共享辅助函数（由记忆包或 workspace 注册表拥有）要等到第三个消费者出现；两份副本加一处明确的所有者说明，比过早的 seam 更便宜。

</details>
