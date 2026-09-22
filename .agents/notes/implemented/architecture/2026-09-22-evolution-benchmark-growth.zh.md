# Agent Note: 基准增长、风险路由与留出规则

Status: implemented

[English](2026-09-22-evolution-benchmark-growth.md) | 中文

## 问题

`specs/evolutionary-harness-v11-deep-research.md` 描述了若干机制族：它们的记录一半已经存在，行动一半则没有；此外还有一族契约完全没有代码。

- §49 按风险路由决策——"低风险 + 强证据 → 自动提升，中风险 → 金丝雀，高风险 → 人工审批，不确定 → 人工复核"——而 §54 的 Phase 0 把"风险模型"列在架构本应据以起步的契约之中。仓库里没有任何包拥有风险模型：拥有发布阶梯的 `evolution-canary` 没有，仅凭实测三元组决定每次在线发布的 actuator 发布监视器也没有。
- §14 要求一个"回归晋升器"（Regression Promoter），并指出"新的失败应自动成为难题，除非它们是重复或被污染"。基准存储此前只从 `/benchmark admit` 与 actuator 的 `admission` 回路接纳任务，而后者读取的是开放的课程提案。课程提案本身来自 `evolutionCurriculum.propose`，其唯一的自动调用者是 actuator 的 `recovery` 回路，且以 `evolutionStagnation.status().stagnant` 为门。在交付的 profile 中，停滞运行的唯一写入者是优化器，而 `packages/bundle/web-app/cordis.patch.yml` 把该行交付为 `disabled: true`。因此在交付的 profile 中，没有任何提案会被暂存，也没有任何基准任务会被自动准入：存储的内容靠人工固定。
- §15 要求 TRAIN/SEARCH、VALIDATION 与 PRIVATE HOLDOUT 三个划分，并指出"候选晋升绝不应只依赖生成该候选所用的数据集"。基准存储自写出以来就持有那四个阶梯状态，但每一次推进都是人工 `/benchmark promote`。没有任何规则把已记录证据与某个档位连起来，也没有任何地方在决定晋升时读取留出覆盖。

## 决定

1. **§49 的风险模型放在 `evolution-canary`，作为一个纯模块**（`src/risk.ts`、`assessRisk`）。它读取一次变更的四个事实——产物类别（`skill` 或作用域级 `memory`）、证据强度（`strong`/`partial`/`none`）、可逆性、留出覆盖——返回一个 `RiskClass` 及该类别准许的 `RiskRoute`。它累计三个加重项（作用域级产物、部分证据、未覆盖的留出），并把"未测量"当作独立的 `uncertain` 类别而不是高风险：测量缺失意味着信号的缺席，§49 将其路由到复核而非审批。命中一个加重项即 `medium`，命中两个或更多、或变更不可撤销即 `high`，一个都不命中即 `low`。
2. **它位于发布阶梯之侧，而不在 actuator 中**，因为正是阶梯让一次变更变得可逆：`canary` 部署仍可退出到 `rolled-back`。风险类别与发布阶段是同一段暂存写入生命周期的两种读法，而 actuator 始终只是其他包所拥有规则的执行者。
3. **发布监视器咨询它**（`rolloutRisk`、`routeAllows`）。`rolloutRisk` 从已记录状态推导输入而不是重述它——实测三元组或什么都没有；永远可逆，因为监视器只决定仍在线的发布；留出覆盖从基准存储中该能力的 `holdout` 任务读取。随后 `routeAllows` 只允许 `auto-promote` 路由上的提升，而允许任何路由上的回滚，因为回滚是把在任者恢复回来而不是装上新补丁。
4. **一个 `growth` 回路把交付 profile 中本就活着的证据挖出来**——反馈存储评为 `trigger_review` 的会话失败，以及 curator 的开放回归债务——经由既有 `admit` 路径变成基准任务，并依据 population 存储记录下的暴露推进阶梯。它不读任何被禁用的存储，也不读任何停滞标记。
5. **每个推导出的任务文本都不含观察计数**，因此存储反复评为决定性的失败会重新哈希到已经为该失败准入的那个任务。让该回路幂等的是内容寻址，而不是存储的记忆；同一性质也让同一能力的两个不同失败成为两个任务。
6. **基准增长在 actuator 中拥有 `growth` 回路，且完全不读 `evolutionStagnation`。** 以停滞为门正是让交付 profile 失去活力的原因；新回路的来源全部由已启用的包写入。
7. **阶梯规则是 `evolution-benchmark` 中的 `ladderAdvance(state, exposure)`**，叠加在既有 `nextLadder` 之上而非取代它。每一档都要求各自的证据：`runs > 0` 加入搜索集，`passes > 0` 建立基线并进入 validation，`HOLDOUT_AFTER_RUNS`（3）在语料已越过该任务后把它保留为受保护留出。
8. **该规则把暴露当作数据读取，而不是去读 population 存储。** `ExposureEvidence` 是 `{ runs, passes }`，因此 `evolution-benchmark` 不保留对引擎 population 层的依赖，规则也无需上下文即可做单元测试。

