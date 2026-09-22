# Agent Note：对抗探针生成与 §37 预算闸门

Status: implemented

[English](2026-09-22-adversarial-probes-and-budget-gates.md) | 中文

## 问题

`specs/evolutionary-harness-v11-deep-research.md` §45 要求"一位专职的对手"，其回路为 `生成器 → 候选 → 对手 → 发现弱点 → 修复 → 验证`，并瞄准八个弱点族；§14 把"对抗样例生成器"列入让基准自身演化的机制；§32 说停滞的技能"自动切换策略"；§37 为每个实验给出预算。记录的那一半都已存在，而其中三处没有消费者：

- `evolution-adversary` 保存探针、八族词表、下一类别挑战，以及 §46 的防御清单。每支探针都来自运维者键入的 `/adversary probe <skill> <category> <probe>`，因此**引擎**已经记录下来的弱点——一条 §43 不确定性信号、一笔策展器回归债务——永远不会变成探针。该存储自己的 README 就这么写着："对技能执行探针并判定弱点仍是运维者的工作。"
- 基准存储的 `admit` 路径接了三个已记录来源（反馈失败、策展器债务、课程提案），而没有任何探针到过那里，因此对抗探针一直只是探针日志里的一行，而没有进入评估集。
- `recoveryStep` 把 §32 的 `newOperators`、`newEvaluators` 与 `newModel` 三个档位报告为 `unactionable`，因为没有任何存储记录这种切换。这份报告诚实，却没有点名任何存储，因此读者无法分辨这是架构空缺还是遗漏。
- `evolution-budget` 按候选类为一个批次定价并结算花费，而它的 `withinAllocation` 规则只在优化器自己的 `run()` 内部被咨询过。驱动器的那些回路——交付 profile 唯一启用的运行者——消耗墙钟时间却从不读取任何分配，因此一个花尽的批次只能停下优化器，停不下别的。§38 的"低潜力候选 → 提前停止"因此在被禁用的包之外没有任何强制点。

## 决策

七条窄决策，全部位于 `packages/evolution/evolution-actuator` 之内。

1. **一个新回路 `adversary`，从已记录证据生成。** 它读取 §43 的不确定性信号与策展器的开放回归债务，每个已记录弱点生成一支探针，并经由 `evolution-adversary` 现有的 `probe` 路径记录它。`AUTOMATION_LOOPS` 增加该回路，`LOOPS`/`LOOP_TASK_NAMES` 增加 `evolution-adversarial-probes`，`Config`/`ResolvedConfig` 增加 `adversaryIntervalHours`（默认 24），使它的节奏与其他每一个一样是部署选择。
2. **弱点族来自存储那份封闭词表，观察内容逐字照录。** 新的 `src/probe.ts` 保存两份映射：`signalProbe` 把每个 §43 种类映射到它所考的 §45 族——`disagreement → evaluator-gaming`、`low-confidence → ambiguous-instruction`、`instability → edge-case`、`retrieval-ambiguity → retrieval-trap`、`conflicting-evidence → contradictory-evidence`——而 `debtProbe` 把一笔开放回归债务映射到 `tool-failure`，因为那笔债务的合并键就是一次失败的工具调用。探针文本为 `Probe <skill> for the recorded <family> weakness: '<observation>'.`：族用的是存储自己的词，观察内容用的是已记录文本，因此这里不发明任何弱点。种类到族的表是全的，因此每个已记录种类都能落到某个族，而未记录下来的弱点不产生探针，而不是被默认归入某一族。
3. **探针只被记录，从不被执行。** §45 的另一半——对候选运行探针并判定它是否暴露了弱点——需要随包 profile 并未提供存储的执行运行器与语料。该轮记录挑战并把 `foundWeakness` 保持为 `false`，而不是报告一次从未发生的运行；比较一轮前后探针存储的用户看到的是挑战，而不是伪造的判决。这一半留在运维侧。
4. **生成的探针按内容地址幂等。** 其 `probeId` 是技能、族与文本三者的 sha256（`adversarial-<32 位十六进制>`——一种记录键不会破坏的形状），且该轮会跳过存储已持有相同类别与文本的探针。不确定性信号仍保持已记录——本回路不得消费排空回路拥有的状态——因此已记录挑战的来历得以保留，而已修复的探针不会被反复看到它的那一轮重新打开。
5. **§14 的对抗样例经现有路径进入评估集。** `probeTask` 把探针转成 `BenchmarkInput`，其能力是探针的技能、任务是探针文本、gist 是构建探针所用的那条观察；该轮经由 `benchmark.admit` 准入它，由存储自身的内容哈希去重。准入以该能力已是"基准形态"为门——存储已持有点名它的任务——因为没有评估集可加入的样例会成为一项无人评估之能力的基准任务。因此某个全新能力的首次失败只产生探针，不产生任务，直到某份课程提案为该能力创建首个任务。
6. **§32 的 `newOperators` 档位以读取方式行动，另外两个点名它们所需的存储。** `recoveryStep` 对该档位返回 `operators`，而恢复回路报告 `evolution-operators` 的 `recommendedInstruction(skill)` 为该停滞技能的工件类返回的指令。它刻意只是读取：那个存储拥有算子组合并提出下一步该试的指令，优化器是同一份推荐的消费者，且交付 profile 中没有任何东西可以允许驱动器改写该组合——因此本回路从不调用 `recordInstruction` 或 `judgeInstruction`。只有在提案存在时该档位才会行动；存储未挂载、或该类下没有提案时，该轮把此档位记为 `unactionable` 并点名究竟是哪一种。`newEvaluators` 与 `newModel` 仍返回 `unactionable`，`recoveryStep` 的文档逐一点名：`evolution-evaluator-strategy` 需要接受提出的评估器集合，`evolution-model-routes` 需要接受某个角色的固定切换。配置好的路由不是模型切换，因此不会用它来近似。
7. **每个回路的写入都由其任务类的 §37 分配设闸。** 一个辅助函数 `underBudget` 位于「规则决定行动」与「规则所指名的存储调用」之间。它读取预算存储为那个技能或能力记录的分配（`src/budget.ts` 中新增的纯规则 `governingAllocation`：先比 `at` 最新、再比批次标识，因此答案是全序的），并向 `evolution-budget` 自己的 `withinAllocation` 询问该批次的已记录花费。已花尽的类会被搁置并留下一行日志式的跳过——什么都没发生，因此不向任何域写入——而运行过的类会向同一批次结算它耗掉的墙钟时间，这正是让已记录额度能停下同一类下一轮的原因。未挂载预算存储、以及没有任何批次定价的类，都像以前一样不计量地运行：未定价的类没有额度，而不是零额度。由于执行者是 `withinAllocation` 而不是在此重新推导的算术，本批次中 `evolution-budget` 新增的 `max_cost`、`time_limit` 与 `parallelism` 字段无需签名变更即被强制。

