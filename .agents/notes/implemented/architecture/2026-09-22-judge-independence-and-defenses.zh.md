# Agent Note：评判者独立性、校准与被观测的博弈防御

Status: implemented

[English](2026-09-22-judge-independence-and-defenses.md) | 中文

## 问题

`specs/evolutionary-harness-v11-deep-research.md` 中有四个机制族只有记录的一半，而没有值得据以行动的一半：

- **§44（把模型分歧作为搜索信号）** 完全没有产生方。没有任何东西比较两条路由或两条独立推理路径。仓库里唯一的「分歧」是 `evolution-scorer` 把三个行为闸门归约成一个 `unanimous` 标志——同一个评分器内的三个闸门，而该评分器出厂即 `disabled: true`，且该标志比较的是一次评估内部的各通道，而不是两条路由或两个模型。
- **§28（评判者独立性）** 记录了哪个路由服务哪个角色、哪个路由评判候选，但从不对两者作比较。`evolution-evaluator-strategy` 接受调用者传来的 `independent: true` 标志，却无法核查本包自己就能核查的那件事：评判者是否正是产出候选的模型。§28 的拓扑还以「最终晋级复核 → 最强验证者」收尾，而没有任何推荐点名那条路由。
- **§13（评判者校准）** 列出误报率、漏报率与和人类结果的相关性。存储只有第一项，并把其余两项称为推迟的工作：`falsePositiveRate` 是裁决对裁决的内部代理，既没有负向的一半，也没有记录在案的地面真值。
- **§46（评估器博弈防御）** 列出六项可自动化防御，并在 `evolution-adversary` 中为每项记录一个手工设置的布尔值。没有任何东西从引擎真正做过的事推导某防御是否成立，因此清单回答的是操作者的断言，而不是证据。

## 决定

1. **路由分歧由路由存储已有的结果推导，且不调用任何模型。** `routeDisagreement`（`evolution-router/src/disagreement.ts`）比较某任务类与角色下、被测量至少 `disagreementMinimumRuns` 次的各路由中的最高与最低通过率，并在差距达到 `disagreementThreshold` 时报告两者。`observe` 对它刚测量的任务类与角色运行该检查，并通过既有的 `ctx.evolutionUncertainty` 接缝写入一条 `disagreement` 不确定性信号。信号身份由任务类、角色与那两条路由推导得出，因此排空队列的一轮与随后再次记录同一分歧的一轮会收敛，而不是无界增长。
2. **该机制检测不到的东西被写下来，而不是留给读者猜。** 它比较的是跨路由的已记录结果，因此发现的是跨路由的结果分歧：两条路由在某个任务类上通过比例相同就不会触发任何信号，即使它们通过的正是类中不同的任务；只有一条路由跑过的任务类也无从比较。要在同一任务上做真正的逐样本双模型比较，需要第二次模型调用，而 §44 并不要求、本次改动也不做这件事。
3. **§28 的独立性规则落在两个模型身份都已知的地方。** `evolution-evaluator-strategy` 中的 `judgeIndependence(judgeModel, candidateModel)` 把产出候选的评判者判为 `same-model`；`updatedStrategy` 把这样的配对计入 `samples` 与新增的 `selfJudgedSamples`，绝不计入 `independentSamples` 或 `corroborations`。空的 `candidateModel` 无法证明就是评判者的，因此读作独立——这一点作为限制记录在案，因为把「未知」悄悄当作「自评」会颠倒调用者记录的含义。
4. **最强已配置验证者被点名，而点名不触发任何路由。** `evolution-evaluator-strategy` 的 `ranking` 与 `recommend` 会把 `ctx.evolutionModelRoutes.recommend('promotion-review')` 作为 `promotionReview` 附在每个条目上，未指派时为 `null`。没有运行会由一条推荐启动，因此 §58.12 的记录而非强制边界完好无损。
5. **校准同时得到两个误差方向与一个真实的地面真值字段。** `evolution-evaluator-health` 中的 `judgeCalibration` 把误报读数镜像成漏报率（被拒后被同一技能更晚的通过所推翻的裁决），并统计随后由**独立**地面真值评判过的裁决数及其一致率。`judge(runId, judgment)` 把该判定附到一条已记录裁决上，并对未知 id 响亮拒绝。
6. **§46 清单在断言之外得到一个观测者。** `evolution-adversary`（`src/defenses.ts`）中的 `observeDefenses` 从真正记录过证据的存储推导六项防御中的每一项——`multiple-evaluators` 取自评估器策略存储、`hidden-holdout` 取自基准的留出分区、`behavioral-metrics` 与 `adversarial-tests` 取自对抗包自己的探针、`evaluator-rotation` 取自路由有效性——并各自报告为 `observed-satisfied`、`observed-open` 或 `unobserved`。`randomized-tests` 恒为 `unobserved` 并点名原因，因为没有任何东西记录哪些测试被随机化；人工抽查根本不是一个清单行。未挂载的存储使其对应防御为 `unobserved` 并点名缺失的存储，绝不读作开放。`defenses()` 继续原样报告操作者的行。
7. **每个新阈值都是已验证的 `Config` 字段。** `disagreementMinimumRuns`（3）与 `disagreementThreshold`（0.5）加入 `evolution-router` 的 `minimumSamples`；观测者复用既有的 `minProbesPerCategory`。