## 考虑过的替代方案

- **新建 `evolution-risk` 包。** 否决：该模型就是一个作用于四个字段的纯函数，而描述这些字段的那个生命周期所属的存储已经存在。新建包会为一个只有发布回路消费的函数多出一行 profile、一对 README 与一个目录条目。
- **把 `assessRisk` 放进 `evolution-actuator`。** 否决：actuator 执行其他包所拥有的规则——这正是它声明的契约——而可逆性是关于金丝雀阶梯的事实，因此该模型会成为这个包中唯一没有归属存储的规则。
- **按是否存在基线来给证据定级。** 经考虑后否决：`rolloutDecision` 已经把候选三元组与在任者的相比，因此把缺少基线当作一个加重项会让同一事实被计算两次，并让任何技能的首个发布永久无法自动提升。
- **把"未测量"当作高风险。** 否决：§49 把 `uncertain` 列为一个路由到复核的类别。把它并入 `high` 会把未测量的补丁送去审批，而那是比复核更重的门，也是错误的门——审批说的是"这很危险"，复核说的是"我们看不出来"。
- **让监视器在 `canary` 路由上也回滚。** 否决：回滚是把在任者恢复回来，因而是安全方向；对回滚设门会让一个失败的补丁在没有留出的宿主上保持在线，那严格劣于结束它。
- **用一个回路自造的会话列表去读 `evolutionFeedback.signals()`。** 否决：该存储的读取以会话为键，而没有任何东西枚举它所保存的会话。回路从 `evolutionSkillTelemetry.entries()` 的 `usage.sessionIds` 读取会话 id，与 `evolutionCurriculum.gaps()` 测量所用的同一条缝，因此两个聚合失败的读取者对"这些会话"的理解一致。
- **用计数、会话数或时间戳推导任务文本。** 否决：这些值会随失败反复出现而变化，于是内容地址会移动，存储便会在下一轮为同一失败准入第二份副本。
- **把阶梯规则绑定到任务级暴露。** 因无法实现而否决：harness 中没有任何东西记录一次候选评估使用了哪个基准任务，任务级规则只能发明这份记录。规则读取能力暴露，README 陈述了随之而来的上限。
- **在排空回路中保留空信号守卫。** 选择移除：不确定性队列从列表所读的同一批信号推导每个任务，因此排队的任务总有至少一个信号，而 `benchmarkInput` 的响亮拒绝比一个无人能到达的分支是更好的守卫。
- **把阶梯规则折进 `nextLadder`。** 否决：`/benchmark promote` 与 `transition` 强制阶梯的形状，而人工手动提升不应被引擎自己的暴露设门。`ladderAdvance` 回答的是另一个问题——已记录证据挣得了什么——并在无法证明时返回 `undefined` 而不是一个档位。

## 后果