## 考虑过的替代方案

- **在本包内合成探针文本。** 否决：存储的 README 已经拒绝凭空写出的弱点文本（"执行探针……仍是运维者的工作"），而证据是本包自己拼出的句子的探针，与已记录的探针将无从分辨。模板只承载一条已记录观察，别无其他。
- **把未记录族归属的弱点默认归入 `edge-case`。** 否决：默认的族就是伪造的词表条目，而归错族的探针会污染 `categoryCoverage` 以及存储据此推导的每一个 `challenge`。没有记录就没有探针。
- **像排空回路那样在探测后消费不确定性信号。** 否决：排空回路拥有该信号的生命周期，而一个会解析它的探针生成器会悄悄缩小它并不拥有的评估队列。幂等改由探针的内容地址提供。
- **经由优化器或评分器执行探针以填上 `foundWeakness`。** 否决：那需要可运行的语料与候选正文，这两样都不在这些存储中，而且会引入 §45 执行半所需的那类模型调用。运行的是已记录的那一半；README 点名缺失的另一半。
- **为对抗样例新增一个基准状态。** 否决：`fresh` 是每个被准入任务的起点，而 §14 的样例就是候选要么通过、要么失败的普通困难用例。独立状态还需要一条"何时推进"的规则。
- **改用 `withinBudget(batchId)` 读取预算。** 否决：那个方法以批次为键，而回路知道的是自己的任务类（技能或能力），不是哪个批次为它定价。`governingAllocation` + `withinAllocation` 用回路真正持有的键施加同一规则，且不暴露任何新的存储方法。
- **在每个存储内部强制额度。** 否决：回路才是运行者，因此检查应当在工作开始之处；一个在超预算时拒绝写入的存储也无从得知调用方的写入属于哪个批次，还会打断与它共用该存储的人工 `/benchmark admit` 动词。
- **在类超预算时抛出异常。** 否决：花尽的批次是正常运作，不是缺陷。抛出会落进心跳的 `lastError` 并把整轮标记为失败——连带丢掉同一轮中其他类的工作——而一行日志式的跳过记录了该决策并让该轮跑完。
- **用 `evolution-model-routes` 的固定来近似 `newModel`。** 否决，依据该机制自身的措辞：§32 要求切换模型，而路由表是在候选可能继续使用的若干路由之间做选择。把路由固定报告为模型切换，等于宣称一次没人做过的变更。

## 后果

- `ctx.evolutionHeartbeat.state()` 增加 `evolution-adversarial-probes`，且 `loops: [...]` 接受 `adversary`。
- `recoveryStep` 增加 `operators` 步骤，恢复回路为此读取 `evolution-operators`。该档位的可观测形式是一行日志，点名算子与其指令；或是一行 `unactionable`，点名缺失的存储或缺失的提案；算子组合从不被写入。
- 本包增加三条工作区边，`@deepseek-ai/dsh-evolution-adversary`、`@deepseek-ai/dsh-evolution-budget` 与 `@deepseek-ai/dsh-evolution-operators`（`peerDependencies` + `devDependencies` + tsconfig 引用）。不改 bundle 行、根清单、lockfile 或 profile：那些行与 lockfile 属于集成轮。
- 新回路的一轮会写下文本携带已记录观察的探针，并准入其中能力已是基准形态者。两处写入都由接收存储自身的身份去重——探针按内容地址，任务按内容哈希——因此该回路的节奏无法使任一方增殖。
- 每个回路的一步如今要么在已记录分配下运行，要么留下一行日志式的跳过。批次花尽的可观察后果是该类已记录的工作停下，而其他每一类的工作继续。
- 探针存储的 `challenge` 与 `/adversary` 输出含义略有变化：某个类别如今可能由运维者从未键入的生成探针覆盖，读 `/adversary list` 会看到引擎从其自身已记录弱点推导出的内容。