## 考虑过的替代方案

- **在路由内做第二次模型调用。** 否决：§44 可由已记录证据支撑，仓库的姿态是零新增模型调用，而实时比较需要一个路由并不拥有的任务工具链。记录版的精确检测上限写在 README 与包文档中。
- **逐任务比较两条路由的结果行，而不是比较通过率。** 否决：`RouteOutcome` 不携带任务类内部的任务身份，因此更细的比较没有数据可读。通过率分歧才是存储真正持有的东西。
- **把空的 `candidateModel` 当作同模型。** 否决：那会把调用者的遗漏变成一项指控，并把证据并未显示的配对计为自评。
- **让 `conflicts()` 拒绝一条既产出又评判的路由。** 否决：运维者的固定指派按设计优先于拓扑，而一个悄悄拒绝已记录运维动作的存储，比一个让冲突可见的存储更糟。`conflicts` 记录，并用 `pinned` 说明是谁选的。
- **两个域直接升版而不带 `compatibleVersions`。** 否决：版本 1 的行本身可读（缺席的 `judgment` 读作未被判定，缺席的 `selfJudgedSamples` 读作零），因此为一次形状变更丢弃它们是扔掉评估器证据。
- **把 `evaluatorRun.unanimous` 当作 §44 的分歧来源。** 否决：那个标志比较的是一次评估内部的各通道，评分器出厂即禁用，且完全不涉及两条路由。§44 要求两个模型或两条推理路径；路由才是本 Harness 真正持有的成对记录。

## 影响

- `evolution-router` 在挂载时会写入 `ctx.evolutionUncertainty`。即使没有东西排空它，信号也会被记录：消费者是驱动器的 `drain` 循环，在该循环挂载之前信号会累积在队列中。README 明确说明了这一点。
- 两个域升到版本 2 并带 `compatibleVersions: [1]`：`evolution_evaluator_strategy`（新增 `selfJudgedSamples`）与 `evolution_evaluator_health`（新增可选的 `judgment`）。
- 出现三条 evolution→evolution 依赖边，沿用 `evolution-metrics`/`evolution-scorer` 的 peer+dev 模式：router → uncertainty、evaluator-strategy → model-routes、adversary → {benchmark, evaluator-strategy, router}。锁文件刷新是父级的步骤。
- `observedDefenses` 只读取姊妹存储：它不向基准追加任何内容、不走任何路由、也不启动任何评估。不存在第二条准入路径。

## 测试

- `evolution-router/tests/disagreement.spec.ts` 固定比较表（最高对最低通过率、低于运行下限的路由被排除、仅一条已测路由不产出任何东西、落在阈值内的差距）以及分组与排序。`tests/store.spec.ts` 驱动真实接缝：一致时不记录信号，分歧时记录一条并核对其精确 id、分数与 detail，重复记录保持同一身份，拒绝的不确定性存储记录一条警告而结果仍然落盘。
- `evolution-evaluator-strategy/tests/strategy.spec.ts` 固定 `judgeIndependence`（含两个空模型方向）与计数规则；`tests/store.spec.ts` 把同模型判定记录为非独立——权重为零、无可推荐、`selfJudgedSamples` 为一——并从被桩替换的模型路由存储读取晋级复核路由，未挂载时读作 `null`。
- `evolution-evaluator-health/tests/stats.spec.ts` 固定误报计数器不触发处的漏报率、同技能与排序守卫，以及只计独立判定的一致率；`tests/health.spec.ts` 通过存储附加判定并拒绝未知 id。
- `evolution-adversary/tests/defenses.spec.ts` 固定每个观测者的满足与开放分支，以及恒为未观测的 `randomized-tests`；`tests/store.spec.ts` 带着三个被桩替换的姊妹存储跑通真实存储中的观测者并核对全部六种状态，无挂载时核对三项 `unobserved` 读数。

## 未触碰

此处没有任何东西对技能设闸、改变会话所见，或进入模型提示词。分歧信号被记录并等待排空循环；晋级复核路由被点名而无人自动应用；防御观测对姊妹存储只读。§58.12 依然成立。