- `assessRisk` 把 §49 的表格发布为一个函数；actuator 的发布监视器如今遵循它返回的路由，这意味着一个已测量、通过、更便宜，但其能力没有任何 `holdout` 任务覆盖的补丁会保持在线等待运维者，而不是被提升。这是 §15 的规则首次触达生产行为，并在 `/canary` 中可见。
- 出现第六个心跳任务 `evolution-benchmark-growth`，且 `Config.loops` 接受 `growth`。
- `ladderAdvance`、`HOLDOUT_AFTER_RUNS` 与 `ExposureEvidence` 加入 `evolution-benchmark` 的公开面；`failureInputs`、`debtInputs`、`exposureOf`、`rolloutRisk` 与 `routeAllows` 加入 actuator 的公开面。
- actuator 新增对 `evolution-curator`、`evolution-feedback` 与 `evolution-skill-telemetry` 的 peer 依赖。
- 任务如今无需人工即可到达 `holdout`：随着该能力的已记录暴露越过每一档，增长回路会推进它。
- 三个包的 README 三元组都陈述了新面，读取 actuator `Config` 的配置目录门禁多出 `growthIntervalHours`。
- 目录门禁没有新增软件包行：本次变更给三个既有包各加一个模块，并给一个既有插件加一个回路。

## 与计划的偏差

§15 的划分无法从任务级证据推导，因为没有任何存储把候选评估绑定到基准任务身份——`evolutionPopulation` 按技能记录候选，`evolutionOptimizer` 的账本按技能记录运行，而 `evolutionLineage` 的实验信封带着一个无人填充的 `tasks: string[]`（优化器把它记为空）。因此诚实的规则读取某任务所属*能力*的已记录暴露，并将其应用到该能力的可学习任务。两个 README 都陈述了随之而来的后果：被准入到充分评估过能力里的任务会在搜索从未使用它的情况下到达 `holdout`，而同属一个能力的两个任务会一起推进。推导任务级暴露需要一份 harness 尚不具备的记录：其形态应是在 population 候选或 lineage 信封上带一个任务身份，由运行该任务的任何东西写入——而目前没有任何东西运行基准任务，所以即便字段存在，这份记录也不会有写入者。

§15 的后半——面向长期存活智能体的"生产重放、对抗、从未见过留出"——同样无法推导：`evolution-trace` 把已提交会话投影成学习追踪，但不记录任何重放语料；基准存储的状态也没有用于数据集出处的第二个维度。两者都仍然开放。

## 测试

`packages/evolution/evolution-canary/tests/risk.spec.ts` 把 §49 的表格摊成十行具名样例——该规则所区分的产物、证据、可逆性与留出的每一种组合——并逐一断言类别与路由。`packages/evolution/evolution-benchmark/tests/dedupe.spec.ts` 增加了阶梯规则：每一档在证据不足时、在证据达成时，以及三个永不推进的状态。

`packages/evolution/evolution-actuator/tests/actuator.spec.ts` 先在无上下文的情况下覆盖各纯映射（决定性信号的选择及其文本稳定性检查、债务映射、忽略未测量候选的暴露计数、已测量与未测量部署的风险输入，以及路由许可），随后在内存后端之上启动真实存储。其中 benchmark、canary、population、stagnation、curriculum 与 uncertainty 存储都是真实的；feedback、curator 与 telemetry 三条缝是返回固定已记录值的桩，因此这些测试证明的是回路以及它所依赖的去重，而不是那三个包在各自套件中完成的评级：

- 决定性失败只被准入一次，且当存储持续把它评为决定性时仍只有一个任务；只排序的信号不产生任何东西；第二个不同的失败被准入在它旁边；
- curator 的开放债务被准入为回归用例；
- 任务随暴露越过每一档而精确走完 `fresh → search → validation → holdout`，证据不足时原地不动；
- 只有当某个 `holdout` 任务覆盖其能力时发布才会提升，而回归或成本超标则在任何情况下都回滚；另有第二个测试覆盖只挂载金丝雀存储的宿主；
- 六个回路中每一个"存储缺失"与"无事可做"的守卫，经由一个可挂载任意存储子集的 boot 辅助函数覆盖。

## 未触碰之处

这些回路仍然只作用于已记录状态，且不门控任何东西：被准入的基准任务不会运行，而 `human-approval` 路由指名的是既有的暂存写入审批所提供的运维步骤，而不是新增一个队列。因此 §58.12 的"只记录、不强制"边界在本次变更后依然成立。三个不可执行的 §32 档位保持不可执行。上文的两个 §15 缺口作为上限记录在案而非被近似：任务级暴露规则需要一份没有写入者的记录，发明它会让基准存储的晋升证据无法追溯；而第二个留出轴需要的出处记录同样不存在。