## 与计划的偏离

- §32 的 `newOperators` 档位原本计划为「报告 unactionable 并点名存储」，在批次中途变为可行动，因为 `evolution-operators` 落地了该档位所需的指令 API。它以「有日志的读取」而非写入的方式行动：该档位对所有权保持诚实，并由该存储自己的排名领先者决定指令。
- 计划提到"一个从已记录证据生成对抗探针的驱动器回路……每支探针都基于一次实际已记录的失败**或被反驳的声明**"。被反驳的声明（`evolution-graph` 的 `contradictionCount > 0`）未被用作来源：图中的声明是按作用域的，驱动器是宿主范围的，而图没有暴露任何跨作用域迭代以供读取——读不到的来源不是来源。`contradictory-evidence` 探针改由 §43 的 `conflicting-evidence` 信号生成，那些信号在观察发生之处记录了同一分歧。
- §45 的八个族中有六个有本回路可读取的已记录来源；`prompt-injection` 与 `stale-memory` 刻意没有。`prompt-injection` 由 agent kernel 在会话账本上分类（`FailureKind`），到不了任何演化存储——反馈存储聚合的是失败的工具结果，因此一次抵达工具的注入被记成 `tool-failure`。`stale-memory` 有写入方（记忆存储的清扫、图让被取代声明退役），但两者都是按作用域的记录，没有宿主范围的读取路径，与被反驳的声明是同一处阻塞。这两个空缺都不靠把探针默认归入邻近的族来填补——这正是任务书"族来自已记录词表"的要求所排除的；两个族仍由运维者记录。

## 途中发现的修复

无。有一项条件得到再次确认而非修复：手工挂载 `EvolutionAdversary` 或 `EvolutionBudget` 而不传配置参数会让它们的 zod `Config` 失败（`expected object, received undefined`），因此测试夹具传入 `{}`。更早那份驱动器注记已就真实加载器（它不传 undefined）排除过同一条件；产品路径上没有任何变化。

## 测试

`node node_modules/vitest/vitest.mjs run packages/evolution/evolution-actuator` 通过 42 项测试。新行为针对内存后端上的真实存储被钉住：

- 一条已记录的 `retrieval-ambiguity` 信号在两轮中恰好产生一支 `retrieval-trap` 族探针与恰好一项被准入的基准任务，而存储已持有（并带有其修复标记）的探针在第三轮被搁置；
- 一笔开放回归债务产生一支 `tool-failure` 探针及其被准入的样例；
- 基准存储从未持有过的能力上的弱点会记录探针且不准入任务；
- 没有不确定性、策展器或基准存储的宿主什么都不生成，而没有基准存储的宿主仍记录探针；
- 批次已花尽的类停止工作——信号留在队列中、不出现任务，且跳过日志点名该批次——而有余量的类在同一轮照常排空并向自己的批次结算一笔花费；
- 没有任何批次定价的类不计量地运行；
- 处于 `newOperators` 档位的停滞技能会记录 `evolution-operators` 推荐的指令——且它读过的组合保持不变——而同档位在两种存储无法作答的情况下分别记录 `unactionable` 并点名缺失的提案与未挂载的存储；
- 每个回路在没有任何存储挂载时报告一次成功轮次。

纯规则测试覆盖族映射（全部五种 §43 种类）、逐字证据与稳定的内容地址、`probeTask`，以及 `governingAllocation`（含最新者胜、同时刻并列、空列表三种情况）。`src/` 保持逐文件 100% 门：8 个文件、234 条语句、156 个分支、65 个函数、189 行。

## 未改动

探针执行与弱点判定留在运维侧（§45 的后半），`/adversary probe` 仍记录运维者键入的内容，`/adversary repair` 仍负责关闭它。优化器保留其运行内预算检查——本闸门只管回路，两者并未合并。§46 的防御清单（包括 `evaluator-gaming` 族中由运维者设置的人工抽查行）未被触碰。`evolution-evaluator-strategy` 与 `evolution-model-routes` 在本次变更中都是只读的，因此这两个 §32 档位在这里仍不改变任何东西；`evolution-operators` 同样只读——本回路只报告它的推荐，从不记录或判定指令。回路仍是宿主范围且串行的，预算闸门继承这两条限制：一个类就是整个宿主的那一类，而一次缓慢的结算会拖住同一轮中它之后的各个类。
