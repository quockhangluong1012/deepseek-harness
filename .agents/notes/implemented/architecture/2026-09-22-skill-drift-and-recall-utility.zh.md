# Agent Note: 技能漂移与召回效用

Status: implemented

[English](2026-09-22-skill-drift-and-recall-utility.md) | 中文

## 问题

`specs/evolutionary-harness-v11-deep-research.md` 的 §22（陈旧与概念漂移）、§23（相关性反馈回路）与 §24（记忆效用学习）点出了三种机制，而本仓库只建成了它们的记录一半，其中两种甚至连记录都没有。

§22 要求系统注意到旧技能不再有效，依据是时间衰减、近期失败尖峰、任务分布漂移、工具与版本变化、低检索效用，以及更新的冲突证据，并把技能按 `active → suspect → stale → archived` 移动，而不是永远信任它。整理器此前按闲置时长加三条失败规则移动技能，而每一次这样的移动都直接落在 `stale` 上：一趟证据就把技能当作已闲置一个月那样退场。规范点名的 `suspect` 档位在生命周期联合类型里根本不存在。没有任何东西度量工具或版本变化、任务分布漂移或技能的检索效用，因此这些信号永远无法移动任何东西。

§23 要求从使用中学习检索质量：`记得召回 → 是否被使用？ → 是否被引用？ → 是否影响了决策？ → 是否帮助了结果？`。评审器把一次排序召回作为普通上下文条目附着，标签为 `Recall: <id>`，这就是全部记录。没有任何东西统计召回，也没有任何东西把一次召回与之后发生的事连起来，因此一个嵌入相似度较低的记忆永远无法压过更相似但无用的记忆。

§24 推导 `memory_utility = relevance × decision_impact × outcome_gain × source_quality`，而 `evolution-metrics` 把 `memory-utility` 报告为结构性不可测量，其 `unavailableReason` 写着"没有召回命中计数器，也没有结果关联"。`conflicting-evidence` 不确定性类别与每个工件的 `refutationCount` 都存在，却都不驱动任何生命周期流转：两者都按作用域、按工件计数，而没有任何存储字段把它们中的任何一个连接到某个技能。

阅读遥测域时还暴露出另一个缺陷：`failureCount` 与 `lastOutcome` 由 `markFailed` 写入、被整理器的三条规则读取，却从未在该域的记录 schema 中声明——而该域在打开时会重新解析每一条已存记录。因此这两个计数器会在任何宿主下一次启动时被丢弃，悄无声息地把失败率规则与分选候选率归零。

## 决定

1. **`suspect` 是共享生命周期联合类型的成员**，在 `evolution-skill-telemetry` 中声明，并在记录 schema 中带默认值（`state` 增加 `.default('active')`），因此早于该档位写下的 version-2 记录会原样打开，而不是让域打开失败。进入 `suspect` 会盖上 `suspectAt` 时间戳，离开则清除它，`SkillUsageRecord` 声明该字段。`CuratorTransition` 与 `RollbackRestored` 经由它们本就携带的联合类型继承该成员，因此没有第二套词汇。

2. **证据与闲置在同一条阶梯上移动技能，而不是两条。** `decideTransition` 保持单一实现；改变的是每类移动的落点。闲置驱动 `active → stale` 与 `suspect 或 stale → archived`；证据驱动 `active → suspect`。`suspect` 按 `active` 所用的同一闲置阈值老化进入 `stale`，而比该技能进入 suspect 那一刻更新的加载会让它回到 `active`——正是这一比较让"一次干净加载回应了证据"成为可判定的事，也解释了为什么*更早*的一次干净加载做不到。

3. **四个可推导的 §22 信号集中在一个纯模块** `packages/evolution/evolution-curator/src/drift.ts` 中，读取档案本就持有的记录：`failureSpike`（一次决定性 `trigger_review` 分级，被归因到该技能、没有更新的加载回应它、且落在 `driftWindowDays` 之内）、`conflictingEvidence`（在该技能最近一次加载或修补之后记录的 `conflicting-evidence` 不确定性信号）、`lowUtility`（§40 的库内相对差值不大于 `lowUtilityFloor`）、以及 `versionChange`（一条已记录的谱系信封，其依赖版本与上一条不同，且在该技能最近一次使用或修补之后）。每个信号都以 `drift: <名称>` 的形式计入流转原因，任意一个就足够。两个新阈值都是 `Config` 字段：想要更宽的失败窗口或更宽松的效用下限，改配置而不改代码。

4. **谱系与不确定性存储是结构性缝，而不是依赖。** 整理器就地声明它读取的三个字段（`RecordedExperiment`）以及一个 `signals` 形状，并用 `typeof Reflect.get(...) === 'function'` 守卫，这正是 `evolution-memory` 已为其可选心跳与嵌入缝所用的模式。未挂载的存储只让它自己的信号安静，其余照常工作——整理器没有因此新增对这两个包的依赖。

5. **召回台账就放在召回本已落地之处。** `RECALL_LABEL_PREFIX` 移到了 `src/recall.ts`，与它现在作为键的台账词汇放在一起；当标签带该前缀时 `addContextItem` 追加一行；`applyExtractionDecisions` 把所有仍在等待决策的召回绑定到那条带来源信息落地的批次；`recordRecallOutcome` 给某个记忆最新一条仍在等待结果的召回分级——没有任何这样的召回时大声拒绝，而不是重复分级。`recalls()` 跨作用域读取台账；`recallUtility()` 按记忆推导 §24 的乘积。

6. **§23 的两个环节被点名，而不是被编造。** 被注入的条目是否被*使用*、是否被*引用*，在本仓库中没有任何写入方，因此台账记录检索、决策批次与结果，README 与指标 caveat 都写明缺失的是哪些环节。同理，§24 的 `source_quality` 因子对被召回的记忆没有任何记录来源，所以效用就是那个三因子乘积。

7. **`memory-utility` 成为一项实测。** `evolution-metrics` 读取 `ctx.evolutionMemory.recallUtility()` 并报告被召回记忆的效用均值；未挂载存储、或未记录任何召回时，它保持不可测量，并准确点名缺失的记录，而不是报告零。

## 考虑过的替代方案

- **为证据另建一套流转阶梯。** 否决：两个函数判定同一技能的下一状态可能互相矛盾，而现有阶梯本就把闲置与失败证据编在一起。在 `decideTransition` 内部把证据导向 `suspect`，只需推理一种顺序。
- **阈值足够严格时让证据把 `active` 直接推到 `stale`。** 否决为对 §22 的误读：该档位存在的意义正是让证据*质疑*技能而不使其退场，而"suspect 技能只按闲置老化"这一要求，只有在该状态存在时才可表达。
- **把 `used` 与 `cited` 也做成已记录环节。** 否决：没有任何东西观测被注入条目是否被读过，在记忆存储里发明一个写入方等于伪造关于模型注意力的证据。台账记录的是档案所记录的东西。
- **直接读取知识图中被否证的声明与每个工件的 `refutationCount`。** 否决：两者都按作用域、按工件，把任何一个连接到技能都需要没有任何记录携带的字段。按技能的 `conflicting-evidence` 不确定性信号才是确实存在的那条连接，README 陈述该限制而不去近似它。
- **从 `evolution-meta` 的 `taskClass` 推导任务分布漂移。** 否决：该键是被测优化器技能，而不是任务类别；技能使用记录的是会话，而不是这些会话提出的任务。技能使用上不存在任务类别轴，因此该信号根本不会被推导，缺口作为当前状态写入文档。
- **无论闲置与否，下一趟就把 `suspect` 迁到 `stale`。** 否决：那样就是通过节奏在决定生命周期，每小时 tick 一次的宿主会在一小时内让技能退场。按 `staleAfterDays` 老化，才能让两条阶梯的阈值可比。
- **另建 `evolution-drift` 包。** 否决：这些信号只被整理器的一趟读取，规则是不需要上下文即可测试的纯函数——为一个 import 新增一个包，意味着多一行 profile 与一对其 README。
- **没有任何记忆有结果时把 `memory-utility` 报为零。** 否决：零意味着"已测量，且毫无价值"，而缺失的那些因子根本没有被测量。读数保持四因子乘积、其中三个已测，caveat 点名第四个。

## 后果

- 技能现在可以停留在 `suspect`：`command-evolution` 的状态行、调查、清除路径与 `/curator` 渲染都会看到第四个状态。`command-evolution` 的 `/curator status` 通过一个收窄为 `'active' | 'stale' | 'archived'` 的参数统计状态，因此在它被放宽之前会少报（已上报给本批次的负责人；该包不在本次改动的可编辑范围内）。
- `SkillUsageRecord` 新增 `suspectAt`，`state` 新增一个带默认值的成员。每个对该联合类型做分支的消费者都必须处理四个状态；今天做分支的两处（归档的 `consolidate`，以及选取 `archived` 的清除路径）都是相等比较，因此不受影响。
- 召回台账是 `evolution_memory` 记录上新增的带默认值字段，因此该域仍是 version 2，已提交记录打开时台账为空。它被有意排除在简报摘要之外：检索并不是简报所渲染的上下文。
- 整理器的一趟现在会在挂载时读取不确定性与谱系存储，因此组合宿主中的一趟比裸宿主中的一趟证据更全，而抛错的存储由与其余部分相同的可选缝守卫兜住。
- `recordRecallOutcome` 是调用方必须提供的新写入方：没有任何东西自行给召回分级，因此只有某一趟——整理器的那一趟是自然选择——读取结果并记录下来，回路才完整。
- `evolution-metrics` 现在把 `@deepseek-ai/dsh-evolution-memory` 作为 peer 与 dev 依赖，并配有相应的 tsconfig 引用。测试经由仓库的 tsconfig paths 解析它；安装与类型检查需要该清单改动落地。

## 与计划的偏离

计划是把 §22–§24 作为 P1–P3 机制族的一个单元来读。有两处与最初的草图不同。其一是，suspect 的复活不是按 `lastUsedAt` 判定，而是由遥测存储盖上 `suspectAt`：没有它，一个因证据而进入 suspect 的技能会在下一趟就复活，因为它最近一次加载是干净的、且早于那次失败——时间戳才让"一次加载回答了那个问题"可判定。其二是，`failureCount`/`lastOutcome` 被补进记录 schema 而不是放着不管，因为阅读该域时发现它们从未在那里声明、每次重开都会被丢弃；这是修复而不是特性，并列在下面。

## 途中发现的修复

- `packages/skill/evolution-skill-telemetry/src/spec.ts` 现在声明 `failureCount` 与 `lastOutcome`。两者都由 `markFailed` 写入、被整理器的信任失败规则与失败率规则读取，而该域在打开时会重新解析每条记录，因此两个计数器会在下一次启动时被悄悄丢弃。钉住这一点的回归测试在该 schema 改动缺失时会失败。
- 整理器的 `recordTrust` 过去按技能读取反馈存储，而新的漂移信号需要同一份列表；现在两者都经由 `signalsFor(name, usage)` 读取一次，而抛错的存储仍让信任处理把该技能视为未被归因，而不是让整趟失败。

## 测试

`packages/evolution/evolution-curator/tests/drift.spec.ts` 在没有上下文的情况下覆盖纯规则：原因构造器的空情形、每个信号的触发与安静情形、版本规则的信封排序、少于两条信封与被覆盖的情形、被跳过的 `skill` 键，以及按最近一次修补的比较。

同包的 `curator.spec.ts` 在真实存储之上启动整理器，钉住要紧的行为：带近期失败尖峰与 `conflicting-evidence` 信号的技能进入 `suspect`，而同龄的安静技能保持 `active`；实测效用偏低与依赖版本变化各自都能单独进入 `suspect`；suspect 技能只按闲置老化进入 `stale`，并在比其进入 suspect 时刻更新的加载后回到 `active`；原先三条证据移动现在都落在 `suspect` 上。

`packages/evolution/evolution-memory/tests/recall.spec.ts` 覆盖标签读取器的拒绝情形、台账折叠（前插并截断、只绑定一次、给最新一条分级）、效用算术，以及在真实存储之上——召回在条目落地时被计数、且只对召回标签计数；决策批次只把等待中的召回绑定一次；分级会拒绝一个没有任何等待结果的记忆；召回在其条目被移除后仍然留存。其效用测试直接钉住验收用例：两个记忆各被召回一次，一个有后续的干净结果、一个没有，因此已记录的结果是唯一差别，并且它把前者抬到后者之上。

`packages/evolution/evolution-metrics/tests/metrics.spec.ts` 挂载记忆存储并断言：没有任何召回时 `memory-utility` 点名缺失的记录；有召回而其后无任何事时报告 `0`；一旦批次与干净结果落地就报告 `relevance × decision impact × outcome gain`——并让 caveat 点名未被记录的环节。`packages/skill/evolution-skill-telemetry/tests/telemetry.spec.ts` 钉住 suspect 时间戳的生命周期、失败计数器在重开后的存活，以及 schema 默认值。

## 未触碰的部分

§22 的任务分布漂移没有被推导：技能使用没有任务类别轴，而从会话 id 发明一个只会是猜测。§22 点名的两个按作用域来源——知识图中被否证的声明与记忆存储的 `refutationCount`——仍不驱动任何自己的流转，只能以确实存在的按技能不确定性信号抵达阶梯。§23 的 `used` 与 `cited` 环节没有写入方，§24 的 `source_quality` 因子没有记录来源，因此该效用是下限而非完整的 §24 测量；若日后有改动记录其中任何一项，台账是可增补的。没有任何新东西抵达模型提示词：漂移信号与召回台账都是读取与持久行，因此 §58.12 的"记录而不强制"边界依然成立。
